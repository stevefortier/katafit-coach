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

// Exercise suggestions route two publication contracts. Automatic
// completed-set feedback (no forceReply) intentionally publishes past ordinary
// evidence edits; an explicit reply (forceReply:true) and a batch keep strict
// source freshness. Either way a stale replacement never retires its input.
for (const variant of [
  "activity_reaction",
  "daily_insight",
  "day_closure",
  "media_chat",
  "workout_chat",
  "workout_suggestions",
  "exercise_suggestions",
  "exercise_suggestions explicit",
])
  for (const consumption of [
    "success",
    "source_revoked",
    ...(variant.startsWith("workout_suggestions") ||
    variant.startsWith("exercise_suggestions")
      ? ["source_aba", "source_edit"]
      : []),
  ])
    test(
      `paired actual Worker ${variant} consolidation ${consumption}: original source extraction, accepted versus consumed publication, no replay`,
      { skip: !memoryBackendEnabled, timeout: 90000 },
      async () => {
        const [kind] = variant.split(" "),
          explicitReply = variant.endsWith(" explicit"),
          automaticFeedback = kind === "exercise_suggestions" && !explicitReply;
        // Strict tasks never publish after a source change. Automatic feedback
        // publishes, but only an unchanged source makes its replacement valid,
        // so only then may the consolidation retire the recalled input.
        const published =
          consumption === "success" ||
          (automaticFeedback && consumption !== "source_revoked");
        const retired = consumption === "success";
        const backend = await startBackend();
        const { db, service, ObjectId } = backend;
        // Exercise suggestions publish automatically after acceptance. Hold the
        // final consume write so that transaction rolls back while this test
        // inspects the accepted-but-unpublished memory and revokes its source.
        // This is a database seam, not a disabled production completion listener.
        let holdPublication = kind === "exercise_suggestions";
        const collection = db.collection.bind(db);
        db.collection = (name: string, ...args: any[]) => {
          const target = collection(name, ...args);
          if (name !== "external_coach_tasks") return target;
          return new Proxy(target, {
            get(target, key) {
              const method = Reflect.get(target, key, target);
              if (key === "updateOne")
                return (...args: any[]) => {
                  if (holdPublication && args[1]?.$set?.status === "consumed")
                    throw new Error("SYNTHETIC_PUBLICATION_HELD");
                  return method.apply(target, args);
                };
              return typeof method === "function"
                ? method.bind(target)
                : method;
            },
          });
        };
        const user = new ObjectId(),
          exercise = {
            _id: new ObjectId(),
            exercise_id: new ObjectId(),
            name: "Synthetic press",
            sets: [
              {
                _id: new ObjectId(),
                complete: false,
                weight: 20,
                repetitions: 8,
              },
            ],
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
        let dynamicSearches = 0;
        let supersededId: string;
        const provider = await startProvider((body) => {
          if (!isExtraction(body)) {
            assert.deepEqual(
              body.tools.map((tool: any) => tool.function.name),
              ["katafit_rest_request", "coach_memory_search"],
              "typed structured final output retains dynamic intermediate tools",
            );
            assert.equal(body.tool_choice === "none", false);
            const search = body.messages.find(
              (m: any) =>
                m.role === "tool" &&
                m.tool_call_id === "producer_memory_search",
            );
            if (!search) {
              dynamicSearches++;
              return {
                tool: "coach_memory_search",
                args: { query: "synthetic source" },
                id: "producer_memory_search",
              };
            }
            assert.match(
              typeof search.content === "string"
                ? search.content
                : JSON.stringify(search.content),
              /Observed synthetic source/,
            );
            return JSON.stringify(result);
          }
          sourceExtractions++;
          const content = body.messages.findLast(
            (m: any) => m.role === "user",
          ).content;
          const input = JSON.parse(
            typeof content === "string"
              ? content
              : content.find((part: any) => part.type === "text").text,
          );
          assert.equal(input.origin, "task");
          assert.ok(input.evidence.task_context);
          if (kind === "workout_suggestions") {
            assert.deepEqual(
              Object.values(input.evidence.task_result.recommendations),
              Object.values(result.recommendations!),
            );
            assert.equal(
              JSON.stringify(input.evidence).includes(String(exercise._id)),
              false,
              "technical navigation handles never enter extraction",
            );
          } else assert.deepEqual(input.evidence.task_result, result);
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
                supersedes: [supersededId],
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
          const token = (await service.createCredential(String(user), {}))
              .token,
            auth = await service.authenticateCredential(token);
          const oldControl = backend.require("./core/coachMemory");
          const oldMemory = (
            await oldControl.execute(auth, "studio_memory_create", {
              idempotency_key: "prior",
              audience: "member_private",
              kind: "fact",
              text: "Observed synthetic source.",
              importance: 0.9,
            })
          ).item;
          supersededId = oldMemory.id;
          await oldControl.execute(auth, "studio_memory_update", {
            memory_id: oldMemory.id,
            expected_revision: oldMemory.revision,
            protected: false,
          });
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
                    ? {
                        workoutExerciseId: String(exercise._id),
                        ...(explicitReply ? { forceReply: true } : {}),
                      }
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
          if (kind === "exercise_suggestions") {
            await new Promise<void>((resolve) => setImmediate(resolve));
            await backend
              .require("./core/workoutExternalSuggestions")
              .publicationsIdle();
          }
          assert.match(
            worker.state,
            /^task-(result-stored|publication-confirmed)$/,
          );
          // An accepted capture extracts through the next idle durable
          // recovery, never inline before the next feedback claim. A welcome's
          // legitimately scheduled suggestions task would (correctly) be
          // admitted first; park it so this poll isolates extraction, then
          // restore it for the unchanged recovery-Worker replay check below.
          const followups = db.collection("external_coach_tasks");
          const parked =
            kind === "workout_chat"
              ? await followups
                  .find({ kind: "workout_suggestions", status: "queued" })
                  .toArray()
              : [];
          for (const row of parked)
            await followups.updateOne(
              { _id: row._id },
              { $set: { status: "parked_by_test" } },
            );
          await worker.pollOnce();
          for (const row of parked)
            await followups.updateOne(
              { _id: row._id },
              { $set: { status: "queued" } },
            );
          const task = await db
            .collection("external_coach_tasks")
            .findOne({ kind });
          assert.equal(task.status, "completed");
          assert.deepEqual(
            task.result,
            result,
            "canonical publication keeps exact structured identities; only extraction redacts them",
          );
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
          assert.equal(
            (
              await db
                .collection("coach_memories")
                .findOne({ _id: new ObjectId(supersededId) })
            ).status,
            "active",
            "pending extraction must preserve the publication input",
          );
          if (consumption === "source_revoked")
            await db.collection("activities").deleteOne({ _id: activity._id });
          const sourceEpoch = async () =>
            (await db.collection("activities").findOne({ _id: activity._id }))
              .memory_source_fields?.data || 0;
          if (consumption === "source_aba") {
            const before = await sourceEpoch();
            await db
              .collection("activities")
              .updateOne(
                { _id: activity._id },
                { $set: { "data.exercises.0.name": "Withdrawn source" } },
              );
            await db
              .collection("activities")
              .updateOne(
                { _id: activity._id },
                { $set: { "data.exercises.0.name": exercise.name } },
              );
            assert.equal(await sourceEpoch(), before + 2);
          }
          if (consumption === "source_edit") {
            const before = await sourceEpoch();
            await db
              .collection("activities")
              .updateOne(
                { _id: activity._id },
                { $set: { "data.exercises.0.name": "Renamed source" } },
              );
            assert.equal(await sourceEpoch(), before + 1);
          }
          holdPublication = false;
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
          if (!published) {
            assert.notEqual(
              (
                await db
                  .collection("external_coach_tasks")
                  .findOne({ _id: task._id })
              ).status,
              "consumed",
            );
            assert.equal(
              (
                await db
                  .collection("coach_memories")
                  .findOne({ _id: new ObjectId(supersededId) })
              ).status,
              "active",
            );
            assert.equal(
              (
                await control.execute(auth, "studio_memory_get", {
                  memory_id: String(memory._id),
                })
              ).item.availability,
              "unavailable",
            );
            return;
          }
          const prior = async () =>
            JSON.stringify(
              await db
                .collection("coach_memories")
                .findOne(
                  { _id: new ObjectId(supersededId) },
                  { projection: { read_fence: 0 } },
                ),
            );
          assert.equal(
            (
              await db
                .collection("coach_memories")
                .findOne({ _id: new ObjectId(supersededId) })
            ).status,
            retired ? "archived" : "active",
            retired
              ? "a valid replacement supersedes its recalled input"
              : "a stale replacement must not retire its recalled input",
          );
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
            retired ? "available" : "unavailable",
          );
          const priorBefore = await prior();
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
            dynamicSearches,
            1,
            "the real typed Pi invocation dynamically acquired memory before its structured final result",
          );
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
          assert.equal(
            await prior(),
            priorBefore,
            "recovery never re-retires or rewrites the recalled input",
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
          db.collection = collection;
          await backend.close();
        }
      },
    );
