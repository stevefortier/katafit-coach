import assert from "node:assert/strict";
import type { startTaskBackend } from "./task-backend.js";

type Backend = Awaited<ReturnType<typeof startTaskBackend>>;
// Exact production registrations: backend index.js and routes/workouts.js.
const modules = [
  "externalActivityCoachTasks",
  "externalDailyCoachTasks",
  "externalDayClosureCoachTasks",
  "externalMediaCoachTasks",
  "workoutExternalCoach",
  "workoutExternalSuggestions",
];
export async function nativeKindInventory(b: Backend, token: string) {
  for (const name of modules) b.backendModule("./core/" + name).register();
  const service = b.backendModule("./core/personalExternalCoach");
  const auth = await service.authenticateCredential(token);
  const capabilities = await b.tasks.capabilities(auth);
  return {
    auth,
    advertised: capabilities.kinds as string[],
    declared: b.tasks.KINDS as string[],
    registrationModules: modules,
  };
}

export async function nativeKindSource(b: Backend, kind: string, auth: any) {
  const { db, user, ObjectId: O } = b;
  const load = (n: string) => b.backendModule("./core/" + n);
  const prose =
    "Fetched target: 3000 kcal, 200 g protein. Native populated memory: easy walk.";
  const row = async () =>
    db.collection("external_coach_tasks").findOne({ kind });
  let result: any, consume: () => Promise<any>, readback: () => Promise<any>;
  if (kind === "daily_insight") {
    await b.checkIn();
    result = {
      general_advice: prose,
      meal_recommendations: [],
      recovery_recommendations: [],
      workout_directives: [],
    };
    consume = () => b.daily.consumePending(db);
    readback = b.published;
  } else if (kind === "activity_reaction" || kind === "day_closure") {
    const meal = await db
      .collection("activities")
      .findOne({ user_id: user, type: "meal" });
    if (kind === "day_closure") {
      await b.tasks.claim(auth, {
        protocol: b.tasks.PROTOCOL,
        kinds: [kind],
        capability_protocols: ["coach.capability.v1"],
      });
      await load("activityLifecycle").publishActivityLifecycleToCoach(
        String(user),
        meal,
        "activity_completed",
        { db, debounceMs: 0 },
      );
    } else
      await load("coachActivityEvents").recordCoachActivityEvent(
        String(user),
        meal,
        "activity_completed",
        { db, debounceMs: 0 },
      );
    result = {
      activity_feedback: { reaction: "chef_kiss", reply_worthwhile: true },
      general_advice: prose,
      ...(kind === "day_closure"
        ? {
            day_closeout_meal_assessment:
              "Synthetic lunch logged against fetched targets.",
          }
        : {}),
    };
    consume = () =>
      load(
        kind === "day_closure"
          ? "externalDayClosureCoachTasks"
          : "externalActivityCoachTasks",
      ).consumePending(db);
    readback = () =>
      db
        .collection("recommendations")
        .find({ kind: "activity_update", user_id: user })
        .toArray();
  } else if (kind === "media_chat") {
    const activity = new O();
    await db
      .collection("activities")
      .insertOne({
        _id: activity,
        user_id: user,
        type: "media",
        status: "pending",
        data: { files: [] },
      });
    await load("mediaCoachChat").recordMediaCoachUserMessage(
      String(user),
      String(activity),
      {
        request_id: "native-media-question",
        text: "How should I approach tomorrow?",
      },
      { db, notify() {} },
    );
    result = { text: prose };
    consume = () => load("externalMediaCoachTasks").consumePending(db);
    readback = () =>
      db
        .collection("media_coach_messages")
        .find({ user_id: user, role: "coach" })
        .toArray();
  } else {
    const workout = {
      _id: new O(),
      user_id: user,
      type: "workout",
      name: "Native synthetic press",
      status: "ongoing",
      started_at: new Date(),
      data: {
        exercises: [
          {
            _id: new O(),
            exercise_id: "native-bench",
            name: "Bench",
            sets: [
              { _id: new O(), complete: false, weight: 20, repetitions: 8 },
            ],
            conversation_log: [],
          },
        ],
      },
    };
    await db
      .collection("exercises")
      .insertOne({ _id: "native-bench", name: "Bench", category: "strength" });
    await db.collection("activities").insertOne(workout);
    if (kind === "workout_chat") {
      await load("workoutCoachThreads").recordWorkoutCoachLifecycle(
        String(user),
        workout,
        "workout_started",
        { db },
      );
      result = { text: prose };
      consume = () =>
        load("workoutExternalCoach").resumeStart(db, String(user), workout._id);
      readback = () =>
        db
          .collection("workout_coach_events")
          .find({
            user_id: user,
            activity_id: workout._id,
            type: "coach_message",
          })
          .toArray();
    } else {
      const single = kind === "exercise_suggestions";
      const routed = await load("workoutExternalSuggestions").routeBatch(
        db,
        String(user),
        workout,
        single
          ? {
              workoutExerciseId: String(workout.data.exercises[0]._id),
              forceReply: true,
            }
          : {},
      );
      assert.equal(routed.generation.status, "pending", JSON.stringify(routed));
      result = single
        ? { summary: prose, reply_worthwhile: true, reactions: [] }
        : {
            recommendations: {
              [String(workout.data.exercises[0]._id)]: { summary: prose },
            },
          };
      consume = async () => {
        const current = await db
          .collection("activities")
          .findOne({ _id: workout._id });
        return single
          ? load("workoutExternalSuggestions").resumeSingle(
              db,
              String(user),
              current,
              String(workout.data.exercises[0]._id),
            )
          : load("workoutExternalSuggestions").resumeBatch(
              db,
              String(user),
              current,
            );
      };
      readback = () =>
        db
          .collection("activities")
          .findOne({ _id: workout._id }, { projection: { _id: 1, data: 1 } });
    }
  }
  assert.ok(await row(), "actual producer must enqueue " + kind);
  return { result, prose, row, consume, readback };
}
