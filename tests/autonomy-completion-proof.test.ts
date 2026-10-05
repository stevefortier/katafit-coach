import { test, after } from "node:test";
import assert from "node:assert/strict";
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
import { prove, type Proof } from "../src/autonomy/reconcile.js";
import type { LedgerEntry } from "../src/autonomy/ledger.js";
import type { AutonomyBackend } from "../src/autonomy/backend.js";

// C5 R1/R2 (client-718-f1f2-independent-review.md): a report projection is
// not exact completion proof, and a current-mandate listing is not an
// exhaustive read of an operation recorded under an older mandate. An
// unknown completion is settled only by its own generation's exact receipt
// (backend 44273475); it is never replayed. See also
// autonomy-exact-receipt.test.ts.

after(closeLeaked);

const LEASE_MS = 241_000;
const deferred = (next_due_at: string) =>
  outcome({
    result: "deferred",
    next_due_at,
    decisions: [
      {
        subject_id: MEMBER,
        decision: "deferred",
        action_slots: [],
        follow_up_ids: [],
      },
    ],
  });
const lostAck = { status: 200, body: { unexpected: true } };

async function proxied(planners: ScriptedRuntime[]) {
  const env = await autonomyAdmin({ planners, proofThrottleMs: 0 });
  const proxy = await holdingProxy(env.fake.origin);
  await env.store.save({ ...env.store.publicConfig(), origin: proxy.origin });
  return {
    env,
    proxy,
    quiesce: () => env.call("POST", "/api/update/quiesce", { confirm: true }),
    async close() {
      await env.close();
      await proxy.close();
    },
  };
}

test("R1: an earlier attempt's equal report projection never proves a later unknown completion", async () => {
  // Two attempts of one work item; both defer with the same coverage,
  // decisions and slots (equal report projection) but different full
  // completion bodies (next_due_at, lease generation).
  const t = await proxied([
    new ScriptedRuntime([
      async () => deferred("2026-10-03T07:01:00.000Z"),
      async () => deferred("2026-10-03T09:00:00.000Z"),
    ]),
  ]);
  const { env, proxy } = t;
  try {
    let completes = 0;
    // The second completion never reaches the backend; its answer is lost.
    proxy.state.intercept = (method, url) =>
      method === "POST" && /\/complete$/.test(url) && ++completes === 2
        ? lostAck
        : undefined;
    await env.call("POST", "/api/autonomy/participate", { participate: true });
    const id = env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
    await until(
      () => env.fake.state.reports.length === 1,
      "attempt 1 reported",
    );
    env.fake.advance(120_000);
    await until(() => completes === 2, "attempt 2 completion sent");
    await until(
      async () => (await env.status()).local.unresolvedWrites === 1,
      "attempt 2 completion unknown",
    );
    await env.call("POST", "/api/autonomy/participate", { participate: false });
    assert.equal(env.fake.state.reports.length, 1, "attempt 2 never committed");
    env.fake.advance(LEASE_MS);
    const q = await t.quiesce();
    assert.equal(q.status, 409, "the older report proves nothing");
    const s = await env.status();
    // Generation 2's lease expired but was never reclaimed: exactly pending.
    assert.deepEqual(
      s.local.unresolved.map((u: any) => [u.op, u.work_id, u.reason]),
      [["complete", id, "pending"]],
    );
    assert.equal(s.local.safeToReplace, false);
    const sent = env.fake.calls.filter((c) => /\/complete$/.test(c.path));
    assert.equal(sent.length, 1, "never replayed as proof");
  } finally {
    await t.close();
  }
});

test("R1: a committed completion whose answer was lost stays unresolved while its exact receipt is unreadable", async () => {
  const t = await proxied([new ScriptedRuntime([async () => outcome()])]);
  const { env, proxy } = t;
  try {
    env.fake.state.completionFault = { status: 503 };
    proxy.state.rewrite = (method, url) =>
      method === "POST" && /\/complete$/.test(url)
        ? { unexpected: true }
        : undefined;
    await env.call("POST", "/api/autonomy/participate", { participate: true });
    const id = env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
    await until(
      () => env.fake.state.work.get(id).status === "completed",
      "completion committed upstream",
    );
    await env.call("POST", "/api/autonomy/participate", { participate: false });
    proxy.state.rewrite = undefined;
    env.fake.advance(LEASE_MS);
    // Its report is readable, which proves nothing.
    assert.equal(env.fake.state.reports.length, 1);
    assert.equal((await t.quiesce()).status, 409);
    const s = await env.status();
    assert.deepEqual(
      s.local.unresolved.map((u: any) => [u.op, u.reason]),
      [["complete", "unavailable"]],
    );
    env.fake.state.completionFault = undefined;
    assert.equal((await t.quiesce()).status, 200, "exact receipt settles it");
  } finally {
    await t.close();
  }
});

test("R1: a completion that never arrived is pending while its generation may still commit, and unpublished once superseded", async () => {
  const t = await proxied([new ScriptedRuntime([async () => outcome()])]);
  const { env, proxy } = t;
  try {
    proxy.state.intercept = (method, url) =>
      method === "POST" && /\/complete$/.test(url) ? lostAck : undefined;
    await env.call("POST", "/api/autonomy/participate", { participate: true });
    env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
    await until(
      async () => (await env.status()).local.unresolvedWrites === 1,
      "completion unknown",
    );
    await env.call("POST", "/api/autonomy/participate", { participate: false });
    proxy.state.intercept = undefined;
    // An expired lease is not absence: the generation is still pending.
    env.fake.advance(LEASE_MS);
    assert.equal((await t.quiesce()).status, 409);
    assert.deepEqual(
      (await env.status()).local.unresolved.map((u: any) => u.reason),
      ["pending"],
    );
    // Another installation reclaims: that generation can never commit.
    assert.ok(await env.fake.client("installation-b").claim());
    const q = await t.quiesce();
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.equal((await env.status()).local.unresolvedWrites, 0);
  } finally {
    await t.close();
  }
});

test("R2: after a same-account mandate replacement, an old-mandate completion is proven by its exact receipt, never by new-mandate absence", async () => {
  const t = await proxied([new ScriptedRuntime([async () => outcome()])]);
  const { env, proxy } = t;
  try {
    proxy.state.rewrite = (method, url) =>
      method === "POST" && /\/complete$/.test(url)
        ? { unexpected: true }
        : undefined;
    await env.call("POST", "/api/autonomy/participate", { participate: true });
    const id = env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
    await until(
      () => env.fake.state.work.get(id).status === "completed",
      "completion committed upstream under the old mandate",
    );
    await env.call("POST", "/api/autonomy/participate", { participate: false });
    proxy.state.rewrite = undefined;
    // Same account, new mandate identity: current listings no longer show
    // the old mandate's work or reports.
    env.fake.state.mandate.mandate_id = "64b7f0c2a1b2c3d4e5f6aaaa";
    env.fake.advance(LEASE_MS);
    assert.equal((await t.quiesce()).status, 200);
    const s = await env.status();
    assert.deepEqual(
      s.local.settled.map((u: any) => [u.op, u.work_id, u.proof]),
      [["complete", id, "committed"]],
    );
  } finally {
    await t.close();
  }
});

test("R2: every non-completion op recorded under another mandate stays unresolved with no read; a completion reads only its exact receipt", async () => {
  const base: LedgerEntry = {
    id: "e1",
    op: "act",
    origin: "https://coach.example",
    chief_id: "64b7f0c2a1b2c3d4e5f60802",
    dojo_id: "64b7f0c2a1b2c3d4e5f60801",
    mandate_id: "64b7f0c2a1b2c3d4e5f60a0a",
    installation: "0".repeat(32),
    work_id: "64b7f0c2a1b2c3d4e5f60b0b",
    lease_generation: 1,
    slot: "r1",
    follow_up_id: null,
    digest: "0".repeat(64),
    expect: {},
    state: "unknown",
    created_at: "2026-10-03T07:00:00.000Z",
  } as unknown as LedgerEntry;
  const reads: string[] = [];
  const backend = new Proxy(
    { origin: base.origin, serverTime: Date.now() },
    {
      get(target: any, key) {
        if (key in target) return target[key];
        return () => {
          reads.push(String(key));
          throw new Error("no read allowed");
        };
      },
    },
  ) as unknown as AutonomyBackend;
  const mandate = {
    chief_id: base.chief_id,
    dojo_id: base.dojo_id,
    mandate_id: "64b7f0c2a1b2c3d4e5f6ffff",
  } as any;
  for (const op of [
    "act",
    "intent",
    "composition",
    "follow_up",
    "follow_up_patch",
  ] as const) {
    const proof: Proof = await prove({ ...base, op }, { backend, mandate });
    assert.equal(proof, "mandate_changed", op);
  }
  assert.deepEqual(reads, []);
  // A completion's proof does not depend on the mandate: one exact read.
  const proof = await prove(
    { ...base, op: "complete", slot: null },
    { backend, mandate },
  );
  assert.equal(proof, "unavailable");
  assert.deepEqual(reads, ["completionReceipt"]);
});

test("R2: a mandate replaced during the proof reads (TOCTOU) never yields a resolving proof", async () => {
  const A = "64b7f0c2a1b2c3d4e5f60a0a";
  const B = "64b7f0c2a1b2c3d4e5f6bbbb";
  const entry = {
    id: "e1",
    op: "follow_up",
    origin: "https://coach.example",
    chief_id: "64b7f0c2a1b2c3d4e5f60802",
    dojo_id: "64b7f0c2a1b2c3d4e5f60801",
    mandate_id: A,
    installation: "0".repeat(32),
    work_id: "64b7f0c2a1b2c3d4e5f60b0b",
    lease_generation: 1,
    slot: "f1",
    follow_up_id: null,
    digest: "0".repeat(64),
    expect: {},
    state: "unknown",
    created_at: "2026-10-03T07:00:00.000Z",
  } as unknown as LedgerEntry;
  const view = (mandate_id: string) => ({
    chief_id: entry.chief_id,
    dojo_id: entry.dojo_id,
    mandate_id,
  });
  const empty = { items: [], has_more: false, next_cursor: null };
  const stub = (afterReads: string) =>
    ({
      origin: entry.origin,
      serverTime: Date.now(),
      listWork: async () => empty,
      // Listings answer for whatever mandate is current when they run.
      listFollowUps: async () => empty,
      mandate: async () => view(afterReads),
    }) as unknown as AutonomyBackend;
  assert.equal(
    await prove(entry, { backend: stub(B), mandate: view(A) as any }),
    "mandate_changed",
  );
  assert.equal(
    await prove(entry, { backend: stub(A), mandate: view(A) as any }),
    "not_published",
    "positive control: an unchanged mandate keeps exact absence proof",
  );
});
