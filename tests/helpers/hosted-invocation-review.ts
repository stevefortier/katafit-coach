import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { Fixture } from "./invocation-successor.js";
/** Canonical synthetic inputs, not manually inserted proposals or memory proofs. */
export async function hostedReviewFixture(
  t: Fixture,
  kind = "nutrition_target_adjustment",
) {
  const b = t.b;
  let plan: any,
    entry: any,
    template: any,
    media: any,
    strategy: any,
    memory: any,
    originalLLM: any;
  const hostedBodies: any[] = [];
  const O = b.ObjectId,
    now = new Date();
  plan = new O();
  entry = new O();
  template = new O();
  media = new O();
  const meal = new O();
  const shared = kind !== "member_workout_plan_adjustment";
  assert.ok(shared);
  const dojoId = new O(t.mandate.dojo_id);
  // Ordinary hosted production is deliberately selected, not external selected-work routing.
  // Hosted initiation is authenticated human HTTP; only approval is isolated-native.
  await b.db.collection("users").updateOne(
    { _id: b.user },
    {
      $set: {
        "external_coach_agent.enabled": false,
        gender: "male",
        height: 175,
        ai_coach_settings: {},
        privacy_settings: Object.fromEntries(
          ["workout", "meal", "media", "metric", "survey"].map((t) => [
            t,
            ["dojo_chief"],
          ]),
        ),
      },
    },
  );
  await b.db
    .collection("exercises")
    .insertOne({ _id: "Squat", name: "Squat", category: "strength" });
  await b.db.collection("activities").insertMany([
    {
      _id: template,
      user_id: b.user,
      type: "workout",
      is_template: true,
      name: "Strength",
      data: {
        exercises: [
          {
            _id: new O(),
            exercise_id: "Squat",
            sets: [{ repetitions: 5, weight: 20 }],
          },
        ],
      },
    },
    {
      _id: media,
      user_id: b.user,
      type: "media",
      is_template: true,
      name: "Progress photos",
      data: {
        requirements: ["Front view (shirtless)"],
        global_constraints: [],
      },
    },
    {
      _id: meal,
      user_id: b.user,
      type: "meal",
      is_template: true,
      name: "Lunch",
      data: { nutrition_target: { calories: 1000, protein_g: 50 } },
    },
    {
      _id: new O(),
      user_id: b.user,
      type: "workout",
      status: "complete",
      created_at: now,
      completed_at: now,
      data: {
        exercises: [
          {
            exercise_id: "Squat",
            sets: [{ weight: 20, repetitions: 5, complete: true }],
          },
        ],
      },
    },
    {
      _id: new O(),
      user_id: b.user,
      type: "status_change",
      created_at: now,
      data: { status: "normal" },
    },
  ]);
  await b.db.collection("activity_plans").insertOne({
    _id: plan,
    user_id: b.user,
    title: "Real synthetic plan",
    entries: [
      {
        _id: entry,
        activity_id: template,
        instruction: "do_workout_generated_automatically_in_advance",
        recurrence_number: 1,
        recurrence_unit: "weeks",
      },
      {
        _id: new O(),
        activity_id: media,
        instruction: "upload_media",
        recurrence_number: 1,
        recurrence_unit: "weeks",
      },
      {
        _id: new O(),
        activity_id: meal,
        instruction: "eat_meal",
        recurrence_number: 1,
        recurrence_unit: "days",
      },
    ],
  });
  await b.db.collection("users").updateOne(
    { _id: b.user },
    {
      $set: { affiliation: [{ activity_plan_id: plan, source: "personal" }] },
    },
  );
  if (shared) {
    const dojo = await b.db.collection("dojos").findOne({ _id: dojoId });
    strategy = new O();
    await b.db.collection("dojos").updateOne(
      { _id: dojo._id },
      {
        $set: {
          "external_coach_agent.enabled": false,
          workout_plan_id: plan,
          active_strategy_id: strategy,
        },
      },
    );
    await b.db.collection("strategies").insertOne({
      _id: strategy,
      user_id: b.user,
      status: "active",
      created_at: now,
      started_at: now,
      data: {
        name: "Shared strategy",
        primary_goal: "strength",
        summary: "Steady training",
        phases: [],
        milestones: [],
        nutrition_plan: {
          daily_calories: 2000,
          protein_g: 120,
          carbs_g: 200,
          fat_g: 80,
          water_ml: 2000,
          meals_per_day: 3,
        },
        workout_plan: {
          sessions: [
            {
              name: "Strength",
              exercises: [
                { exercise_id: "Squat", name: "Squat", sets: 1, reps: 5 },
              ],
            },
          ],
        },
      },
    });
    if (kind === "media_requirements_adjustment") strategy = undefined;
  }
  const service = b.backendModule("./core/personalExternalCoach");
  const issued = await service.createCredential(
    String(b.user),
    {
      name: "Synthetic production caller",
      scopes: service.ALL_SCOPES.filter((s: string) => s !== "proposals:write"),
    },
    { restUserAccess: true },
  );
  const auth = await service.authenticateCredential(issued.token),
    M = b.backendModule("./core/coachMemory"),
    S = b.backendModule("./core/studioCoachRead").authority;
  const member = shared
    ? (await S.members(await S.context(b.db, auth))).find((r: any) =>
        r.user.equals(b.user),
      )
    : null;
  memory = (
    await M.execute(auth, "studio_memory_create", {
      idempotency_key: "native-production-memory",
      audience: shared ? "member_coach" : "member_private",
      ...(member ? { member_ref: member.dto.member_ref } : {}),
      kind: "preference",
      text: "Use achievable training prescriptions: three sets of eight squats, small 100-calorie increases and side progress views.",
      importance: 0.9,
      pinned: true,
    })
  ).item;
  const llm = b.backendModule("./core/llm");
  originalLLM = llm.createChatCompletion;
  llm.createChatCompletion = async (params: any) => {
    hostedBodies.push(params);
    const wire = JSON.stringify(params.messages),
      composer = wire.includes("isolated no-tools audience composer");
    if (composer) {
      assert.deepEqual(params.tools, []);
      assert.equal(params.tool_choice, "none");
      assert.ok(!wire.includes(memory.id) && !wire.includes(memory.text));
      assert.deepEqual(JSON.parse(params.messages[1].content).selected_kinds, [
        kind,
      ]);
    } else {
      assert.ok(wire.includes(memory.id) && wire.includes(memory.text));
    }
    let out: any;
    if (strategy) {
      out = {
        assessment: composer
          ? "Shared source review"
          : "Conservative preference",
        on_track: true,
        recommendation: "adjust",
        adjustments: ["Review achievable change"],
        ai_message: "Review this conservative change.",
      };
      if (kind === "dojo_workout_plan_adjustment")
        out.updated_workout_plan = {
          sessions: [
            {
              name: "Strength",
              exercises: [
                { exercise_id: "Squat", name: "Squat", sets: 3, reps: 8 },
              ],
            },
          ],
        };
      else
        out.updated_nutrition_plan = {
          daily_calories: 2100,
          protein_g: 120,
          carbs_g: 225,
          fat_g: 80,
          water_ml: 2000,
          meals_per_day: 3,
        };
    } else {
      out = {
        general_advice: "Review achievable programming.",
        workout_recommendations: [],
        meal_recommendations: [],
        workout_directives: [],
      };
      if (kind === "media_requirements_adjustment")
        out.media_requirement_update = {
          additions: ["Side view (shirtless)"],
          reason: "Use canonical progress evidence.",
        };
      else
        out.exercise_adjustment_proposal = {
          reason: "Achievable prescriptions.",
          sessions: [
            {
              entry_id: String(entry),
              name: "Strength",
              exercises: [
                {
                  exercise_id: "Squat",
                  name: "Squat",
                  sets: 3,
                  reps: "8",
                  proposal_status: "adjusted",
                },
              ],
            },
          ],
        };
    }
    if (!composer) out.memory_citations = { [kind]: [memory.id] };
    return {
      choices: [
        { finish_reason: "stop", message: { content: JSON.stringify(out) } },
      ],
    };
  };
  const human = b
    .backendModule("jsonwebtoken")
    .sign({ user_id: String(b.user) }, process.env.JWT_SECRET);
  const require = createRequire(
    process.env.COACH_BACKEND_ROOT + "/package.json",
  );
  for (const n of [
    "./core/recommendations",
    "./core/strategy",
    "./routes/recommendations",
    "./routes/strategy",
  ])
    delete require.cache[require.resolve(n)];
  b.backendModule("./core/coachMemorySourceEpochs").instrument(b.db);
  b.app.use("/api", b.backendModule("./routes/plans"));
  b.app.use("/api", b.backendModule("./routes/strategy"));
  b.app.use("/api", b.backendModule("./routes/recommendations"));

  return {
    plan,
    entry,
    template,
    media,
    strategy,
    memory,
    hostedBodies,
    close: () => {
      b.backendModule("./core/llm").createChatCompletion = originalLLM;
      b.backendModule(
        "./core/coachActivityEvents",
      ).__resetCoachInsightSchedulerForTests();
    },
  };
}
