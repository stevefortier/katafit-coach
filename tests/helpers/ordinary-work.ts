import assert from "node:assert/strict";
import type { uncertaintyFixture } from "./native-cross-uncertainty.js";
import { until } from "./autonomy-admin.js";
export type OrdinaryFixture = Awaited<ReturnType<typeof uncertaintyFixture>>;

export async function ordinaryPolicy(
  t: OrdinaryFixture,
  delegated = [
    "rest_mutation",
    "proposal_approval",
    "manager_report",
    "configured_integration",
  ],
  mode = "message",
) {
  const human = t.b
    .backendModule("jsonwebtoken")
    .sign({ user_id: String(t.b.user) }, process.env.JWT_SECRET);
  const {
    protocol,
    mandate_id,
    dojo_id,
    chief_id,
    revision,
    status,
    suspended_reason,
    updated_at,
    updated_by,
    capabilities,
    ...policy
  } = t.mandate;
  const p = await fetch(t.origin + "/api/coach/autonomy/mandate", {
    method: "PUT",
    headers: {
      authorization: "Bearer " + human,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      expected_revision: revision,
      idempotency_key: "ordinary-policy-" + revision,
      mandate: { ...policy, mode, delegated_actions: delegated },
    }),
  });
  assert.equal(p.status, 200, await p.clone().text());
  t.mandate = ((await p.json()) as any).mandate;
}
export async function ordinaryCycle(t: OrdinaryFixture, key: string) {
  const work = await t.enqueue(key),
    host = t.host();
  await host.start();
  try {
    await until(
      () => {
        t.check();
        return host.snapshot().lastWorkId === String(work._id);
      },
      "ordinary native completion",
      45000,
    );
  } finally {
    await host.stop();
  }
  t.check();
  return {
    work,
    snapshot: host.snapshot(),
    canonical: await t.b.db
      .collection("coach_autonomy_work")
      .findOne({ _id: work._id }),
  };
}
export async function seedOrdinaryProposal(t: OrdinaryFixture, kind: string) {
  const O = t.b.backendModule("mongodb").ObjectId;
  const plan = new O(),
    entry = new O(),
    template = new O(),
    proposal = new O(),
    future = new O(),
    owner = t.b.user;
  const workout = kind.includes("workout"),
    metric = kind === "metric_cadence_adjustment",
    scope = kind === "dojo_workout_plan_adjustment" ? "dojo" : "member";
  const type = metric
    ? "metric"
    : workout
      ? "workout"
      : kind === "nutrition_target_adjustment"
        ? "meal"
        : "media";
  const data = metric
    ? { measurements: [{ type_id: "weight" }] }
    : workout
      ? {
          exercises: [
            {
              _id: new O(),
              exercise_id: "Squat",
              sets: [{ repetitions: 5, weight: 20 }],
            },
          ],
        }
      : type === "meal"
        ? { nutrition_target: { calories: 1000, protein_g: 50 } }
        : { requirements: ["Front view"], global_constraints: [] };
  await t.b.db.collection("activities").insertMany([
    {
      _id: template,
      user_id: owner,
      type,
      is_template: true,
      name: "Synthetic session",
      data,
    },
    {
      _id: future,
      user_id: owner,
      type,
      is_template: false,
      status: "pending",
      due_at: new Date(Date.now() + 86400000),
      source: { activity_id: template, activity_plan_entry_id: entry },
      data,
    },
  ]);
  await t.b.db.collection("activity_plans").insertOne({
    _id: plan,
    user_id: owner,
    entries: [
      {
        _id: entry,
        activity_id: template,
        instruction: metric
          ? "take_measurements"
          : workout
            ? "do_workout_generated_automatically_in_advance"
            : type === "meal"
              ? "eat_meal"
              : "upload_media",
        ...(metric ? { recurrence_number: 1, recurrence_unit: "weeks" } : {}),
      },
    ],
  });
  await t.b.db.collection("users").updateOne(
    { _id: owner },
    {
      $set: {
        timezone: "UTC",
        affiliation: [
          {
            activity_plan_id: plan,
            source: scope === "dojo" || type === "meal" ? "dojo" : "personal",
          },
        ],
      },
    },
  );
  if (scope === "dojo" || type === "meal")
    await t.b.db
      .collection("dojos")
      .updateOne(
        { _id: new O(t.mandate.dojo_id) },
        { $set: { workout_plan_id: plan } },
      );
  if (workout)
    await t.b.db
      .collection("exercises")
      .updateOne(
        { _id: "Squat" },
        { $setOnInsert: { name: "Squat" } },
        { upsert: true },
      );
  const fields = metric
    ? {
        activity_plan_id: plan,
        activity_plan_entry_id: entry,
        current_recurrence_number: 1,
        current_recurrence_unit: "weeks",
        proposed_recurrence_number: 1,
        proposed_recurrence_unit: "days",
      }
    : workout
      ? {
          workout_plan_id: plan,
          proposed_changes: [
            {
              type: "replace_workout_session",
              entry_id: String(entry),
              name: "Synthetic stronger session",
              exercises: [
                {
                  exercise_id: "Squat",
                  name: "Squat",
                  sets: 3,
                  reps: 8,
                  proposal_status: "adjusted",
                },
              ],
            },
          ],
        }
      : type === "meal"
        ? {
            member_plan_id: plan,
            new_daily_calories: 2200,
            new_daily_targets: { protein_g: 120 },
          }
        : {
            activity_plan_id: plan,
            member_plan_id: plan,
            media_activity_ids: [String(template)],
            current_requirements: ["Front view"],
            proposed_requirements: ["Front view", "Side view"],
          };
  await t.b.db.collection("coach_strategy_proposals").insertOne({
    _id: proposal,
    kind,
    scope,
    status: "pending",
    created_at: new Date(),
    ...(scope === "dojo"
      ? { dojo_id: new O(t.mandate.dojo_id) }
      : { member_id: owner }),
    ...fields,
  });
  return {
    plan,
    entry,
    template,
    proposal,
    future,
    kind,
    request: {
      method: "POST",
      path: `/api/strategy/proposals/${proposal}/approve`,
      body: {},
    },
  };
}
