import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "../src/worker/runner.js";
import { taskFixture } from "./task-fixtures.js";

const result = JSON.stringify({
  general_advice: "A bounded observation.",
  workout_directives: [],
  meal_recommendations: [],
  recovery_recommendations: [],
});

test("actual daily worker ignores malformed optional baseline and retains legacy recall", async () => {
  const fixture = await taskFixture({
    memory: true,
    context: { daily_baseline: { schema: "unknown" } },
  });
  const inputs: string[] = [];
  const worker = new Worker({
    origin: fixture.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async (input) => {
      if (JSON.parse(input).generation_task) inputs.push(input);
      return result;
    },
  });
  try {
    fixture.enqueue("daily_insight");
    await worker.pollOnce();
    assert.equal(
      inputs.length,
      1,
      "optional malformed extension must not block generation",
    );
    assert.equal(JSON.parse(inputs[0]).daily_baseline, undefined);
    assert.ok(
      fixture.calls.some((c) => c.name === "coach_memory_recall"),
      "legacy recall remains",
    );
    assert.equal(fixture.saved.length, 1);
  } finally {
    await worker.stop();
    await fixture.close();
  }
});
