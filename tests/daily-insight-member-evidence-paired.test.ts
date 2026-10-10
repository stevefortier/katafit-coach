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

// The REAL backend daily_insight producer, lease/context and canonical
// publisher, paired with the real Worker and Pi adapter over HTTP. Only the
// model is scripted: this proves what the provider received before its first
// turn and what may publish, not live model prose quality.

const P = "coach.tasks.v1";
const CAP = "coach.capability.v1";
const LABEL = "Requester nutrition targets";
const NOTE = "Synthetic readiness note";
const insight = {
  general_advice:
    "You saved good with a note this morning; keep the first session easy.",
  meal_recommendations: [],
  recovery_recommendations: [],
  workout_directives: [],
};
const text = (m: any) =>
  typeof m.content === "string"
    ? m.content
    : (m.content ?? []).map((p: any) => p.text ?? "").join("");
const prescription = (calories: number, protein: number) => ({
  calories,
  protein_g: protein,
  carbs_g: 260,
  fat_g: 70,
  water_ml: 3000,
});

async function scriptedProvider(during: () => Promise<void>) {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    res.setHeader("Content-Type", "text/event-stream");
    // Post-result memory extraction runs tool-less; it proposes nothing here.
    if (!body.tools?.length) return void res.end(answer('{"proposals":[]}'));
    if (!bodies.length) await during();
    bodies.push(body);
    res.end(answer(JSON.stringify(insight)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    bodies,
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    close: () => closeServer(server),
  };
}

async function reset(b: TaskPairedBackend) {
  await b.reset();
  for (const name of [
    "dojos",
    "dojo_members",
    "member_nutrition_overlays",
    "activity_plans",
    "coach_chat_canonical",
    "external_coach_credentials",
  ])
    await b.db
      .collection(name)
      .deleteMany({})
      .catch(() => undefined);
}

const checkIn = (b: TaskPairedBackend, user: any) =>
  b.daily.recordStatus(b.db, String(user), {
    _id: new b.ObjectId(),
    user_id: user,
    type: "status_change",
    status: "complete",
    data: { status: "good", note: NOTE },
    created_at: new Date(),
    completed_at: new Date(),
    source: null,
  });

async function dojo(b: TaskPairedBackend, share = ["meal", "workout"]) {
  await reset(b);
  const { db, ObjectId } = b;
  const member = new ObjectId(),
    other = new ObjectId(),
    chief = new ObjectId(),
    dojoId = new ObjectId(),
    plan = new ObjectId();
  await db.collection("users").insertMany([
    {
      _id: member,
      timezone: "UTC",
      privacy_settings: Object.fromEntries(
        share.map((type) => [type, ["dojo_chief"]]),
      ),
    },
    { _id: other, timezone: "UTC", privacy_settings: { meal: ["dojo_chief"] } },
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
    title: "Synthetic Dojo plan",
  });
  const policy = b.backendModule("./core/dojoMembershipPolicy");
  for (const [id, role] of [
    [member, "member"],
    [other, "member"],
    [chief, "chief"],
  ])
    await policy.insertDojoMembership(db, {
      user_id: id,
      dojo_id: dojoId,
      role,
      joined_at: new Date(Date.now() - 60000),
    });
  // Deliberately different chief, other-member and requester prescriptions.
  await db.collection("member_nutrition_overlays").insertMany([
    {
      member_id: member,
      activity_plan_id: plan,
      daily_targets: prescription(2400, 160),
    },
    {
      member_id: other,
      activity_plan_id: plan,
      daily_targets: prescription(3100, 210),
    },
    {
      member_id: chief,
      activity_plan_id: plan,
      daily_targets: prescription(5000, 300),
    },
  ]);
  // Pending meal only: no completed/shared meal exists before breakfast.
  await db.collection("activities").insertOne({
    _id: new ObjectId(),
    user_id: member,
    dojo_id: dojoId,
    type: "meal",
    status: "pending",
    name: "Synthetic breakfast",
    created_at: new Date(),
    due_at: new Date(Date.now() + 3600000),
    is_template: false,
  });
  const service = b.backendModule("./core/personalExternalCoach");
  const { token } = await service.createCredential(
    String(chief),
    { name: "Synthetic chief worker" },
    { restUserAccess: true },
  );
  await checkIn(b, member);
  return { member, other, chief, token };
}

async function runWorker(
  b: TaskPairedBackend,
  token: string,
  during: () => Promise<void> = async () => {},
) {
  let p: Awaited<ReturnType<typeof scriptedProvider>> | undefined;
  let w: Worker | undefined;
  try {
    p = await scriptedProvider(during);
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
      (m: any) => m.role === "user" && text(m).includes("generation_task"),
    );
    const envelope = user ? JSON.parse(text(user)) : undefined;
    const observation = envelope?.evidence.observations.find(
      (o: any) => o.label === LABEL,
    );
    return {
      error,
      raw: JSON.stringify(first ?? {}),
      system: (first?.messages ?? [])
        .filter((m: any) => m.role === "system" || m.role === "developer")
        .map(text)
        .join("\n"),
      envelope,
      targets: observation ? JSON.parse(observation.text) : undefined,
    };
  } finally {
    await w?.stop();
    await p?.close();
  }
}

test(
  "daily insight member evidence, paired real producer -> HTTP -> Pi provider envelope -> publisher",
  { skip: pairedSkip, timeout: 600000 },
  async (t) => {
    let b: TaskPairedBackend | undefined;
    try {
      b = await startTaskBackend();
      const backend = b;
      const published = (user: any) =>
        backend.db.collection("recommendations").countDocuments({
          user_id: user,
          kind: "daily",
          source: "external_agent",
        });

      await t.test(
        "Dojo member: validated identity, saved feeling and own targets before any completed meal",
        async () => {
          const f = await dojo(backend);
          const r = await runWorker(backend, f.token);
          assert.equal(r.error, undefined, String(r.error));
          const task = r.envelope.generation_task;
          assert.equal(task.kind, "daily_insight");
          assert.deepEqual(task.requester, {
            user_id: String(f.member),
            owner_type: "dojo",
          });
          assert.deepEqual(task.rest_principal, {
            user_id: String(f.chief),
            is_requester: false,
          });
          const status = r.envelope.evidence.observations.find(
            (o: any) => o.label === "Current status",
          );
          assert.match(status.text, /"status":"good"/);
          assert.ok(status.text.includes(NOTE));
          assert.equal(r.targets.status, "available");
          assert.equal(r.targets.subject, "requester");
          assert.equal(r.targets.targets.calories, 2400);
          assert.equal(r.targets.targets.protein, 160);
          assert.equal(r.targets.day, JSON.parse(status.text).day);
          for (const foreign of ["5000", "3100", String(f.other)])
            assert.ok(!r.raw.includes(foreign), foreign);
          assert.match(r.raw, /acknowledg\w* (?:that |the )?saved/i);
          assert.match(r.raw, /not measured recovery/i);
          assert.match(r.raw, /Daily insight fixed constraints/);
          assert.ok(!r.raw.includes(f.token));
          assert.ok(
            !backend.calls.some((c) => c.includes("/api/user/targets")),
          );
          assert.equal(await backend.daily.consumePending(backend.db), 1);
          assert.equal(await published(f.member), 1);
        },
      );

      await t.test(
        "denied Meal sharing: withheld label, no numbers, still publishes",
        async () => {
          const f = await dojo(backend, ["workout"]);
          const r = await runWorker(backend, f.token);
          assert.equal(r.error, undefined, String(r.error));
          assert.equal(r.targets.status, "withheld");
          assert.equal(r.targets.reason, "MEAL_SHARING_NOT_AUTHORIZED");
          for (const number of ["2400", "5000", "3100"])
            assert.ok(!r.raw.includes(number), number);
          assert.equal(await backend.daily.consumePending(backend.db), 1);
        },
      );

      await t.test(
        "personal requester: own prescription and self principal",
        async () => {
          await reset(backend);
          await backend.withTargets();
          await checkIn(backend, backend.user);
          const token = await backend.credential(false);
          const r = await runWorker(backend, token);
          assert.equal(r.error, undefined, String(r.error));
          assert.deepEqual(r.envelope.generation_task.requester, {
            user_id: String(backend.user),
            owner_type: "personal",
          });
          assert.equal(r.targets.status, "available");
          assert.equal(r.targets.source, "strategy");
          assert.equal(r.targets.targets.calories, 3000);
          assert.equal(r.targets.targets.protein, 200);
          assert.equal(await backend.daily.consumePending(backend.db), 1);
          assert.equal(await published(backend.user), 1);
        },
      );

      for (const change of [
        "target change",
        "meal sharing revoked",
        "Clear",
      ] as const)
        await t.test(
          `${change} during generation refuses publication`,
          async () => {
            const f = await dojo(backend);
            const r = await runWorker(backend, f.token, async () => {
              if (change === "target change")
                await backend.db
                  .collection("member_nutrition_overlays")
                  .updateOne(
                    { member_id: f.member },
                    { $set: { daily_targets: prescription(2700, 175) } },
                  );
              if (change === "meal sharing revoked")
                await backend.db
                  .collection("users")
                  .updateOne(
                    { _id: f.member },
                    { $set: { privacy_settings: { workout: ["dojo_chief"] } } },
                  );
              if (change === "Clear")
                await backend.db.collection("coach_chat_canonical").updateOne(
                  { _id: f.member },
                  {
                    $set: {
                      history_cleared_at: new Date(),
                      clear_generation: 1,
                    },
                  },
                  { upsert: true },
                );
            });
            assert.equal(r.targets.targets.calories, 2400);
            assert.equal(await backend.daily.consumePending(backend.db), 0);
            assert.equal(await published(f.member), 0);
            if (change === "target change") {
              // Accepted completion, refused only at the publication fence.
              assert.equal(r.error, undefined, String(r.error));
              const task = await backend.task();
              assert.equal(task?.status, "completed");
              assert.equal(
                task?.consumption_failure_code,
                "TASK_SOURCE_CHANGED",
              );
            }
          },
        );
    } finally {
      await b?.close();
    }
  },
);
