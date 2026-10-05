import test from "node:test";
import { pairedSkip } from "./helpers/account-backend.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Client } from "../src/katafit/client.js";
import { Actions } from "../src/chat/actions.js";
import { InvocationCapability } from "../src/capability/invocation.js";
import { WorkActions } from "../src/capability/workActions.js";
import { ConfiguredIntegrations } from "../src/capability/integrations.js";
import { taskAdmission, TASK_PROTOCOL } from "../src/katafit/tasks.js";
import {
  uncertaintyFixture,
  emptyOutcome,
} from "./helpers/native-cross-uncertainty.js";
import {
  claimedInvocation,
  invocationPolicy,
  planRequest,
  parsed,
} from "./helpers/invocation-successor.js";
import { ordinaryPolicy } from "./helpers/ordinary-work.js";

for (const plane of ["request", "task"] as const) {
  test(
    `N5 ${plane} finite unsupported paths and missing approval grant never open`,
    { skip: pairedSkip },
    async () => {
      const t = await uncertaintyFixture(emptyOutcome);
      try {
        await invocationPolicy(t, ["rest_mutation"], ["rest_mutation"]);
        const i = await claimedInvocation(t, plane),
          before = t.requests.length;
        for (const input of [
          { ...planRequest, method: "DELETE" },
          { ...planRequest, path: "/api/plans/" },
          { ...planRequest, path: "/api/plans?x=1" },
          { ...planRequest, path: "/api/Plans" },
          { ...planRequest, path: "/api/users/me/rest-days" },
        ])
          assert.equal(
            parsed(await i.adapter().execute(input)).error,
            "INVOCATION_ACTION_UNSUPPORTED",
          );
        assert.equal(
          parsed(
            await i.adapter().execute({
              method: "POST",
              path: `/api/strategy/proposals/${"a".repeat(24)}/approve`,
              body: {},
            }),
          ).error,
          "INVOCATION_ACTION_NOT_DELEGATED",
        );
        assert.equal(
          t.requests.length,
          before,
          "zero HTTP calls including occurrence opens",
        );
        assert.equal(
          await t.b.db
            .collection("coach_invocation_occurrences")
            .countDocuments({}),
          0,
        );
      } finally {
        await t.close();
      }
    },
  );
  for (const deny of [
    "nonchief",
    "revoked",
    ...(plane === "task" ? ["source"] : []),
  ])
    test(
      `P2 ${plane} actual ${deny} change after acquisition: zero effect and no replay`,
      { skip: pairedSkip },
      async () => {
        const t = await uncertaintyFixture(emptyOutcome);
        try {
          await invocationPolicy(t);
          t.b.app.use("/api", t.b.backendModule("./routes/plans"));
          const i = await claimedInvocation(t, plane);
          if (deny === "nonchief")
            await t.b.db
              .collection("dojos")
              .updateOne(
                { _id: new t.b.ObjectId(t.mandate.dojo_id) },
                { $set: { chief_id: new t.b.ObjectId(t.member) } },
              );
          if (deny === "revoked")
            await t.b.db
              .collection("external_coach_credentials")
              .updateMany(
                { user_id: t.b.user },
                { $set: { revoked_at: new Date() } },
              );
          if (deny === "source") {
            const task = await t.b.task();
            const changed = await t.b.db
              .collection("activities")
              .updateOne(
                { _id: new t.b.ObjectId(task.source.source_id) },
                { $set: { "data.status": "bad" } },
              );
            assert.equal(changed.modifiedCount, 1);
          }
          const before = t.requests.length;
          assert.equal(
            parsed(await i.adapter().execute(planRequest)).error,
            "INVOCATION_ACTION_UNRESOLVED",
          );
          const count = t.requests.length;
          assert.equal(
            parsed(await i.adapter().execute(planRequest)).error,
            "INVOCATION_ACTION_UNRESOLVED",
          );
          assert.deepEqual(
            t.requests.slice(count).map((r) => r.method),
            ["GET"],
            "replacement adapter only reads exact occurrence",
          );
          assert.equal(
            t.requests.slice(before).filter((r) => r.path === "/api/plans")
              .length,
            0,
          );
          assert.equal(
            await t.b.db
              .collection("activity_plans")
              .countDocuments({ user_id: t.b.user }),
            0,
          );
          assert.equal(
            i.ledger.unresolved(),
            true,
            "failed authority cannot fabricate no-effect clearance",
          );
        } finally {
          await t.close();
        }
      },
    );
}

for (const status of ["pending", "unknown"] as const)
  test(
    `N10 persisted old-credential legacy ${status} blocks both successor planes despite empty server journal`,
    { skip: pairedSkip },
    async () => {
      const t = await uncertaintyFixture(emptyOutcome);
      try {
        await invocationPolicy(t);
        const legacy = new Actions(t.store);
        legacy.save({
          session_id: "worker-request:historical:1",
          idempotency_key: "unmapped-legacy",
          tool_name: "katafit_rest_request",
          status,
        });
        await t.store.save({
          ...t.store.publicConfig(),
          token: await t.b.credential(true),
        });
        for (const plane of ["request", "task"] as const) {
          const i = await claimedInvocation(t, plane);
          const before = t.requests.length;
          assert.equal(
            parsed(await i.adapter().execute(planRequest)).error,
            "INVOCATION_ACTION_UNRESOLVED",
          );
          assert.equal(t.requests.length, before);
        }
        assert.equal(
          await t.b.db
            .collection("coach_invocation_occurrences")
            .countDocuments({}),
          0,
        );
        assert.equal(new Actions(t.store).unresolved(), true);
        assert.equal(
          new Actions(t.store)
            .snapshot()
            .filter((r) => r.idempotency_key === "unmapped-legacy").length,
          1,
        );
      } finally {
        await t.close();
      }
    },
  );

for (const plane of ["request", "task"] as const)
  test(
    `P3 ${plane} lost actual effect response fences new work through shared durable client ledger`,
    { skip: pairedSkip },
    async () => {
      const t = await uncertaintyFixture(emptyOutcome);
      try {
        await ordinaryPolicy(t);
        await invocationPolicy(t);
        t.b.app.use("/api", t.b.backendModule("./routes/plans"));
        const i = await claimedInvocation(t, plane);
        t.setWireFault(async (meta) =>
          meta.method === "POST" && meta.path === "/api/plans"
            ? "drop"
            : undefined,
        );
        const lost = parsed(await i.adapter().execute(planRequest));
        assert.equal(lost.observation.status, "unknown");
        assert.equal(lost.observation.local_effect.kind, "plan_created");
        t.setWireFault(undefined);
        const binding = i.admission.ordinary.binding;
        const integrations = new ConfiguredIntegrations({
          origin: t.origin,
          token: t.store.secrets.token!,
          secrets: [],
          execution:
            plane === "request"
              ? {
                  plane,
                  request_id: binding.invocation_id,
                  lease_generation: binding.lease_generation,
                }
              : {
                  plane,
                  task_id: binding.invocation_id,
                  lease_generation: binding.lease_generation,
                },
          directory: t.home,
          dispatch: true,
          current: () => true,
          ledger: i.ledger,
        });
        const tools = integrations.tools();
        const catalog = parsed(
          await tools
            .find((v) => v.name === "coach_discover_integrations")!
            .execute("catalog", {}, new AbortController().signal),
        );
        assert.ok(catalog.tools.length);
        const remote = parsed(
          await tools
            .find((v) => v.name === "coach_call_integration")!
            .execute(
              "held",
              {
                slot: "after-invocation-unknown",
                tool: catalog.tools[0].name,
                arguments: { value: "never dispatch" },
              },
              new AbortController().signal,
            ),
        );
        assert.equal(remote.error, "INTEGRATION_UNRESOLVED");
        assert.equal(t.remote.calls.length, 0);
        for (const nextPlane of ["request", "task"] as const) {
          const next = await claimedInvocation(t, nextPlane);
          const priorCalls = t.requests.length;
          assert.equal(
            parsed(
              await next.adapter().execute({
                ...planRequest,
                body: { title: "New invocation held" },
              }),
            ).error,
            "INVOCATION_ACTION_UNRESOLVED",
          );
          assert.equal(
            t.requests.length,
            priorCalls,
            "shared unknown fences the other invocation plane before open",
          );
        }
        await t.enqueue("invocation-unknown-work-" + plane);
        const backend = t.backend(),
          cycle = await backend.claimCycle();
        assert.ok(cycle);
        await backend.start(cycle.work.id, cycle.work.lease_generation);
        const actions = new Actions(t.store);
        const work = new WorkActions({
          backend,
          origin: t.origin,
          token: t.store.secrets.token!,
          secrets: [],
          directory: t.home,
          work: cycle.work,
          actions,
          descriptor: cycle.capability!.ordinary!,
          dispatch: true,
          proposalApproval: true,
          current: () => true,
          held: () => false,
          onUnknown: () => {},
          onObserved: () => {},
        });
        const before = t.requests.length;
        assert.equal(
          parsed(
            await work.execute({
              ...planRequest,
              body: { title: "New work must remain held" },
            }),
          ).error,
          "WORK_ACTION_UNRESOLVED",
        );
        assert.equal(
          t.requests.length,
          before,
          "hold before work open or effect dispatch",
        );
        assert.equal(
          await t.b.db
            .collection("activity_plans")
            .countDocuments({ user_id: t.b.user }),
          1,
        );
        assert.equal(actions.unresolved(), true);
        assert.equal(t.remote.calls.length, 0);
      } finally {
        await t.close();
      }
    },
  );

for (const nextPlane of ["request", "task"] as const)
  test(
    `P3 actual work UNKNOWN fences later ${nextPlane} before invocation open`,
    { skip: pairedSkip },
    async () => {
      const t = await uncertaintyFixture(emptyOutcome);
      try {
        await ordinaryPolicy(t);
        await invocationPolicy(t);
        t.b.app.use("/api", t.b.backendModule("./routes/plans"));
        await t.enqueue("work-to-invocation-unknown-" + nextPlane);
        const backend = t.backend(),
          cycle = await backend.claimCycle();
        assert.ok(cycle);
        await backend.start(cycle.work.id, cycle.work.lease_generation);
        const actions = new Actions(t.store);
        const work = new WorkActions({
          backend,
          origin: t.origin,
          token: t.store.secrets.token!,
          secrets: [],
          directory: t.home,
          work: cycle.work,
          actions,
          descriptor: cycle.capability!.ordinary!,
          dispatch: true,
          proposalApproval: true,
          current: () => true,
          held: () => false,
          onUnknown: () => {},
          onObserved: () => {},
        });
        t.setWireFault(async (meta) =>
          meta.method === "POST" && meta.path === "/api/plans"
            ? "drop"
            : undefined,
        );
        const lost = parsed(await work.execute(planRequest));
        assert.equal(lost.error, "WORK_ACTION_UNRESOLVED");
        assert.ok(
          actions
            .snapshot()
            .some(
              (row) =>
                "tool_name" in row &&
                row.tool_name === "katafit_rest_request" &&
                row.status === "unknown",
            ),
        );
        assert.equal(actions.unresolved(), true);
        t.setWireFault(undefined);
        const next = await claimedInvocation(t, nextPlane),
          before = t.requests.length;
        assert.equal(
          parsed(
            await next.adapter().execute({
              ...planRequest,
              body: { title: "Work UNKNOWN remains held" },
            }),
          ).error,
          "INVOCATION_ACTION_UNRESOLVED",
        );
        assert.equal(t.requests.length, before);
        assert.equal(
          await t.b.db
            .collection("activity_plans")
            .countDocuments({ user_id: t.b.user }),
          1,
        );
        assert.equal(
          await t.b.db
            .collection("coach_invocation_occurrences")
            .countDocuments({}),
          0,
        );
      } finally {
        await t.close();
      }
    },
  );

test(
  "N1 legacy capability-only Dojo task uses real canonical member_message journal and receipt, never successor ordinary header",
  { skip: pairedSkip },
  async () => {
    const t = await uncertaintyFixture(emptyOutcome);
    try {
      await t.b.checkIn();
      const c = new Client(
        t.origin,
        t.store.secrets.token,
        new AbortController().signal,
      );
      await c.connect();
      const lease: any = await c.call("coach_claim_task", {
        protocol: TASK_PROTOCOL,
        kinds: ["daily_insight"],
        capability_protocols: ["coach.capability.v1"],
      });
      const ids = {
        protocol: TASK_PROTOCOL,
        task_id: lease.task.id,
        lease_generation: lease.task.lease_generation,
      };
      const context = await c.call("coach_read_task_context", ids);
      const admission = taskAdmission(lease.task, context);
      assert.equal(admission.ordinary, undefined);
      assert.deepEqual(admission.actions, ["member_message"]);
      const capability = new InvocationCapability({
        plane: "task",
        origin: t.origin,
        token: t.store.secrets.token!,
        secrets: [],
        vision: false,
        current: () => true,
        actions: admission.actions,
        recipient: lease.task.requester_id,
        occurrences: admission.occurrences,
        journal: {
          open: async (input) =>
            (await c.call("coach_open_task_action", { ...ids, ...input }))
              .occurrence,
          settle: async (slot, status) =>
            (await c.call("coach_settle_task_action", { ...ids, slot, status }))
              .occurrence,
        },
      });
      const input = {
        method: "POST",
        path: "/api/coach/member-messages/" + lease.task.requester_id,
        body: { text: "Synthetic canonical legacy communication" },
      };
      const first = parsed(
        await capability
          .tools()[0]
          .execute("send", input, new AbortController().signal),
      );
      assert.equal(first.status, "delivered");
      assert.equal(first.settled, true);
      const again = parsed(
        await capability
          .tools()[0]
          .execute("repair", input, new AbortController().signal),
      );
      assert.match(JSON.stringify(again), /ALREADY_PERFORMED/);
      const messages = await t.b.db
        .collection("coach_member_message_receipts")
        .find({})
        .toArray();
      assert.equal(messages.length, 1);
      assert.equal(
        messages[0].text_hash,
        createHash("sha256").update(input.body.text).digest("hex"),
      );
      const rows = await t.b.occurrences();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "succeeded");
      const posts = t.requests.filter(
        (r) => r.method === "POST" && r.path === input.path,
      );
      assert.equal(posts.length, 1);
      assert.equal(posts[0].invocationBinding, undefined);
      assert.equal(posts[0].workBinding, undefined);
      assert.equal(
        await t.b.db
          .collection("coach_invocation_occurrences")
          .countDocuments({}),
        0,
      );
    } finally {
      await t.close();
    }
  },
);
