import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
  appendFile,
  open,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import {
  syntheticArchive,
  tar,
  sha256,
  noSuchImage,
} from "./helpers/native-import-archive.js";

// The isolated child enables Node's explicit module API fixtures. No production
// executable, HTTP request, attestation or daemon is used by these controls.
if (!process.execArgv.includes("--experimental-test-module-mocks")) {
  test(
    "production release journal engine recovery controls",
    { timeout: 90000 },
    async () => {
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT; // Start a real nested runner, not a runner child protocol.
      const result = await promisify(execFile)(
        process.execPath,
        [
          "--experimental-test-module-mocks",
          "--import",
          "tsx",
          "--test",
          "--test-reporter=spec",
          fileURLToPath(import.meta.url),
        ],
        { timeout: 85000, maxBuffer: 1024 * 1024, env },
      );
      assert.match(result.stdout, /tests 17/);
      assert.match(result.stdout, /pass 17/);
      console.log(result.stdout);
    },
  );
} else {
  type State = Awaited<ReturnType<typeof fixture>>;
  let active: State;
  let writingPhase: string | undefined;
  let stop: { phase: string; before?: boolean } | undefined;
  const ownership = await import("../src/release/native-ownership.js");
  const command = async (file: string, args: string[]) => {
    active.commands.push({ file, args: [...args] });
    if (process.env.JOURNAL_FIXTURE_CRASH_PHASE)
      await appendFile(
        join(active.dir, "child-commands.jsonl"),
        JSON.stringify({ file, args }) + "\n",
      );
    if (file === "/usr/bin/true" || file === "gh" || file === "npm")
      return { stdout: "", stderr: "" };
    assert.equal(file, "docker");
    const host = args[0];
    if (args[2] === "load") {
      active.loads++;
      const journal = await active.journal();
      active.atLoad.push(journal);
      active.present.add(host);
      if (active.lostReply) throw Error("MOCK_ACCEPTED_REPLY_LOST");
      return { stdout: "", stderr: "" };
    }
    assert.equal(args[2], "inspect");
    if (!active.present.has(host) || args[3] !== active.image.Id)
      throw noSuchImage(args[3]);
    return { stdout: JSON.stringify([active.image]), stderr: "" };
  };
  mock.module(
    new URL("../src/release/native-ownership.ts", import.meta.url).href,
    { namedExports: { ...ownership, nativeOwnedExec: command } },
  );
  const artifact = await import("../src/sandbox/artifact.js");
  mock.module(new URL("../src/sandbox/artifact.ts", import.meta.url).href, {
    namedExports: {
      ...artifact,
      nativeBindingPreflight: async (root: string, home: string) => {
        active.probes++;
        active.atProbe.push(await active.journal());
        return artifact.nativeBinding(home, root, command);
      },
    },
  });
  const journal = await import("../src/update/journal.js");
  mock.module(new URL("../src/update/journal.ts", import.meta.url).href, {
    namedExports: {
      ...journal,
      atomicWrite: async (home: string, name: string, value: any) => {
        if (stop?.phase === value.phase && stop.before)
          throw Error("MOCK_JOURNAL_WRITE_FAILED");
        writingPhase = value.phase;
        try {
          await journal.atomicWrite(home, name, value);
        } finally {
          writingPhase = undefined;
        }
        active.phases.push(value);
        if (stop?.phase === value.phase) {
          if (process.env.JOURNAL_FIXTURE_CRASH_PHASE) {
            process.send?.({ checkpoint: value.phase });
            await new Promise(() => {});
          }
          throw Error("MOCK_CHECKPOINT_INTERRUPTED");
        }
      },
    },
  });
  const { provisionReleaseOwned } = await import("../src/release/provision.js");
  const { withNativeEngineAuthorityFixture } = await import(
    "../src/sandbox/binding.js"
  );
  const bounded =
    "--host=unix:///var/lib/katafit-bounded/store/run/docker.sock";
  const legacy = "--host=unix:///var/run/docker.sock";
  async function fixture(existing?: string) {
    const dir = existing ?? (await mkdtemp(join(tmpdir(), "engine-journal-")));
    const home = join(dir, "home"),
      staging = join(dir, "staging"),
      artifacts = join(dir, "artifacts");
    for (const p of [home, staging, artifacts])
      await mkdir(p, { mode: 0o700, recursive: true });
    const f = syntheticArchive();
    const pkg = gzipSync(
      tar(
        new Map([
          [
            "package/dist/build.json",
            Buffer.from(
              JSON.stringify({
                revision: f.m.revision,
                fingerprint: f.m.fingerprint,
                protocol: 2,
                capabilities: ["ready-releases-v1"],
              }),
            ),
          ],
          ["package/dist/native/npm-lock.json", Buffer.from("{}")],
        ]),
      ),
    );
    f.m.artifacts[0] = {
      name: `coach-${f.m.revision}.tgz`,
      size: pkg.length,
      sha256: sha256(pkg),
    };
    f.m.artifacts[1].name = `native-${f.m.revision}.tar.gz`;
    await writeFile(join(artifacts, f.m.artifacts[0].name), pkg);
    await writeFile(join(artifacts, f.m.artifacts[1].name), f.bytes);
    const state = join(home, "release-delivery"),
      key = f.m.revision + ".json";
    return {
      dir,
      home,
      staging,
      artifacts,
      f,
      state,
      key,
      image: f.inspection,
      present: new Set<string>(),
      commands: [] as { file: string; args: string[] }[],
      loads: 0,
      probes: 0,
      lostReply: false,
      phases: [] as any[],
      atLoad: [] as any[],
      atProbe: [] as any[],
      journal: async () => JSON.parse(await readFile(join(state, key), "utf8")),
    };
  }
  async function run(engine?: "legacy" | "bounded-v1") {
    return withNativeEngineAuthorityFixture(
      () => {},
      () =>
        provisionReleaseOwned(
          active.f.m,
          active.artifacts,
          active.home,
          active.staging,
          Buffer.from(JSON.stringify(active.f.m)),
          engine === undefined ? {} : { engine },
        ),
    );
  }
  async function using(work: () => Promise<void>) {
    active = await fixture();
    stop = undefined;
    try {
      await work();
    } finally {
      await rm(active.dir, { recursive: true, force: true });
    }
  }
  function dockerCommands() {
    return active.commands.filter((c) => c.file === "docker");
  }
  if (process.env.JOURNAL_FIXTURE_CRASH_PHASE) {
    active = await fixture(process.env.JOURNAL_FIXTURE_CRASH_ROOT!);
    stop = { phase: process.env.JOURNAL_FIXTURE_CRASH_PHASE };
    await run("bounded-v1");
    throw Error("MISSING_CRASH_CHECKPOINT");
  } else {
    test("accepted bounded load/lost reply: omitted and changed retry reject with zero commands, explicit retry reconciles", () =>
      using(async () => {
        active.lostReply = true;
        await assert.rejects(run("bounded-v1"), /MOCK_ACCEPTED_REPLY_LOST/);
        assert.equal(active.loads, 1);
        assert.equal((await active.journal()).phase, "loading");
        assert.equal((await active.journal()).importEngine, "bounded-v1");
        await assert.rejects(
          readFile(
            join(active.home, "native-artifacts", "bounded-v1", active.key),
          ),
          { code: "ENOENT" },
        );
        for (const engine of [undefined, "legacy"] as const) {
          active.commands = [];
          await assert.rejects(run(engine), /RELEASE_STATE_CONFLICT/);
          assert.deepEqual(active.commands, []);
        }
        active.lostReply = false;
        active.commands = [];
        const selected = await run("bounded-v1");
        assert.equal(selected.engine, "bounded-v1");
        assert.equal(active.loads, 1);
        assert.ok(dockerCommands().length > 0);
        assert.ok(dockerCommands().every((c) => c.args[0] === bounded));
        assert.ok(active.phases.every((p) => p.importEngine === "bounded-v1"));
        const probes = active.probes;
        await run("bounded-v1");
        assert.equal(active.probes, probes);
        assert.equal(active.loads, 1);
        active.commands = [];
        await assert.rejects(run(), /RELEASE_STATE_CONFLICT/);
        assert.deepEqual(active.commands, []);
      }));
    test("behavioral counterexample: omitted retry after accepted bounded load never dispatches legacy", () =>
      using(async () => {
        active.lostReply = true;
        await assert.rejects(run("bounded-v1"), /MOCK_ACCEPTED_REPLY_LOST/);
        active.lostReply = false;
        active.commands = [];
        const outcome = await run().then(
          () => "ready",
          (e) => e.message,
        );
        console.log(
          JSON.stringify({
            control: "omitted-retry",
            outcome,
            totalLoads: active.loads,
            retryCommands: active.commands,
          }),
        );
        assert.equal(active.loads, 1);
        assert.deepEqual(active.commands, []);
        assert.equal(outcome, "RELEASE_STATE_CONFLICT");
      }));
    for (const phase of [
      "staging",
      "staged",
      "loading",
      "provisioning",
      "ready",
    ])
      test(`durable ${phase} interruption retains import authority before retry effects`, () =>
        using(async () => {
          stop = { phase };
          await assert.rejects(
            run("bounded-v1"),
            /MOCK_CHECKPOINT_INTERRUPTED/,
          );
          assert.equal((await active.journal()).importEngine, "bounded-v1");
          assert.equal(
            active.loads,
            ["provisioning", "ready"].includes(phase) ? 1 : 0,
          );
          stop = undefined;
          active.commands = [];
          await assert.rejects(run(), /RELEASE_STATE_CONFLICT/);
          assert.deepEqual(active.commands, []);
          await run("bounded-v1");
          assert.equal(active.loads, 1);
          assert.ok(dockerCommands().every((c) => c.args[0] === bounded));
        }));
    for (const phase of ["loading", "provisioning", "ready"])
      test(
        `actual process crash after durable ${phase} checkpoint keeps engine on recovery`,
        { timeout: 10000 },
        () =>
          using(async () => {
            const child = fork(fileURLToPath(import.meta.url), [], {
              execArgv: ["--experimental-test-module-mocks", "--import", "tsx"],
              env: {
                ...process.env,
                JOURNAL_FIXTURE_CRASH_PHASE: phase,
                JOURNAL_FIXTURE_CRASH_ROOT: active.dir,
              },
              stdio: ["ignore", "pipe", "pipe", "ipc"],
            });
            let output = "";
            child.stdout!.on("data", (b) => {
              output += b;
            });
            child.stderr!.on("data", (b) => {
              output += b;
            });
            const closed = once(child, "close");
            let timer: ReturnType<typeof setTimeout>;
            try {
              const checkpoint = await Promise.race([
                once(child, "message").then(([message]) => message),
                closed.then(() => {
                  throw Error("early child exit: " + output);
                }),
                new Promise((_, reject) => {
                  timer = setTimeout(
                    () => reject(Error("checkpoint timeout: " + output)),
                    5000,
                  );
                }),
              ]);
              assert.deepEqual(checkpoint, { checkpoint: phase });
              child.kill("SIGKILL"); // exact fixture ChildProcess handle after fsync event
              assert.deepEqual(await closed, [null, "SIGKILL"]);
            } finally {
              clearTimeout(timer!);
              if (child.exitCode === null && child.signalCode === null)
                child.kill("SIGKILL");
              await closed;
            }
            assert.equal((await active.journal()).phase, phase);
            assert.equal((await active.journal()).importEngine, "bounded-v1");
            const childCommands = (
              await readFile(join(active.dir, "child-commands.jsonl"), "utf8")
            )
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
            const accepted = childCommands.filter(
              (c) => c.file === "docker" && c.args[2] === "load",
            );
            for (const c of accepted) active.present.add(c.args[0]);
            active.commands = [];
            await assert.rejects(run(), /RELEASE_STATE_CONFLICT/);
            assert.deepEqual(active.commands, []);
            await run("bounded-v1");
            assert.equal(accepted.length + active.loads, 1);
            assert.ok(
              [...childCommands, ...active.commands]
                .filter((c) => c.file === "docker")
                .every((c) => c.args[0] === bounded),
            );
            console.log(
              JSON.stringify({
                control: "actual-crash",
                phase,
                childLoadCalls: accepted.length,
                recoveryLoadCalls: active.loads,
                otherEngineCalls: 0,
                childSignal: "SIGKILL",
              }),
            );
          }),
      );
    test("failed loading checkpoint never dispatches load", () =>
      using(async () => {
        stop = { phase: "loading", before: true };
        await assert.rejects(run("bounded-v1"), /MOCK_JOURNAL_WRITE_FAILED/);
        assert.equal(active.loads, 0);
        assert.equal(dockerCommands().length, 0);
        assert.equal((await active.journal()).importEngine, "bounded-v1");
      }));
    for (const kind of ["file", "directory"])
      test(`actual journal ${kind} fsync failure stops before load`, () =>
        using(async () => {
          const handle = await open(join(active.dir, "prototype"), "w");
          const prototype = Object.getPrototypeOf(handle),
            original = prototype.sync;
          await handle.close();
          let failures = 0;
          const replaced = mock.method(
            prototype,
            "sync",
            async function (this: any) {
              if (
                writingPhase === "loading" &&
                (await this.stat()).isDirectory() === (kind === "directory")
              ) {
                failures++;
                throw Error("MOCK_FSYNC_FAILED");
              }
              return original.call(this);
            },
          );
          try {
            await assert.rejects(run("bounded-v1"), /MOCK_FSYNC_FAILED/);
          } finally {
            replaced.mock.restore();
          }
          assert.equal(failures, 1);
          assert.equal(active.loads, 0);
          assert.deepEqual(dockerCommands(), []);
          assert.equal((await active.journal()).importEngine, "bounded-v1");
          assert.equal(
            (await active.journal()).phase,
            kind === "file" ? "staged" : "loading",
          );
          await run("bounded-v1");
          assert.equal(active.loads, 1);
        }));
    test("bounded request reuses legacy sameFP while retaining separate requested authority, original receipt, no load", () =>
      using(async () => {
        const revision = "d".repeat(40);
        active.image = {
          ...active.image,
          Config: {
            Labels: {
              ...active.image.Config.Labels,
              "fit.kata.native.revision": revision,
            },
          },
        };
        active.present.add(legacy);
        const folder = join(active.home, "native-artifacts");
        await mkdir(folder, { mode: 0o700 });
        const path = join(folder, revision + ".json");
        const bytes =
          JSON.stringify({
            revision,
            fingerprint: active.f.m.fingerprint,
            image: active.image.Id,
            platform: "linux/amd64",
          }) + "\n";
        await writeFile(path, bytes, { mode: 0o600 });
        stop = { phase: "validating-reuse" };
        await assert.rejects(run("bounded-v1"), /MOCK_CHECKPOINT_INTERRUPTED/);
        assert.equal((await active.journal()).importEngine, "bounded-v1");
        stop = undefined;
        active.commands = [];
        await assert.rejects(run(), /RELEASE_STATE_CONFLICT/);
        assert.deepEqual(active.commands, []);
        const selected = await run("bounded-v1");
        assert.equal(selected.binding, "reused");
        assert.equal(selected.engine, undefined);
        const saved = await active.journal();
        assert.equal(saved.importEngine, "bounded-v1");
        assert.equal(saved.engine, undefined);
        assert.equal(active.loads, 0);
        assert.ok(dockerCommands().every((c) => c.args[0] === legacy));
        assert.equal(active.atProbe[0].importEngine, "bounded-v1");
        assert.equal(await readFile(path, "utf8"), bytes);
        assert.deepEqual(await readdir(folder), [revision + ".json"]);
        const probes = active.probes;
        await run("bounded-v1");
        assert.equal(active.probes, probes);
        active.commands = [];
        await assert.rejects(run(), /RELEASE_STATE_CONFLICT/);
        assert.deepEqual(active.commands, []);
      }));
    test("malformed/unknown/stale journal and engine fields reject before all commands", () =>
      using(async () => {
        stop = { phase: "staged" };
        await assert.rejects(run("bounded-v1"));
        stop = undefined;
        const good = await active.journal();
        const changes = [
          null,
          [],
          false,
          0,
          { ...good, importEngine: null },
          { ...good, importEngine: [] },
          { ...good, importEngine: false },
          { ...good, importEngine: 0 },
          { ...good, importEngine: "other" },
          { ...good, engine: "other" },
          { ...good, root: good.root + "-other" },
          {
            ...good,
            manifest: { ...good.manifest, fingerprint: "e".repeat(64) },
          },
          { ...good, extra: true },
          { ...good, phase: "ready" },
        ];
        for (const value of changes) {
          await writeFile(
            join(active.state, active.key),
            JSON.stringify(value),
            { mode: 0o600 },
          );
          active.commands = [];
          await assert.rejects(run("bounded-v1"));
          assert.deepEqual(active.commands, []);
        }
      }));
    test("same home retry with changed signed operation identity rejects before commands", () =>
      using(async () => {
        stop = { phase: "loading" };
        await assert.rejects(run("bounded-v1"));
        stop = undefined;
        const original = structuredClone(active.f.m);
        for (const change of [
          (m: any) => {
            m.fingerprint = "f".repeat(64);
          },
          (m: any) => {
            m.artifacts[1].sha256 = "f".repeat(64);
          },
          (m: any) => {
            m.artifacts[1].size++;
          },
          (m: any) => {
            m.platform = "linux/arm64";
          },
        ]) {
          active.f.m = structuredClone(original);
          change(active.f.m);
          active.commands = [];
          await assert.rejects(run("bounded-v1"));
          assert.deepEqual(active.commands, []);
        }
        active.f.m = original;
        assert.equal(active.loads, 0);
      }));
    test("old pre-import and ready legacy journals stay legacy; ambiguous old intermediate journals reject", () =>
      using(async () => {
        stop = { phase: "staged" };
        await assert.rejects(run("legacy"));
        stop = undefined;
        const saved = await active.journal();
        delete saved.importEngine;
        for (const phase of ["loading", "provisioning", "provisioned"]) {
          await writeFile(
            join(active.state, active.key),
            JSON.stringify({ ...saved, phase }),
            { mode: 0o600 },
          );
          active.commands = [];
          await assert.rejects(run(), /RELEASE_STATE_CONFLICT/);
          assert.deepEqual(active.commands, []);
        }
        await writeFile(join(active.state, active.key), JSON.stringify(saved), {
          mode: 0o600,
        });
        active.commands = [];
        await assert.rejects(run("bounded-v1"), /RELEASE_STATE_CONFLICT/);
        assert.deepEqual(active.commands, []);
        await run();
        assert.equal(active.loads, 1);
        assert.ok(dockerCommands().every((c) => c.args[0] === legacy));
        const ready = await active.journal();
        delete ready.importEngine;
        await writeFile(join(active.state, active.key), JSON.stringify(ready), {
          mode: 0o600,
        });
        await run();
        assert.equal(active.loads, 1);
        assert.equal((await active.journal()).importEngine, "legacy");
      }));
  }
}
