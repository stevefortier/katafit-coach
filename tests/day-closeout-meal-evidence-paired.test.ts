import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { complete } from "../src/runtime/piAdapter.js";
import { Worker } from "../src/worker/runner.js";
import { closeServer, pairedSkip } from "./helpers/account-backend.js";
import { answer } from "./helpers/continuity.js";
import {
  startTaskBackend,
  type TaskPairedBackend,
} from "./helpers/task-backend.js";

// The REAL backend day_closure producer, lease/context, ordinary activity and
// friends REST, and canonical publisher, paired with the real Worker and Pi
// adapter. Only the model is scripted: this proves what the provider received
// before its first turn, not live model compliance.

const P = "coach.tasks.v1";
const CAP = "coach.capability.v1";
const closeout = {
  activity_feedback: { reaction: "check", reply_worthwhile: true },
  general_advice:
    "Every scheduled meal is complete as of the snapshot. Keep tomorrow simple.",
  day_closeout_meal_assessment:
    "The saved foods for the completed meals were read before this closeout.",
};
const toolText = (m: any) =>
  typeof m.content === "string"
    ? m.content
    : (m.content ?? []).map((p: any) => p.text ?? "").join("");

async function scriptedProvider(onFirst: () => void) {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    res.setHeader("Content-Type", "text/event-stream");
    // Post-result memory extraction runs tool-less; it proposes nothing here.
    if (!body.tools?.length) return void res.end(answer('{"proposals":[]}'));
    if (!bodies.length) onFirst();
    bodies.push(body);
    res.end(answer(JSON.stringify(closeout)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    bodies,
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    close: () => closeServer(server),
  };
}

async function day(b: TaskPairedBackend, scope: "personal" | "dojo") {
  await b.reset();
  const { db, ObjectId } = b;
  const user = new ObjectId(),
    chief = new ObjectId(),
    dojo = new ObjectId();
  await db.collection("users").insertOne({
    _id: user,
    timezone: "UTC",
    external_coach_agent: { enabled: true, allow_hosted_fallback: false },
    privacy_settings: Object.fromEntries(
      ["meal", "workout", "metric", "media", "survey"].map((type) => [
        type,
        ["dojo_chief"],
      ]),
    ),
  });
  if (scope === "dojo") {
    const plan = new ObjectId();
    await db.collection("users").insertOne({ _id: chief, timezone: "UTC" });
    await db.collection("dojos").insertOne({
      _id: dojo,
      chief_id: chief,
      workout_plan_id: plan,
      external_coach_agent: { enabled: true },
    });
    await db.collection("member_nutrition_overlays").insertOne({
      member_id: user,
      activity_plan_id: plan,
      daily_targets: {
        calories: 2400,
        protein_g: 160,
        carbs_g: 260,
        fat_g: 70,
        water_ml: 3000,
      },
    });
    const policy = b.backendModule("./core/dojoMembershipPolicy");
    for (const [id, role] of [
      [user, "member"],
      [chief, "chief"],
    ])
      await policy.insertDojoMembership(db, {
        user_id: id,
        dojo_id: dojo,
        role,
        joined_at: new Date(Date.now() - 60000),
      });
    // A different principal prescription catches chief attribution.
    await db.collection("strategies").insertOne({
      user_id: chief,
      status: "active",
      created_at: new Date(),
      data: { nutrition_plan: { daily_calories: 5000, protein_g: 300 } },
    });
  }
  await db.collection("strategies").insertOne({
    user_id: user,
    status: "active",
    created_at: new Date(),
    data: {
      nutrition_plan: {
        daily_calories: 2400,
        protein_g: 160,
        carbs_g: 260,
        fat_g: 70,
        water_ml: 3000,
      },
    },
  });
  const food = new ObjectId();
  await db.collection("foods").insertOne({
    _id: food,
    name: "Synthetic bowl",
    calories: 600,
    protein: 40,
    carbs: 60,
    fat: 20,
  });
  const meal = (name: string, foods: any[]) => ({
    _id: new ObjectId(),
    user_id: user,
    type: "meal",
    name,
    status: "complete",
    is_template: false,
    created_at: new Date(),
    completed_at: new Date(),
    ...(scope === "dojo" ? { dojo_id: dojo } : {}),
    data: { foods },
  });
  const meals = [
    meal("Synthetic lunch", [
      {
        food_id: String(food),
        instance_id: String(new ObjectId()),
        name: "Synthetic bowl",
        quantity: 1,
        unit: "serving",
      },
    ]),
    ...(scope === "personal" ? [meal("Synthetic snack", [])] : []),
  ];
  await db.collection("activities").insertMany(meals);
  const service = b.backendModule("./core/personalExternalCoach");
  const { token } = await service.createCredential(
    String(scope === "dojo" ? chief : user),
    { name: "Synthetic meal evidence worker" },
    { restUserAccess: true },
  );
  // Advertise the kind (a worker-ready owner), then close the day.
  await b.tasks.claim(await service.authenticateCredential(token), {
    protocol: P,
    kinds: ["day_closure"],
    capability_protocols: [CAP],
  });
  const lifecycle = b.backendModule(
    "./core/activityLifecycle",
  ).publishActivityLifecycleToCoach;
  const closed = await lifecycle(
    String(user),
    meals.at(-1),
    "activity_completed",
    { db, debounceMs: 0 },
  );
  assert.equal(closed.dayClosure?.queued, true);
  return { user, meals: meals.map((m) => String(m._id)), token };
}

async function runWorker(b: TaskPairedBackend, token: string) {
  let p: Awaited<ReturnType<typeof scriptedProvider>> | undefined;
  let w: Worker | undefined;
  const firstTurn: string[] = [];
  try {
    p = await scriptedProvider(() => firstTurn.push(...b.calls));
    const provider = p;
    w = new Worker({
      origin: b.origin,
      token,
      system: "Synthetic Coach persona",
      complete: (context, signal, system, tools) =>
        complete(
          {
            baseUrl: provider.baseUrl,
            model: "synthetic-model",
            apiKey: "synthetic-provider-credential",
            secrets: [token],
          },
          system,
          context,
          signal,
          tools,
        ),
    });
    const error = await w.pollOnce().then(
      () => undefined,
      (e: Error) => e,
    );
    const first = provider.bodies[0];
    const user = first?.messages.find(
      (m: any) => m.role === "user" && toolText(m).includes("generation_task"),
    );
    return {
      error,
      state: w.state,
      firstTurn,
      calls: [...b.calls],
      raw: JSON.stringify(first ?? {}),
      envelope: user ? JSON.parse(toolText(user)) : undefined,
    };
  } finally {
    await w?.stop();
    await p?.close();
  }
}

test(
  "day closeout meal evidence, paired with the real backend producer, routes and publisher",
  { skip: pairedSkip, timeout: 600000 },
  async (t) => {
    let b: TaskPairedBackend | undefined;
    try {
      b = await startTaskBackend();
      const backend = b;
      backend.backendModule("./core/externalDayClosureCoachTasks").register();
      backend.app.use(
        "/api/friends",
        backend.backendModule("./routes/friends"),
      );
      const closure = backend.backendModule(
        "./core/externalDayClosureCoachTasks",
      );
      const published = (user: any) =>
        backend.db
          .collection("recommendations")
          .countDocuments({ user_id: user, source: "external_agent" });

      await t.test(
        "personal: canonical self detail, saved foods, empty foods and own day targets reach the provider",
        async () => {
          const { user, meals, token } = await day(backend, "personal");
          const r = await runWorker(backend, token);
          assert.equal(r.error, undefined, String(r.error));
          assert.equal(r.state, "task-result-stored");
          assert.deepEqual(r.firstTurn, [
            `GET /api/activities/${meals[0]} 200`,
            `GET /api/activities/${meals[1]} 200`,
          ]);
          assert.ok(!r.calls.some((c) => c.startsWith("GET /api/user/")));
          const acquired = r.envelope.acquired_meal_evidence;
          assert.equal(acquired.subject, "self");
          const [lunch, snack] = acquired.meals;
          assert.equal(lunch.read, "ok");
          assert.deepEqual(lunch.foods, [
            { name: "Synthetic bowl", quantity: 1, unit: "serving" },
          ]);
          assert.equal(lunch.nutrition_summary.calories, 600);
          assert.equal(lunch.nutrition_summary.protein, 40);
          assert.equal(lunch.targets.read, "ok");
          assert.equal(lunch.targets.source, "own_activity_detail");
          assert.equal(lunch.targets.values.calories, 2400);
          assert.equal(lunch.targets.values.protein, 160);
          assert.equal(snack.read, "ok");
          assert.equal(snack.foods_empty, true);
          const snapshot = JSON.parse(
            r.envelope.evidence.observations.find(
              (o: any) => o.label === "Day closeout snapshot",
            ).text,
          );
          assert.equal(acquired.seed_as_of, snapshot.as_of);
          assert.equal(await closure.consumePending(backend.db), 1);
          assert.equal(await published(user), 1);
        },
      );

      await t.test(
        "Dojo requester: nested peer detail and exact feed targets, never the chief's prescription",
        async () => {
          const { user, meals, token } = await day(backend, "dojo");
          const r = await runWorker(backend, token);
          assert.equal(r.error, undefined, String(r.error));
          assert.equal(r.state, "task-result-stored");
          assert.deepEqual(r.firstTurn, [
            `GET /api/friends/activity/${meals[0]} 200`,
            "GET /api/friends/feed/dojo 200",
          ]);
          assert.ok(!r.calls.some((c) => c.startsWith("GET /api/user/")));
          assert.ok(!r.calls.some((c) => c.startsWith("GET /api/activities/")));
          const acquired = r.envelope.acquired_meal_evidence;
          assert.equal(acquired.subject, "dojo_requester");
          const [lunch] = acquired.meals;
          assert.equal(lunch.read, "ok");
          assert.deepEqual(lunch.foods, [
            { name: "Synthetic bowl", quantity: 1, unit: "serving" },
          ]);
          assert.equal(lunch.nutrition_summary.protein, 40);
          assert.equal(lunch.targets.read, "ok");
          assert.equal(lunch.targets.source, "dojo_feed");
          assert.equal(lunch.targets.coverage, "partial");
          assert.equal(lunch.targets.values.calories, 2400);
          assert.equal(lunch.targets.values.protein, 160);
          assert.doesNotMatch(r.raw, /5000/);
          assert.equal(await closure.consumePending(backend.db), 1);
          assert.equal(await published(user), 1);
        },
      );
    } finally {
      await b?.close();
    }
  },
);
