import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "../src/worker/runner.js";
import { parseTaskResult, TaskOutputError } from "../src/katafit/tasks.js";
import { taskFixture } from "./task-fixtures.js";

test("repair hints bound structural detail without echoing dynamic keys or values", () => {
  for (const value of [
    {
      recommendations: {
        ["malicious-key-" + "x".repeat(4000)]: { summary: "untrusted-value" },
      },
    },
    {
      recommendations: {
        ["a".repeat(24)]: {
          summary: "",
          "inject-extra-field": "untrusted-value",
        },
      },
    },
    { recommendations: { ["a".repeat(24)]: {} } },
    {
      recommendations: {
        ["a".repeat(24)]: { summary: "", intensity: "inject-enum-value" },
      },
    },
  ]) {
    assert.throws(
      () => parseTaskResult("workout_suggestions", JSON.stringify(value), []),
      (e: any) => {
        assert.ok(e instanceof TaskOutputError);
        assert.ok(e.repairHint.length > 0 && e.repairHint.length <= 1200);
        assert.doesNotMatch(
          e.repairHint,
          /malicious|inject|untrusted|aaaaaaaa/,
        );
        return true;
      },
    );
  }
});

test("JSON and semantic repairs receive fixed actionable reasons", () => {
  for (const [kind, text, hint] of [
    ["activity_followup", "private-malformed-output", /valid JSON syntax/],
    ["workout_suggestions", '{"recommendations":{}}', /between 1 and 40/],
    [
      "activity_reaction",
      '{"activity_feedback":{"reaction":"flex","reply_worthwhile":false},"general_advice":"private-prose"}',
      /reply_worthwhile must equal Boolean/,
    ],
  ] as const) {
    assert.throws(
      () => parseTaskResult(kind, text, []),
      (e: any) => {
        assert.match(e.repairHint, hint as RegExp);
        assert.doesNotMatch(e.repairHint, /private/);
        return true;
      },
    );
  }
});

test("Runner gives workout-specific context-grounded shape and constraints", async () => {
  const ids = ["b".repeat(24), "c".repeat(24)];
  const recommendations = Object.fromEntries(
    ids.map((id) => [id, { summary: "" }]),
  );
  const f = await taskFixture({
    evidence: {
      timezone: "UTC",
      observations: ids.map((id, index) => ({
        label: "Exercise",
        text: JSON.stringify({
          workout_exercise_id: id,
          name: index ? "Row" : "Press",
          sets: [],
        }),
      })),
      conversation: [],
    },
  });
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async (context, _signal, system) => {
      for (const id of ids) assert.ok(context.includes(id));
      assert.match(system, /exact exercise IDs from the workout context/);
      assert.match(system, /1 to 40/);
      assert.match(system, /not an array/);
      assert.match(system, /Do not invent IDs, history, or evidence/);
      assert.match(system, /target_weight.*null/);
      assert.match(system, /24000 UTF-8 bytes/);
      return JSON.stringify({ recommendations });
    },
  });
  try {
    f.enqueue("workout_suggestions");
    await w.pollOnce();
    assert.deepEqual(
      f.saved.map((c) => c.result),
      [{ recommendations }],
    );
  } finally {
    await w.stop();
    await f.close();
  }
});

test("Runner repairs schema-invalid workout output only when given structural reason", async () => {
  const id = "a".repeat(24);
  const f = await taskFixture({
    evidence: {
      timezone: "UTC",
      observations: [
        {
          label: "Exercise",
          text: JSON.stringify({
            workout_exercise_id: id,
            name: "Press",
            sets: [],
          }),
        },
      ],
      conversation: [],
    },
  });
  const prompts: string[] = [];
  const signals: AbortSignal[] = [];
  const bad = JSON.stringify({
    recommendations: {
      [id]: {
        summary: "private rejected prose",
        target_reps: "untrusted-number-text",
      },
    },
  });
  const good = { recommendations: { [id]: { summary: "", target_reps: 8 } } };
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async (_context, signal, system) => {
      prompts.push(system);
      signals.push(signal);
      return system.includes(
        "/recommendations/*/target_reps: must match the allowed types",
      )
        ? JSON.stringify(good)
        : bad;
    },
  });
  try {
    f.enqueue("workout_suggestions");
    await w.pollOnce();
    assert.deepEqual(f.saved[0]?.result, good);
    assert.equal(prompts.length, 2);
    assert.equal(signals[0], signals[1]);
    assert.ok(!prompts[1].includes("private rejected prose"));
    assert.ok(!prompts[1].includes("untrusted-number-text"));
    assert.ok(!prompts[1].includes(id));
    assert.ok(!f.calls.some((c) => c.name.includes("renew")));
  } finally {
    await w.stop();
    await f.close();
  }
});
