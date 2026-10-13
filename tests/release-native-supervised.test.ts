import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  rename,
  rm,
  readdir,
  appendFile,
  stat,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { watch } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { spawn, fork, type ChildProcess } from "node:child_process";
import { gzipSync } from "node:zlib";
import { superviseNativeWorker } from "../src/release/native-supervisor.js";
import {
  withReleaseOperatorLock,
  provisionRelease,
} from "../src/release/provision.js";
import { recoverNativeSnapshots } from "../src/release/native-snapshot.js";
import {
  syntheticArchive,
  tar,
  sha256,
} from "./helpers/native-import-archive.js";

const workers = new Map<
  string,
  { child: ChildProcess; exited: Promise<unknown> }[]
>();
const entry = new URL("./helpers/native-owned-worker.ts", import.meta.url);
async function eventFile(state: string, name: string) {
  const path = join(state, name);
  let release!: () => void;
  const event = new Promise<void>((resolve) => {
    release = resolve;
  });
  const watcher = watch(state, (_type, file) => {
    if (file === name) release();
  });
  const timer = setTimeout(release, 5000);
  try {
    try {
      return await readFile(path, "utf8");
    } catch {}
    await event;
    return await readFile(path, "utf8");
  } finally {
    clearTimeout(timer);
    watcher.close();
  }
}
async function contender(state: string) {
  return withReleaseOperatorLock(state, async () => "entered").catch(
    (e) => e.message,
  );
}
async function lockFree(state: string) {
  const child = spawn("/usr/bin/flock", [
    "--exclusive",
    "--timeout",
    "5",
    join(state, "operator.lock"),
    "/usr/bin/true",
  ]);
  const [code] = await once(child, "close");
  assert.equal(code, 0, "owned work failed to release actual flock");
}
async function records(state: string) {
  try {
    return (await readFile(join(state, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  } catch (error: any) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
async function fixture(
  work: (r: any, f: ReturnType<typeof syntheticArchive>) => Promise<void>,
) {
  const state = await mkdtemp("/dev/shm/native-supervised-");
  const f = syntheticArchive(),
    archive = join(state, "original.tar.gz");
  await writeFile(archive, f.bytes);
  try {
    await work({ state, archive, manifest: f.m, inspection: f.inspection }, f);
  } finally {
    for (const name of [
      "open",
      "close",
      "close-failure",
      "destroy",
      "unlink",
      "copy",
      "copy-partial",
      "inspect",
      "child",
      "guardian",
    ])
      await writeFile(join(state, `release-${name}`), "test cleanup");
    for (const { child, exited } of workers.get(state) ?? []) {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
    }
    workers.delete(state);
    await rm(state, { recursive: true, force: true });
  }
}

test("production provisioning entry uses private worker and rejects malformed provenance before filesystem/daemon work", async () => {
  await assert.rejects(
    provisionRelease(
      {} as any,
      "/not-read",
      "/not-created",
      "/not-created",
      Buffer.from("{}"),
    ),
    /RELEASE_REJECTED/,
  );
});

test(
  "archive growth after signed-size stat hits the streaming hard cap before import",
  { timeout: 8000 },
  async () => {
    await fixture(async (r) => {
      const operation = launch({ ...r, hold: "copy" });
      const rejected = assert.rejects(
        operation,
        /RELEASE_IMAGE_IDENTITY_REJECTED/,
      );
      await eventFile(r.state, "event-copy");
      await appendFile(r.archive, Buffer.alloc(131072, 1));
      await writeFile(join(r.state, "release-copy"), "go");
      await rejected;
      assert.equal((await records(r.state)).length, 0);
      assert.deepEqual(
        (await readdir(r.state)).filter((n) => n.startsWith(".native-import-")),
        [],
      );
    });
  },
);

test(
  "cancellation after a real partial snapshot write owns cleanup and imports nothing",
  { timeout: 8000 },
  async (t) => {
    await fixture(async (r) => {
      const large = syntheticArchive({
        config: (c) => {
          c.config.Labels["unit.padding"] = randomBytes(100000).toString("hex");
        },
      });
      await writeFile(r.archive, large.bytes);
      const controller = new AbortController();
      const operation = launch(
        {
          ...r,
          manifest: large.m,
          inspection: large.inspection,
          hold: "copy-partial",
        },
        controller.signal,
      ).catch((e) => e.message);
      await eventFile(r.state, "event-copy-partial");
      const name = (await readdir(r.state)).find((n) =>
        n.startsWith(".native-import-"),
      )!;
      const written = (await stat(join(r.state, name, "image.tar.gz"))).size;
      assert.equal(written, 65536);
      assert.ok(written < large.bytes.length);
      controller.abort();
      assert.equal(await operation, "RELEASE_NATIVE_OWNERSHIP_RETAINED");
      assert.equal(await contender(r.state), "RELEASE_BUSY");
      await writeFile(join(r.state, "release-copy-partial"), "settle");
      await eventFile(r.state, "worker-exited");
      await lockFree(r.state);
      assert.equal((await records(r.state)).length, 0);
      assert.deepEqual(
        (await readdir(r.state)).filter((n) => n.startsWith(".native-import-")),
        [],
      );
      t.diagnostic(
        JSON.stringify({
          partialWrittenBytes: written,
          signedSize: large.bytes.length,
          imports: 0,
          snapshotRemoved: true,
        }),
      );
    });
  },
);

test(
  "CLI wrapper crash leaves worker lock retained even after the client later exits",
  { timeout: 8000 },
  async (t) => {
    await fixture(async (r) => {
      const controller = new AbortController();
      let worker!: ChildProcess;
      const operation = launch(
        { ...r, hold: "guardian-crash", swallow: true },
        controller.signal,
        (child) => {
          worker = child;
        },
      ).catch((e) => e.message);
      await eventFile(r.state, "event-guardian");
      await eventFile(r.state, "event-child");
      await writeFile(
        join(r.state, "release-guardian"),
        "kill exact owned wrapper",
      );
      controller.abort();
      assert.equal(await operation, "RELEASE_NATIVE_OWNERSHIP_RETAINED");
      assert.equal(await contender(r.state), "RELEASE_BUSY");
      await writeFile(join(r.state, "release-child"), "settle client");
      await eventFile(r.state, "cli-exited");
      assert.equal(await contender(r.state), "RELEASE_BUSY");
      worker.kill("SIGKILL");
      await workers.get(r.state)![0].exited;
      await lockFree(r.state);
      await withReleaseOperatorLock(r.state, () =>
        recoverNativeSnapshots(r.state),
      );
      t.diagnostic(
        "exact owned wrapper killed in fixture; worker retained uncertainty; test cleanup killed exact worker only after client exit event",
      );
    });
  },
);
function launch(
  r: any,
  signal?: AbortSignal,
  onSpawn?: (child: ChildProcess) => void,
) {
  return superviseNativeWorker(
    r,
    { signal, workMs: 5000, drainMs: 100 },
    {
      entry,
      onSpawn: (child) => {
        const owned = workers.get(r.state) ?? [];
        owned.push({ child, exited: once(child, "exit") });
        workers.set(r.state, owned);
        onSpawn?.(child);
      },
    },
  );
}

for (const change of ["replace", "in-place", "approved-plus-extra"]) {
  test(
    `P1 real worker ${change} during held inspection imports only signed snapshot`,
    { timeout: 8000 },
    async (t) => {
      await fixture(async (r, f) => {
        const operation = launch({ ...r, hold: "inspect" });
        await eventFile(r.state, "event-inspect");
        assert.equal(await contender(r.state), "RELEASE_BUSY");
        const entries = new Map(f.entries);
        entries.set("unapproved-extra", Buffer.from("unsigned"));
        const changed =
          change === "approved-plus-extra"
            ? gzipSync(tar(entries))
            : Buffer.from("unapproved replacement");
        if (change === "in-place") await writeFile(r.archive, changed);
        else {
          await writeFile(join(r.state, "replacement"), changed);
          await rename(join(r.state, "replacement"), r.archive);
        }
        await writeFile(join(r.state, "release-inspect"), "go");
        const result: any = await operation;
        assert.equal(result.selectedImage, f.inspection.Id);
        const calls = await records(r.state),
          loads = calls.filter((v) => v.op === "load");
        assert.equal(loads.length, 1);
        assert.equal(loads[0].hash, sha256(f.bytes));
        assert.notEqual(loads[0].path, r.archive);
        assert.equal(loads[0].mode, 0o400);
        assert.equal(loads[0].parentMode, 0o700);
        assert.deepEqual(
          (await readdir(r.state)).filter((n) =>
            n.startsWith(".native-import-"),
          ),
          [],
        );
        assert.equal(await contender(r.state), "entered");
        t.diagnostic(
          JSON.stringify({
            change,
            calls,
            snapshotRemoved: true,
            lockReleased: true,
          }),
        );
      });
    },
  );
}

for (const hold of [
  "open",
  "close",
  "close-failure",
  "destroy",
  "unlink",
  "copy",
]) {
  test(
    `P2 real worker ${hold}: finite parent error retains actual lock until settlement`,
    { timeout: 8000 },
    async (t) => {
      await fixture(async (r) => {
        const controller = new AbortController();
        let worker!: ChildProcess;
        const operation = launch({ ...r, hold }, controller.signal, (child) => {
          worker = child;
        }).then(
          (v) => ({ value: v }),
          (e) => ({ error: e.message, cleanup: e.cleanup }),
        );
        await eventFile(r.state, `event-${hold}`);
        assert.equal(await contender(r.state), "RELEASE_BUSY");
        controller.abort();
        const outcome = await operation;
        assert.deepEqual(outcome, {
          error: "RELEASE_NATIVE_OWNERSHIP_RETAINED",
          cleanup: "unconfirmed",
        });
        assert.equal(await contender(r.state), "RELEASE_BUSY");
        const calls = await records(r.state);
        if (hold !== "unlink") assert.equal(calls.length, 0);
        await writeFile(join(r.state, `release-${hold}`), "settle");
        if (hold === "close-failure") {
          await eventFile(r.state, "event-close-failed");
          assert.equal(await contender(r.state), "RELEASE_BUSY");
          // Test cleanup only: the exact live ChildProcess created by this test.
          // Production never retries failed close or reports it as settled.
          worker.kill("SIGKILL");
          await workers.get(r.state)![0].exited;
        } else await eventFile(r.state, "worker-exited");
        await lockFree(r.state);
        await withReleaseOperatorLock(r.state, () =>
          recoverNativeSnapshots(r.state),
        );
        assert.equal(await contender(r.state), "entered");
        assert.deepEqual(
          (await readdir(r.state)).filter((n) =>
            n.startsWith(".native-import-"),
          ),
          [],
        );
        t.diagnostic(
          JSON.stringify({
            hold,
            outcome,
            calls,
            cleanup: "settled-and-recovered",
            forcedTestCleanup: hold === "close-failure",
          }),
        );
      });
    },
  );
}

test(
  "lost load reply rejects, next worker reconciles exact identity without second import",
  { timeout: 8000 },
  async (t) => {
    await fixture(async (r) => {
      await assert.rejects(
        launch({ ...r, lostReply: true }),
        /RELEASE_CHILD_FAILED/,
      );
      await launch(r);
      const calls = await records(r.state);
      assert.equal(calls.filter((v) => v.op === "load").length, 1);
      assert.equal(await contender(r.state), "entered");
      t.diagnostic(JSON.stringify({ calls, loadCount: 1 }));
    });
  },
);

test(
  "worker crash during child import leaves duplicate flock until actual child exits",
  { timeout: 8000 },
  async (t) => {
    await fixture(async (r) => {
      let worker!: ChildProcess;
      const operation = launch({ ...r, hold: "child" }, undefined, (child) => {
        worker = child;
      }).catch((e) => e.message);
      await eventFile(r.state, "event-child");
      worker.kill("SIGKILL");
      assert.equal(await operation, "RELEASE_WORKER_EXIT_UNCONFIRMED");
      assert.equal(await contender(r.state), "RELEASE_BUSY");
      await writeFile(join(r.state, "release-child"), "settle");
      await lockFree(r.state);
      await withReleaseOperatorLock(r.state, () =>
        recoverNativeSnapshots(r.state),
      );
      assert.equal(
        (await records(r.state)).filter((v) => v.op === "load").length,
        1,
      );
      t.diagnostic(
        "worker killed through exact child handle; surviving CLI retained flock; released by CLI settlement; snapshot recovered",
      );
    });
  },
);

for (const earlyExit of [false, true]) {
  test(
    `supervisor ${earlyExit ? "exits unexpectedly" : "returns bounded retained error and exits"}: orphan worker cancels and drains`,
    { timeout: 8000 },
    async (t) => {
      await fixture(async (r) => {
        const parent = fork(
          new URL("./helpers/native-owned-parent.ts", import.meta.url),
          [JSON.stringify({ ...r, hold: "open" })],
          {
            execArgv: ["--import", "tsx"],
            stdio: ["ignore", "ignore", "ignore", "ipc"],
          },
        );
        const exit = once(parent, "close");
        await eventFile(r.state, "event-open");
        if (earlyExit) parent.send("exit-now");
        await exit;
        assert.equal(await contender(r.state), "RELEASE_BUSY");
        if (!earlyExit)
          assert.equal(
            await readFile(join(r.state, "parent-result"), "utf8"),
            "RELEASE_NATIVE_OWNERSHIP_RETAINED",
          );
        await writeFile(join(r.state, "release-open"), "settle");
        await eventFile(r.state, "worker-exited");
        await lockFree(r.state);
        assert.equal((await records(r.state)).length, 0);
        t.diagnostic(
          JSON.stringify({
            earlyExit,
            parentExited: true,
            orphanDrained: true,
            daemonCalls: 0,
          }),
        );
      });
    },
  );
}

for (const damage of ["oversize", "truncated", "wrong-hash"]) {
  test(
    `snapshot ${damage} performs zero CLI calls`,
    { timeout: 8000 },
    async () => {
      await fixture(async (r, f) => {
        const bytes =
          damage === "oversize"
            ? Buffer.concat([f.bytes, Buffer.from("extra")])
            : damage === "truncated"
              ? f.bytes.subarray(0, -1)
              : Buffer.from(f.bytes);
        if (damage === "wrong-hash") bytes[30] ^= 1;
        await writeFile(r.archive, bytes);
        await assert.rejects(launch(r), /RELEASE_IMAGE_IDENTITY_REJECTED/);
        assert.equal((await records(r.state)).length, 0);
        assert.deepEqual(
          (await readdir(r.state)).filter((n) =>
            n.startsWith(".native-import-"),
          ),
          [],
        );
      });
    },
  );
}
