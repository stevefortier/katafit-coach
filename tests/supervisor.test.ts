import { test } from "node:test";
import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "../src/config/store.js";
import { AutoUpdateSetting } from "../src/update/auto.js";
import {
  activateLegacyFixture,
  supervise,
} from "./helpers/legacy-supervisor.js";

// Launchers persist only the original key set; the reason lives in a sidecar.
const legacyOperation = ({
  reason: _reason,
  ...rest
}: { reason?: unknown } & Record<string, unknown>) => rest;

test("failed and interrupted accepted operations retain durable outcome across restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-outcome-"));
  const store = new Store(home);
  await store.init();
  let owner = await supervise(store, 0, undefined, {
    prepare: async () => {
      throw new Error("fixture");
    },
  });
  try {
    owner.updates.latest = "7".repeat(40);
    owner.updates.checkedAt = Date.now();
    await assert.rejects(owner.updates.apply(owner.updates.latest));
    const outcome = owner.updates.snapshot().lastOperation;
    assert.equal(outcome?.state, "failed");
    assert.equal(outcome?.sha, "7".repeat(40));
    await owner.close();
    owner = await supervise(store, 0);
    assert.deepEqual(owner.updates.snapshot().lastOperation, outcome);
    await owner.close();
    await writeFile(
      join(home, "update-operation.json"),
      JSON.stringify({ ...legacyOperation(outcome!), state: "applying" }),
    );
    owner = await supervise(store, 0);
    assert.equal(owner.updates.snapshot().lastOperation?.state, "interrupted");
  } finally {
    await owner.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("runtime death during failed preparation releases owner after operation settles", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-stage-crash-"));
  const store = new Store(home);
  await store.init();
  let shutdown = false,
    rejectStage!: (e: Error) => void;
  const owner = await supervise(
    store,
    0,
    () => {
      shutdown = true;
    },
    {
      prepare: () =>
        new Promise((_, reject) => {
          rejectStage = reject;
        }),
    },
  );
  try {
    owner.updates.latest = "e".repeat(40);
    owner.updates.checkedAt = Date.now();
    const apply = owner.updates.apply(owner.updates.latest);
    const failed = assert.rejects(apply, /UPGRADE_FAILED/);
    await owner.updates.accepted;
    process.kill(owner.pid!, "SIGKILL");
    await new Promise((r) => setTimeout(r, 100));
    rejectStage(new Error("stage failure"));
    await failed;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(shutdown, true);
  } finally {
    await owner.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("activation rollback never replays an older native probe cleanup receipt", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-probe-receipt-rollback-"));
  const store = new Store(home);
  await store.init();
  await activateLegacyFixture(home);
  const target = "a".repeat(40);
  const candidate = join(home, "versions", target);
  const receipt = join(home, "native-probe-cleanup.json");
  let candidatePreflights = 0;
  const prepare = async () => {
    await mkdir(join(candidate, "dist/config"), { recursive: true });
    await mkdir(join(candidate, "dist/server"), { recursive: true });
    await writeFile(join(candidate, "package.json"), '{"type":"module"}');
    await writeFile(
      join(candidate, "dist/build.json"),
      JSON.stringify({ revision: target, protocol: 1 }),
    );
    await writeFile(
      join(candidate, "dist/config/store.js"),
      `export {Store} from ${JSON.stringify(pathToFileURL(resolve("dist/config/store.js")).href)};`,
    );
    await writeFile(
      join(candidate, "dist/server/admin.js"),
      `export {admin, updatePreparationProtocol} from ${JSON.stringify(pathToFileURL(resolve("dist/server/admin.js")).href)};`,
    );
    return candidate;
  };
  const owner = await supervise(store, 0, undefined, {
    prepare,
    preflight: async (root) => {
      if (root !== candidate) return undefined;
      candidatePreflights++;
      if (candidatePreflights === 1) {
        await writeFile(receipt, '{"generation":"before-snapshot"}\n');
        return undefined;
      }
      await writeFile(receipt, '{"generation":"live-failed-cleanup"}\n');
      throw new Error("synthetic candidate startup failure");
    },
  });
  try {
    owner.updates.latest = target;
    owner.updates.checkedAt = Date.now();
    await assert.rejects(owner.updates.apply(target), /UPGRADE_FAILED/);
    assert.equal(
      candidatePreflights,
      2,
      "candidate reached activation preflight",
    );
    assert.deepEqual(JSON.parse(await readFile(receipt, "utf8")), {
      generation: "live-failed-cleanup",
    });
  } finally {
    await rm(receipt, { force: true });
    await owner.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("owner shutdown aborts and awaits in-flight candidate preparation", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-stage-shutdown-"));
  const store = new Store(home);
  await store.init();
  let entered!: () => void;
  let finish!: () => void;
  let aborted = false;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const stopped = new Promise<void>((resolve) => (finish = resolve));
  const owner = await supervise(store, 0, undefined, {
    prepare: async (_sha, signal) => {
      entered();
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      await stopped;
      signal.throwIfAborted();
      throw new Error("fixture should be aborted");
    },
  });
  try {
    owner.updates.latest = "a".repeat(40);
    owner.updates.checkedAt = Date.now();
    const applying = owner.updates.apply(owner.updates.latest);
    await started;
    let closed = false;
    const closing = owner.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(aborted, true);
    assert.equal(closed, false, "shutdown awaits stable-owner preparation");
    finish();
    await closing;
    await assert.rejects(applying, /UPGRADE_FAILED/);
  } finally {
    finish();
    await owner.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("owner shutdown drains retained native preflight cleanup", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-native-drain-shutdown-"));
  const store = new Store(home);
  await store.init();
  const root = join(home, "native-candidate");
  const revision = "a".repeat(40);
  const fingerprint = "b".repeat(64);
  const image = "sha256:" + "c".repeat(64);
  const architecture = process.arch === "arm64" ? "arm64" : "amd64";
  let stops = 0;
  let owner: Awaited<ReturnType<typeof supervise>> | undefined;
  try {
    await mkdir(join(root, "dist"), { recursive: true });
    await mkdir(join(home, "native-artifacts"));
    await writeFile(
      join(root, "dist/build.json"),
      JSON.stringify({ revision, protocol: 2, fingerprint }),
    );
    await writeFile(
      join(home, "native-artifacts", revision + ".json"),
      JSON.stringify({
        revision,
        fingerprint,
        image,
        platform: `linux/${architecture}`,
      }),
    );
    const inspect = async () => ({
      stdout: JSON.stringify([
        {
          Id: image,
          Os: "linux",
          Architecture: architecture,
          Config: {
            Labels: {
              "fit.kata.native.revision": revision,
              "fit.kata.native.fingerprint": fingerprint,
            },
          },
        },
      ]),
    });
    const runtime = {
      onOutput: (_chunk: string) => {},
      async start(session: any) {
        runtime.onOutput((await session.handle({ kind: "catalog" })).model);
      },
      async attach() {},
      async inspect() {
        return {
          Image: image,
          HostConfig: { NetworkMode: "none", ReadonlyRootfs: true },
          Config: { User: "1000:1000" },
          Mounts: [],
        };
      },
      async stop() {
        if (++stops < 3) throw new Error("synthetic cleanup failure");
      },
    };
    const { nativePreflight } = await import("../src/sandbox/artifact.js");
    await assert.rejects(
      nativePreflight(root, home, { inspect, runtime: () => runtime }),
      /EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED/,
    );
    await activateLegacyFixture(home);
    const { supervise: currentSupervise } = await import(
      "../src/update/supervisor.js"
    );
    owner = await currentSupervise(store, 0);
    const pid = owner.pid;
    assert.equal(await owner.close(), false);
    assert.equal(stops, 2, "graceful owner close retries retained cleanup");
    assert.equal(owner.pid, pid, "failed drain keeps the owner child alive");
    assert.equal(owner.updates.snapshot().cleanupWarning, true);
    assert.equal(await owner.close(), true);
    assert.equal(
      stops,
      3,
      "a later bounded shutdown drains retained ownership",
    );
  } finally {
    await owner?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("failed staged deletion is retained and drained before same-SHA retry", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-stage-cleanup-retry-"));
  const store = new Store(home);
  await store.init();
  const target = "a".repeat(40);
  const candidate = join(home, "versions", target);
  const currentAdmin = pathToFileURL(resolve("dist/server/admin.js")).href;
  const currentStore = pathToFileURL(resolve("dist/config/store.js")).href;
  let preparations = 0;
  let firstPreflight = true;
  const prepare = async () => {
    preparations++;
    await access(candidate).then(
      () => {
        throw new Error("synthetic destination exists");
      },
      () => {},
    );
    await mkdir(join(candidate, "dist/config"), { recursive: true });
    await mkdir(join(candidate, "dist/server"), { recursive: true });
    await writeFile(join(candidate, "package.json"), '{"type":"module"}');
    await writeFile(
      join(candidate, "dist/build.json"),
      JSON.stringify({ revision: target, protocol: 1 }),
    );
    await writeFile(
      join(candidate, "dist/config/store.js"),
      `export {Store} from ${JSON.stringify(currentStore)};`,
    );
    await writeFile(
      join(candidate, "dist/server/admin.js"),
      `export {admin, updatePreparationProtocol} from ${JSON.stringify(currentAdmin)};`,
    );
    return candidate;
  };
  const owner = await supervise(store, 0, undefined, {
    prepare,
    preflight: async (root) => {
      if (root === candidate && firstPreflight) {
        firstPreflight = false;
        await chmod(join(candidate, "dist"), 0o500);
        await chmod(candidate, 0o500);
        await chmod(join(home, "versions"), 0o500);
        throw new Error("EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED");
      }
      return undefined;
    },
  });
  try {
    owner.updates.latest = target;
    owner.updates.checkedAt = Date.now();
    await assert.rejects(owner.updates.apply(target), /UPGRADE_FAILED/);
    assert.equal(owner.updates.snapshot().cleanupWarning, true);
    assert.match(owner.updates.snapshot().guidance, /cleanup is incomplete/i);
    await chmod(join(home, "versions"), 0o700);
    await chmod(candidate, 0o700);
    await chmod(join(candidate, "dist"), 0o700);
    owner.updates.checkedAt = Date.now();
    await owner.updates.apply(target);
    assert.equal(preparations, 2);
    assert.equal(owner.updates.installed, target);
  } finally {
    await chmod(join(home, "versions"), 0o700).catch(() => {});
    await chmod(candidate, 0o700).catch(() => {});
    await chmod(join(candidate, "dist"), 0o700).catch(() => {});
    await owner.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("new owner explicitly supports stopped legacy admin but withholds running capability", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-new-owner-legacy-admin-"));
  const store = new Store(home);
  await store.init();
  const initial = "1".repeat(40);
  let latest = "a".repeat(40);
  const currentStore = pathToFileURL(resolve("dist/config/store.js")).href;
  const legacyAdmin = `
    import {createServer} from "node:http";
    export async function admin(store, port = 0, _infer, _shutdown, updates) {
      let state = "stopped";
      const server = createServer(async (request, response) => {
        const send = (status, value) => {
          response.writeHead(status, {"Content-Type":"application/json"});
          response.end(JSON.stringify(value));
        };
        if (request.method === "GET" && request.url === "/api/status")
          return send(200, {state, safeToReplace:true, stopConfirmed:true});
        let raw = "";
        for await (const chunk of request) raw += chunk;
        const body = raw ? JSON.parse(raw) : {};
        if (request.url === "/api/run") { state = "idle"; return send(200, {ok:true}); }
        if (request.url === "/api/update/check") {
          await updates.check();
          return send(200, updates.snapshot());
        }
        if (request.url === "/api/update/apply") {
          try { updates.validate(body.sha); }
          catch (error) { return send(400, {error:error.message}); }
          const wasRunning = state !== "stopped";
          if (wasRunning && !updates.snapshot().manualRestartSupported)
            return send(409, {error:"LAUNCHER_UPGRADE_REQUIRED"});
          if (wasRunning) state = "stopped";
          void updates.apply(body.sha).catch(() => {});
          try { await updates.accepted; }
          catch { return send(503, {error:"UPDATE_NOT_ACCEPTED"}); }
          return send(202, {ok:true});
        }
        send(404, {error:"NOT_FOUND"});
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      const origin = "http://127.0.0.1:" + server.address().port;
      return {origin, async close(){server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}};
    }
  `;
  const writeCandidate = async (revision: string) => {
    const root = join(home, "versions", revision);
    await mkdir(join(root, "dist/config"), { recursive: true });
    await mkdir(join(root, "dist/server"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(
      join(root, "dist/build.json"),
      JSON.stringify({ revision, protocol: 1 }),
    );
    await writeFile(
      join(root, "dist/config/store.js"),
      `export {Store} from ${JSON.stringify(currentStore)};`,
    );
    await writeFile(join(root, "dist/server/admin.js"), legacyAdmin);
    return root;
  };
  await writeCandidate(initial);
  await writeFile(
    join(home, "active.json"),
    JSON.stringify({ revision: initial }),
  );
  const { supervise: currentSupervise } = await import(
    "../src/update/supervisor.js"
  );
  const owner = await currentSupervise(store, 0, undefined, {
    prepare: writeCandidate,
    request: async () =>
      new Response(JSON.stringify({ object: { sha: latest } })),
  });
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: owner.origin,
    "Content-Type": "application/json",
  };
  const post = (path: string, body: unknown = {}) =>
    fetch(owner.origin + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post("/api/update/check")).status, 200);
    assert.equal(
      (
        await post("/api/update/apply", {
          sha: latest,
          confirm: true,
        })
      ).status,
      202,
      "stopped legacy admin uses owner-side lazy preparation",
    );
    for (
      let attempt = 0;
      attempt < 200 &&
      (owner.updates.installed !== latest || owner.updates.applying);
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(owner.updates.installed, latest);
    assert.equal(owner.updates.applying, false);

    const installed = latest;
    latest = "b".repeat(40);
    owner.updates.checkedAt = 0;
    assert.equal((await post("/api/update/check")).status, 200);
    assert.equal((await post("/api/run")).status, 200);
    const rejected = await post("/api/update/apply", {
      sha: latest,
      confirm: true,
    });
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).error, "LAUNCHER_UPGRADE_REQUIRED");
    assert.equal(owner.updates.installed, installed);
    assert.equal(
      (await (await fetch(owner.origin + "/api/status", { headers })).json())
        .state,
      "idle",
      "legacy running worker was not silently stopped",
    );
  } finally {
    await owner.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("auto post-prepare failures release their prepared reservations", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-auto-accept-release-"));
  const store = new Store(home);
  await store.init();
  let latest = "a".repeat(40);
  const consentFailure = latest;
  const acceptanceFailure = "b".repeat(40);
  const success = "d".repeat(40);
  const prepared: string[] = [];
  const currentAdmin = pathToFileURL(resolve("dist/server/admin.js")).href;
  const currentStore = pathToFileURL(resolve("dist/config/store.js")).href;
  const prepare = async (target: string) => {
    prepared.push(target);
    const root = join(home, "versions", target);
    await mkdir(join(root, "dist/config"), { recursive: true });
    await mkdir(join(root, "dist/server"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(
      join(root, "dist/build.json"),
      JSON.stringify({ revision: target, protocol: 1 }),
    );
    await writeFile(
      join(root, "dist/config/store.js"),
      `export {Store} from ${JSON.stringify(currentStore)};`,
    );
    await writeFile(
      join(root, "dist/server/admin.js"),
      `export {admin, updatePreparationProtocol} from ${JSON.stringify(currentAdmin)};`,
    );
    if (target === consentFailure)
      await writeFile(join(home, "auto-update.json"), "{invalid");
    if (target === acceptanceFailure)
      await mkdir(join(home, "update-operation.json"), { recursive: true });
    return root;
  };
  const owner = await supervise(store, 0, undefined, {
    prepare,
    request: async (url) =>
      new Response(
        JSON.stringify(
          String(url).includes("/compare/")
            ? { status: "ahead", ahead_by: 1 }
            : { object: { sha: latest } },
        ),
      ),
  });
  try {
    owner.updates.installed = "c".repeat(40);
    await new AutoUpdateSetting(home).write(true);
    await assert.rejects(owner.auto.tick());
    await assert.rejects(access(join(home, "versions", consentFailure)), {
      code: "ENOENT",
    });
    await writeFile(join(home, "auto-update.json"), '{"enabled":true}');
    latest = acceptanceFailure;
    owner.updates.checkedAt = 0;
    await assert.rejects(owner.auto.tick());
    await assert.rejects(access(join(home, "versions", acceptanceFailure)), {
      code: "ENOENT",
    });
    await rm(join(home, "update-operation.json"), {
      recursive: true,
      force: true,
    });
    latest = success;
    owner.updates.checkedAt = 0;
    await owner.auto.tick();
    assert.deepEqual(prepared, [consentFailure, acceptanceFailure, success]);
    assert.equal(owner.updates.installed, success);
  } finally {
    await owner.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("initial active native preflight drains retained cleanup before supervise rejects", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-initial-native-cleanup-"));
  const store = new Store(home);
  await store.init();
  const revision = "a".repeat(40);
  const fingerprint = "b".repeat(64);
  const image = "sha256:" + "c".repeat(64);
  const architecture = process.arch === "arm64" ? "arm64" : "amd64";
  const activeRoot = join(home, "versions", revision);
  const currentAdmin = pathToFileURL(resolve("dist/server/admin.js")).href;
  const currentStore = pathToFileURL(resolve("dist/config/store.js")).href;
  let stops = 0;
  try {
    await mkdir(join(activeRoot, "dist/config"), { recursive: true });
    await mkdir(join(activeRoot, "dist/server"), { recursive: true });
    await mkdir(join(home, "native-artifacts"));
    await writeFile(join(activeRoot, "package.json"), '{"type":"module"}');
    await writeFile(
      join(activeRoot, "dist/build.json"),
      JSON.stringify({ revision, protocol: 2, fingerprint }),
    );
    await writeFile(
      join(activeRoot, "dist/config/store.js"),
      `export {Store} from ${JSON.stringify(currentStore)};`,
    );
    await writeFile(
      join(activeRoot, "dist/server/admin.js"),
      `export {admin, updatePreparationProtocol} from ${JSON.stringify(currentAdmin)};`,
    );
    await writeFile(
      join(home, "active.json"),
      JSON.stringify({ revision, image }),
    );
    await writeFile(
      join(home, "native-artifacts", revision + ".json"),
      JSON.stringify({
        revision,
        fingerprint,
        image,
        platform: `linux/${architecture}`,
      }),
    );
    const inspect = async () => ({
      stdout: JSON.stringify([
        {
          Id: image,
          Os: "linux",
          Architecture: architecture,
          Config: {
            Labels: {
              "fit.kata.native.revision": revision,
              "fit.kata.native.fingerprint": fingerprint,
            },
          },
        },
      ]),
    });
    const runtime = {
      onOutput: (_chunk: string) => {},
      async start(session: any) {
        runtime.onOutput((await session.handle({ kind: "catalog" })).model);
      },
      async attach() {},
      async inspect() {
        return {
          Image: image,
          HostConfig: { NetworkMode: "none", ReadonlyRootfs: true },
          Config: { User: "1000:1000" },
          Mounts: [],
        };
      },
      async stop() {
        if (++stops === 1) throw new Error("synthetic cleanup failure");
      },
    };
    const { nativePreflight } = await import("../src/sandbox/artifact.js");
    const { supervise: currentSupervise } = await import(
      "../src/update/supervisor.js"
    );
    await assert.rejects(
      currentSupervise(store, 0, undefined, {
        preflight: (root, targetHome, signal) =>
          nativePreflight(root, targetHome, {
            inspect,
            runtime: () => runtime,
            signal,
          }),
      }),
      /EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED/,
    );
    assert.equal(stops, 2, "startup rejection drains the retained probe");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("managed child reports explicitly disabled updates", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-disabled-"));
  const store = new Store(home);
  await store.init();
  process.env.KATAFIT_COACH_UPDATES = "disabled";
  let owner: Awaited<ReturnType<typeof supervise>> | undefined;
  try {
    owner = await supervise(store, 0);
    const state = await (
      await fetch(owner.origin + "/api/update", {
        headers: { Authorization: "Bearer " + store.secrets.admin },
      })
    ).json();
    assert.equal(state.supported, false);
  } finally {
    delete process.env.KATAFIT_COACH_UPDATES;
    await owner?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("preparation cleanup never removes the active runtime directory", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-active-cleanup-"));
  const store = new Store(home);
  await store.init();
  await activateLegacyFixture(home);
  const activeRevision = "1".repeat(40);
  const activeRoot = join(home, "versions", activeRevision);
  const owner = await supervise(store, 0, undefined, {
    prepare: async () => activeRoot,
  });
  try {
    const target = "a".repeat(40);
    owner.updates.latest = target;
    owner.updates.checkedAt = Date.now();
    const pid = owner.pid;
    await assert.rejects(owner.updates.apply(target), /UPGRADE_FAILED/);
    assert.equal(owner.pid, pid);
    assert.equal(
      JSON.parse(await readFile(join(home, "active.json"), "utf8")).revision,
      activeRevision,
    );
    assert.equal(
      JSON.parse(await readFile(join(activeRoot, "dist/build.json"), "utf8"))
        .revision,
      activeRevision,
    );
  } finally {
    await owner.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("stable owner validates isolated candidate, switches same port and rolls back failed activation preserving data", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-supervisor-"));
  const store = new Store(home);
  await store.init();
  const secrets = await readFile(join(home, "secrets.json"), "utf8");
  const original = pathToFileURL(resolve("dist/server/admin.js")).href;
  const sha = "c".repeat(40),
    bad = "d".repeat(40),
    badStore = "f".repeat(40),
    delayed = "9".repeat(40),
    native = "8".repeat(40);
  const prepare = async (target: string) => {
    const root = join(home, "versions", target);
    await mkdir(join(root, "dist/server"), { recursive: true });
    await mkdir(join(root, "dist/config"), { recursive: true });
    await writeFile(
      join(root, "dist/config/store.js"),
      target === badStore
        ? `export class Store {constructor(){throw Error('incompatible Store');}}`
        : `export {Store} from ${JSON.stringify(pathToFileURL(resolve("dist/config/store.js")).href)};`,
    );
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(
      join(root, "dist/build.json"),
      JSON.stringify({
        revision: target,
        protocol: target === native ? 2 : 1,
        ...(target === native ? { fingerprint: "b".repeat(64) } : {}),
      }),
    );
    await writeFile(
      join(root, "dist/server/admin.js"),
      `import {admin as base} from ${JSON.stringify(original)}; export {updatePreparationProtocol} from ${JSON.stringify(original)}; export async function admin(...args){${target === bad ? `if(args[0].dir===${JSON.stringify(home)}) throw Error('bad startup');` : ""}${target === delayed ? `if(args[0].dir===${JSON.stringify(home)}) setTimeout(()=>process.exit(8),150);` : ""} return base(...args);}`,
    );
    return root;
  };
  let owner: Awaited<ReturnType<typeof supervise>> | undefined;
  try {
    let cleanupCalls = 0;
    owner = await supervise(store, 0, undefined, {
      prepare,
      housekeeping: async () => {
        cleanupCalls++;
        throw new Error("fixture cleanup error");
      },
      request: async () => new Response(JSON.stringify({ object: { sha } })),
    });
    const origin = owner.origin;
    const firstPid = owner.pid;
    assert.ok(Number.isInteger(firstPid));
    assert.notEqual(firstPid, process.pid);
    const auth = {
      Authorization: "Bearer " + store.secrets.admin,
      Origin: origin,
      "Content-Type": "application/json",
    };
    const before = await readFile(join(home, "config.json"), "utf8");
    await owner.updates.check();
    await owner.updates.apply(sha);
    assert.equal(cleanupCalls, 1);
    assert.equal(owner.updates.snapshot().lastOperation?.state, "succeeded");
    assert.match(owner.updates.snapshot().guidance, /cleanup/i);
    assert.equal(owner.origin, origin);
    assert.notEqual(owner.pid, firstPid);
    assert.throws(() => process.kill(firstPid!, 0));
    assert.equal(
      JSON.parse(await readFile(join(home, "service.json"), "utf8")).runtimePid,
      owner.pid,
    );
    assert.equal(
      (await fetch(origin + "/api/status", { headers: auth })).status,
      200,
    );
    assert.equal(
      JSON.parse(await readFile(join(home, "active.json"), "utf8")).revision,
      sha,
    );
    const healthyPid = owner.pid;
    owner.updates.latest = native;
    owner.updates.checkedAt = Date.now();
    await assert.rejects(owner.updates.apply(native), /UPGRADE_FAILED/);
    assert.equal(
      owner.pid,
      healthyPid,
      "missing native artifact must not stop old child",
    );
    assert.match(owner.updates.guidance, /external artifact.*bootstrap/i);
    owner.updates.latest = badStore;
    owner.updates.checkedAt = Date.now();
    await assert.rejects(owner.updates.apply(badStore), /UPGRADE_FAILED/);
    assert.equal(
      owner.pid,
      healthyPid,
      "candidate Store must be probed before stopping live child",
    );
    owner.updates.latest = delayed;
    owner.updates.checkedAt = Date.now();
    await assert.rejects(owner.updates.apply(delayed), /UPGRADE_FAILED/);
    assert.equal(owner.updates.installed, sha);
    owner.updates.latest = bad;
    owner.updates.checkedAt = Date.now();
    await assert.rejects(owner.updates.apply(bad), /UPGRADE_FAILED/);
    assert.equal(
      JSON.parse(await readFile(join(home, "active.json"), "utf8")).revision,
      sha,
    );
    assert.equal(owner.updates.installed, sha);
    assert.equal(
      (await fetch(origin + "/api/status", { headers: auth })).status,
      200,
    );
    assert.equal(await readFile(join(home, "config.json"), "utf8"), before);
    assert.equal(await readFile(join(home, "secrets.json"), "utf8"), secrets);
  } finally {
    await owner?.close();
    await rm(home, { recursive: true, force: true });
  }
});
