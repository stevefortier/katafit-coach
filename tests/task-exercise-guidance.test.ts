import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "../src/worker/runner.js";
import { taskFixture } from "./task-fixtures.js";
import { parseTaskResult } from "../src/katafit/tasks.js";

const exerciseId = "b".repeat(24);

function assertGuidance(system: string) {
  assert.match(system, /Exercise guidance fixed constraints/);
  assert.match(
    system,
    /override conflicting editable or disabled skill guidance/,
  );
  assert.match(system, /1 or 2 short sentences/);
  assert.match(system, /recommendations\[exercise_id\]\.summary/);
  assert.match(system, /exercise_suggestions\.summary/);
  assert.match(system, /concrete rep\/weight target/);
  assert.match(
    system,
    /prior-session history even when the current exercise has no logged sets/,
  );
  assert.match(
    system,
    /context, living context, or recalled memory before additional reads/,
  );
  assert.match(system, /acquire relevant authorized history/);
  assert.match(system, /discovery.*history/);
  assert.match(system, /requester.*not.*principal/);
  assert.match(system, /holding the current prescription.*recovery/);
  assert.match(system, /conditional next-set target/);
  assert.match(
    system,
    /Do not invent performance, loads, equipment increments/,
  );
  assert.match(
    system,
    /internal IDs in prose, routine workout-expiry reminders, or repeated approval boilerplate/,
  );
  assert.match(system, /exact JSON identifier keys/);
  assert.match(system, /target_weight, target_reps, and target_working_sets/);
  assert.match(system, /approval.*mutation.*privacy/);
}

// The completion boundary is scripted: these tests qualify the real Worker's
// delivered policy, validation and canonical JSON, not live-model adherence.
test("workout start delivers fixed concise progression policy and preserves exact targets", async () => {
  const evidence = {
    timezone: "UTC",
    observations: [
      {
        label: "Exercise",
        text: JSON.stringify({
          workout_exercise_id: exerciseId,
          name: "Cable crunch",
          sets: [],
        }),
      },
      {
        label: "Prior session",
        text: "Cable crunch: 4 sets of 12 at 50 lb, controlled reps with 2 reps in reserve. Available next load: 55 lb.",
      },
    ],
    conversation: [],
  };
  const expected = {
    recommendations: {
      [exerciseId]: {
        summary: "Try 4 sets of 12 at 55 lb, keeping the same controlled form.",
        target_weight: 55,
        target_reps: 12,
        target_working_sets: 4,
      },
    },
  };
  const fixture = await taskFixture({ evidence });
  const captures: { input: string; system: string; output: unknown }[] = [];
  const worker = new Worker({
    origin: fixture.origin,
    token: "synthetic-worker-credential",
    system: "CUSTOM_CONFLICT: explain at length and repeat approval policy.",
    complete: async (input, _signal, system) => {
      captures.push({ input, system, output: expected });
      return JSON.stringify(expected);
    },
  });
  try {
    fixture.enqueue("workout_suggestions");
    await worker.pollOnce();
    assert.equal(captures.length, 1);
    assertGuidance(captures[0].system);
    assert.ok(
      captures[0].system.indexOf("Exercise guidance fixed constraints") >
        captures[0].system.indexOf("CUSTOM_CONFLICT"),
    );
    assert.ok(captures[0].input.includes(exerciseId));
    assert.ok(captures[0].input.includes("Prior session"));
    assert.deepEqual(
      fixture.saved.map((c) => c.result),
      [expected],
    );
    assert.equal(
      fixture.restCalls.length,
      0,
      "proposed targets do not apply prescription mutations",
    );
  } finally {
    try {
      await worker.stop();
    } finally {
      await fixture.close();
    }
    if (process.env.CONCISE_PROGRESSION_EVIDENCE_DIR) {
      await mkdir(process.env.CONCISE_PROGRESSION_EVIDENCE_DIR, {
        recursive: true,
      });
      await writeFile(
        join(
          process.env.CONCISE_PROGRESSION_EVIDENCE_DIR,
          "workout-start.json",
        ),
        JSON.stringify(captures, null, 2) + "\n",
      );
    }
  }
});

for (const kind of ["workout_suggestions", "exercise_suggestions"] as const) {
  for (const scenario of [
    "initial-missing-history",
    "followup-recovery",
  ] as const) {
    test(`${kind} ${scenario} keeps scoped policy through structural repair`, async () => {
      const followup = scenario === "followup-recovery";
      const summary = followup
        ? "Hold 50 lb for 10 controlled reps today; stop if the discomfort returns."
        : "Start with 12 reps at 50 lb; if form stays controlled with 2 reps in reserve, aim for 13 on the next set.";
      const targets = {
        summary,
        target_weight: 50,
        target_reps: followup ? 10 : 12,
      };
      const reactions = [
        { target_event_key: "completed-set-1", reaction: "eyes" },
      ];
      const expected =
        kind === "workout_suggestions"
          ? { recommendations: { [exerciseId]: targets } }
          : { ...targets, reply_worthwhile: true, reactions };
      const fixture = await taskFixture({
        evidence: {
          timezone: "UTC",
          observations: [
            {
              label: "Exercise",
              text: JSON.stringify({
                workout_exercise_id: exerciseId,
                name: "Cable crunch",
                sets: [{ reps: 12, weight: 50, completed: followup }],
              }),
            },
            ...(kind === "exercise_suggestions"
              ? [
                  {
                    label: "Eligible reaction targets",
                    text: JSON.stringify([
                      {
                        target_event_key: "completed-set-1",
                        target_type: "set_completed",
                      },
                    ]),
                  },
                ]
              : []),
          ],
          conversation: followup
            ? [
                {
                  role: "user",
                  text: "Some discomfort today; should I push heavier?",
                  created_at: "2026-10-27T12:00:00.000Z",
                },
              ]
            : [],
        },
      });
      const captures: { input: string; system: string; output: unknown }[] = [];
      const signals: AbortSignal[] = [];
      const worker = new Worker({
        origin: fixture.origin,
        token: "synthetic-worker-credential",
        system: "Synthetic Coach; no editable exercise skills enabled.",
        complete: async (input, signal, system, tools) => {
          signals.push(signal);
          assert.ok(
            tools?.some((t) => t.name === "katafit_rest_request"),
            "authorized on-demand history acquisition remains available",
          );
          const output =
            captures.length === 0
              ? { ...expected, unrecognized_field: true }
              : expected;
          captures.push({ input, system, output });
          return JSON.stringify(output);
        },
      });
      try {
        fixture.enqueue(kind);
        await worker.pollOnce();
        assert.equal(captures.length, 2);
        for (const capture of captures) assertGuidance(capture.system);
        assert.match(
          captures[1].system,
          /previous result failed local validation/,
        );
        assert.ok(!captures[1].system.includes("unrecognized_field"));
        assert.equal(
          signals[0],
          signals[1],
          "repair keeps the same invocation budget",
        );
        assert.deepEqual(
          fixture.saved.map((c) => c.result),
          [expected],
        );
        assert.equal(fixture.restCalls.length, 0);
        assert.ok(!fixture.calls.some((c) => c.name.includes("renew")));
      } finally {
        try {
          await worker.stop();
        } finally {
          await fixture.close();
        }
        if (process.env.CONCISE_PROGRESSION_EVIDENCE_DIR) {
          await mkdir(process.env.CONCISE_PROGRESSION_EVIDENCE_DIR, {
            recursive: true,
          });
          await writeFile(
            join(
              process.env.CONCISE_PROGRESSION_EVIDENCE_DIR,
              `${kind}-${scenario}.json`,
            ),
            JSON.stringify(captures, null, 2) + "\n",
          );
        }
      }
    });
  }
}

test("completed-set reaction-only result remains silent under concise guidance", async () => {
  const fixture = await taskFixture({
    evidence: {
      timezone: "UTC",
      conversation: [],
      observations: [
        {
          label: "Eligible reaction targets",
          text: JSON.stringify([
            { target_event_key: "set-1", target_type: "set_completed" },
          ]),
        },
      ],
    },
  });
  const expected = {
    summary: "",
    reply_worthwhile: false,
    reactions: [{ target_event_key: "set-1", reaction: "eyes" }],
  };
  const worker = new Worker({
    origin: fixture.origin,
    token: "synthetic-worker-credential",
    system: "Coach",
    complete: async (_input, _signal, system) => {
      assertGuidance(system);
      assert.match(
        system,
        /exactly one reaction for each offered completed-set target/,
      );
      assert.match(
        system,
        /required reaction alone does not require a summary/,
      );
      return JSON.stringify(expected);
    },
  });
  try {
    fixture.enqueue("exercise_suggestions");
    await worker.pollOnce();
    assert.deepEqual(
      fixture.saved.map((c) => c.result),
      [expected],
    );
  } finally {
    try {
      await worker.stop();
    } finally {
      await fixture.close();
    }
  }
});

for (const kind of ["daily_insight", "activity_followup"] as const) {
  test(`${kind} does not receive inline exercise policy`, async () => {
    const fixture = await taskFixture();
    const expected =
      kind === "daily_insight"
        ? {
            general_advice: "Keep going.",
            meal_recommendations: [],
            recovery_recommendations: [],
            workout_directives: [],
          }
        : { text: "Keep going." };
    let system = "";
    const worker = new Worker({
      origin: fixture.origin,
      token: "synthetic-worker-credential",
      system: "Coach",
      complete: async (_input, _signal, prompt) => {
        system = prompt;
        return JSON.stringify(expected);
      },
    });
    try {
      fixture.enqueue(kind);
      await worker.pollOnce();
      assert.ok(!system.includes("Exercise guidance fixed constraints"));
      if (kind === "daily_insight")
        assert.match(system, /Daily insight fixed constraints/);
      assert.deepEqual(
        fixture.saved.map((c) => c.result),
        [expected],
      );
    } finally {
      try {
        await worker.stop();
      } finally {
        await fixture.close();
      }
    }
  });
}

test("conciseness is generation policy, not prose rejection or truncation", () => {
  const summary =
    "Hold the current load. Discomfort is relevant. Stop if pain returns. Ask for help if it persists.";
  const expected = { summary, reply_worthwhile: true, reactions: [] };
  assert.deepEqual(
    parseTaskResult("exercise_suggestions", JSON.stringify(expected), []),
    expected,
  );
});
