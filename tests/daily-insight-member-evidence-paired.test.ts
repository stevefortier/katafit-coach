import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { complete } from "../src/runtime/piAdapter.js";
import { Worker } from "../src/worker/runner.js";
import { Client } from "../src/katafit/client.js";
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
  const originalFetch = globalThis.fetch;
  const taskReplies: Array<{
    tool: string;
    taskId: string;
    httpStatus: number;
    result: any;
  }> = [];
  // Observe actual completion and exact metadata receipts separately: source
  // refusal belongs to completion, not to the metadata-only recovery read.
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    if (
      String(input) === b.origin + "/api/agents/coach/mcp" &&
      typeof init?.body === "string"
    ) {
      const request = JSON.parse(init.body);
      if (
        request.method === "tools/call" &&
        [
          "coach_complete_task",
          "coach_read_task_receipt",
          "coach_reconcile_task",
        ].includes(request.params?.name)
      ) {
        const raw = await response.clone().text();
        const packets = response.headers
          .get("content-type")
          ?.includes("text/event-stream")
          ? raw
              .replace(/\r\n/g, "\n")
              .split("\n\n")
              .flatMap((event) => {
                const data = event
                  .split("\n")
                  .filter((line) => line.startsWith("data:"))
                  .map((line) => line.slice(5).trimStart())
                  .join("\n");
                return data ? [JSON.parse(data)] : [];
              })
          : [JSON.parse(raw)];
        taskReplies.push({
          tool: request.params.name,
          taskId: request.params.arguments.task_id,
          httpStatus: response.status,
          result: packets.find((packet) => packet.id === request.id)?.result,
        });
      }
    }
    return response;
  };
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
      state: w.state,
      safeToReplace: w.safeToReplace,
      taskReplies,
      raw: JSON.stringify(first ?? {}),
      system: (first?.messages ?? [])
        .filter((m: any) => m.role === "system" || m.role === "developer")
        .map(text)
        .join("\n"),
      envelope,
      targets: observation ? JSON.parse(observation.text) : undefined,
    };
  } finally {
    try {
      await w?.stop();
    } finally {
      try {
        await p?.close();
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
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
              // Inference received 2400, but the actual source is now 2700.
              // Completion must refuse that stale result before accepting it.
              const overlay = await backend.db
                .collection("member_nutrition_overlays")
                .findOne({ member_id: f.member });
              assert.deepEqual(overlay.daily_targets, prescription(2700, 175));
              assert.equal(r.error, undefined);
              assert.equal(r.state, "task-result-unknown");
              assert.equal(r.safeToReplace, false);
              const task = await backend.task();
              assert.equal(task?.status, "claimed");
              const completions = r.taskReplies.filter(
                (reply) => reply.tool === "coach_complete_task",
              );
              const receipts = r.taskReplies.filter(
                (reply) => reply.tool === "coach_read_task_receipt",
              );
              assert.equal(
                completions.length,
                1,
                "one real completion attempt, no write replay",
              );
              assert.equal(
                receipts.length,
                1,
                "worker checked exact metadata once",
              );
              assert.equal(
                r.taskReplies.filter(
                  (reply) => reply.tool === "coach_reconcile_task",
                ).length,
                0,
              );
              for (const wire of completions) {
                assert.equal(wire.taskId, String(task._id));
                assert.equal(wire.httpStatus, 200);
                assert.equal(wire.result.isError, true);
                const denial = JSON.parse(
                  wire.result.content.find((part: any) => part.type === "text")
                    .text,
                );
                assert.equal(denial.code, "TASK_SOURCE_CHANGED");
              }
              assert.equal(receipts[0].taskId, String(task._id));
              assert.equal(receipts[0].httpStatus, 200);
              assert.notEqual(receipts[0].result.isError, true);
              const metadata = receipts[0].result.structuredContent;
              assert.equal(metadata.task.id, String(task._id));
              assert.equal(metadata.status, "claimed");
              assert.equal(metadata.result_sha256, null);
              assert.equal(metadata.completed_at, null);
              const noAcceptedResult = (row: any) => {
                for (const field of [
                  "result",
                  "result_hash",
                  "completed_at",
                  "result_auth",
                  "provenance",
                  "consumed_at",
                  "recommendation_id",
                  "consumption_failure_code",
                ])
                  assert.equal(row[field], undefined, field);
              };
              noAcceptedResult(task);
              // A failed completion leaves the lease claimed. Simulate only its
              // expiry, then let the real claim path record source invalidation.
              await backend.db
                .collection("external_coach_tasks")
                .updateOne(
                  { _id: task._id },
                  { $set: { lease_expires_at: new Date(Date.now() - 1000) } },
                );
              const recovery = new Client(
                backend.origin,
                f.token,
                AbortSignal.timeout(10000),
              );
              await recovery.connect();
              const claimed = await recovery.call("coach_claim_task", {
                protocol: P,
                kinds: ["daily_insight"],
                capability_protocols: [CAP],
              });
              assert.equal(claimed.task, null);
              const invalidated = await backend.task();
              assert.equal(invalidated.status, "invalidated");
              assert.equal(
                invalidated.invalidation_code,
                "TASK_SOURCE_CHANGED",
              );
              assert.equal(
                invalidated.invalidation_detail_code,
                "DAILY_SNAPSHOT_CHANGED",
              );
              noAcceptedResult(invalidated);
              const receipt = await recovery.call("coach_read_task_receipt", {
                protocol: P,
                task_id: String(task._id),
                lease_generation: task.lease_generation,
              });
              assert.equal(receipt.status, "invalidated");
              assert.equal(receipt.invalidation_code, "TASK_SOURCE_CHANGED");
              assert.equal(receipt.result_sha256, null);
              assert.equal(receipt.completed_at, null);
              assert.equal(receipt.consumed_at, null);
              assert.equal(await backend.daily.consumePending(backend.db), 0);
              assert.equal(
                await backend.db
                  .collection("recommendations")
                  .countDocuments({ user_id: f.member }),
                0,
              );
              assert.equal(
                await backend.db
                  .collection("recommendations")
                  .countDocuments({ external_task_id: String(task._id) }),
                0,
              );
            }
          },
        );
    } finally {
      await b?.close();
    }
  },
);
