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
  blockingRuntime,
  holdingProxy,
  until,
} from "./helpers/autonomy-admin.js";
import { MEMBER } from "./helpers/autonomy-fake.js";

// C5 lifecycle (work-packages §4 C5): configuration apply mid-cycle, mandate
// pause/resume, process restart, update quiesce with an in-flight action, and
// an unknown action outcome that blocks replacement until it is settled.

after(closeLeaked);

const LEASE_MS = 121_000;
const writes = (calls: any[], from: number) =>
  calls
    .slice(from)
    .filter((c) => c.method !== "GET")
    .map((c) => `${c.method} ${c.path.split("?")[0]}`);
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

test("C5: a config apply mid-cycle aborts the cycle without local release and autonomy resumes on the saved revision", async () => {
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  const blocked = blockingRuntime(entered);
  const resumed = new ScriptedRuntime([async () => outcome()]);
  const env = await autonomyAdmin({ planners: [blocked as any, resumed] });
  try {
    await env.call("POST", "/api/autonomy/participate", { participate: true });
    const id = env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
    await inside;
    const generation = env.fake.state.work.get(id).lease_generation;
    const before = env.fake.calls.length;
    const config = env.store.publicConfig();
    const applied = await env.call("POST", "/api/config", {
      ...config,
      persona: { ...config.persona, name: "Coach Revised" },
      expectedRevision: config.revision,
    });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(env.store.publicConfig().revision, config.revision + 1);
    // Aborted locally: no completion, no release; the backend lease stands.
    assert.ok(
      !writes(env.fake.calls, before).some((w) =>
        /\/work\/[0-9a-f]+\/(complete|release)/.test(w),
      ),
      JSON.stringify(writes(env.fake.calls, before)),
    );
    assert.equal(env.fake.state.work.get(id).status, "running");
    assert.equal(env.fake.state.work.get(id).lease_generation, generation);
    // Autonomy restarted itself with a fresh runtime pair after the apply.
    await until(() => env.pairs.length === 2, "autonomy restarted");
    assert.notEqual((await env.status()).local.state, "stopped");
    env.fake.advance(LEASE_MS);
    await until(
      async () => (await env.status()).local.lastOutcome === "completed",
      "the re-claimed cycle completes",
    );
    assert.equal(env.fake.state.work.get(id).status, "completed");
    assert.ok(
      resumed.runs[0].catalog.prompt.includes("Coach Revised"),
      "the resumed planner runs the saved revision",
    );
  } finally {
    await env.close();
  }
});

test("C5: a paused mandate claims nothing; unpausing resumes the same loop", async () => {
  const planner = new ScriptedRuntime([async () => outcome()]);
  const env = await autonomyAdmin({ planners: [planner] });
  try {
    await env.call("POST", "/api/autonomy/participate", { participate: true });
    const mandate = (await env.call("GET", "/api/autonomy/mandate")).body;
    const {
      capabilities,
      protocol,
      mandate_id,
      dojo_id,
      chief_id,
      revision,
      status,
      suspended_reason,
      updated_at,
      updated_by,
      ...fields
    } = mandate;
    const pause = await env.call("PUT", "/api/autonomy/mandate", {
      idempotency_key: "c5-life-pause",
      expected_revision: revision,
      mandate: { ...fields, paused: true },
    });
    assert.equal(pause.status, 200);
    const id = env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
    await until(
      async () => (await env.status()).local.state === "disabled",
      "paused mandate disables the loop",
    );
    const before = env.fake.calls.length;
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(writes(env.fake.calls, before), []);
    assert.equal(planner.runs.length, 0);
    const resume = await env.call("PUT", "/api/autonomy/mandate", {
      idempotency_key: "c5-life-resume",
      expected_revision: revision + 1,
      mandate: { ...fields, paused: false },
    });
    assert.equal(resume.status, 200);
    await until(
      () => env.fake.state.work.get(id).status === "completed",
      "resumed cycle",
    );
    assert.equal(planner.runs.length, 1);
  } finally {
    await env.close();
  }
});

test("C5: a process restart resumes participation from installation storage, and only then", async () => {
  // Each start takes a fresh runtime pair: the first process never runs work.
  const env = await autonomyAdmin({
    planners: [
      new ScriptedRuntime([]),
      new ScriptedRuntime([async () => outcome()]),
    ],
  });
  try {
    await env.call("POST", "/api/autonomy/participate", { participate: true });
    await env.restart();
    await until(
      async () => (await env.status()).local.state !== "stopped",
      "autonomy autostarts after restart",
    );
    const id = env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
    await until(
      () => env.fake.state.work.get(id).status === "completed",
      "restarted loop runs due work",
    );
    await env.call("POST", "/api/autonomy/participate", { participate: false });
    const starts = env.pairs.length;
    await env.restart();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await env.status()).local.state, "stopped");
    assert.equal(env.pairs.length, starts, "no runtime created when opted out");
  } finally {
    await env.close();
  }
});

test("C5: update quiesce refuses while an autonomy action is in flight, then quiesces; release resumes", async () => {
  const planner = new ScriptedRuntime([
    async ({ call }) => {
      const r = await call(REPORT_TOOL, { slot: "r1", text: "Private." });
      assert.ok(!r.error, JSON.stringify(r));
      return acted(["r1"]);
    },
  ]);
  const env = await autonomyAdmin({ planners: [planner] });
  const proxy = await holdingProxy(env.fake.origin);
  try {
    await env.store.save({
      ...env.store.publicConfig(),
      origin: proxy.origin,
    });
    proxy.state.hold = true;
    await env.call("POST", "/api/autonomy/participate", { participate: true });
    const id = env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
    await until(() => proxy.state.entered.length === 1, "action write held");
    const busy = await env.call("POST", "/api/update/quiesce", {
      confirm: true,
    });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error, "UPDATE_BUSY");
    assert.equal((await env.status()).local.safeToReplace, false);
    proxy.release();
    await until(
      () => env.fake.state.work.get(id).status === "completed",
      "the in-flight cycle completes undisturbed",
    );
    assert.equal(env.fake.state.reports[0].counts.acted, 1);
    // The completion's answer (and its ledger settlement) lands locally.
    await until(
      async () => !(await env.status()).local.busy,
      "the completion answer settles locally",
    );
    const quiesced = await env.call("POST", "/api/update/quiesce", {
      confirm: true,
    });
    assert.equal(quiesced.status, 200, JSON.stringify(quiesced.body));
    const s = await env.status();
    assert.equal(s.local.state, "stopped");
    assert.equal(s.participate, true, "quiesce does not opt out");
    const next = env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(env.fake.state.work.get(next).status, "queued");
    const released = await env.call("POST", "/api/update/release", {});
    assert.equal(released.status, 200);
    await until(
      async () => (await env.status()).local.state !== "stopped",
      "release resumes autonomy",
    );
  } finally {
    await env.close();
    await proxy.close();
  }
});

test("C5/R4: an unknown action outcome blocks replacement and every new claim until an exact receipt read proves it; participation then resumes", async () => {
  const planner = new ScriptedRuntime([
    async ({ call }) => {
      await call(REPORT_TOOL, { slot: "r1", text: "Private." });
      return acted(["r1"]);
    },
  ]);
  const settle = new ScriptedRuntime([async () => acted(["r1"])]);
  const env = await autonomyAdmin({
    planners: [planner, settle],
    proofThrottleMs: 0,
  });
  const proxy = await holdingProxy(env.fake.origin);
  try {
    await env.store.save({
      ...env.store.publicConfig(),
      origin: proxy.origin,
    });
    proxy.state.hold = true;
    await env.call("POST", "/api/autonomy/participate", { participate: true });
    const id = env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
    await until(() => proxy.state.entered.length === 1, "action write held");
    // Opting out aborts the cycle mid-write: the outcome is now unknown.
    const off = await env.call("POST", "/api/autonomy/participate", {
      participate: false,
    });
    assert.equal(off.status, 200);
    assert.equal(off.body.local.state, "stopped");
    assert.equal(off.body.local.unknownOutcome, true);
    assert.equal(off.body.local.safeToReplace, false);
    // The held write commits upstream after the client gave up on it, while
    // its exact receipt read is unavailable.
    proxy.state.intercept = (method, url) =>
      method === "GET" && /\/actions\/r1$/.test(url.split("?")[0])
        ? { status: 503, body: { code: "AUTONOMY_UNAVAILABLE" } }
        : undefined;
    proxy.release();
    await until(
      () => env.fake.state.work.get(id).actions.length === 1,
      "the write committed upstream",
    );
    const refused = await env.call("POST", "/api/update/quiesce", {
      confirm: true,
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, "WORKER_STOP_UNCONFIRMED");
    // Participating again with the work due again: nothing is claimed while
    // the write is unresolved (R4), however often the scheduler looks.
    await env.call("POST", "/api/autonomy/participate", { participate: true });
    env.fake.advance(LEASE_MS);
    const mark = env.fake.calls.length;
    await until(
      () =>
        env.fake.calls
          .slice(mark)
          .filter((c) => c.method === "GET" && /status=due/.test(c.path))
          .length >= 5,
      "the scheduler saw the due work repeatedly",
    );
    const held = await env.status();
    assert.equal(held.local.unknownOutcome, true);
    assert.equal(held.local.safeToReplace, false);
    assert.equal(
      env.fake.calls.slice(mark).filter((c) => /\/work\/claim$/.test(c.path))
        .length,
      0,
      "no claim while the write is unresolved",
    );
    assert.equal(env.fake.state.work.get(id).lease_generation, 1);
    // The exact receipt read (independent reconciliation) proves the write
    // and clears the fence; only then does the next cycle run. Nothing is
    // ever replayed.
    proxy.state.intercept = undefined;
    await until(
      () => env.fake.state.work.get(id).status === "completed",
      "the settling cycle completes after settlement",
    );
    await until(async () => {
      const v = await env.status();
      return v.local.state === "idle" && v.local.unresolvedWrites === 0;
    }, "settled and idle");
    await env.call("POST", "/api/autonomy/participate", { participate: false });
    const quiesced = await env.call("POST", "/api/update/quiesce", {
      confirm: true,
    });
    assert.equal(quiesced.status, 200, JSON.stringify(quiesced.body));
    const acts = env.fake.calls.filter(
      (c) => c.method === "PUT" && c.path.includes("/actions/"),
    );
    assert.equal(acts.length, 1, "the uncertain write was never replayed");
  } finally {
    await env.close();
    await proxy.close();
  }
});
