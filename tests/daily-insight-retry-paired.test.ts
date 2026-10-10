import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
// This acceptance gate exercises the built package, never the tsx src loader.
import { complete } from "../dist/runtime/piAdapter.js";
import { Worker } from "../dist/worker/runner.js";
import { closeServer, pairedSkip } from "./helpers/account-backend.js";
import { answer } from "./helpers/continuity.js";
import {
  startTaskBackend,
  type TaskPairedBackend,
} from "./helpers/task-backend.js";

// Explicit Retry of a failed daily insight, paired: the REAL backend producer,
// retry transaction, lease/context and canonical publisher with the real
// Worker and Pi adapter over HTTP. Only the model endpoint is synthetic. This
// proves the retry metadata and fresh evidence the provider received and what
// may publish, never live model prose quality.

const P = "coach.tasks.v1";
const insight = {
  general_advice:
    "You saved good this morning; with breakfast done, keep tonight's pull session steady.",
  meal_recommendations: [],
  recovery_recommendations: [],
  workout_directives: [],
};
const text = (m: any) =>
  typeof m.content === "string"
    ? m.content
    : (m.content ?? []).map((p: any) => p.text ?? "").join("");

/** One synthetic endpoint: an upstream 504 or a scripted structured answer. */
async function provider() {
  const bodies: any[] = [];
  let mode: "fail" | "ok" = "ok";
  let during: () => Promise<void> = async () => {};
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (mode === "fail") {
      res.writeHead(504, { "Content-Type": "application/json" });
      return void res.end(
        JSON.stringify({ error: { message: "synthetic upstream" } }),
      );
    }
    res.setHeader("Content-Type", "text/event-stream");
    // Post-result memory extraction runs tool-less; it proposes nothing here.
    if (!body.tools?.length) return void res.end(answer('{"proposals":[]}'));
    bodies.push(body);
    await during();
    res.end(answer(JSON.stringify(insight)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    bodies,
    set(next: "fail" | "ok", hook: () => Promise<void> = async () => {}) {
      mode = next;
      during = hook;
    },
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    close: () => closeServer(server),
  };
}

async function runOnce(
  b: TaskPairedBackend,
  token: string,
  p: Awaited<ReturnType<typeof provider>>,
) {
  const w = new Worker({
    origin: b.origin,
    token,
    system: "Synthetic Coach persona",
    complete: (context, signal, system, tools) =>
      complete(
        {
          baseUrl: p.baseUrl,
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
  try {
    const error = await w.pollOnce().then(
      () => undefined,
      (e: Error) => e,
    );
    return { error, state: w.state, safeToReplace: w.safeToReplace };
  } finally {
    await w.stop();
  }
}

async function retryHttp(b: TaskPairedBackend, user: string, status: string) {
  const jwt = b.backendModule("jsonwebtoken");
  const token = jwt.sign({ user_id: user }, process.env.JWT_SECRET);
  const response = await fetch(
    `${b.origin}/api/status/${status}/coach-insight/retry`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(result.task_id, /^[a-f0-9]{24}$/);
  return result;
}

function envelopeOf(body: any) {
  const user = body.messages.find(
    (m: any) => m.role === "user" && text(m).includes("generation_task"),
  );
  const envelope = JSON.parse(text(user));
  const system = body.messages
    .filter((m: any) => m.role === "system" || m.role === "developer")
    .map(text)
    .join("\n");
  const observation = (label: string) =>
    envelope.evidence.observations.find((o: any) => o.label === label);
  return { envelope, system, observation, raw: JSON.stringify(body) };
}

async function dojo(b: TaskPairedBackend) {
  await b.reset();
  const { db, ObjectId } = b;
  for (const name of [
    "dojos",
    "dojo_members",
    "activity_plans",
    "coach_chat_canonical",
    "external_coach_credentials",
  ])
    await db
      .collection(name)
      .deleteMany({})
      .catch(() => undefined);
  const member = new ObjectId(),
    chief = new ObjectId(),
    dojoId = new ObjectId(),
    plan = new ObjectId(),
    meal = new ObjectId(),
    status = new ObjectId();
  await db.collection("users").insertMany([
    {
      _id: member,
      timezone: "UTC",
      privacy_settings: { meal: ["dojo_chief"], workout: ["dojo_chief"] },
    },
    { _id: chief, timezone: "UTC" },
  ]);
  await db.collection("dojos").insertOne({
    _id: dojoId,
    chief_id: chief,
    workout_plan_id: plan,
    external_coach_agent: { enabled: true },
  });
  await db.collection("activity_plans").insertOne({
    _id: plan,
    user_id: chief,
    dojo_id: dojoId,
    title: "Synthetic hypertrophy block",
  });
  const policy = b.backendModule("./core/dojoMembershipPolicy");
  for (const [id, role] of [
    [member, "member"],
    [chief, "chief"],
  ])
    await policy.insertDojoMembership(db, {
      user_id: id,
      dojo_id: dojoId,
      role,
      joined_at: new Date(Date.now() - 60000),
    });
  await db.collection("activities").insertOne({
    _id: meal,
    user_id: member,
    dojo_id: dojoId,
    type: "meal",
    status: "pending",
    name: "Synthetic breakfast",
    created_at: new Date(),
    is_template: false,
  });
  const service = b.backendModule("./core/personalExternalCoach");
  const { token } = await service.createCredential(
    String(chief),
    { name: "Synthetic chief worker" },
    { restUserAccess: true },
  );
  await b.daily.recordStatus(b.db, String(member), {
    _id: status,
    user_id: member,
    type: "status_change",
    status: "complete",
    data: { status: "good", note: "Synthetic retry note" },
    created_at: new Date(),
    completed_at: new Date(),
    source: null,
  });
  // Ordinary same-day drift after the failed attempt.
  const drift = async () => {
    await db
      .collection("activities")
      .updateOne(
        { _id: meal },
        { $set: { status: "complete", completed_at: new Date() } },
      );
    await db.collection("activities").insertOne({
      _id: new ObjectId(),
      user_id: member,
      dojo_id: dojoId,
      type: "workout",
      status: "pending",
      name: "Synthetic evening pull",
      created_at: new Date(),
      is_template: false,
    });
    await db
      .collection("activity_plans")
      .updateOne(
        { _id: plan },
        { $set: { title: "Synthetic hypertrophy block v2" } },
      );
  };
  return { member, chief, dojoId, status, token, drift };
}

test(
  "daily insight Retry, paired real backend -> Worker -> Pi provider envelope -> publisher",
  { skip: pairedSkip, timeout: 600000 },
  async (t) => {
    let b: TaskPairedBackend | undefined;
    let p: Awaited<ReturnType<typeof provider>> | undefined;
    try {
      b = await startTaskBackend();
      p = await provider();
      const backend = b,
        model = p;
      const tasks = backend.backendModule("./core/externalCoachTasks");
      const row = async (status: any) => {
        const saved = await backend.db
          .collection("activities")
          .findOne({ _id: status });
        return backend.db
          .collection("external_coach_tasks")
          .findOne({ _id: new backend.ObjectId(saved.external_daily_task_id) });
      };
      const published = (member: any) =>
        backend.db
          .collection("recommendations")
          .find({ user_id: member, kind: "daily" })
          .toArray();

      await t.test(
        "accepted but unpublished supersession settles the original worker even after Retry renews the lease",
        async () => {
          const f = await dojo(backend);
          model.set("ok");
          const daily = backend.backendModule("./core/externalDailyCoachTasks");
          const execute = tasks.execute;
          let release!: () => void;
          let enter!: () => void;
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          const entered = new Promise<void>((resolve) => {
            enter = resolve;
          });
          let gate = true;
          // Hold the actual HTTP reconciliation at dispatch BEFORE its Mongo
          // transaction. Completion must already be committed; no result or
          // authorization response is replaced by this test-only scheduling gate.
          tasks.execute = async (auth: any, name: string, input: any) => {
            if (name === "coach_reconcile_task" && gate) {
              gate = false;
              enter();
              await held;
            }
            return execute(auth, name, input);
          };
          const pending = runOnce(backend, f.token, model);
          try {
            await Promise.race([
              entered,
              pending.then(() => {
                throw new Error("worker never reached held reconciliation");
              }),
            ]);
            const accepted = await row(f.status);
            assert.equal(accepted.status, "completed");
            assert.match(accepted.result_hash, /^[a-f0-9]{64}$/);
            await f.drift();
            assert.equal(await daily.consumePending(backend.db), 0);
            assert.equal((await row(f.status)).status, "invalidated");
            assert.equal((await published(f.member)).length, 0);
            const retry = await retryHttp(
              backend,
              String(f.member),
              String(f.status),
            );
            assert.equal(retry.queued, true);
            release();
            const settled = await pending;
            assert.equal(settled.error, undefined, String(settled.error));
            assert.equal(
              settled.safeToReplace,
              true,
              "accepted original lease must settle without unresolved incident",
            );
            const fresh = await runOnce(backend, f.token, model);
            assert.equal(fresh.error, undefined, String(fresh.error));
            assert.equal(fresh.safeToReplace, true);
            assert.equal((await row(f.status)).retry_count, 1);
            assert.equal((await published(f.member)).length, 1);
            assert.equal(
              await backend.db
                .collection("external_coach_task_actions")
                .countDocuments({}),
              0,
            );
          } finally {
            release();
            tasks.execute = execute;
            await pending;
          }
        },
      );

      await t.test(
        "failed attempt + ordinary drift: Retry delivers dated retry metadata and fresh evidence, then publishes once",
        async () => {
          const f = await dojo(backend);
          model.set("fail");
          const failed = await runOnce(backend, f.token, model);
          assert.ok(failed.error);
          const first = await row(f.status);
          assert.equal(first.status, "failed");
          assert.equal(first.failure_code, "TASK_PROVIDER_FAILED");
          await f.drift();

          const renewed = await retryHttp(
            backend,
            String(f.member),
            String(f.status),
          );
          assert.equal(renewed.queued, true);
          model.set("ok");
          const before = model.bodies.length;
          const ok = await runOnce(backend, f.token, model);
          assert.equal(ok.error, undefined, String(ok.error));
          assert.equal(model.bodies.length, before + 1);
          const { envelope, system, observation, raw } = envelopeOf(
            model.bodies.at(-1),
          );
          const saved = await backend.db
            .collection("activities")
            .findOne({ _id: f.status });
          const retried = await row(f.status);
          assert.deepEqual(envelope.generation_task.requester, {
            user_id: String(f.member),
            owner_type: "dojo",
          });
          assert.equal(envelope.generation_task.kind, "daily_insight");
          const status = JSON.parse(observation("Current status").text);
          assert.deepEqual(status, {
            day: saved.created_at.toISOString().slice(0, 10),
            status: "good",
            note: "Synthetic retry note",
          });
          const timing = JSON.parse(observation("Retry timing").text);
          assert.equal(timing.attempt, 2);
          assert.equal(
            timing.check_in_saved_at,
            saved.created_at.toISOString(),
          );
          assert.equal(
            timing.first_attempt_requested_at,
            first.created_at.toISOString(),
          );
          assert.equal(
            timing.first_attempt_failed_at,
            first.failed_at.toISOString(),
          );
          assert.equal(
            timing.retry_requested_at,
            retried.retry_requested_at.toISOString(),
          );
          assert.ok(
            Date.parse(timing.evidence_as_of) >= +retried.retry_requested_at,
          );
          assert.match(timing.note, /not available to earlier attempts/);
          const windows = JSON.parse(
            observation("Selected authorized activity windows").text,
          );
          assert.ok(
            windows.some(
              (w: any) =>
                w.name === "Synthetic breakfast" && w.status === "complete",
            ),
          );
          assert.ok(
            windows.some(
              (w: any) =>
                w.name === "Synthetic evening pull" && w.status === "pending",
            ),
          );
          assert.equal(
            JSON.parse(observation("Canonical shared Dojo plan").text).title,
            "Synthetic hypertrophy block v2",
          );
          assert.match(
            system,
            /retry of a failed daily brief for the same saved check-in/,
          );
          assert.match(system, /never imply you knew it or acted on it/);
          assert.match(system, /Daily insight fixed constraints/);
          assert.ok(!raw.includes(f.token));
          // Memory is acquired against the retried lease, not the failed one.
          const captures = await backend.db
            .collection("coach_memory_captures")
            .find({ origin: "task", origin_id: String(retried._id) })
            .toArray();
          assert.ok(
            captures.some(
              (c: any) => c.lease_generation === retried.lease_generation,
            ),
            JSON.stringify(captures.map((c: any) => c.lease_generation)),
          );
          assert.equal(await backend.daily.consumePending(backend.db), 1);
          assert.equal(await backend.daily.consumePending(backend.db), 0);
          const rows = await published(f.member);
          assert.equal(rows.length, 1);
          assert.equal(rows[0].status_context_id, String(f.status));
          assert.equal(
            rows[0].target_date,
            saved.created_at.toISOString().slice(0, 10),
          );
          assert.equal(rows[0].external_task_id, String(retried._id));
          assert.equal(rows[0].lease_generation, retried.lease_generation);
          assert.equal(rows[0].data.general_advice, insight.general_advice);
        },
      );

      await t.test(
        "drift during the retried inference never publishes stale advice; the explicit supersession is retryable",
        async () => {
          const f = await dojo(backend);
          model.set("fail");
          await runOnce(backend, f.token, model);
          await retryHttp(backend, String(f.member), String(f.status));
          model.set("ok", async () => {
            await backend.db.collection("activities").insertOne({
              _id: new backend.ObjectId(),
              user_id: f.member,
              dojo_id: f.dojoId,
              type: "meal",
              status: "pending",
              name: "Synthetic late snack",
              created_at: new Date(),
              is_template: false,
            });
          });
          await runOnce(backend, f.token, model);
          assert.equal(await backend.daily.consumePending(backend.db), 0);
          assert.equal((await published(f.member)).length, 0);
          const stale = await row(f.status);
          assert.notEqual(stale.status, "completed");
          assert.equal(stale.result, undefined);
          // The abandoned lease expires and the next claim retires it.
          await backend.db
            .collection("external_coach_tasks")
            .updateOne(
              { _id: stale._id },
              { $set: { lease_expires_at: new Date(Date.now() - 1000) } },
            );
          model.set("ok");
          await runOnce(backend, f.token, model);
          const superseded = await row(f.status);
          assert.equal(superseded.status, "invalidated");
          assert.equal(
            superseded.invalidation_detail_code,
            "DAILY_SNAPSHOT_CHANGED",
          );
          await retryHttp(backend, String(f.member), String(f.status));
          const ok = await runOnce(backend, f.token, model);
          assert.equal(ok.error, undefined, String(ok.error));
          const { observation } = envelopeOf(model.bodies.at(-1));
          assert.equal(JSON.parse(observation("Retry timing").text).attempt, 3);
          assert.ok(
            JSON.stringify(
              observation("Selected authorized activity windows"),
            ).includes("Synthetic late snack"),
          );
          assert.equal(await backend.daily.consumePending(backend.db), 1);
          assert.equal((await published(f.member)).length, 1);
        },
      );
    } finally {
      await p?.close();
      await b?.close();
    }
  },
);
