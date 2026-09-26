import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "../src/config/store.js";
import { supervise } from "./helpers/legacy-supervisor.js";

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
      `import {admin as base} from ${JSON.stringify(original)}; export async function admin(...args){${target === bad ? `if(args[0].dir===${JSON.stringify(home)}) throw Error('bad startup');` : ""}${target === delayed ? `if(args[0].dir===${JSON.stringify(home)}) setTimeout(()=>process.exit(8),150);` : ""} return base(...args);}`,
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
