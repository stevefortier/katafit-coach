import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "../src/worker/runner.js";
import { taskFixture } from "./task-fixtures.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { Updates } from "../src/update/updates.js";
import { AutoUpdateSetting } from "../src/update/auto.js";
import { NativeTerminal } from "../src/server/terminal.js";
import { setTimeout as sleep } from "node:timers/promises";

test("manual update excludes an in-flight claim and fences late claims and native admission", async () => {
  let holdClaim = false;
  let entered!: () => void, release!: () => void;
  const claimEntered = new Promise<void>((r) => (entered = r));
  const claimGate = new Promise<void>((r) => (release = r));
  const f = await taskFixture({
    onClaimTask: async () => {
      if (holdClaim) {
        entered();
        await claimGate;
      }
    },
  });
  const home = await mkdtemp(tmpdir() + "/update-claim-fence-");
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
    apiKey: "synthetic-key",
  });
  const updates = new Updates("a".repeat(40), async () => {});
  updates.latest = "b".repeat(40);
  updates.checkedAt = Date.now();
  updates.manualRestartSupported = true;
  const start = Worker.prototype.start,
    stopNative = NativeTerminal.prototype.stop;
  let owned!: Worker;
  Worker.prototype.start = function () {
    owned = this;
    (this as any).options.pollMs = 100000;
    return start.call(this);
  };
  const app = await admin(store, 0, undefined, undefined, updates);
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  const post = (path: string, body = {}) =>
    fetch(app.origin + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  let releaseStop!: () => void, enterStop!: () => void;
  const stopEntered = new Promise<void>((r) => (enterStop = r)),
    stopGate = new Promise<void>((r) => (releaseStop = r));
  let applying: Promise<Response> | undefined;
  try {
    await post("/api/run");
    for (let i = 0; i < 100 && owned.state !== "idle"; i++) await sleep(10);
    holdClaim = true;
    const polling = owned.pollOnce();
    await claimEntered;
    assert.equal(
      owned.state,
      "idle",
      "visible idle alone hides an in-flight claim",
    );
    assert.equal(
      (await post("/api/update/apply", { confirm: true, sha: updates.latest }))
        .status,
      409,
    );
    assert.equal(owned.state, "idle");
    release();
    await polling;
    NativeTerminal.prototype.stop = async function () {
      enterStop();
      await stopGate;
      return stopNative.call(this);
    };
    applying = post("/api/update/apply", {
      confirm: true,
      sha: updates.latest,
    });
    await stopEntered;
    const calls = f.calls.length;
    await assert.rejects(owned.pollOnce(), /CANCELLED/);
    assert.equal((await post("/api/terminal/ticket")).status, 409);
    assert.equal(f.calls.length, calls);
    releaseStop();
    assert.equal((await applying).status, 202);
  } finally {
    release();
    releaseStop();
    await applying;
    Worker.prototype.start = start;
    NativeTerminal.prototype.stop = stopNative;
    await app.close();
    await f.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("actual admin rejects idle-unsafe manual apply before stop and supports receipt-only stopped recovery", async () => {
  const options = {
    dropComplete: true,
    reconcileDenial: "TASK_SOURCE_CHANGED",
  };
  const f = await taskFixture(options);
  const task = f.enqueue();
  f.deny(task.id);
  const home = await mkdtemp(tmpdir() + "/worker-recovery-");
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
    apiKey: "synthetic-key",
  });
  const updates = new Updates("a".repeat(40), async () => {
    throw new Error("must not apply");
  });
  updates.latest = "b".repeat(40);
  updates.checkedAt = Date.now();
  updates.manualRestartSupported = true;
  const start = Worker.prototype.start;
  let owned: Worker | undefined;
  Worker.prototype.start = function () {
    owned = this;
    (this as any).options.complete = async () => '{"text":"synthetic"}';
    (this as any).options.pollMs = 10;
    return start.call(this);
  };
  const app = await admin(
    store,
    0,
    undefined,
    undefined,
    updates,
    new AutoUpdateSetting(home),
  );
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  const post = (path: string, body = {}) =>
    fetch(app.origin + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post("/api/run")).status, 200);
    for (
      let n = 0;
      n < 200 && !(owned?.state === "idle" && owned.incidents.length);
      n++
    )
      await sleep(10);
    assert.equal(owned?.state, "idle");
    assert.equal(owned?.incidents.length, 1);
    const response = await post("/api/update/apply", {
      confirm: true,
      sha: updates.latest,
    });
    assert.equal(response.status, 409);
    assert.equal(
      owned?.state,
      "idle",
      "manual apply must not abort the original worker",
    );
    assert.equal(updates.lastOperation, undefined);
    assert.equal((await post("/api/update/auto/quiesce")).status, 409);
    assert.equal(owned?.state, "idle");
    await post("/api/stop");
    assert.equal(owned?.state, "stopped");
    const before = f.calls.length;
    const denied = await post("/api/worker/reconcile");
    assert.equal(denied.status, 409);
    assert.equal(owned?.incidents.length, 1);
    options.reconcileDenial = "";
    assert.equal((await post("/api/worker/reconcile")).status, 200);
    assert.equal(owned?.state, "stopped");
    assert.equal(owned?.safeToReplace, true);
    assert.equal(owned?.lastError?.code, "DELIVERY_UNVERIFIED");
    assert.ok(
      f.calls
        .slice(before)
        .every((c) =>
          [
            "coach_read_task_receipt",
            "initialize",
            "notifications/initialized",
          ].includes(c.name),
        ),
    );
    const status = await (
      await fetch(app.origin + "/api/status", { headers })
    ).json();
    assert.equal(status.safeToReplace, true);
    // This fixture has no presence tool; model a previously attempted report.
    (owned as any).presenceAttempted = true;
    owned!.presence = "unconfirmed";
    assert.equal(owned!.stopConfirmed, false);
    let nativeStops = 0;
    const nativeStop = NativeTerminal.prototype.stop;
    NativeTerminal.prototype.stop = async function () {
      nativeStops++;
      return nativeStop.call(this);
    };
    try {
      assert.equal((await post("/api/worker/reconcile")).status, 409);
      assert.equal(
        (
          await post("/api/update/apply", {
            confirm: true,
            sha: updates.latest,
          })
        ).status,
        409,
      );
      assert.equal(nativeStops, 0);
    } finally {
      NativeTerminal.prototype.stop = nativeStop;
      owned!.presence = "reported";
    }
    assert.equal((await post("/api/run")).status, 200);
    assert.equal(f.saved.length, 1);
  } finally {
    Worker.prototype.start = start;
    await app.close();
    await f.close();
    await rm(home, { recursive: true, force: true });
  }
});

for (const dropped of [false, true])
  test(`exact main receipt reaches beyond 100 completions (lost=${dropped})`, async () => {
    const options = {
      main: true,
      dropRespond: dropped,
      mainReceipts: [
        ...Array.from({ length: 120 }, (_, i) => ({
          id: `older-${i}`,
          status: "completed",
          lease_generation: 1,
        })),
        { id: "main", status: "completed", lease_generation: 1 },
      ],
    };
    const f = await taskFixture(options);
    const w = new Worker({
      origin: f.origin,
      token: "synthetic-secret",
      system: "Coach",
      complete: async () => "reply",
    });
    try {
      if (dropped) await assert.rejects(w.pollOnce(), /DELIVERY_UNVERIFIED/);
      else await w.pollOnce();
      await w.stop();
      await w.reconcilePublications();
      assert.equal(w.safeToReplace, true);
      assert.equal(f.calls.filter((c) => c.name === "coach_respond").length, 1);
      const reads = f.calls.filter(
        (c) => c.name === "coach_list_requests" && c.args.statuses,
      );
      assert.ok(reads.length > 0);
      assert.ok(
        reads.every((c) => c.args.request_id === "main" && c.args.limit === 1),
      );
    } finally {
      await w.stop();
      await f.close();
    }
  });

test("missing exact receipt capability retains identity and never replays publication", async () => {
  const options = { main: true, exactReceipt: false };
  const f = await taskFixture(options);
  const w = new Worker({
    origin: f.origin,
    token: "synthetic-secret",
    system: "Coach",
    complete: async () => "reply",
  });
  try {
    await assert.rejects(w.pollOnce(), /DELIVERY_UNVERIFIED/);
    options.main = true; // stale/requeued listing must not cause another write
    await w.pollOnce().catch(() => {});
    await w.stop();
    const before = f.calls.length;
    await w.reconcilePublications();
    assert.equal(w.safeToReplace, false);
    assert.equal(f.calls.filter((c) => c.name === "coach_respond").length, 1);
    assert.ok(
      !f.calls.slice(before).some((c) => c.name === "coach_list_requests"),
    );
    options.exactReceipt = true;
    await w.reconcilePublications();
    assert.equal(w.safeToReplace, true);
  } finally {
    await w.stop();
    await f.close();
  }
});

test("main success readback with the wrong lease stays unresolved", async () => {
  const f = await taskFixture({
    main: true,
    mainReceipts: [{ id: "main", status: "completed", lease_generation: 2 }],
  });
  const w = new Worker({
    origin: f.origin,
    token: "synthetic-secret",
    system: "Coach",
    complete: async () => "synthetic main reply",
  });
  try {
    await assert.rejects(w.pollOnce(), /DELIVERY_UNVERIFIED/);
    assert.equal(w.safeToReplace, false);
    assert.equal(f.calls.filter((c) => c.name === "coach_respond").length, 1);
  } finally {
    await w.stop();
    await f.close();
  }
});

test("stopped pending task requires matching digest and read errors never discard identity", async () => {
  const options: any = { dropComplete: true, receiptError: true };
  const f = await taskFixture(options);
  const w = new Worker({
    origin: f.origin,
    token: "synthetic-secret",
    system: "Coach",
    complete: async () => '{"text":"synthetic"}',
  });
  try {
    f.enqueue();
    await assert.rejects(w.pollOnce(), /DELIVERY_UNVERIFIED/);
    await w.stop();
    assert.equal(
      w.incidents.length,
      0,
      "transient read failure stays pending, not isolated",
    );
    await w.reconcilePublications();
    assert.equal(w.safeToReplace, false);
    options.receiptError = false;
    options.receiptHash = "0".repeat(64);
    await w.reconcilePublications();
    assert.equal(w.safeToReplace, false);
    delete options.receiptHash;
    await w.reconcilePublications();
    assert.equal(w.safeToReplace, true);
    assert.equal(w.lastError?.code, "DELIVERY_UNVERIFIED");
    assert.equal(f.saved.length, 1);
  } finally {
    await w.stop();
    await f.close();
  }
});

test("lost main reply is retained independently of later error history and only exact canonical identity resolves it", async () => {
  const options: any = { main: true, dropRespond: true, mainReceipts: [] };
  const f = await taskFixture(options);
  const w = new Worker({
    origin: f.origin,
    token: "synthetic-secret",
    system: "Coach",
    complete: async () => "synthetic main reply",
  });
  try {
    await assert.rejects(w.pollOnce(), /DELIVERY_UNVERIFIED/);
    options.mainListError = true;
    await assert.rejects(w.pollOnce());
    assert.notEqual(w.lastError?.code, "DELIVERY_UNVERIFIED");
    await w.stop();
    assert.equal(w.safeToReplace, false);
    options.mainListError = false;
    await w.reconcilePublications();
    assert.equal(w.safeToReplace, false, "absence is not proof");
    options.mainReceipts = [
      { id: "main", status: "completed", lease_generation: 2 },
    ];
    await w.reconcilePublications();
    assert.equal(w.safeToReplace, false, "another lease is not proof");
    options.mainReceipts = [
      { id: "main", status: "completed", lease_generation: 1 },
    ];
    await w.reconcilePublications();
    assert.equal(w.safeToReplace, true);
    assert.equal(w.state, "stopped");
    assert.equal(f.calls.filter((c) => c.name === "coach_respond").length, 1);
    assert.equal(
      f.calls.filter((c) => c.name === "coach_claim_request").length,
      1,
    );
  } finally {
    await w.stop();
    await f.close();
  }
});

test("stopped task reconciliation retains denied identities and resolves without replay or clearing history", async () => {
  const options = {
    dropComplete: true,
    reconcileDenial: "TASK_SOURCE_CHANGED",
  };
  const f = await taskFixture(options);
  const w = new Worker({
    origin: f.origin,
    token: "synthetic-secret",
    system: "Coach",
    complete: async () => '{"text":"synthetic"}',
  });
  try {
    const task = f.enqueue();
    f.deny(task.id);
    await assert.rejects(w.pollOnce(), /DELIVERY_UNVERIFIED/);
    await w.pollOnce();
    assert.equal(w.state, "idle");
    assert.equal(w.safeToReplace, false);
    assert.equal(
      w.quiesceForUpdate(),
      false,
      "unsafe idle worker must not be stopped for update",
    );
    await w.stop();
    const identity = w.incidents;
    await w.reconcilePublications();
    assert.deepEqual(w.incidents, identity);
    assert.equal(w.state, "stopped");
    assert.equal(w.safeToReplace, false);
    options.reconcileDenial = "";
    await Promise.all([w.reconcilePublications(), w.reconcilePublications()]);
    assert.equal(w.safeToReplace, true);
    assert.equal(w.stopConfirmed, true);
    assert.equal(w.state, "stopped");
    assert.equal(
      w.lastError?.code,
      "DELIVERY_UNVERIFIED",
      "history is not a live blocker",
    );
    assert.equal(f.saved.length, 1);
    assert.equal(
      f.calls.filter((c) => c.name === "coach_claim_task").length,
      2,
    );
  } finally {
    await w.stop();
    await f.close();
  }
});
