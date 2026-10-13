import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeImage } from "../src/sandbox/artifact.js";
const revision = "a".repeat(40),
  fingerprint = "b".repeat(64),
  image = "sha256:" + "c".repeat(64);
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "engine-binding-"));
  const root = join(home, "app");
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(
    join(root, "dist/build.json"),
    JSON.stringify({ revision, fingerprint, protocol: 2 }),
  );
  await mkdir(join(home, "native-artifacts"), { mode: 0o700 });
  return { home, root };
}
const observation = () => ({
  stdout: JSON.stringify([
    {
      Id: image,
      Os: "linux",
      Architecture: "amd64",
      Config: {
        Labels: {
          "fit.kata.native.revision": revision,
          "fit.kata.native.fingerprint": fingerprint,
        },
      },
    },
  ]),
});
test("unknown or misplaced receipt engine refuses before any daemon effect", async () => {
  const { home, root } = await fixture();
  try {
    for (const engine of ["unknown", "bounded-v1", null, false, [], 0]) {
      await writeFile(
        join(home, "native-artifacts", revision + ".json"),
        JSON.stringify({
          revision,
          fingerprint,
          image,
          platform: "linux/amd64",
          engine,
        }),
        { mode: 0o600 },
      );
      let calls = 0;
      await assert.rejects(
        nativeImage(home, root, async () => {
          calls++;
          return observation();
        }),
      );
      assert.equal(calls, 0);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

import { readFile, readdir } from "node:fs/promises";
import {
  nativeBinding,
  nativeBindingForBuild,
  nativeBindingPreflight,
  drainNativePreflightCleanup,
  provisionArtifact,
} from "../src/sandbox/artifact.js";
import {
  nativeEngineSocket,
  nativeEngineHost,
  validateNativeEngineInstallation,
  withNativeEngineAuthorityFixture,
  nativeEngineInstallation,
} from "../src/sandbox/binding.js";
import {
  ensureNativeReleaseBinding,
  loadNativeReleaseImage,
} from "../src/release/provision.js";
import { NativeRuntime, cleanupNativeProbe } from "../src/sandbox/runtime.js";
import { CleanupRegistry } from "../src/autonomy/cleanup.js";
import {
  HeadlessCycleRuntime,
  HEADLESS_OWNER_LABEL,
} from "../src/autonomy/headless.js";
import {
  syntheticArchive,
  noSuchImage,
} from "./helpers/native-import-archive.js";
const approved = <T>(work: () => T) =>
  withNativeEngineAuthorityFixture(() => {}, work);
const bounded = { image, engine: "bounded-v1" as const };
async function receipt(
  home: string,
  engine: "legacy" | "bounded-v1",
  rev = revision,
  fp = fingerprint,
) {
  const folder = join(
    home,
    "native-artifacts",
    ...(engine === "legacy" ? [] : [engine]),
  );
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, rev + ".json");
  await writeFile(
    path,
    JSON.stringify({
      revision: rev,
      fingerprint: fp,
      image,
      platform: "linux/amd64",
      ...(engine === "legacy" ? {} : { engine }),
    }),
    { mode: 0o600 },
  );
  return path;
}
test("fixed installed mapping rejects unsafe authority, malformed shape and arbitrary endpoints", () => {
  const path = nativeEngineInstallation,
    socket = "/var/lib/katafit-bounded/store/run/docker.sock";
  function io(change: (x: any) => void = () => {}) {
    const state: any = {
      bytes: JSON.stringify({ "bounded-v1": socket }),
      file: {
        uid: 0,
        nlink: 1,
        mode: 0o100644,
        dev: 1,
        ino: 2,
        isFile: () => true,
        isSymbolicLink: () => false,
      },
      dir: {
        uid: 0,
        mode: 0o40755,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      },
      closed: 0,
    };
    change(state);
    return {
      state,
      fs: {
        lstatSync: (p: string) =>
          p === path
            ? { ...state.file, size: Buffer.byteLength(state.bytes) }
            : state.dir,
        openSync: (p: string) => {
          assert.equal(p, path);
          return 3;
        },
        fstatSync: () => ({
          ...state.file,
          size: Buffer.byteLength(state.bytes),
        }),
        readSync: (_fd: number, b: Buffer) => Buffer.from(state.bytes).copy(b),
        closeSync: () => {
          state.closed++;
        },
      } as any,
    };
  }
  const good = io();
  validateNativeEngineInstallation(good.fs);
  assert.equal(good.state.closed, 1);
  for (const change of [
    (x: any) => (x.file.uid = 1000),
    (x: any) => (x.file.nlink = 2),
    (x: any) => (x.file.mode |= 0o020),
    (x: any) => (x.file.isSymbolicLink = () => true),
    (x: any) => (x.dir.mode |= 0o002),
    (x: any) => (x.dir.uid = 1000),
    (x: any) => (x.dir.isSymbolicLink = () => true),
    (x: any) => (x.bytes = "[]"),
    (x: any) => (x.bytes = "null"),
    (x: any) =>
      (x.bytes = JSON.stringify({ "bounded-v1": "unix:///tmp/evil" })),
    (x: any) =>
      (x.bytes = JSON.stringify({ "bounded-v1": socket, legacy: socket })),
    (x: any) => (x.bytes = " ".repeat(257)),
  ])
    assert.throws(
      () => validateNativeEngineInstallation(io(change).fs),
      /INSTALLATION_REQUIRED/,
    );
  assert.equal(nativeEngineSocket("legacy"), "/var/run/docker.sock");
  assert.throws(() => nativeEngineSocket("unknown" as any), /ENGINE_INVALID/);
  assert.throws(
    () => nativeEngineSocket("bounded-v1"),
    /INSTALLATION_REQUIRED/,
  );
  approved(() => assert.equal(nativeEngineSocket("bounded-v1"), socket));
});
test("same image on both engines resolves only the exact protected engine; legacy API refuses bounded before inspect", () =>
  approved(async () => {
    const { home, root } = await fixture();
    try {
      const path = await receipt(home, "bounded-v1");
      let calls: string[][] = [];
      const inspect = async (_f: string, args: string[]) => {
        calls.push(args);
        return observation();
      };
      assert.deepEqual(await nativeBinding(home, root, inspect), bounded);
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], nativeEngineHost("bounded-v1"));
      calls = [];
      await assert.rejects(nativeImage(home, root, inspect));
      assert.equal(calls.length, 0);
      await receipt(home, "legacy");
      await assert.rejects(nativeBinding(home, root, inspect));
      assert.equal(calls.length, 0);
      await rm(path);
      assert.deepEqual(await nativeBinding(home, root, inspect), {
        image,
        engine: "legacy",
      });
      assert.equal(calls[0][0], nativeEngineHost("legacy"));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }));
test("bounded receipt namespace is invisible to frozen receipt scans and cannot shadow legacy active/rollback", () =>
  approved(async () => {
    const { home, root } = await fixture();
    try {
      const old = "d".repeat(40);
      await receipt(home, "legacy", old, "e".repeat(64));
      await receipt(home, "bounded-v1");
      await writeFile(
        join(home, "active.json"),
        JSON.stringify({ revision: old, image }),
        { mode: 0o600 },
      );
      const active = await readFile(join(home, "active.json"));
      const scan = (await readdir(join(home, "native-artifacts"))).filter((n) =>
        /^[a-f0-9]{40}\.json$/.test(n),
      );
      assert.deepEqual(scan, [old + ".json"]);
      const inspect = async (_f: string, args: string[]) => {
        const x = JSON.parse(observation().stdout);
        if (args[0] === nativeEngineHost("legacy")) {
          x[0].Config.Labels["fit.kata.native.revision"] = old;
          x[0].Config.Labels["fit.kata.native.fingerprint"] = "e".repeat(64);
        }
        return { stdout: JSON.stringify(x) };
      };
      assert.equal(
        (await nativeBinding(home, root, inspect)).engine,
        "bounded-v1",
      );
      assert.equal(
        (
          await nativeBindingForBuild(
            home,
            { revision: old, fingerprint: "e".repeat(64), protocol: 2 },
            inspect,
          )
        ).engine,
        "legacy",
      );
      assert.deepEqual(await readFile(join(home, "active.json")), active);
      await writeFile(
        join(home, "active.json"),
        JSON.stringify({ revision, image }),
        { mode: 0o600 },
      );
      let calls = 0;
      await assert.rejects(
        nativeBinding(home, root, async () => {
          calls++;
          return observation();
        }),
      );
      assert.equal(calls, 0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }));
test("same fingerprint reuse retains bounded image+engine and original bytes; ready mismatch is not reusable", () =>
  approved(async () => {
    const { home, root } = await fixture();
    try {
      const old = "d".repeat(40),
        path = await receipt(home, "bounded-v1", old),
        before = await readFile(path);
      let loads = 0,
        probes = 0;
      const inspect = async () => {
        const x = JSON.parse(observation().stdout);
        x[0].Config.Labels["fit.kata.native.revision"] = old;
        return { stdout: JSON.stringify(x) };
      };
      const choice = await ensureNativeReleaseBinding(
        home,
        root,
        "sha256:" + "f".repeat(64),
        async () => {
          loads++;
        },
        undefined,
        undefined,
        {
          inspect,
          probe: async () => {
            probes++;
            return bounded;
          },
        },
      );
      assert.equal(choice.engine, "bounded-v1");
      assert.equal(choice.selectedImage, image);
      assert.equal(choice.binding, "reused");
      assert.equal(loads, 0);
      assert.equal(probes, 1);
      await ensureNativeReleaseBinding(
        home,
        root,
        choice.publishedImage,
        async () => {
          loads++;
        },
        undefined,
        choice,
        {
          inspect,
          probe: async () => {
            probes++;
            return bounded;
          },
        },
      );
      assert.equal(probes, 1);
      assert.deepEqual(await readFile(path), before);
      await assert.rejects(
        ensureNativeReleaseBinding(
          home,
          root,
          choice.publishedImage,
          async () => {
            loads++;
          },
          undefined,
          { ...choice, engine: "legacy" },
          { inspect },
        ),
      );
      assert.equal(loads, 0);
      await assert.rejects(
        readFile(
          join(home, "native-artifacts", "bounded-v1", revision + ".json"),
        ),
        { code: "ENOENT" },
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }));
test("fresh provision stores only bounded receipt and validates exact readback; conflicting engine zero probe", () =>
  approved(async () => {
    const { home, root } = await fixture();
    try {
      let probes = 0,
        calls = 0;
      const inspect = async (_f: string, args: string[]) => {
        calls++;
        assert.equal(args[0], nativeEngineHost("bounded-v1"));
        return observation();
      };
      await provisionArtifact(home, root, image, {
        engine: "bounded-v1",
        inspect,
        probe: async () => {
          probes++;
          return bounded;
        },
      });
      assert.equal(probes, 1);
      assert.equal(calls, 2);
      assert.equal(
        JSON.parse(
          await readFile(
            join(home, "native-artifacts", "bounded-v1", revision + ".json"),
            "utf8",
          ),
        ).engine,
        "bounded-v1",
      );
      await assert.rejects(
        readFile(join(home, "native-artifacts", revision + ".json")),
        { code: "ENOENT" },
      );
      await assert.rejects(
        provisionArtifact(home, root, image, {
          engine: "unknown" as any,
          inspect,
          probe: async () => {
            probes++;
            return bounded;
          },
        }),
      );
      assert.equal(calls, 2);
      assert.equal(probes, 1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }));
test("verified archive load and lost-reply reconcile remain on bounded engine (synthetic archive/API)", () =>
  approved(async () => {
    const { home } = await fixture();
    try {
      const f = syntheticArchive(),
        path = join(home, "native.tar.gz");
      await writeFile(path, f.bytes);
      let loaded = false,
        loads = 0;
      const run = async (_file: string, args: string[]) => {
        assert.equal(args[0], nativeEngineHost("bounded-v1"));
        if (args[2] === "load") {
          loaded = true;
          loads++;
          throw Error("MOCK_LOST_REPLY");
        }
        if (args.at(-1) === f.m.image || !loaded)
          throw noSuchImage(args.at(-1)!);
        return { stdout: JSON.stringify([f.inspection]) };
      };
      await assert.rejects(
        loadNativeReleaseImage(f.m, path, run, { engine: "bounded-v1" }),
        /MOCK_LOST_REPLY/,
      );
      const binding = await loadNativeReleaseImage(f.m, path, run, {
        engine: "bounded-v1",
      });
      assert.equal(binding.engine, "bounded-v1");
      assert.equal(binding.selectedImage, f.inspection.Id);
      assert.equal(loads, 1);
      let calls = 0;
      await assert.rejects(
        loadNativeReleaseImage(
          f.m,
          path,
          async () => {
            calls++;
            throw Error("TRANSPORT");
          },
          { engine: "bounded-v1" },
        ),
        /TRANSPORT/,
      );
      assert.equal(calls, 1);
      assert.equal(loads, 1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }));
function ownership(engine?: any) {
  const token = "12345678-1234-4234-8234-123456789abc";
  return {
    protocol: 1 as const,
    name: "katafit-pi-probe-" + token,
    token,
    revision,
    fingerprint,
    image,
    labels: {
      "fit.kata.native.probe": "1",
      "fit.kata.native.probe-owner": token,
      "fit.kata.native.revision": revision,
      "fit.kata.native.fingerprint": fingerprint,
    },
    containerId: null,
    ...(engine === undefined ? {} : { engine }),
  };
}
test("restart probe cleanup uses record engine; unknown/mismatched engine has zero inspect/remove", () =>
  approved(async () => {
    const { home } = await fixture();
    try {
      const path = join(home, "native-probe-cleanup.json");
      let calls = 0;
      const probe = {
        engine: "bounded-v1" as const,
        async inspect() {
          calls++;
          return undefined;
        },
        async remove() {
          calls++;
        },
      };
      await writeFile(path, JSON.stringify(ownership("bounded-v1")), {
        mode: 0o600,
      });
      await assert.rejects(
        drainNativePreflightCleanup(home, {
          engine: { ...probe, engine: "legacy" },
        }),
      );
      assert.equal(calls, 0);
      await drainNativePreflightCleanup(home, { engine: probe });
      assert.equal(calls, 1);
      await assert.rejects(readFile(path), { code: "ENOENT" });
      for (const value of ["unknown", false, null, []]) {
        await writeFile(path, JSON.stringify(ownership(value)), {
          mode: 0o600,
        });
        await assert.rejects(
          drainNativePreflightCleanup(home, { engine: probe }),
        );
      }
      assert.equal(calls, 1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }));
test("autonomy restart registry selects per-record engine and retains mismatched cleanup", () =>
  approved(async () => {
    const { home } = await fixture();
    try {
      const owner = "1".repeat(32),
        registry = await CleanupRegistry.open(home, owner);
      const name = "katafit-pi-auto-12345678-1234-4234-8234-123456789abc";
      await registry.begin({
        name,
        image,
        engine: "bounded-v1",
        labels: { [HEADLESS_OWNER_LABEL]: owner },
      });
      await registry.end(name, false);
      const reopened = await CleanupRegistry.open(home, owner);
      let calls = 0;
      const probe = {
        async inspect() {
          calls++;
          return undefined;
        },
        async remove() {
          calls++;
        },
      };
      assert.equal(await reopened.drain(probe), 1);
      assert.equal(calls, 0);
      assert.equal(
        await reopened.drain((engine) => {
          assert.equal(engine, "bounded-v1");
          return { ...probe, engine };
        }),
        0,
      );
      assert.equal(calls, 1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }));
test("runtime and headless reject ownership/endpoint mismatch before commands", () =>
  approved(() => {
    let calls = 0;
    const exec = async () => {
      calls++;
      return { stdout: "" };
    };
    assert.throws(
      () =>
        new NativeRuntime(bounded, {
          exec,
          socketPath: "/var/run/docker.sock",
        }),
      /ENGINE_MISMATCH/,
    );
    assert.throws(
      () => new NativeRuntime(bounded, { exec, ownership: ownership() }),
      /ENGINE_MISMATCH/,
    );
    assert.throws(
      () =>
        new NativeRuntime(bounded, {
          exec,
          probeEngine: {
            async inspect() {
              calls++;
            },
            async remove() {
              calls++;
            },
          },
        }),
      /ENGINE_MISMATCH/,
    );
    assert.throws(
      () =>
        new HeadlessCycleRuntime({
          image: bounded,
          engine: { exec, socketPath: "/tmp/other" },
        }),
      /ENGINE_MISMATCH/,
    );
    assert.equal(calls, 0);
  }));

import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { NativeTerminal } from "../src/server/terminal.js";
import { productionRuntimes } from "../src/autonomy/host.js";
test("actual default preflight/NativeRuntime uses bounded version, create, HTTP, relay, inspect and cleanup (mocked API)", () =>
  approved(async () => {
    const { home, root } = await fixture();
    const previous = http.request;
    const commands: string[][] = [],
      requests: any[] = [];
    let relayKills = 0,
      relayStarts = 0;
    let captured: any;
    try {
      await receipt(home, "bounded-v1");
      // Mock the Node HTTP API itself, not an alternate daemon/socket. Every
      // request must still contain the actual fixed bounded socket.
      http.request = ((options: any) => {
        requests.push(options);
        assert.equal(options.socketPath, nativeEngineSocket("bounded-v1"));
        const req: any = new EventEmitter();
        req.destroy = (e: Error) => req.emit("error", e);
        req.end = () =>
          queueMicrotask(() => {
            if (options.headers?.Upgrade) {
              req.emit(
                "upgrade",
                {},
                new PassThrough(),
                Buffer.from("katafit-preflight"),
              );
              return;
            }
            const res: any = new PassThrough();
            res.statusCode = options.method === "GET" ? 404 : 204;
            req.emit("response", res);
            res.end();
          });
        return req;
      }) as any;
      syncBuiltinESMExports();
      const exec = async (_f: string, args: string[]) => {
        commands.push(args);
        assert.equal(args[0], nativeEngineHost("bounded-v1"));
        if (args.includes("version")) return { stdout: "1.52" };
        if (args.includes("create")) {
          captured = JSON.parse(
            await readFile(join(home, "native-probe-cleanup.json"), "utf8"),
          );
          assert.equal(captured.engine, "bounded-v1");
          return { stdout: "1".repeat(64) };
        }
        if (args[1] === "inspect")
          return {
            stdout: JSON.stringify([
              {
                Image: image,
                HostConfig: { NetworkMode: "none", ReadonlyRootfs: true },
                Config: { User: "1000:1000" },
                Mounts: [],
              },
            ]),
          };
        throw Error("UNEXPECTED_MOCK_COMMAND " + args.join(" "));
      };
      const spawn = (_f: string, args: string[]) => {
        relayStarts++;
        assert.equal(args[0], nativeEngineHost("bounded-v1"));
        assert.ok(args.includes("/opt/coach/sandbox/relay.mjs"));
        const child: any = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {
          relayKills++;
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          return true;
        };
        queueMicrotask(() =>
          child.stdout.write(
            JSON.stringify({ id: 1, request: { kind: "catalog" } }) + "\n",
          ),
        );
        return child;
      };
      assert.deepEqual(
        await nativeBindingPreflight(root, home, {
          inspect: async (_f, args) => {
            assert.equal(args[0], nativeEngineHost("bounded-v1"));
            return observation();
          },
          commands: { exec, spawn },
        }),
        bounded,
      );
      assert.equal(relayStarts, 1);
      assert.ok(relayKills >= 1);
      assert.ok(commands.some((a) => a.includes("create")));
      assert.ok(requests.some((r) => r.method === "GET"));
      await assert.rejects(readFile(join(home, "native-probe-cleanup.json")), {
        code: "ENOENT",
      });
    } finally {
      http.request = previous;
      syncBuiltinESMExports();
      await rm(home, { recursive: true, force: true });
    }
  }));
test("terminal constructor and actual autonomy factory preserve complete binding; sweep pins auxiliary commands", () =>
  approved(async () => {
    const runtime = (NativeTerminal.prototype as any).createRuntime.call(
      {},
      bounded,
    ) as NativeRuntime;
    assert.deepEqual(runtime.binding, bounded);
    await runtime.stop();
    const { home } = await fixture();
    try {
      const owner = "2".repeat(32),
        cleanup = await CleanupRegistry.open(home, owner),
        commands: string[][] = [];
      const runtimes = await productionRuntimes(home, {
        owner,
        cleanup,
        image: async () => bounded,
        engine: {
          exec: async (_f, args) => {
            commands.push(args);
            return { stdout: "" };
          },
        },
      });
      for (const r of [runtimes.planner, runtimes.composer])
        assert.deepEqual((r as HeadlessCycleRuntime).binding, bounded);
      assert.ok(commands.length > 0);
      assert.ok(
        commands.every((args) => args[0] === nativeEngineHost("bounded-v1")),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }));
test("all product image consumers use binding APIs; image-only compatibility is confined to explicit wrappers", async () => {
  for (const file of [
    "src/server/terminal.ts",
    "src/autonomy/host.ts",
    "src/runtime/isolatedInvocation.ts",
    "src/release/provision.ts",
    "src/update/supervisor.ts",
  ]) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /\bnativeImage(?:ForBuild)?\b/);
    assert.match(source, /nativeBinding/);
  }
  const runtime = await readFile("src/autonomy/headless.ts", "utf8");
  assert.match(runtime, /new NativeRuntime\(this.binding/);
  assert.doesNotMatch(runtime, /\/var\/run\/docker.sock/);
});
import { nativeImageForBuild as frozenNativeImageForBuild } from "./fixtures/engine-binding-legacy-reader.js";
test("actual frozen 7c9088 lookup refuses bounded-only receipt even when default daemon has the same image", () =>
  approved(async () => {
    const { home } = await fixture();
    try {
      await receipt(home, "bounded-v1");
      let calls = 0;
      const inspect = async () => {
        calls++;
        return observation();
      };
      await assert.rejects(
        frozenNativeImageForBuild(
          home,
          { protocol: 2, revision, fingerprint },
          inspect,
        ),
      );
      assert.equal(calls, 0);
      await rm(join(home, "native-artifacts", "bounded-v1"), {
        recursive: true,
      });
      await receipt(home, "legacy");
      assert.equal(
        await frozenNativeImageForBuild(
          home,
          { protocol: 2, revision, fingerprint },
          inspect,
        ),
        image,
      );
      assert.equal(calls, 1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }));
test("unsafe bounded receipt directory cannot turn failed authority into permission to load", async () => {
  const { home, root } = await fixture();
  try {
    const { symlink } = await import("node:fs/promises");
    const empty = join(home, "empty");
    await mkdir(empty);
    await symlink(empty, join(home, "native-artifacts", "bounded-v1"));
    let loads = 0,
      inspects = 0;
    await assert.rejects(
      ensureNativeReleaseBinding(
        home,
        root,
        image,
        async () => {
          loads++;
          throw Error("MOCK_LOAD_MUST_NOT_RUN");
        },
        undefined,
        undefined,
        {
          inspect: async () => {
            inspects++;
            return observation();
          },
        },
      ),
    );
    assert.equal(loads, 0);
    assert.equal(inspects, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
