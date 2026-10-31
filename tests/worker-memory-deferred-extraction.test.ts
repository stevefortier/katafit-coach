import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import * as runner from "../src/worker/runner.js";
import type { LogInput } from "../src/diagnostics/log.js";
import { taskFixture } from "./task-fixtures.js";

const results: Record<string, unknown> = {
  daily_insight: {
    general_advice: "Synthetic daily encouragement.",
    meal_recommendations: [],
    recovery_recommendations: [],
    workout_directives: [],
  },
  activity_reaction: {
    activity_feedback: { reaction: "check", reply_worthwhile: false },
    general_advice: "",
  },
  exercise_suggestions: {
    summary: "",
    reply_worthwhile: false,
    reactions: [{ target_event_key: "set-a", reaction: "eyes" }],
  },
};
const evidence = {
  timezone: "UTC",
  conversation: [],
  observations: [
    { label: "Synthetic private observation", text: "SYNTHETIC-PRIVATE-NOTE" },
    {
      label: "Eligible reaction targets",
      text: JSON.stringify([
        { target_event_key: "set-a", target_type: "set_completed" },
      ]),
    },
  ],
};
const token = "synthetic-worker-credential";
const { Worker } = runner;
// Documented fixed mapping; absent before the telemetry repair (RED).
const TASK_KIND_CODES: Record<string, number> =
  (runner as any).TASK_KIND_CODES ?? {};

// Distinguish extraction from typed generation by the actual Worker seam.
const extraction = (context: string) => {
  try {
    return JSON.parse(context).origin === "task";
  } catch {
    return false;
  }
};

function harness(f: Awaited<ReturnType<typeof taskFixture>>) {
  const order: string[] = [];
  const diagnostics: LogInput[] = [];
  let active = 0;
  let peak = 0;
  let hold: PromiseWithResolvers<void> | undefined;
  const entered: PromiseWithResolvers<void>[] = [];
  const worker = new Worker({
    origin: f.origin,
    token,
    system: "Coach",
    onDiagnostic: (event) => diagnostics.push(event),
    complete: async (context) => {
      active++;
      peak = Math.max(peak, active);
      try {
        if (extraction(context)) {
          order.push("extract");
          entered.shift()?.resolve();
          await hold?.promise;
          return JSON.stringify({ proposals: [] });
        }
        const kind = JSON.parse(context).generation_task.kind;
        order.push("generate:" + kind);
        return JSON.stringify(results[kind]);
      } finally {
        active--;
      }
    },
  });
  return {
    worker,
    order,
    diagnostics,
    peak: () => peak,
    holdExtraction() {
      hold = Promise.withResolvers<void>();
      const enter = Promise.withResolvers<void>();
      entered.push(enter);
      return { entered: enter.promise, release: () => hold!.resolve() };
    },
  };
}
const count = (f: any, name: string) =>
  f.calls.filter((c: any) => c.name === name).length;

for (const kind of [
  "daily_insight",
  "activity_reaction",
  "exercise_suggestions",
]) {
  test(`${kind} accepted capture defers held extraction behind next completed-set feedback, then recovers exactly once`, async () => {
    const f = await taskFixture({ memoryCaptures: true, evidence });
    const h = harness(f);
    const held = h.holdExtraction();
    let first: Promise<void> | undefined;
    try {
      const t1 = f.enqueue(kind);
      const t2 = f.enqueue("exercise_suggestions");
      first = h.worker.pollOnce();
      const outcome = await Promise.race([
        first.then(() => "accepted"),
        held.entered.then(() => "blocked"),
      ]);
      assert.equal(
        outcome,
        "accepted",
        "an accepted capture must not run inline extraction before the next claim",
      );
      assert.deepEqual(h.order, ["generate:" + kind]);
      // Next completed-set feedback is claimed and generated before T1's extraction.
      await h.worker.pollOnce();
      assert.deepEqual(h.order, [
        "generate:" + kind,
        "generate:exercise_suggestions",
      ]);
      assert.equal(count(f, "coach_memory_resume"), 0);
      // Idle maintenance then owns the held extraction serially.
      const third = h.worker.pollOnce();
      await held.entered;
      let settled = false;
      void third.then(() => (settled = true));
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(settled, false, "idle recovery is awaited by its poll");
      held.release();
      await third;
      await h.worker.pollOnce();
      await h.worker.pollOnce();
      assert.deepEqual(h.order, [
        "generate:" + kind,
        "generate:exercise_suggestions",
        "extract",
        "extract",
      ]);
      assert.equal(h.peak(), 1, "provider attempts stay serial");
      for (const task of [t1, t2]) {
        const capture = f.captures.find((c) => c.task_id === task.id);
        assert.equal(capture.status, "committed");
        assert.equal(capture.commits, 1, "each capture commits exactly once");
        // One recovery pass: its listing resume plus retention's own
        // re-resume (existing read, not an extraction replay).
        assert.equal(capture.resumes, 2, "no recovery replay");
      }
      assert.equal(count(f, "coach_claim_task"), 5);
      assert.equal(count(f, "coach_complete_task"), 2, "no task replay");
      assert.equal(f.saved.length, 2);
      // Telemetry: fixed numeric codes with the original poll ref.
      const timing = h.diagnostics.filter((d) => d.stage === "task-timing");
      const accepted = timing.find(
        (d) =>
          d.metadata?.timingCode === 5 &&
          d.metadata?.taskKindCode === TASK_KIND_CODES[kind],
      );
      assert.ok(accepted, "accepted timing carries the task kind code");
      const origin = accepted!.ref;
      assert.match(origin!, /^[0-9a-f-]{36}$/);
      const codes = timing
        .filter((d) => d.ref === origin)
        .map((d) => d.metadata!.timingCode);
      for (const code of [1, 2, 3, 4, 5, 7, 8, 9, 10, 11])
        assert.ok(codes.includes(code), `timing code ${code} for ${kind}`);
      for (const entry of timing.filter((d) => d.ref === origin)) {
        assert.equal(entry.metadata!.taskKindCode, TASK_KIND_CODES[kind]);
        assert.equal(typeof entry.metadata!.elapsedMs, "number");
      }
      const recovered = timing.find(
        (d) => d.ref === origin && d.metadata?.timingCode === 11,
      );
      assert.equal(typeof recovered!.metadata!.sinceAcceptedMs, "number");
    } finally {
      held.release();
      await first?.catch(() => {});
      await h.worker.stop();
      await f.close();
    }
  });
}

test("task timing diagnostics are numeric, fixed-code and content-free after log sanitization", async () => {
  const { Diagnostics } = await import("../src/diagnostics/log.js");
  const f = await taskFixture({ memoryCaptures: true, evidence });
  const h = harness(f);
  const dir = await mkdtemp(tmpdir() + "/task-timing-privacy-");
  const log = new Diagnostics(dir);
  try {
    f.enqueue("daily_insight");
    await h.worker.pollOnce();
    await h.worker.pollOnce();
    for (const event of h.diagnostics) log.record(event);
    const entries = log
      .snapshot()
      .entries.filter((e: any) => e.stage === "task-timing");
    assert.ok(entries.length >= 9);
    const allowed = new Set([
      "taskKindCode",
      "timingCode",
      "elapsedMs",
      "sinceAcceptedMs",
      "leaseGeneration",
      // Bounded 48-bit task-attempt digest and 1-based output attempt.
      "attemptDigest",
      "outputAttempt",
    ]);
    for (const entry of entries) {
      for (const [key, value] of Object.entries(entry.metadata)) {
        assert.ok(allowed.has(key), key);
        assert.equal(Number.isSafeInteger(value), true);
      }
      assert.ok(entry.metadata.taskKindCode <= 9);
      assert.ok(entry.metadata.timingCode <= 11);
      assert.ok(entry.metadata.attemptDigest < 2 ** 48);
      assert.ok((entry.metadata.outputAttempt ?? 1) <= 2);
      const text = JSON.stringify(entry);
      for (const secret of [
        token,
        "SYNTHETIC-PRIVATE-NOTE",
        "Synthetic daily encouragement",
        "daily_insight",
        "set-a",
      ])
        assert.equal(text.includes(secret), false, secret);
    }
  } finally {
    await h.worker.stop();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("without negotiated recovery the accepted capture still extracts inline (durability fallback)", async () => {
  const f = await taskFixture({ memory: true, evidence });
  const h = harness(f);
  try {
    f.enqueue("activity_reaction");
    await h.worker.pollOnce();
    assert.deepEqual(h.order, ["generate:activity_reaction", "extract"]);
  } finally {
    await h.worker.stop();
    await f.close();
  }
});

test("Stop after acceptance leaves the durable capture for one recovery after restart", async () => {
  const f = await taskFixture({ memoryCaptures: true, evidence });
  const h = harness(f);
  const task = f.enqueue("activity_reaction");
  await h.worker.pollOnce();
  await h.worker.stop();
  const capture = f.captures.find((c) => c.task_id === task.id);
  assert.equal(capture.status, "open");
  const restarted = harness(f);
  try {
    await restarted.worker.pollOnce();
    await restarted.worker.pollOnce();
    assert.deepEqual(h.order, ["generate:activity_reaction"]);
    assert.deepEqual(restarted.order, ["extract"]);
    assert.equal(capture.commits, 1);
    assert.equal(count(f, "coach_complete_task"), 1);
    // A restarted Worker has no original ref; recovery still reports codes.
    const ended = restarted.diagnostics.find(
      (d) => d.stage === "task-timing" && d.metadata?.timingCode === 11,
    );
    assert.ok(ended);
    assert.equal(ended!.metadata!.taskKindCode, 0);
  } finally {
    await restarted.worker.stop();
    await f.close();
  }
});

test("a deferred capture too close to expiry is skipped without extraction or commit", async () => {
  const f = await taskFixture({
    memoryCaptures: true,
    evidence,
    captureTtlMs: 4000,
  });
  const h = harness(f);
  try {
    const task = f.enqueue("activity_reaction");
    await h.worker.pollOnce();
    await h.worker.pollOnce();
    assert.deepEqual(h.order, ["generate:activity_reaction"]);
    const capture = f.captures.find((c) => c.task_id === task.id);
    assert.equal(capture.commits, 0);
    assert.equal(count(f, "coach_memory_commit"), 0);
  } finally {
    await h.worker.stop();
    await f.close();
  }
});

test("an unknown task result is never deferred or extracted by its Worker", async () => {
  const f = await taskFixture({
    memoryCaptures: true,
    evidence,
    receiptError: true,
    completionReceipt: (r: any) => ({ ...r, result_sha256: "0".repeat(64) }),
  });
  const h = harness(f);
  try {
    f.enqueue("activity_reaction");
    await assert.rejects(h.worker.pollOnce(), /DELIVERY_UNVERIFIED/);
    assert.equal(
      h.diagnostics.some(
        (d) => d.stage === "task-timing" && d.metadata?.timingCode === 7,
      ),
      false,
    );
    assert.deepEqual(h.order, ["generate:activity_reaction"]);
    assert.equal(h.worker.safeToReplace, false);
  } finally {
    await h.worker.stop();
    await f.close();
  }
});
