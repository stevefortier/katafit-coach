import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "../src/worker/runner.js";
import { complete } from "../src/runtime/piAdapter.js";
import {
  memoryBackendEnabled,
  startBackend,
  startProvider,
  isExtraction,
} from "./helpers/memory-backend.js";

for (const kind of [
  "activity_reaction",
  "daily_insight",
  "day_closure",
  "media_chat",
  "workout_chat",
  "workout_suggestions",
  "exercise_suggestions",
])
  test(
    `paired actual Worker ${kind}: original source extraction, accepted versus consumed publication, no replay`,
    { skip: !memoryBackendEnabled, timeout: 90000 },
    async () => {
      const backend = await startBackend();
      const { db, service, ObjectId } = backend;
      const user = new ObjectId(),
        exercise = {
          _id: new ObjectId(),
          exercise_id: new ObjectId(),
          name: "Synthetic press",
          sets: [],
          conversation_log: [],
        };
      const workout =
        kind.startsWith("workout") || kind === "exercise_suggestions";
      const activity = {
        _id: new ObjectId(),
        user_id: user,
        type: workout
          ? "workout"
          : kind === "media_chat"
            ? "media"
            : kind === "daily_insight"
              ? "status_change"
              : "meal",
        name: "Synthetic original task source",
        status: workout ? "ongoing" : "complete",
        created_at: new Date(),
        started_at: new Date(),
        completed_at: new Date(Date.now() - 60000),
        nutrition_summary: { protein: 42 },
        data:
          kind === "daily_insight"
            ? { status: "good", note: "I prefer calm mornings." }
            : { exercises: [exercise] },
      };
      const result =
        kind === "workout_suggestions"
          ? {
              recommendations: {
                [String(exercise._id)]: { summary: "Start gently." },
              },
            }
          : kind === "exercise_suggestions"
            ? {
                summary: "Start gently.",
                reply_worthwhile: true,
                reactions: [],
              }
            : kind === "media_chat" || kind === "workout_chat"
              ? { text: "Calm morning noted." }
              : kind === "daily_insight"
                ? {
                    general_advice: "Keep it calm.",
                    meal_recommendations: [],
                    recovery_recommendations: [],
                    workout_directives: [],
                  }
                : {
                    activity_feedback: {
                      reaction: "chef_kiss",
                      reply_worthwhile: true,
                    },
                    general_advice: "Source meal has 42g protein.",
                    ...(kind === "day_closure"
                      ? { day_closeout_meal_assessment: "Final meal logged." }
                      : {}),
                  };
      let sourceExtractions = 0;
      const provider = await startProvider((body) => {
        if (!isExtraction(body)) {
          assert.equal(body.tools, undefined);
          return JSON.stringify(result);
        }
        sourceExtractions++;
        const content = body.messages.findLast(
          (m: any) => m.role === "user",
        ).content;
        const input = JSON.parse(
          typeof content === "string"
            ? content
            : content.map((part: any) => part.text ?? "").join(""),
        );
        assert.equal(input.origin, "task");
        assert.ok(input.evidence.task_context);
        assert.deepEqual(input.evidence.task_result, result);
        assert.match(
          JSON.stringify(input.evidence.task_context),
          /Synthetic|calm morning|started a workout/i,
        );
        // Deliberately synthetic extraction output: validates real wiring and
        // authority, not whether a model should select this fact as durable.
        return JSON.stringify({
          proposals: [
            {
              kind: "fact",
              text: `Observed synthetic ${kind} source.`,
              confidence: 0.7,
              importance: 0.7,
            },
          ],
        });
      });
      let worker: Worker | undefined;
      try {
        await db.collection("users").insertOne({
          _id: user,
          display_name: "Synthetic producer member",
          timezone: "UTC",
          external_coach_agent: { enabled: true },
        });
        const token = (await service.createCredential(String(user), {})).token,
          auth = await service.authenticateCredential(token);
        // Advertise the actual supported task family before producing it.
        await backend.require("./core/externalCoachTasks").claim(auth, {
          protocol: "coach.tasks.v1",
          kinds: [kind],
          lease_seconds: 120,
        });
        if (kind === "daily_insight")
          await backend
            .require("./core/externalDailyCoachTasks")
            .recordStatus(db, String(user), activity);
        else {
          await db.collection("activities").insertOne(activity);
          if (kind === "activity_reaction")
            await backend
              .require("./core/coachActivityEvents")
              .recordCoachActivityEvent(
                String(user),
                activity,
                "activity_completed",
                { db, debounceMs: 0 },
              );
          else if (kind === "day_closure")
            await backend
              .require("./core/activityLifecycle")
              .publishActivityLifecycleToCoach(
                String(user),
                activity,
                "activity_completed",
                { db, debounceMs: 0 },
              );
          else if (kind === "media_chat")
            await backend
              .require("./core/mediaCoachChat")
              .recordMediaCoachUserMessage(
                String(user),
                String(activity._id),
                {
                  request_id: "paired-source",
                  text: "I prefer calm morning check-ins.",
                },
                { db, notify: () => {} },
              );
          else if (kind === "workout_chat")
            await backend
              .require("./core/workoutCoachThreads")
              .recordWorkoutCoachLifecycle(
                String(user),
                activity,
                "workout_started",
                { db },
              );
          else
            await backend
              .require("./core/workoutExternalSuggestions")
              .routeBatch(
                db,
                String(user),
                activity,
                kind === "exercise_suggestions"
                  ? { workoutExerciseId: String(exercise._id) }
                  : {},
              );
        }
        worker = new Worker({
          origin: backend.origin,
          token,
          system: "Synthetic Coach prioritizes sustainable habits.",
          complete: (context, signal, system, tools, _ref, budget) =>
            complete(
              {
                baseUrl: provider.origin + "/v1",
                model: "synthetic",
                apiKey: "synthetic-key",
              },
              system,
              context,
              signal,
              tools,
              budget,
            ),
        });
        await worker.pollOnce();
        assert.match(
          worker.state,
          /^task-(result-stored|publication-confirmed)$/,
        );
        const task = await db
          .collection("external_coach_tasks")
          .findOne({ kind });
        assert.equal(task.status, "completed");
        const memory = await db
          .collection("coach_memories")
          .findOne({ "provenance.task_kind": kind });
        assert.ok(
          memory,
          "nonempty automatic task-origin extraction committed",
        );
        const control = backend.require("./core/coachMemory");
        assert.equal(
          (
            await control.execute(auth, "studio_memory_get", {
              memory_id: String(memory._id),
            })
          ).item.availability,
          "unavailable",
        );
        if (kind === "activity_reaction")
          await backend
            .require("./core/externalActivityCoachTasks")
            .consumePending(db);
        else if (kind === "daily_insight")
          await backend
            .require("./core/externalDailyCoachTasks")
            .consumePending(db);
        else if (kind === "day_closure")
          await backend
            .require("./core/externalDayClosureCoachTasks")
            .consumePending(db);
        else if (kind === "media_chat")
          await backend
            .require("./core/externalMediaCoachTasks")
            .consumePending(db);
        else
          await backend
            .require("./core/workoutExternalSuggestions")
            .processCompleted(db);
        assert.equal(
          (
            await db
              .collection("external_coach_tasks")
              .findOne({ _id: task._id })
          ).status,
          "consumed",
        );
        assert.equal(
          (
            await control.execute(auth, "studio_memory_get", {
              memory_id: String(memory._id),
            })
          ).item.availability,
          "available",
        );
        const before = JSON.stringify(
          await db
            .collection("external_coach_tasks")
            .findOne(
              { _id: task._id },
              { projection: { status: 1, result: 1, consumed_at: 1 } },
            ),
        );
        await worker.stop();
        const recovery = new Worker({
          origin: backend.origin,
          token,
          system: "Synthetic Coach",
          complete: async (context) => {
            const input = JSON.parse(context);
            if (input.origin) {
              assert.notEqual(
                input.evidence.task_kind,
                kind,
                "Original task extraction must not replay",
              );
              return JSON.stringify({ proposals: [] });
            }
            // Completing a workout welcome legitimately schedules a distinct
            // suggestion task. Process it without mistaking it for welcome replay.
            assert.equal(kind, "workout_chat");
            assert.equal(input.generation_task.kind, "workout_suggestions");
            return JSON.stringify({
              recommendations: {
                [String(exercise._id)]: { summary: "Start gently." },
              },
            });
          },
        });
        try {
          await recovery.pollOnce();
        } finally {
          await recovery.stop();
        }
        assert.equal(sourceExtractions, 1);
        assert.equal(
          JSON.stringify(
            await db
              .collection("external_coach_tasks")
              .findOne(
                { _id: task._id },
                { projection: { status: 1, result: 1, consumed_at: 1 } },
              ),
          ),
          before,
        );
        await db.collection("activities").deleteOne({ _id: activity._id });
        assert.equal(
          (
            await control.execute(auth, "studio_memory_get", {
              memory_id: String(memory._id),
            })
          ).item.availability,
          "unavailable",
        );
      } finally {
        await worker?.stop();
        await provider.close();
        await backend.close();
      }
    },
  );
