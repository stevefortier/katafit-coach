import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/config/store.js";
import { autonomyRunner } from "../src/autonomy/runner.js";
import { AutonomyBackend } from "../src/autonomy/backend.js";
import {
  HeadlessCycleRuntime,
  HeadlessFailure,
  type HeadlessRun,
} from "../src/autonomy/headless.js";
import { CleanupRegistry } from "../src/autonomy/cleanup.js";
import { pairedSkip } from "./helpers/account-backend.js";
import { startAutonomyBackend } from "./helpers/autonomy-backend.js";
import { outcome, ScriptedRuntime } from "./helpers/autonomy-cycle.js";
import { holdingProxy } from "./helpers/autonomy-admin.js";
import { fakeEngine, IMAGE } from "./helpers/headless-engine.js";

const gate = { skip: pairedSkip, timeout: 60000 };
// Each control owns a fresh disposable backend. No production auth/config or
// database is read. Date-only advancement leaves HTTP and Mongo timers real.
async function scene(t: TestContext, seconds = 120, freeze = true) {
  const b = await startAutonomyBackend();
  let dir: string | undefined;
  t.after(async () => {
    t.mock.timers.reset();
    t.mock.restoreAll();
    try {
      await b.close();
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });
  const token = await b.bearer();
  const controller = new AbortController();
  const backend = new AutonomyBackend(b.origin, token, controller.signal, [
    token,
  ]);
  const observer = new AutonomyBackend(
    b.origin,
    token,
    new AbortController().signal,
    [token],
  );
  const defaults = await backend.mandate();
  await b.saveMandate({
    mode: "observe",
    timezone: "UTC",
    delegated_actions: ["manager_report"],
    budgets: { ...defaults.budgets, cycle_seconds: seconds },
    digest: {
      enabled: false,
      local_time: "18:00",
      weekdays: [0],
      suppress_empty: true,
    },
  });
  const mandate = await backend.mandate(); // machine view includes capabilities
  assert.ok(mandate.mandate_id);
  dir = await mkdtemp(join(tmpdir(), "deadline0210-controls-"));
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: b.origin,
    token,
    apiKey: "synthetic-deadline-key",
    provider: { baseUrl: b.origin + "/v1", model: "synthetic-model" },
  });
  const origin = Date.now();
  if (freeze) t.mock.timers.enable({ apis: ["Date"], now: origin });
  const queued = await b.enqueue(mandate.mandate_id);
  const claimed = await backend.claimCycle({ lease_seconds: 120 });
  assert.ok(claimed);
  assert.equal(claimed.work.id, String(queued._id));
  const work = await backend.start(
    claimed.work.id,
    claimed.work.lease_generation,
  );
  const expires = Date.parse(work.timeout_at!);
  const run = (
    runtime: { run(run: HeadlessRun): Promise<{ text: string }> },
    client = backend,
  ) =>
    autonomyRunner({ store, runtime })({
      work,
      mandate,
      backend: client,
      capability: claimed.capability,
      signal: controller.signal,
    });
  const receipt = () =>
    observer.completionReceipt(work.id, work.lease_generation);
  const stored = () =>
    b.db.collection("coach_autonomy_work").findOne({ _id: queued._id });
  const noCompletion = async () => {
    assert.equal((await receipt()).receipt, null);
    assert.equal(
      await b.db
        .collection("coach_autonomy_reports")
        .countDocuments({ work_id: queued._id }),
      0,
    );
  };
  const blocked = async (
    result: Awaited<ReturnType<typeof run>>,
    reason = "budget_exhausted",
  ) => {
    const exact = await receipt();
    const row = await stored();
    assert.equal(result.outcome.result, "blocked");
    assert.equal(result.outcome.blocked_reason, reason);
    assert.equal(exact.state, "committed");
    assert.equal(exact.receipt?.report_id, result.report_id);
    assert.equal(exact.receipt?.status_after, "blocked");
    assert.equal(row.status, "blocked");
    assert.equal(row.blocked_reason, reason);
    assert.ok(Date.parse(exact.receipt!.committed_at) < expires);
    assert.equal(
      await observer.claimCycle(),
      null,
      "no replay of blocked identities",
    );
  };
  return {
    b,
    backend,
    observer,
    controller,
    token,
    store,
    work,
    mandate,
    origin,
    expires,
    run,
    receipt,
    stored,
    blocked,
    noCompletion,
  };
}

test(
  "deadline controls: claim/start delay reduces runtime admission instead of extending authority",
  gate,
  async (t) => {
    const s = await scene(t);
    t.mock.timers.setTime(s.origin + 10_000);
    let runs = 0;
    const result = await s.run({
      async run(run) {
        runs++;
        assert.ok(
          run.cycleMs < s.expires - Date.now(),
          "settlement reserve stays inside claim timeout",
        );
        assert.ok(run.deadlineAt! < s.expires);
        assert.equal(run.cycleMs, run.deadlineAt! - Date.now());
        t.mock.timers.setTime(Date.now() + run.cycleMs + 1000);
        throw new HeadlessFailure("HEADLESS_TIMEOUT");
      },
    });
    assert.equal(runs, 1);
    await s.blocked(result);
  },
);

test(
  "deadline controls: short valid budget settles without launching inference",
  gate,
  async (t) => {
    const s = await scene(t, 30);
    let runs = 0;
    const result = await s.run({
      async run() {
        runs++;
        return { text: outcome() };
      },
    });
    assert.equal(runs, 0);
    assert.equal(result.outcome.budget.provider_tokens, 0);
    assert.equal(result.outcome.budget.tool_calls, 0);
    await s.blocked(result);
  },
);

test(
  "deadline controls: slow setup consumes inference time and settles without provider work",
  gate,
  async (t) => {
    const s = await scene(t);
    const reports = s.backend.reports.bind(s.backend);
    t.mock.method(s.backend, "reports", async (...args) => {
      const result = await reports(...args);
      t.mock.timers.setTime(s.origin + 70_000);
      return result;
    });
    let runs = 0;
    const result = await s.run({
      async run() {
        runs++;
        return { text: outcome() };
      },
    });
    assert.equal(runs, 0);
    await s.blocked(result);
  },
);

test(
  "deadline controls: already expired authority is denied by runner and unchanged backend lease checks",
  gate,
  async (t) => {
    const s = await scene(t);
    t.mock.timers.setTime(s.expires);
    let runs = 0;
    await assert.rejects(
      s.run({
        async run() {
          runs++;
          return { text: outcome() };
        },
      }),
      (e: any) => e.code === "LEASE_LOST",
    );
    assert.equal(runs, 0);
    await assert.rejects(
      s.backend.complete(s.work.id, {
        lease_generation: s.work.lease_generation,
        mandate_revision: s.work.mandate_revision,
        outcome: JSON.parse(outcome()),
      }),
      (e: any) => e.code === "LEASE_LOST" && e.status === 409,
    );
    await s.noCompletion();
  },
);

test(
  "deadline controls: reserve overrun stays visibly unsettled, never claims closure",
  gate,
  async (t) => {
    const s = await scene(t);
    let runs = 0;
    await assert.rejects(
      s.run({
        async run() {
          runs++;
          t.mock.timers.setTime(s.expires + 1); // daemon/gateway stall consumed the entire reserve
          throw new HeadlessFailure("HEADLESS_TIMEOUT");
        },
      }),
      (e: any) => e.code === "LEASE_LOST",
    );
    assert.equal(runs, 1);
    await s.noCompletion();
  },
);

test(
  "deadline controls: cancellation at inference timeout never dispatches completion",
  gate,
  async (t) => {
    const s = await scene(t);
    const cancelled = new Error("synthetic pause");
    await assert.rejects(
      s.run({
        async run(run) {
          t.mock.timers.setTime(Date.now() + run.cycleMs);
          s.controller.abort(cancelled);
          throw new HeadlessFailure("HEADLESS_TIMEOUT");
        },
      }),
      (e) => e === cancelled,
    );
    await s.noCompletion();
  },
);

test(
  "deadline controls: independent lease loss still rejects terminal completion",
  gate,
  async (t) => {
    const s = await scene(t);
    await assert.rejects(
      s.run({
        async run() {
          await s.b.expire(s.work.id); // real disposable-Mongo authority loss
          throw new HeadlessFailure("HEADLESS_TIMEOUT");
        },
      }),
      (e: any) => e.code === "LEASE_LOST" && e.status === 409,
    );
    await s.noCompletion();
  },
);

test(
  "deadline controls: unknown action dominates timeout and fences every later action",
  gate,
  async (t) => {
    const s = await scene(t);
    const proxy = await holdingProxy(s.b.origin);
    t.after(() => proxy.close());
    proxy.state.rewrite = (method, path) =>
      method === "PUT" && path.includes("/actions/")
        ? { unexpected: true }
        : undefined;
    proxy.state.intercept = (method, path) =>
      method === "GET" && path.includes("/actions/")
        ? { status: 503, body: { code: "AUTONOMY_UNAVAILABLE" } }
        : undefined;
    const backend = new AutonomyBackend(
      proxy.origin,
      s.token,
      s.controller.signal,
      [s.token],
    );
    let cutoff = 0;
    const scripted = new ScriptedRuntime([
      async ({ call }) => {
        const first = await call("coach_autonomy_report", {
          slot: "unknown-first",
          text: "Synthetic private report.",
        });
        assert.match(JSON.stringify(first), /AUTONOMY_OUTCOME_UNKNOWN/);
        const later = await call("coach_autonomy_report", {
          slot: "forbidden-later",
          text: "Must not be dispatched.",
        });
        assert.match(JSON.stringify(later), /AUTONOMY_OUTCOME_UNKNOWN/);
        t.mock.timers.setTime(cutoff + 1000);
        throw new HeadlessFailure("HEADLESS_TIMEOUT");
      },
    ]);
    const result = await s.run(
      {
        async run(run) {
          cutoff = run.deadlineAt!;
          return scripted.run(run);
        },
      },
      backend,
    );
    assert.deepEqual(scripted.errors, []);
    assert.equal(scripted.runs.length, 1);
    assert.equal(
      proxy.state.requests.filter((r) =>
        r.path.endsWith("/actions/forbidden-later"),
      ).length,
      0,
    );
    assert.equal(
      (await s.stored()).actions.length,
      1,
      "first action actually committed despite synthetic lost ACK",
    );
    assert.equal((await s.stored()).actions[0].slot, "unknown-first");
    await s.blocked(result, "uncertain_write");
  },
);

test(
  "deadline controls: ordinary success retains canonical completion",
  gate,
  async (t) => {
    const s = await scene(t);
    const scripted = new ScriptedRuntime([
      async () =>
        outcome({
          decisions: [
            {
              subject_id: String(s.b.member),
              decision: "no_action",
              action_slots: [],
              follow_up_ids: [],
            },
          ],
        }),
    ]);
    const result = await s.run(scripted);
    assert.deepEqual(scripted.errors, []);
    assert.equal(scripted.runs.length, 1);
    assert.equal(result.outcome.result, "completed");
    const exact = await s.receipt();
    assert.equal(exact.state, "committed");
    assert.equal(exact.receipt?.result, "completed");
    assert.equal(exact.receipt?.report_id, result.report_id);
    assert.equal((await s.stored()).status, "completed");
    assert.equal(await s.observer.claimCycle(), null);
  },
);

test(
  "deadline controls: real headless timeout, abort, delayed teardown and HTTP/Mongo settlement",
  gate,
  async (t) => {
    const s = await scene(t, 120, false);
    const fake = await fakeEngine((command, pi) => {
      if (command.type === "prompt" || command.type === "abort")
        pi.send({
          id: command.id,
          type: "response",
          command: command.type,
          success: true,
        });
      // Deliberately never emits agent_end: the real headless timer must fire.
    });
    t.after(() => fake.close());
    const cleanup = await CleanupRegistry.open(s.store.dir, "a".repeat(32));
    const exec = fake.engine.exec;
    let removedAt = 0;
    const runtime = new HeadlessCycleRuntime({
      image: IMAGE,
      cleanup,
      engine: {
        ...fake.engine,
        exec: async (...args) => {
          if (args[1].includes("rm"))
            await new Promise((r) => setTimeout(r, 150));
          const result = await exec(...args);
          if (args[1].includes("rm")) removedAt = Date.now();
          return result;
        },
      },
    });
    // Shorten only this disposable row, never extend the actual 120s authority.
    // Keep 55s settlement room plus 800ms real inference, no Date virtualization.
    const until = Date.now() + 55_800;
    await s.b.db.collection("coach_autonomy_work").updateOne(
      { _id: new s.b.ObjectId(s.work.id) },
      {
        $set: {
          timeout_at: new Date(until),
          lease_expires_at: new Date(until),
        },
      },
    );
    s.work.timeout_at = new Date(until).toISOString();
    s.work.lease_expires_at = s.work.timeout_at;
    let admittedAt = 0;
    let admittedMs = 0;
    const result = await s.run({
      async run(run) {
        admittedAt = Date.now();
        admittedMs = run.cycleMs;
        return runtime.run(run);
      },
    });
    assert.ok(admittedMs > 0 && admittedMs <= 800);
    assert.ok(
      removedAt >= admittedAt + admittedMs,
      "actual timer fired before delayed teardown returned",
    );
    assert.deepEqual(
      fake.commands.map((c) => c.type),
      ["prompt", "abort"],
    );
    assert.equal(fake.creates().length, 1);
    assert.equal(fake.removes().length, 1);
    assert.equal(fake.daemon.containers.size, 0);
    assert.equal(cleanup.pending, 0);
    assert.equal(runtime.active, false);
    await s.blocked(result);
    const exact = await s.receipt();
    assert.ok(Date.parse(exact.receipt!.committed_at) >= removedAt);
    assert.ok(Date.parse(exact.receipt!.committed_at) < until);
    t.diagnostic(
      JSON.stringify({
        realClock: true,
        admittedMs,
        teardownAfterCutoffMs: removedAt - admittedAt - admittedMs,
        receipt: exact,
      }),
    );
  },
);
