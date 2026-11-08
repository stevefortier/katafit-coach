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
  assertProgression(system);
}

// Next-eligible-set progression: readiness is decided for the next pending
// working set now, never renewed as a next-session deferral.
function assertProgression(system: string) {
  assert.match(system, /next eligible pending working set/);
  assert.match(system, /propose the modest increase for the pending sets now/);
  assert.match(
    system,
    /do not defer it by asking to repeat every set first and increase next session/,
  );
  assert.match(system, /prior conditional advice is not proof/i);
  assert.match(system, /Form and effort are unknown unless/);
  assert.match(system, /concise conditional/);
  assert.match(
    system,
    /pain, fatigue, a current miss, recovery or a program constraint/,
  );
  assert.match(
    system,
    /every set is complete, the target is for next session; never change completed sets/,
  );
  assert.match(system, /no mandatory \+1/);
  assert.match(
    system,
    /recent_sessions are recorded actuals; their prescriptions, target attainment, form and effort are unknown/,
  );
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

// Scenario matrix for next-eligible-set progression. Evidence mirrors the
// app's Exercise observations (per-set actuals in recent_sessions, set phase).
// Completions are scripted: these qualify delivered policy, evidence and
// canonical persistence for both exercise kinds, not live-model adherence.
const actual = (weight: number, ...reps: number[]) =>
  reps.map((repetitions) => ({ weight, repetitions }));
const session = (day: string, weight: number, ...reps: number[]) => ({
  day,
  working_sets: reps.length,
  top_set: { weight, reps: Math.max(...reps) },
  sets: actual(weight, ...reps),
});
const pending = (weight: number, reps: number, done: number, total = 3) =>
  Array.from({ length: total }, (_, index) => ({
    complete: index < done,
    weight,
    repetitions: reps,
  }));
const deferral = {
  role: "coach",
  text: "Repeat 15 on all three sets today, then increase next session.",
  created_at: "2026-10-27T11:58:00.000Z",
};
const progressionScenarios = [
  {
    name: "readiness after repeated all-target sessions progresses the next pending set",
    phase:
      "Set phase: 1 of 3 working sets done; 2 remain. Next-set target first.",
    sets: pending(100, 15, 1),
    recent: [
      session("2026-10-24", 100, 15, 15, 15),
      session("2026-10-20", 100, 15, 15, 15),
    ],
    conversation: [deferral],
    targets: {
      summary:
        "You hit 15 on every set in your last two sessions, so take 105 lb for 12 on the next set.",
      target_weight: 105,
      target_reps: 12,
    },
  },
  {
    name: "top-only history holds the current prescription",
    phase:
      "Set phase: 1 of 3 working sets done; 2 remain. Next-set target first.",
    sets: pending(100, 15, 1),
    recent: [session("2026-10-24", 100, 15, 10, 8)],
    conversation: [deferral],
    targets: {
      summary:
        "Last time reps fell to 10 and 8, so hold 100 lb and aim for 15 on the next set.",
      target_weight: 100,
      target_reps: 15,
    },
  },
  {
    name: "pain or fatigue justifies a hold or backoff",
    phase:
      "Set phase: 1 of 3 working sets done; 2 remain. Next-set target first.",
    sets: pending(100, 15, 1),
    recent: [session("2026-10-24", 100, 15, 15, 15)],
    conversation: [
      {
        role: "user",
        text: "My knee is sore and I'm wiped out today.",
        created_at: "2026-10-27T12:00:00.000Z",
      },
    ],
    targets: {
      summary:
        "With knee soreness, drop to 90 lb for 12 easy reps on the next set.",
      target_weight: 90,
      target_reps: 12,
    },
  },
  {
    name: "unknown form or effort uses conditional wording without an unconditional numeric increase",
    phase:
      "Set phase: 1 of 3 working sets done; 2 remain. Next-set target first.",
    sets: pending(100, 15, 1),
    recent: [session("2026-10-24", 100, 15, 15, 15)],
    conversation: [],
    targets: {
      summary:
        "If that set moved cleanly with reps to spare, try 105 lb next; otherwise stay at 100 lb for 15.",
      target_weight: null,
      target_reps: 15,
    },
  },
  {
    name: "no history gives a conditional first-set target",
    phase: "Set phase: no working sets done yet; 3 remain.",
    sets: pending(50, 12, 0),
    recent: null,
    conversation: [],
    targets: {
      summary:
        "Start with 12 at 50 lb; if it feels easy with good form, add a little load next set.",
      target_weight: 50,
      target_reps: 12,
    },
  },
  {
    name: "completed exercise scopes the target to next session",
    phase: "Set phase: all 3 working sets done; none remain.",
    sets: pending(100, 15, 3),
    recent: [session("2026-10-24", 100, 15, 15, 15)],
    conversation: [],
    targets: {
      summary:
        "All three sets hit 15 again; next session start at 105 lb for 12.",
      target_weight: 105,
      target_reps: 12,
    },
  },
];

for (const kind of ["workout_suggestions", "exercise_suggestions"] as const) {
  for (const scenario of progressionScenarios) {
    test(`${kind}: ${scenario.name}`, async () => {
      const exercise = {
        workout_exercise_id: exerciseId,
        name: "Leg press",
        superset_group: null,
        tracked_fields: ["weight", "repetitions"],
        sets: scenario.sets,
        ...(scenario.recent ? { recent_sessions: scenario.recent } : {}),
      };
      const expected =
        kind === "workout_suggestions"
          ? { recommendations: { [exerciseId]: scenario.targets } }
          : { ...scenario.targets, reply_worthwhile: true, reactions: [] };
      const fixture = await taskFixture({
        evidence: {
          timezone: "UTC",
          observations: [
            { label: "Workout recommendations", text: scenario.phase },
            { label: "Exercise", text: JSON.stringify(exercise) },
          ],
          conversation: scenario.conversation,
        },
      });
      const captures: { input: string; system: string }[] = [];
      const worker = new Worker({
        origin: fixture.origin,
        token: "synthetic-worker-credential",
        system: "Coach",
        complete: async (input, _signal, system) => {
          captures.push({ input, system });
          return JSON.stringify(expected);
        },
      });
      try {
        fixture.enqueue(kind);
        await worker.pollOnce();
        assert.equal(captures.length, 1);
        assertGuidance(captures[0].system);
        assert.ok(captures[0].input.includes(scenario.phase));
        if (scenario.recent)
          assert.ok(
            // Observation text is itself JSON-encoded inside the model input.
            captures[0].input.includes(
              JSON.stringify(JSON.stringify(scenario.recent[0].sets)).slice(
                1,
                -1,
              ),
            ),
            "per-set historical actuals reach the model",
          );
        assert.deepEqual(
          fixture.saved.map((c) => c.result),
          [expected],
        );
        assert.equal(fixture.restCalls.length, 0);
      } finally {
        try {
          await worker.stop();
        } finally {
          await fixture.close();
        }
      }
    });
  }
}
