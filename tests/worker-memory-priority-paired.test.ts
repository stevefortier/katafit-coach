import test from "node:test";
import assert from "node:assert/strict";
// Deliberately qualify the built shipping Worker and Pi adapter.
import { Worker } from "../dist/worker/runner.js";
import { complete } from "../dist/runtime/piAdapter.js";
import {
  memoryBackendEnabled,
  startBackend,
  startProvider,
  isExtraction,
} from "./helpers/memory-backend.js";

for (const kind of [
  "daily_insight",
  "activity_reaction",
  "exercise_suggestions",
]) {
  test(
    `compiled Worker publishes ${kind} through real Mongo without entering held recovery`,
    { skip: !memoryBackendEnabled, timeout: 90000 },
    async () => {
      const backend = await startBackend();
      const { db, service, ObjectId } = backend;
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const memory = backend.require("./core/coachMemory");
      const execute = memory.execute;
      memory.execute = async (auth: unknown, name: string, input: unknown) => {
        if (name === "coach_memory_pending") {
          entered.resolve();
          await gate.promise;
        }
        return execute(auth, name, input);
      };
      let worker: Worker | undefined;
      let poll: Promise<void> | undefined;
      let generations = 0;
      const provider = await startProvider((body) => {
        if (isExtraction(body)) return '{"proposals":[]}';
        generations++;
        if (kind === "daily_insight")
          return JSON.stringify({
            general_advice: "Synthetic readiness acknowledged.",
            meal_recommendations: [],
            recovery_recommendations: [],
            workout_directives: [],
          });
        if (kind === "activity_reaction")
          return JSON.stringify({
            activity_feedback: { reaction: "check", reply_worthwhile: false },
            general_advice: "",
          });
        // Require the real backend's completed-set inventory in the provider input.
        const raw = body.messages.findLast(
          (m: any) => m.role === "user",
        ).content;
        const envelope = JSON.parse(
          typeof raw === "string"
            ? raw
            : raw.find((p: any) => p.type === "text").text,
        );
        const observation = envelope.evidence.observations.find(
          (o: any) => o.label === "Eligible reaction targets",
        );
        const targets = JSON.parse(observation.text).filter(
          (t: any) => t.target_type === "set_completed",
        );
        assert.equal(targets.length, 1);
        return JSON.stringify({
          summary: "",
          reply_worthwhile: false,
          reactions: targets.map((t: any) => ({
            target_event_key: t.target_event_key,
            reaction: "eyes",
          })),
        });
      });
      try {
        const user = new ObjectId();
        await db.collection("users").insertOne({
          _id: user,
          display_name: "Synthetic latency member",
          timezone: "UTC",
          external_coach_agent: { enabled: true },
        });
        const token = (await service.createCredential(String(user), {})).token;
        const auth = await service.authenticateCredential(token);
        await backend.require("./core/externalCoachTasks").claim(auth, {
          protocol: "coach.tasks.v1",
          kinds: [kind],
          lease_seconds: 120,
        });
        const exercise = {
          _id: new ObjectId(),
          exercise_id: new ObjectId(),
          name: "Synthetic press",
          sets: [
            { _id: new ObjectId(), complete: true, weight: 20, repetitions: 8 },
          ],
          conversation_log: [
            {
              type: "set_complete",
              timestamp: new Date(),
              data: { set_index: 0, weight: 20, repetitions: 8 },
            },
          ],
        };
        const activity = {
          _id: new ObjectId(),
          user_id: user,
          type:
            kind === "daily_insight"
              ? "status_change"
              : kind === "activity_reaction"
                ? "meal"
                : "workout",
          name: "Synthetic latency source",
          status: kind === "exercise_suggestions" ? "ongoing" : "complete",
          created_at: new Date(),
          started_at: new Date(),
          completed_at: new Date(Date.now() - 60000),
          data:
            kind === "daily_insight"
              ? { status: "good", note: "Synthetic readiness" }
              : { exercises: [exercise] },
        };
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
          else
            await backend
              .require("./core/workoutExternalSuggestions")
              .routeBatch(db, String(user), activity, {
                workoutExerciseId: String(exercise._id),
              });
        }
        worker = new Worker({
          origin: backend.origin,
          token,
          system: "Synthetic Coach",
          complete: (
            context: string,
            signal: AbortSignal,
            system: string,
            tools: any[],
            _ref: string,
            budget: any,
          ) =>
            complete(
              {
                baseUrl: provider.origin + "/v1",
                model: "synthetic-latency",
                apiKey: "synthetic-key",
              },
              system,
              context,
              signal,
              tools,
              budget,
            ),
        });
        const attempt = worker.pollOnce() as Promise<void>;
        poll = attempt;
        const outcome = await Promise.race([
          attempt.then(() => "accepted"),
          entered.promise.then(() => "blocked"),
        ]);
        assert.equal(
          outcome,
          "accepted",
          "post-publication recovery must not block task admission",
        );
        assert.equal(generations, 1);
        if (kind === "daily_insight")
          await backend
            .require("./core/externalDailyCoachTasks")
            .consumePending(db);
        else if (kind === "activity_reaction")
          await backend
            .require("./core/externalActivityCoachTasks")
            .consumePending(db);
        else {
          await new Promise<void>((r) => setImmediate(r));
          await backend
            .require("./core/workoutExternalSuggestions")
            .publicationsIdle();
          await backend
            .require("./core/workoutExternalSuggestions")
            .processCompleted(db);
        }
        const tasks = await db
          .collection("external_coach_tasks")
          .find({ kind })
          .toArray();
        assert.equal(tasks.length, 1);
        assert.equal(tasks[0].status, "consumed");
        assert.equal(worker.safeToReplace, true);
      } finally {
        gate.resolve();
        await poll?.catch(() => {});
        await worker?.stop();
        memory.execute = execute;
        await provider.close();
        await backend.close();
      }
    },
  );
}
