import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "../src/worker/runner.js";
import { taskFixture } from "./task-fixtures.js";

// Synthetic meal activity review whose backend memory recall exceeds its own
// bounded work limit. Memory is optional context: the typed review proceeds
// once without it. Authority denials still fail closed before the provider.
const evidence = {
  timezone: "UTC",
  observations: [{ label: "Activity", text: "Synthetic completed meal" }],
  conversation: [],
};
const valid = {
  activity_feedback: { reaction: "check", reply_worthwhile: true },
  general_advice: "Synthetic meal note.",
  meal_recommendations: ["Synthetic meal suggestion."],
};

test("activity_reaction memory recall MEMORY_LIMIT degrades to no memory and completes once", async () => {
  const f = await taskFixture({
    evidence,
    memoryRecallFailure: "MEMORY_LIMIT",
  });
  const events: any[] = [];
  let inference = 0;
  const w = new Worker({
    origin: f.origin,
    token: "synthetic-worker-credential",
    system: "Coach",
    complete: async (_context, _signal, system, tools) => {
      inference++;
      assert.deepEqual(tools, []);
      assert.doesNotMatch(system, /Long-term Coach memory/);
      return JSON.stringify(valid);
    },
    onDiagnostic: (e) => events.push(e),
  });
  try {
    f.enqueue("activity_reaction");
    await w.pollOnce();
    const count = (name: string) =>
      f.calls.filter((c) => c.name === name).length;
    assert.equal(count("coach_memory_recall"), 1, "no recall retry");
    assert.equal(inference, 1);
    assert.equal(count("coach_fail_task"), 0);
    assert.equal(count("coach_complete_task"), 1);
    assert.equal(count("coach_memory_commit"), 0);
    assert.deepEqual(
      f.saved.map((s) => s.result),
      [valid],
    );
    assert.equal(w.state, "task-result-stored");
    const degraded = events.find((e) => e.stage === "memory-unavailable");
    assert.equal(degraded?.level, "warn");
  } finally {
    await w.stop();
    await f.close();
  }
});

for (const code of [
  "MEMORY_NOT_AUTHORIZED",
  "LEASE_LOST",
  "CREDENTIAL_REJECTED",
])
  test(`activity_reaction memory recall ${code} fails closed before the provider`, async () => {
    const f = await taskFixture({ evidence, memoryRecallFailure: code });
    let inference = 0;
    const w = new Worker({
      origin: f.origin,
      token: "synthetic-worker-credential",
      system: "Coach",
      complete: async () => {
        inference++;
        return JSON.stringify(valid);
      },
    });
    try {
      f.enqueue("activity_reaction");
      await assert.rejects(w.pollOnce());
      assert.equal(inference, 0);
      assert.equal(f.saved.length, 0);
      assert.equal(
        f.calls.filter((c) => c.name === "coach_complete_task").length,
        0,
      );
    } finally {
      await w.stop();
      await f.close();
    }
  });
