import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "../src/worker/runner.js";
import { taskFixture } from "./task-fixtures.js";
import {
  TaskOutputError,
  validateTaskReactionCoverage,
} from "../src/katafit/tasks.js";

const inventory = (targets: unknown) => ({
  observations: [
    { label: "Eligible reaction targets", text: JSON.stringify(targets) },
  ],
});

test("Reaction coverage preserves legacy contexts and other task kinds", () => {
  const result = { reactions: [] };
  assert.doesNotThrow(() =>
    validateTaskReactionCoverage("exercise_suggestions", result, {}),
  );
  assert.doesNotThrow(() =>
    validateTaskReactionCoverage(
      "daily_insight",
      result,
      inventory("irrelevant"),
    ),
  );
});

test("Offered user-message reactions remain optional; completed sets do not", () => {
  const evidence = inventory([
    { target_event_key: "set-a", target_type: "set_completed" },
    { target_event_key: "message-a", target_type: "user_message" },
  ]);
  const result = {
    reactions: [{ target_event_key: "set-a", reaction: "eyes" }],
  };
  assert.doesNotThrow(() =>
    validateTaskReactionCoverage("exercise_suggestions", result, evidence),
  );
  assert.throws(
    () =>
      validateTaskReactionCoverage(
        "exercise_suggestions",
        { reactions: [] },
        evidence,
      ),
    (error: unknown) =>
      error instanceof TaskOutputError && error.category === "SEMANTIC",
  );
});

test("Malformed or duplicate backend inventories are context failures, not model repair", () => {
  for (const targets of [
    null,
    {},
    [null],
    [{ target_event_key: "a", target_type: "other" }],
    [
      { target_event_key: "a", target_type: "set_completed" },
      { target_event_key: "a", target_type: "set_completed" },
    ],
  ]) {
    assert.throws(
      () =>
        validateTaskReactionCoverage(
          "exercise_suggestions",
          { reactions: [] },
          inventory(targets),
        ),
      /TASK_CONTEXT_INVALID/,
    );
  }
});

for (const first of ["missing", "duplicate", "unknown"] as const) {
  test(`Runner repairs ${first} completed-set reactions before publishing`, async () => {
    const keys = ["set-a", "set-b"];
    const f = await taskFixture({
      evidence: {
        timezone: "UTC",
        conversation: [],
        observations: [
          {
            label: "Eligible reaction targets",
            text: JSON.stringify(
              keys.map((target_event_key) => ({
                target_event_key,
                target_type: "set_completed",
              })),
            ),
          },
        ],
      },
    });
    const signals: AbortSignal[] = [];
    const prompts: string[] = [];
    const good = {
      summary: "",
      reply_worthwhile: false,
      reactions: keys.map((target_event_key) => ({
        target_event_key,
        reaction: "eyes",
      })),
    };
    const bad = {
      ...good,
      reactions:
        first === "missing"
          ? []
          : first === "duplicate"
            ? [good.reactions[0], good.reactions[0], good.reactions[1]]
            : [
                ...good.reactions,
                { target_event_key: "not-offered", reaction: "eyes" },
              ],
    };
    const w = new Worker({
      origin: f.origin,
      token: "worker-secret",
      system: "Coach",
      complete: async (_context, signal, system) => {
        signals.push(signal);
        prompts.push(system);
        return JSON.stringify(prompts.length === 1 ? bad : good);
      },
    });
    try {
      f.enqueue("exercise_suggestions");
      await w.pollOnce();
      assert.equal(
        prompts.length,
        2,
        "missing/invalid acknowledgments require the bounded model correction",
      );
      assert.deepEqual(
        f.saved.map((c) => c.result),
        [good],
      );
      assert.equal(signals[0], signals[1]);
      assert.match(
        prompts[1],
        /exactly one reaction for each offered completed-set target/,
      );
      assert.ok(
        !prompts[1].includes("not-offered"),
        "repair does not echo rejected dynamic keys",
      );
      assert.ok(!f.calls.some((c) => c.name.includes("renew")));
    } finally {
      await w.stop();
      await f.close();
    }
  });
}

test("Runner does not invent a reaction when no set targets were offered", async () => {
  const f = await taskFixture({
    evidence: {
      timezone: "UTC",
      conversation: [],
      observations: [{ label: "Eligible reaction targets", text: "[]" }],
    },
  });
  const result = { summary: "", reply_worthwhile: false, reactions: [] };
  let calls = 0;
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async () => {
      calls++;
      return JSON.stringify(result);
    },
  });
  try {
    f.enqueue("exercise_suggestions");
    await w.pollOnce();
    assert.equal(calls, 1);
    assert.deepEqual(
      f.saved.map((c) => c.result),
      [result],
    );
  } finally {
    await w.stop();
    await f.close();
  }
});

test("Runner refuses a second incomplete reaction result without fabricated fallback", async () => {
  const f = await taskFixture({
    evidence: {
      timezone: "UTC",
      conversation: [],
      observations: [
        {
          label: "Eligible reaction targets",
          text: JSON.stringify([
            { target_event_key: "set-a", target_type: "set_completed" },
          ]),
        },
      ],
    },
  });
  let calls = 0;
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async () => {
      calls++;
      return JSON.stringify({
        summary: "",
        reply_worthwhile: false,
        reactions: [],
      });
    },
  });
  try {
    f.enqueue("exercise_suggestions");
    await assert.rejects(w.pollOnce(), /TASK_OUTPUT_SEMANTIC/);
    assert.equal(calls, 2);
    assert.equal(f.saved.length, 0);
    assert.ok(f.calls.some((c) => c.name === "coach_fail_task"));
  } finally {
    await w.stop();
    await f.close();
  }
});
