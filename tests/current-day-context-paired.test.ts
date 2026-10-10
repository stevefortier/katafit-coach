import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "../dist/worker/runner.js";
import { complete } from "../dist/runtime/piAdapter.js";
import {
  memoryBackendEnabled,
  startBackend,
  startProvider,
  isExtraction,
} from "./helpers/memory-backend.js";

function evidenceOf(body: any) {
  for (const message of body.messages ?? []) {
    if (message.role !== "user") continue;
    const text =
      typeof message.content === "string"
        ? message.content
        : (message.content ?? []).map((p: any) => p.text ?? "").join("");
    try {
      const value = JSON.parse(text);
      if (value.generation_task) return value.evidence;
    } catch {}
  }
  return null;
}

for (const mode of ["personal", "dojo", "dojo_metric_denied", "stale_day"])
  test(
    `compiled Worker ${mode} receives the authorized day before its FIRST advice request and fences publication`,
    { skip: !memoryBackendEnabled, timeout: 90000 },
    async () => {
      const b = await startBackend();
      let worker: Worker | undefined;
      let first: any;
      let beforeAnswer = async () => {};
      const provider = await startProvider(async (body) => {
        if (isExtraction(body)) return JSON.stringify({ proposals: [] });
        first ??= body;
        await beforeAnswer();
        // The synthetic answer depends on the evidence actually received. It does
        // not pretend to qualify live model prose or a private incident.
        const raw = JSON.stringify(evidenceOf(body));
        const informed =
          raw.includes("Current local day") &&
          raw.includes("Synthetic breakfast") &&
          raw.includes("Synthetic lunch");
        return JSON.stringify({
          activity_feedback: { reaction: "check", reply_worthwhile: true },
          general_advice: informed
            ? "Two completed meals are visible in the captured day."
            : "Only the triggering meal is visible.",
        });
      });
      try {
        const { ObjectId, db, service } = b;
        const user = new ObjectId();
        const now = new Date();
        await db.collection("users").insertOne({
          _id: user,
          timezone: "America/New_York",
          external_coach_agent: { enabled: true },
        });
        await db.collection("strategies").insertOne({
          user_id: user,
          status: "active",
          created_at: now,
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
        let principal = user;
        const dojo = mode.startsWith("dojo") ? new ObjectId() : null;
        if (dojo) {
          principal = new ObjectId();
          const plan = new ObjectId();
          await db
            .collection("users")
            .insertOne({ _id: principal, timezone: "UTC" });
          await db.collection("users").updateOne(
            { _id: user },
            {
              $set: {
                privacy_settings: Object.fromEntries(
                  ["meal", "workout", "metric", "media", "survey"]
                    .filter(
                      (c) => mode !== "dojo_metric_denied" || c !== "metric",
                    )
                    .map((c) => [c, ["dojo_chief"]]),
                ),
              },
            },
          );
          await db.collection("dojos").insertOne({
            _id: dojo,
            chief_id: principal,
            workout_plan_id: plan,
            external_coach_agent: { enabled: true },
          });
          await db
            .collection("activity_plans")
            .insertOne({ _id: plan, user_id: principal, dojo_id: dojo });
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
          await db.collection("strategies").insertOne({
            user_id: principal,
            status: "active",
            data: {
              nutrition_plan: { daily_calories: 9000, protein_g: 500 },
            },
          });
          const membership = b.require("./core/dojoMembershipPolicy");
          for (const [id, role] of [
            [user, "member"],
            [principal, "chief"],
          ])
            await membership.insertDojoMembership(db, {
              user_id: id,
              dojo_id: dojo,
              role,
              joined_at: new Date(+now - 60000),
            });
        }
        const { token } = await service.createCredential(String(principal), {});
        const rows = [
          "meal",
          "meal",
          "workout",
          "metric",
          "media",
          "survey",
          "status_change",
        ].map((type, i) => ({
          _id: new ObjectId(),
          user_id: user,
          type,
          name:
            i === 0
              ? "Synthetic breakfast"
              : i === 1
                ? "Synthetic lunch"
                : `Synthetic ${type}`,
          status: "complete",
          ...(dojo ? { dojo_id: dojo } : {}),
          created_at: now,
          completed_at: now,
          nutrition_summary:
            type === "meal"
              ? { calories: 600, protein: 40, carbs: 60, fat: 20 }
              : undefined,
          data: {},
        }));
        await db.collection("activities").insertMany(rows);
        await db.collection("activities").insertMany(
          ["expired", "cancelled", "pending"].map((status) => ({
            ...rows[0],
            _id: new ObjectId(),
            name: `Synthetic ${status} meal`,
            status,
            due_at: new Date(+now - 1000),
            nutrition_summary: { calories: 9999 },
          })),
        );
        if (dojo)
          await db.collection("activities").insertMany([
            {
              ...rows[0],
              _id: new ObjectId(),
              dojo_id: undefined,
              name: "Denied source-less supplement",
            },
            {
              ...rows[0],
              _id: new ObjectId(),
              dojo_id: undefined,
              source: { provider: "health_connect" },
              name: "Denied imported supplement",
            },
          ]);
        await b
          .require("./core/coachActivityEvents")
          .recordCoachActivityEvent(
            String(user),
            rows[1],
            "activity_completed",
            { db, debounceMs: 0 },
          );
        const captured = await db
          .collection("external_coach_tasks")
          .findOne({ kind: "activity_reaction" });
        await db.collection("activities").insertOne({
          ...rows[0],
          _id: new ObjectId(),
          name: "Synthetic late physical meal",
        });
        worker = new Worker({
          origin: b.origin,
          token,
          system: "Synthetic Coach",
          complete: (context, signal, system, tools) =>
            complete(
              {
                baseUrl: provider.origin + "/v1",
                model: "synthetic",
                apiKey: "synthetic-provider-key-12345",
              },
              system,
              context,
              signal,
              tools,
            ),
        });
        if (mode === "stale_day")
          beforeAnswer = async () => {
            await db
              .collection("activities")
              .updateOne({ _id: rows[0]._id }, { $set: { status: "pending" } });
          };
        const error = await worker.pollOnce().then(
          () => null,
          (e) => e,
        );
        if (mode !== "stale_day") assert.equal(error, null);
        assert.ok(first, "actual HTTP provider received inference");
        const evidence = evidenceOf(first);
        const raw = JSON.stringify(evidence);
        assert.match(
          raw,
          /Current local day/,
          "default acquisition precedes advice without model tool calls",
        );
        for (const row of rows)
          assert.equal(
            raw.includes(row.name),
            !(
              (mode === "dojo_metric_denied" && row.type === "metric") ||
              (dojo && row.type === "status_change")
            ),
            row.name,
          );
        assert.ok(
          !raw.includes("9000"),
          "chief targets never reach requester inference",
        );
        assert.match(raw, /2400/);
        assert.match(raw, /1200/);
        assert.ok(!raw.includes("Denied source-less supplement"));
        assert.ok(!raw.includes("Denied imported supplement"));
        const entries = evidence.observations
          .filter((o: any) =>
            o.label.startsWith("Current local day activities"),
          )
          .flatMap((o: any) => JSON.parse(o.text));
        for (const status of ["expired", "cancelled", "pending"]) {
          const entry = entries.find(
            (row: any) => row.name === `Synthetic ${status} meal`,
          );
          assert.equal(entry.status, status);
          if (status === "pending") assert.equal(entry.due_passed_as_of, true);
        }
        assert.ok(!raw.includes("Synthetic late physical meal"));
        const metadata = JSON.parse(
          evidence.observations.find(
            (o: any) => o.label === "Current local day",
          ).text,
        );
        assert.equal(metadata.as_of, captured.created_at.toISOString());
        assert.equal(
          captured.current_day_capture.as_of.toISOString(),
          metadata.as_of,
        );
        const tasks = b.require("./core/externalActivityCoachTasks");
        await tasks.consumePending(db);
        const publication = await db
          .collection("recommendations")
          .findOne({ user_id: user, source: "external_agent" });
        if (mode === "stale_day") assert.equal(publication, null);
        else
          assert.equal(
            publication?.data.general_advice,
            "Two completed meals are visible in the captured day.",
          );
      } finally {
        await worker?.stop();
        await provider.close();
        await b.close();
      }
    },
  );

for (const count of [26, 27, 28])
  test(
    `compiled max workout ${count} retains all long escaped producer observations`,
    { skip: !memoryBackendEnabled, timeout: 90000 },
    async () => {
      const b = await startBackend();
      let worker: Worker | undefined;
      let first: any;
      const provider = await startProvider(async (body) => {
        if (isExtraction(body)) return JSON.stringify({ proposals: [] });
        first ??= body;
        const exercises =
          evidenceOf(body)
            ?.observations.filter((o: any) => o.label === "Exercise")
            .map((o: any) => JSON.parse(o.text)) || [];
        return JSON.stringify({
          recommendations: Object.fromEntries(
            exercises.map((e: any) => [
              e.workout_exercise_id,
              { summary: "Synthetic prescription." },
            ]),
          ),
        });
      });
      try {
        const { db, ObjectId, service } = b;
        const user = new ObjectId(),
          now = new Date();
        await db.collection("users").insertOne({
          _id: user,
          timezone: "UTC",
          external_coach_agent: { enabled: true },
        });
        const { token } = await service.createCredential(String(user), {});
        const workout = {
          _id: new ObjectId(),
          user_id: user,
          type: "workout",
          status: "pending",
          name: "Synthetic max workout",
          created_at: now,
          data: {
            exercises: Array.from({ length: count }, (_, i) => ({
              _id: new ObjectId(),
              exercise_id: i + 1,
              name: 'Escaped "\\ control\n 😀 '.repeat(55),
              sets: [],
            })),
          },
        };
        await db.collection("activities").insertMany([
          workout,
          ...Array.from({ length: 50 }, () => ({
            _id: new ObjectId(),
            user_id: user,
            type: "media",
            status: "complete",
            completed_at: now,
            created_at: now,
            name: 'Long "\\ 😀 '.repeat(30),
          })),
        ]);
        const routed = await b
          .require("./core/workoutExternalSuggestions")
          .routeBatch(db, String(user), workout);
        assert.equal(routed.generation.status, "pending");
        worker = new Worker({
          origin: b.origin,
          token,
          system: "Synthetic Coach",
          complete: (context, signal, system, tools) =>
            complete(
              {
                baseUrl: provider.origin + "/v1",
                model: "synthetic",
                apiKey: "synthetic-provider-key-12345",
              },
              system,
              context,
              signal,
              tools,
            ),
        });
        await worker.pollOnce();
        assert.ok(first);
        const evidence = evidenceOf(first);
        assert.equal(
          evidence.observations.filter((o: any) => o.label === "Exercise")
            .length,
          count,
        );
        assert.ok(evidence.observations.length <= 30);
        assert.ok(Buffer.byteLength(JSON.stringify(evidence)) <= 65536);
        assert.match(JSON.stringify(first), /ENVELOPE_LIMIT/);
        for (const exercise of workout.data.exercises)
          assert.ok(
            evidence.observations.some(
              (o: any) =>
                o.label === "Exercise" &&
                JSON.parse(o.text).name === exercise.name,
            ),
          );
      } finally {
        await worker?.stop();
        await provider.close();
        await b.close();
      }
    },
  );
for (const mode of ["foreign", "missing", "overflow"])
  test(
    `compiled whole chat ${mode} supplement cannot escape captured authority`,
    { skip: !memoryBackendEnabled, timeout: 90000 },
    async () => {
      const b = await startBackend();
      let worker: Worker | undefined;
      let first: any;
      const provider = await startProvider(async (body) => {
        if (isExtraction(body)) return JSON.stringify({ proposals: [] });
        first ??= body;
        return "Synthetic captured-day reply.";
      });
      try {
        const { db, ObjectId, service } = b;
        const user = new ObjectId(),
          now = new Date(),
          plan = new ObjectId();
        await db.collection("users").insertOne({
          _id: user,
          timezone: "UTC",
          external_coach_agent: { enabled: true },
        });
        const { token } = await service.createCredential(String(user), {});
        if (mode === "foreign")
          await db
            .collection("activity_plans")
            .insertOne({ _id: plan, user_id: new ObjectId() });
        if (mode === "overflow")
          await db.collection("activities").insertMany(
            Array.from({ length: 125 }, () => ({
              _id: new ObjectId(),
              user_id: user,
              type: "media",
              status: "complete",
              completed_at: new Date(+now - 1000),
              created_at: new Date(+now - 1000),
              name: "Synthetic earlier media",
            })),
          );
        const hidden = {
          _id: new ObjectId(),
          user_id: user,
          type: "meal",
          status: "complete",
          completed_at: now,
          created_at: now,
          name: "Forbidden chat supplement",
          ...(mode === "overflow" ? {} : { source_plan_id: plan }),
        };
        await db.collection("activities").insertOne(hidden);
        await service.enqueueExternalCoachRequest(
          String(user),
          "Review my captured day",
          [],
          { client_request_id: String(new ObjectId()) },
        );
        if (mode === "overflow")
          await db
            .collection("activities")
            .updateOne(
              { _id: hidden._id },
              { $set: { name: "Forbidden edited supplement" } },
            );
        worker = new Worker({
          origin: b.origin,
          token,
          system: "Synthetic Coach",
          complete: (context, signal, system, tools) =>
            complete(
              {
                baseUrl: provider.origin + "/v1",
                model: "synthetic",
                apiKey: "synthetic-provider-key-12345",
              },
              system,
              context,
              signal,
              tools,
            ),
        });
        await worker.pollOnce();
        assert.ok(first, "first actual chat provider request captured");
        assert.ok(!JSON.stringify(first).includes("Forbidden"));
        assert.match(JSON.stringify(first), /current_local_day/);
      } finally {
        await worker?.stop();
        await provider.close();
        await b.close();
      }
    },
  );

test(
  "own publication receipt cannot renew a changed-and-restored day fact without recalled memory",
  { skip: !memoryBackendEnabled, timeout: 90000 },
  async () => {
    const b = await startBackend();
    try {
      const { db, ObjectId, service } = b;
      const user = new ObjectId(),
        exercise = new ObjectId();
      await db.collection("users").insertOne({
        _id: user,
        timezone: "UTC",
        external_coach_agent: { enabled: true },
      });
      const auth = await service.authenticateCredential(
        (await service.createCredential(String(user), {})).token,
      );
      const workout = {
        _id: new ObjectId(),
        user_id: user,
        type: "workout",
        name: "Synthetic workout",
        status: "ongoing",
        created_at: new Date(),
        data: {
          exercises: [{ _id: exercise, name: "Original exercise", sets: [] }],
        },
      };
      await db.collection("activities").insertOne(workout);
      const producer = b.require("./core/workoutExternalSuggestions"),
        tasks = b.require("./core/externalCoachTasks");
      assert.equal(
        (await producer.routeBatch(db, String(user), workout)).generation
          .status,
        "pending",
      );
      const { task } = await tasks.claim(auth, {
        protocol: tasks.PROTOCOL,
        kinds: ["workout_suggestions"],
      });
      const lease = {
        protocol: tasks.PROTOCOL,
        task_id: task.id,
        lease_generation: task.lease_generation,
      };
      await tasks.context(auth, lease);
      await tasks.complete(auth, {
        ...lease,
        result: {
          recommendations: {
            [String(exercise)]: { summary: "Synthetic prescription." },
          },
        },
      });
      await db
        .collection("activities")
        .updateOne(
          { _id: workout._id },
          { $set: { "data.exercises.0.name": "Withdrawn" } },
        );
      await db
        .collection("activities")
        .updateOne(
          { _id: workout._id },
          { $set: { "data.exercises.0.name": "Original exercise" } },
        );
      await producer.processCompleted(db);
      const stored = await db
        .collection("external_coach_tasks")
        .findOne({ _id: new ObjectId(task.id) });
      assert.equal(stored.status, "consumed");
      const crypto = b.require("crypto");
      const changed = stored.memory_initial_deps.filter(
        (dep: any) =>
          dep.view === "current_day_fact" && dep.projection["data.exercises"],
      );
      assert.ok(changed.length);
      for (const dep of changed)
        assert.ok(
          !(stored.memory_source_successors || []).some(
            (receipt: any) =>
              receipt.proof ===
              crypto
                .createHash("sha256")
                .update(JSON.stringify(dep))
                .digest("hex"),
          ),
          "own output must not renew an intervening source epoch",
        );
    } finally {
      await b.close();
    }
  },
);

for (const mode of ["control", "late", "ordinary_retry", "fresh_retry"])
  test(
    `V2 compiled Worker daily targets agree at FIRST provider request: ${mode}`,
    { skip: !memoryBackendEnabled, timeout: 90000 },
    async () => {
      const b = await startBackend();
      let worker: Worker | undefined;
      let first: any;
      const provider = await startProvider(async (body) => {
        if (isExtraction(body)) return JSON.stringify({ proposals: [] });
        first ??= body;
        return JSON.stringify({
          general_advice: "Synthetic captured daily advice.",
          meal_recommendations: [],
          recovery_recommendations: [],
          workout_directives: [],
        });
      });
      try {
        const { ObjectId, db, service } = b;
        const user = new ObjectId(),
          now = new Date();
        await db.collection("users").insertOne({
          _id: user,
          timezone: "America/New_York",
          external_coach_agent: { enabled: true },
        });
        const { token } = await service.createCredential(String(user), {});
        const auth = await service.authenticateCredential(token);
        const tasks = b.require("./core/externalCoachTasks");
        const daily = b.require("./core/externalDailyCoachTasks");
        await tasks.claim(auth, {
          protocol: tasks.PROTOCOL,
          kinds: ["daily_insight"],
        });
        const status = {
          _id: new ObjectId(),
          user_id: user,
          type: "status_change",
          status: "complete",
          source: null,
          created_at: now,
          completed_at: now,
          data: { status: "good", note: "Synthetic check-in" },
        };
        await daily.recordStatus(db, String(user), status);
        const original = await db
          .collection("external_coach_tasks")
          .findOne({ kind: "daily_insight" });
        assert.equal(
          original.current_day_capture.snapshot.targets.source,
          "formula",
        );
        if (mode !== "control")
          await db.collection("strategies").insertOne({
            user_id: user,
            status: "active",
            created_at: now,
            data: {
              nutrition_plan: {
                daily_calories: 9100,
                protein_g: 500,
                carbs_g: 500,
                fat_g: 100,
              },
            },
          });
        if (mode.endsWith("retry")) {
          const { task } = await tasks.claim(auth, {
            protocol: tasks.PROTOCOL,
            kinds: ["daily_insight"],
          });
          const lease = {
            protocol: tasks.PROTOCOL,
            task_id: task.id,
            lease_generation: task.lease_generation,
          };
          if (mode === "fresh_retry") {
            await tasks.fail(auth, { ...lease, code: "TASK_PROVIDER_FAILED" });
            await tasks.retryFailedDailyInsight(
              String(user),
              String(status._id),
              { db },
            );
          } else
            await db
              .collection("external_coach_tasks")
              .updateOne(
                { _id: original._id },
                { $set: { lease_expires_at: new Date(0) } },
              );
        }
        const captured = await db
          .collection("external_coach_tasks")
          .findOne({ _id: original._id });
        worker = new Worker({
          origin: b.origin,
          token,
          system: "Synthetic Coach",
          complete: (context, signal, system, tools) =>
            complete(
              {
                baseUrl: provider.origin + "/v1",
                model: "synthetic",
                apiKey: "synthetic-provider-key-12345",
              },
              system,
              context,
              signal,
              tools,
            ),
        });
        await worker.pollOnce();
        assert.ok(first, "actual first HTTP advice request was received");
        const evidence = evidenceOf(first);
        const observation = (label: string) =>
          JSON.parse(
            evidence.observations.find((o: any) => o.label === label).text,
          );
        const targets = observation("Requester nutrition targets"),
          day = observation("Current local day");
        assert.deepEqual(
          targets,
          captured.current_day_capture.snapshot.targets,
        );
        assert.deepEqual(targets, day.targets);
        assert.equal(targets.day, day.local_day);
        assert.equal(
          day.as_of,
          captured.current_day_capture.as_of.toISOString(),
        );
        assert.equal(
          targets.source,
          mode === "fresh_retry" ? "strategy" : "formula",
        );
        if (mode === "fresh_retry") {
          assert.equal(targets.targets.calories, 9100);
          assert.ok(
            +captured.current_day_capture.as_of >
              +original.current_day_capture.as_of,
          );
          assert.equal(observation("Retry timing").evidence_as_of, day.as_of);
        } else
          assert.deepEqual(
            captured.current_day_capture,
            original.current_day_capture,
          );
        await daily.consumePending(db);
        const published = await db
          .collection("external_coach_tasks")
          .findOne({ _id: original._id });
        assert.equal(
          published.status,
          "consumed",
          "same target inventory remains valid at canonical publication",
        );
      } finally {
        await worker?.stop();
        await provider.close();
        await b.close();
      }
    },
  );
