import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NativeTerminal } from "../src/server/terminal.js";
import { ledgerObligations } from "../src/autonomy/ledger.js";
import {
  closeLeaked,
  outcome,
  ScriptedRuntime,
} from "./helpers/autonomy-cycle.js";
import {
  autonomyAdmin,
  holdingProxy,
  until,
} from "./helpers/autonomy-admin.js";
import { MEMBER } from "./helpers/autonomy-fake.js";
import { readyUpdates } from "./helpers/ready-updates.js";

// October 15 upgrade admission (approved): an uncertain historical autonomy
// completion is durable recoverable bookkeeping, not current execution. It
// stays on disk across the upgrade and blocks new autonomous actions, but it
// does not block replacement of an idle host, is never replayed and is never
// a pre-upgrade receipt wait. The new host reconciles it afterwards.

after(closeLeaked);

const LEASE_MS = 241_000;
const lostAck = { status: 200, body: { unexpected: true } };
const isComplete = (method: string, path: string) =>
  method === "POST" && /\/complete$/.test(path.split("?")[0]);
const isReceiptRead = (method: string, path: string) =>
  method === "GET" && /\/completions\//.test(path);

/**
 * The live incident shape: a participating, idle host retaining one durable
 * unknown completion whose exact generation receipt answers `pending`.
 */
async function retainedCompletion() {
  const applications: string[] = [];
  let stops = 0;
  const updates = await readyUpdates(async (sha) => {
    applications.push(sha);
  });
  updates.manualRestartSupported = true;
  const env = await autonomyAdmin({
    updates,
    // Only explicit proof reads: status polling never nudges one here.
    proofThrottleMs: 3_600_000,
    planners: [new ScriptedRuntime([async () => outcome()])],
  });
  const proxy = await holdingProxy(env.fake.origin);
  await env.store.save({ ...env.store.publicConfig(), origin: proxy.origin });
  // The completion never reaches the backend and its answer is lost.
  proxy.state.intercept = (method, url) =>
    isComplete(method, url) ? lostAck : undefined;
  await env.call("POST", "/api/autonomy/participate", { participate: true });
  const id = env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
  await until(async () => {
    const s = (await env.status()).local;
    return (
      s.unresolvedWrites === 1 &&
      s.unresolved[0].reason === "pending" &&
      !s.busy
    );
  }, "idle host with one pending unknown completion");
  proxy.state.intercept = undefined;
  // The lease expired but nobody reclaimed it: exactly `pending`, as live.
  env.fake.advance(LEASE_MS);
  const ledgerFile = join(env.store.dir, "autonomy/writes.json");
  const stop = NativeTerminal.prototype.stop;
  return {
    env,
    proxy,
    id,
    updates,
    applications,
    ledgerFile,
    get stops() {
      return stops;
    },
    countStops() {
      NativeTerminal.prototype.stop = async function () {
        stops++;
        return stop.call(this);
      };
    },
    completions: () =>
      proxy.state.requests.filter((r) => isComplete(r.method, r.path)).length,
    async close() {
      NativeTerminal.prototype.stop = stop;
      await env.close();
      await proxy.close();
    },
  };
}

test(
  "an idle host's durable unknown completion is retained across an accepted manual upgrade and restart, never replayed, and reconciled afterwards",
  { timeout: 30000 },
  async () => {
    const t = await retainedCompletion();
    const { env, proxy, id, updates } = t;
    try {
      const before = await readFile(t.ledgerFile);
      const [entry] = JSON.parse(before.toString("utf8")).entries;
      assert.equal(entry.op, "complete");
      assert.equal(entry.work_id, id);
      assert.equal(t.completions(), 1);

      // The authenticated admin manual upgrade path accepts and installs.
      const proxyMark = proxy.state.requests.length;
      const backendMark = env.fake.calls.length;
      const started = Date.now();
      const response = await env.call("POST", "/api/update/apply", {
        confirm: true,
        sha: updates.latest,
      });
      assert.equal(response.status, 202, JSON.stringify(response.body));
      assert.equal(response.body.queued, true);
      const queue = await until(async () => {
        const q = (await env.call("GET", "/api/update")).body.manualQueue;
        return ["accepted", "failed", "cancelled"].includes(q?.phase) && q;
      }, "manual queue settles");
      assert.equal(queue.phase, "accepted", JSON.stringify(queue));
      assert.deepEqual(t.applications, [updates.latest], "installed once");
      assert.ok(Date.now() - started < 10000, "no receipt wait before install");
      const during = proxy.state.requests.slice(proxyMark);
      assert.equal(
        during.filter((r) => isReceiptRead(r.method, r.path)).length,
        0,
        "admission and Stop never depend on the unresolved receipt",
      );
      assert.equal(t.completions(), 1, "completion never replayed");
      assert.equal(
        env.fake.calls
          .slice(backendMark)
          .filter((c) => /\/work\/claim$/.test(c.path)).length,
        0,
        "no claim across the upgrade boundary",
      );
      assert.deepEqual(await readFile(t.ledgerFile), before, "ledger kept");
      // The stable owner's read-only launch gate still sees the obligation, so
      // a pre-ledger rollback target stays refused.
      assert.equal(await ledgerObligations(env.store.dir), "unresolved");

      // Replacement readiness is distinct from new-action readiness.
      const local = (await env.status()).local;
      assert.equal(local.busy, false);
      assert.equal(local.ledgerHealthy, true);
      assert.equal(local.unknownOutcome, true);
      assert.equal(local.safeToAct, false, "new autonomous work stays paused");
      assert.equal(local.safeToReplace, true, "durable history is not busy");
      assert.equal(local.replacementBlocker, null);
      const owner = (await env.call("GET", "/api/status")).body;
      assert.equal(owner.safeToReplace, true);
      assert.equal(owner.autonomySafeToAct, false);
      assert.equal(owner.autonomyUnresolvedWrites, 1);

      // The successor host on the same protected home: exact original record.
      await env.restart();
      assert.deepEqual(await readFile(t.ledgerFile), before, "restart kept");
      const reloaded = (await env.status()).local;
      assert.deepEqual(
        reloaded.unresolved.map((u: any) => [
          u.op,
          u.work_id,
          u.state,
          u.created_at,
        ]),
        [["complete", id, "unknown", entry.created_at]],
      );
      assert.equal(reloaded.safeToAct, false);
      assert.equal(reloaded.safeToReplace, true);
      // Bounded post-restart proof leaves it pending; nothing is replayed or
      // claimed however often the scheduler looks at the due work.
      const mark = env.fake.calls.length;
      await until(
        () =>
          env.fake.calls
            .slice(mark)
            .filter((c) => c.method === "GET" && /status=due/.test(c.path))
            .length >= 3,
        "the scheduler looked at due work repeatedly",
      );
      await until(
        async () => (await env.status()).local.unresolved[0]?.reason,
        "post-restart proof observed",
      );
      const held = (await env.status()).local;
      assert.equal(held.unresolved[0].reason, "pending");
      assert.equal(
        env.fake.calls.slice(mark).filter((c) => /\/work\/claim$/.test(c.path))
          .length,
        0,
        "no claim while the completion is unresolved",
      );
      assert.equal(t.completions(), 1);
      assert.deepEqual(await readFile(t.ledgerFile), before);

      // Later, the exact receipt becomes conclusive: another installation
      // reclaimed the work, so our generation can never commit.
      assert.ok(await env.fake.client("installation-b").claim());
      const released = await env.call("POST", "/api/update/release", {});
      assert.equal(released.status, 200, JSON.stringify(released.body));
      const settled = (await env.status()).local;
      assert.equal(settled.unresolvedWrites, 0);
      assert.deepEqual(
        settled.settled.map((s: any) => [s.op, s.work_id, s.proof]),
        [["complete", id, "not_published"]],
      );
      assert.equal(settled.safeToAct, true);
      assert.equal(t.completions(), 1, "settled without any replay");
    } finally {
      await t.close();
    }
  },
);

test(
  "a journal that no longer reads back exactly is an accurate autonomy blocker before Stop, not WORKER_STOP_UNCONFIRMED",
  { timeout: 30000 },
  async () => {
    const t = await retainedCompletion();
    const { env, updates } = t;
    try {
      t.countStops();
      // The journal on disk no longer matches what this host holds.
      await writeFile(t.ledgerFile, "{not json", { mode: 0o600 });
      const refused = await env.call("POST", "/api/update/apply", {
        confirm: true,
        sha: updates.latest,
      });
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.equal(refused.body.error, "AUTONOMY_REPLACEMENT_UNCONFIRMED");
      assert.equal(t.stops, 0, "rejected before native teardown");
      assert.deepEqual(t.applications, []);
      const local = (await env.status()).local;
      assert.equal(local.safeToReplace, false);
      assert.equal(local.safeToAct, false);
      assert.equal(local.replacementBlocker, "ledger_unavailable");
      const snapshot = (await env.call("GET", "/api/update")).body;
      assert.equal(snapshot.manualQueue, undefined);
      assert.equal(
        snapshot.lastAdmission?.reason,
        "AUTONOMY_REPLACEMENT_UNCONFIRMED",
      );
      assert.match(snapshot.guidance, /autonomy/i);
      assert.equal(t.completions(), 1);
    } finally {
      await t.close();
    }
  },
);
