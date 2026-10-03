import { test, after } from "node:test";
import assert from "node:assert/strict";
import { REPORT_TOOL } from "../src/autonomy/tools.js";
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

// C5 repair F1/F2 (client-c5-independent-review.md): an effectful autonomy
// write whose outcome is unknown is a durable, exactly bound ledger entry.
// It survives restart, opt-out, origin/account switch and acknowledged
// blocked/uncertain_write completion, covers typed response validation, and
// is cleared only by an exact read (or proven nonpublication). Every
// replacement gate consumes it independently of participation.

after(closeLeaked);

// Past the 120 s lease plus the 120 s fence allowance on the backend clock:
// valid whether expiry is lazy (real backend) or eager (fake).
const LEASE_MS = 241_000;
const acted = (slots: string[]) =>
  outcome({
    decisions: [
      {
        subject_id: null,
        decision: "acted",
        action_slots: slots,
        follow_up_ids: [],
      },
    ],
  });
const reporting = () =>
  new ScriptedRuntime([
    async ({ call }) => {
      await call(REPORT_TOOL, { slot: "r1", text: "Private." });
      return acted(["r1"]);
    },
  ]);
const unavailable = { status: 503, body: { code: "AUTONOMY_UNAVAILABLE" } };
const receiptRead = (method: string, url: string) =>
  method === "GET" && /\/actions\/r1$/.test(url.split("?")[0]);

async function proxied(planners: ScriptedRuntime[]) {
  const env = await autonomyAdmin({ planners });
  const proxy = await holdingProxy(env.fake.origin);
  await env.store.save({ ...env.store.publicConfig(), origin: proxy.origin });
  const quiesce = () =>
    env.call("POST", "/api/update/quiesce", { confirm: true });
  const ownerStatus = async () => (await env.call("GET", "/api/status")).body;
  return {
    env,
    proxy,
    quiesce,
    ownerStatus,
    async close() {
      await env.close();
      await proxy.close();
    },
  };
}

/** Opt out while the action write is held: the write becomes unknown. */
async function abandonHeldWrite(t: Awaited<ReturnType<typeof proxied>>) {
  const { env, proxy } = t;
  proxy.state.hold = true;
  await env.call("POST", "/api/autonomy/participate", { participate: true });
  const id = env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
  await until(() => proxy.state.entered.length === 1, "action write held");
  const off = await env.call("POST", "/api/autonomy/participate", {
    participate: false,
  });
  assert.equal(off.status, 200);
  assert.equal(off.body.local.unresolvedWrites, 1);
  assert.equal(off.body.local.safeToReplace, false);
  return id;
}

test("F1: an unknown write survives an opted-out restart and blocks every replacement gate until its exact receipt", async () => {
  const t = await proxied([reporting()]);
  const { env, proxy } = t;
  try {
    const id = await abandonHeldWrite(t);
    // The held write has not reached the backend; nothing proves it either way.
    await env.restart();
    const s = await env.status();
    assert.equal(s.participate, false);
    assert.equal(s.local.state, "stopped");
    assert.equal(s.local.unresolvedWrites, 1, "reloaded from durable storage");
    assert.equal(s.local.unknownOutcome, true);
    assert.equal(s.local.safeToReplace, false);
    assert.deepEqual(
      s.local.unresolved.map((u: any) => [u.op, u.work_id, u.slot]),
      [["act", id, "r1"]],
    );
    const owner = await t.ownerStatus();
    assert.equal(owner.safeToReplace, false, "/api/status combines autonomy");
    const refused = await t.quiesce();
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, "WORKER_STOP_UNCONFIRMED");
    // The held write now commits upstream; the exact receipt proves it.
    proxy.release();
    await until(
      () => env.fake.state.work.get(id).actions.length === 1,
      "write committed upstream",
    );
    const quiesced = await t.quiesce();
    assert.equal(quiesced.status, 200, JSON.stringify(quiesced.body));
    const after = await env.status();
    assert.equal(after.local.unresolvedWrites, 0);
    assert.equal(after.local.safeToReplace, true);
    assert.equal((await t.ownerStatus()).updateQuiesceReady, true);
    const puts = env.fake.calls.filter(
      (c) => c.method === "PUT" && c.path.includes("/actions/"),
    );
    assert.equal(puts.length, 1, "proof never replays the write");
  } finally {
    await t.close();
  }
});

test("F1: proven nonpublication (fenced lease + exact absent receipt) clears the entry; a live lease does not", async () => {
  const t = await proxied([reporting()]);
  const { env, proxy } = t;
  try {
    const id = await abandonHeldWrite(t);
    // The client gave up; the held request is dropped before the backend.
    proxy.state.intercept = (method, url) =>
      method === "PUT" && url.includes("/actions/") ? unavailable : undefined;
    proxy.state.hold = false;
    for (const go of proxy.state.held.splice(0)) go();
    // Lease still live at our generation: absence is not yet proof.
    const early = await t.quiesce();
    assert.equal(early.status, 409);
    assert.equal((await env.status()).local.unresolvedWrites, 1);
    env.fake.advance(LEASE_MS);
    const quiesced = await t.quiesce();
    assert.equal(quiesced.status, 200, JSON.stringify(quiesced.body));
    assert.equal(env.fake.state.work.get(id).actions.length, 0);
  } finally {
    await t.close();
  }
});

test("F1: an origin or account switch keeps the original binding; only the original authority resolves it", async () => {
  const t = await proxied([reporting()]);
  const { env, proxy } = t;
  try {
    const id = await abandonHeldWrite(t);
    // Exact proof is unavailable (before any background proof can read it).
    proxy.state.intercept = (method, url) =>
      receiptRead(method, url) ? unavailable : undefined;
    proxy.release();
    await until(
      () => env.fake.state.work.get(id).actions.length === 1,
      "write committed upstream",
    );
    // A configuration transition is refused while the write is unresolved.
    const config = env.store.publicConfig();
    const refused = await env.call("POST", "/api/config", {
      ...config,
      origin: env.fake.origin,
      expectedRevision: config.revision,
    });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error, "AUTONOMY_WRITE_UNRESOLVED");
    assert.equal(env.store.publicConfig().origin, proxy.origin);
    proxy.state.intercept = undefined;
    // An out-of-band switch (another process, older launcher) to a different
    // origin cannot prove it, even though that origin could read a receipt.
    await env.store.save({ ...config, origin: env.fake.origin });
    await env.restart();
    assert.equal((await t.quiesce()).status, 409);
    let s = await env.status();
    assert.equal(s.local.unresolvedWrites, 1);
    assert.equal(s.local.unresolved[0].reason, "binding_unavailable");
    // The same origin with a different account is also not the binding.
    await env.store.save({ ...config, origin: proxy.origin });
    env.fake.state.mandate.chief_id = "6a0000000000000000000099";
    assert.equal((await t.quiesce()).status, 409);
    s = await env.status();
    assert.equal(s.local.unresolved[0].reason, "binding_unavailable");
    env.fake.state.mandate.chief_id = env.fake.chief;
    const quiesced = await t.quiesce();
    assert.equal(quiesced.status, 200, JSON.stringify(quiesced.body));
  } finally {
    await t.close();
  }
});

test("F1/F2: a wrong-digest 2xx with denied readback completes blocked/uncertain_write yet keeps the fence until an exact read", async () => {
  const t = await proxied([reporting()]);
  const { env, proxy } = t;
  try {
    proxy.state.rewrite = (method, url, body) =>
      method === "PUT" && url.includes("/actions/")
        ? { ...body, receipt: { ...body.receipt, text_sha256: "0".repeat(64) } }
        : undefined;
    proxy.state.intercept = (method, url) =>
      receiptRead(method, url) ? unavailable : undefined;
    await env.call("POST", "/api/autonomy/participate", { participate: true });
    const id = env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
    await until(
      () => env.fake.state.work.get(id).status === "blocked",
      "acknowledged blocked completion",
    );
    assert.equal(env.fake.state.work.get(id).blocked_reason, "uncertain_write");
    const s = await until(async () => {
      const v = await env.status();
      return v.local.state === "idle" && v;
    }, "cycle settled");
    assert.equal(s.local.unresolvedWrites, 1, "completion is not a receipt");
    assert.equal(s.local.safeToReplace, false);
    assert.equal((await t.quiesce()).status, 409);
    proxy.state.rewrite = undefined;
    proxy.state.intercept = undefined;
    const quiesced = await t.quiesce();
    assert.equal(quiesced.status, 200, JSON.stringify(quiesced.body));
  } finally {
    await t.close();
  }
});

// C5 R1: a report projection is not exact completion proof, so a committed
// completion with a lost answer stays unresolved (fail closed) until the
// backend exposes an exact completion receipt.
for (const [name, rewrite] of [
  ["wrong schema", () => ({ unexpected: true })],
  [
    "wrong work id",
    (body: any) => ({
      ...body,
      work: { ...body.work, id: "6a00000000000000000000ff" },
    }),
  ],
] as const)
  test(`F2/R1: a lost completion ACK (${name}) stays unknown; readable reports never prove it`, async () => {
    const t = await proxied([new ScriptedRuntime([async () => outcome()])]);
    const { env, proxy } = t;
    try {
      proxy.state.rewrite = (method, url, body) =>
        method === "POST" && /\/complete$/.test(url)
          ? rewrite(body)
          : undefined;
      // Proof is unavailable at first: work and report listings fail.
      proxy.state.intercept = (method, url) =>
        method === "GET" &&
        /\/(work|reports)(\?|$)/.test(url) &&
        !url.includes("status=due")
          ? unavailable
          : undefined;
      await env.call("POST", "/api/autonomy/participate", {
        participate: true,
      });
      const id = env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
      await until(
        () => env.fake.state.work.get(id).status === "completed",
        "completion committed upstream",
      );
      await env.call("POST", "/api/autonomy/participate", {
        participate: false,
      });
      const s = await env.status();
      assert.deepEqual(
        s.local.unresolved.map((u: any) => [u.op, u.work_id]),
        [["complete", id]],
      );
      assert.equal((await t.quiesce()).status, 409);
      proxy.state.intercept = undefined;
      proxy.state.rewrite = undefined;
      env.fake.advance(LEASE_MS);
      assert.equal((await t.quiesce()).status, 409);
      assert.deepEqual(
        (await env.status()).local.unresolved.map((u: any) => u.reason),
        ["receipt_required"],
      );
      const completes = env.fake.calls.filter((c) =>
        /\/complete$/.test(c.path),
      );
      assert.equal(completes.length, 1, "completion never replayed");
    } finally {
      await t.close();
    }
  });
