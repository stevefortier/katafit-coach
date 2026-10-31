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

// T1 is one of the three latency-sensitive feedback kinds; T2 is the next
// completed-set feedback. A held extractor proves T2 is claimed and generated
// before T1's extraction, and that the real backend lists T1's accepted
// capture for durable recovery immediately (no extraction lease wait).
for (const kind of [
  "daily_insight",
  "activity_reaction",
  "exercise_suggestions",
]) {
  test(
    `compiled Worker defers ${kind} extraction to real-backend recovery behind next completed-set feedback`,
    { skip: !memoryBackendEnabled, timeout: 90000 },
    async () => {
      const backend = await startBackend();
      const { db, service, ObjectId } = backend;
      const order: string[] = [];
      const hold = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      let active = 0;
      let peak = 0;
      const provider = await startProvider(async (body) => {
        active++;
        peak = Math.max(peak, active);
        try {
          if (isExtraction(body)) {
            order.push("extract");
            entered.resolve();
            await hold.promise;
            return '{"proposals":[]}';
          }
          const raw = body.messages.findLast(
            (m: any) => m.role === "user",
          ).content;
          const envelope = JSON.parse(
            typeof raw === "string"
              ? raw
              : raw.find((p: any) => p.type === "text").text,
          );
          const generated = envelope.generation_task.kind;
          order.push("generate:" + generated);
          if (generated === "daily_insight")
            return JSON.stringify({
              general_advice: "Synthetic readiness acknowledged.",
              meal_recommendations: [],
              recovery_recommendations: [],
              workout_directives: [],
            });
          if (generated === "activity_reaction")
            return JSON.stringify({
              activity_feedback: { reaction: "check", reply_worthwhile: false },
              general_advice: "",
            });
          const observation = envelope.evidence.observations.find(
            (o: any) => o.label === "Eligible reaction targets",
          );
          const targets = JSON.parse(observation.text).filter(
            (t: any) => t.target_type === "set_completed",
          );
          return JSON.stringify({
            summary: "",
            reply_worthwhile: false,
            reactions: targets.map((t: any) => ({
              target_event_key: t.target_event_key,
              reaction: "eyes",
            })),
          });
        } finally {
          active--;
        }
      });
      let worker: Worker | undefined;
      let poll: Promise<void> | undefined;
      try {
        const user = new ObjectId();
        await db.collection("users").insertOne({
          _id: user,
          display_name: "Synthetic deferred member",
          timezone: "UTC",
          external_coach_agent: { enabled: true },
        });
        const token = (await service.createCredential(String(user), {})).token;
        const auth = await service.authenticateCredential(token);
        const tasks = backend.require("./core/externalCoachTasks");
        await tasks.claim(auth, {
          protocol: "coach.tasks.v1",
          kinds: [...new Set([kind, "exercise_suggestions"])],
          lease_seconds: 120,
        });
        const suggestions = backend.require(
          "./core/workoutExternalSuggestions",
        );
        const workout = async (name: string) => {
          const exercise = {
            _id: new ObjectId(),
            exercise_id: new ObjectId(),
            name,
            sets: [
              {
                _id: new ObjectId(),
                complete: true,
                weight: 20,
                repetitions: 8,
              },
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
            type: "workout",
            name: "Synthetic deferred workout",
            status: "ongoing",
            created_at: new Date(),
            started_at: new Date(),
            data: { exercises: [exercise] },
          };
          await db.collection("activities").insertOne(activity);
          await suggestions.routeBatch(db, String(user), activity, {
            workoutExerciseId: String(exercise._id),
          });
        };
        if (kind === "daily_insight")
          await backend
            .require("./core/externalDailyCoachTasks")
            .recordStatus(db, String(user), {
              _id: new ObjectId(),
              user_id: user,
              type: "status_change",
              name: "Synthetic deferred readiness",
              status: "complete",
              created_at: new Date(),
              completed_at: new Date(Date.now() - 60000),
              data: { status: "good", note: "Synthetic readiness" },
            });
        else if (kind === "activity_reaction") {
          const meal = {
            _id: new ObjectId(),
            user_id: user,
            type: "meal",
            name: "Synthetic deferred meal",
            status: "complete",
            created_at: new Date(),
            completed_at: new Date(Date.now() - 60000),
            data: {},
          };
          await db.collection("activities").insertOne(meal);
          await backend
            .require("./core/coachActivityEvents")
            .recordCoachActivityEvent(
              String(user),
              meal,
              "activity_completed",
              { db, debounceMs: 0 },
            );
        } else await workout("Synthetic first press");
        await workout("Synthetic next press");
        const queued = await db
          .collection("external_coach_tasks")
          .find({}, { sort: { created_at: 1 } })
          .toArray();
        assert.deepEqual(
          queued.map((t: any) => t.kind),
          [kind, "exercise_suggestions"],
        );
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
                model: "synthetic-deferred",
                apiKey: "synthetic-key",
              },
              system,
              context,
              signal,
              tools,
              budget,
            ),
        });
        poll = worker.pollOnce() as Promise<void>;
        const outcome = await Promise.race([
          poll.then(() => "accepted"),
          entered.promise.then(() => "blocked"),
        ]);
        assert.equal(
          outcome,
          "accepted",
          "accepted capture must not extract inline before the next claim",
        );
        const memory = backend.require("./core/coachMemory");
        const listed = await memory.execute(auth, "coach_memory_pending", {});
        const first = await db
          .collection("coach_memory_captures")
          .findOne({ origin_id: String(queued[0]._id) });
        assert.equal(first.status, "open");
        assert.deepEqual(
          listed.captures,
          [{ capture_id: String(first._id), origin: "task" }],
          "the real backend lists the accepted capture immediately",
        );
        poll = worker.pollOnce() as Promise<void>;
        await poll;
        assert.deepEqual(order, [
          "generate:" + kind,
          "generate:exercise_suggestions",
        ]);
        poll = worker.pollOnce() as Promise<void>;
        await entered.promise;
        assert.equal(
          (
            await db
              .collection("coach_memory_captures")
              .findOne({ _id: first._id })
          ).status,
          "open",
          "held extraction has not committed",
        );
        hold.resolve();
        await poll;
        for (let i = 0; i < 2; i++) {
          poll = worker.pollOnce() as Promise<void>;
          await poll;
        }
        await new Promise<void>((r) => setImmediate(r));
        await suggestions.publicationsIdle();
        assert.deepEqual(order, [
          "generate:" + kind,
          "generate:exercise_suggestions",
          "extract",
          "extract",
        ]);
        assert.equal(peak, 1, "provider attempts stay serial");
        const captures = await db
          .collection("coach_memory_captures")
          .find({})
          .toArray();
        assert.equal(captures.length, 2);
        for (const capture of captures)
          assert.equal(capture.status, "committed");
        const after = await db
          .collection("external_coach_tasks")
          .find({})
          .toArray();
        for (const task of after) {
          assert.equal(task.lease_generation, 1, "no task reclaim/replay");
          assert.match(task.status, /^(completed|consumed)$/);
        }
        assert.deepEqual(
          (await memory.execute(auth, "coach_memory_pending", {})).captures,
          [],
        );
        assert.equal(worker.safeToReplace, true);
      } finally {
        hold.resolve();
        await poll?.catch(() => {});
        await worker?.stop();
        await provider.close();
        await backend.close();
      }
    },
  );
}
