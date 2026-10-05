import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  uncertaintyFixture,
  emptyOutcome,
  toolResult,
} from "./helpers/native-cross-uncertainty.js";
import { toolCall } from "./helpers/continuity.js";
import { immutableWorkRequest } from "../src/capability/workActions.js";
const enabled = process.env.AUTONOMY_NATIVE_ACCEPTANCE === "1";
test(
  "ordinary work native planner creates/updates plan with negotiated transport summaries",
  { skip: !enabled, timeout: 120000 },
  async () => {
    let t!: Awaited<ReturnType<typeof uncertaintyFixture>>;
    let planId = "",
      selected = false;
    const saveMemory = async (body: unknown) => {
      const r = await fetch(t.origin + "/api/coach/memory", {
        method: "POST",
        headers: {
          authorization: "Bearer " + t.store.secrets.token,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 200);
    };
    t = await uncertaintyFixture(async (body: any) => {
      const tools = (body.tools || []).map((x: any) => x.function.name);
      for (const n of [
        "katafit_rest_request",
        "coach_discover_integrations",
        "coach_call_integration",
      ])
        assert.ok(tools.includes(n), n);
      if (!JSON.stringify(body).includes("NATIVE_ORDINARY_ENABLED_SKILL")) {
        const system = body.messages
          .filter((m: any) => m.role === "system")
          .map((m: any) => m.content)
          .join("\n");
        const location =
          /<name>katafit-api<\/name>\s*<description>[\s\S]*?<\/description>\s*<location>([^<]+)<\/location>/.exec(
            system,
          )?.[1];
        assert.ok(location, "saved enabled API skill advertised by native Pi");
        assert.ok(tools.includes("read"));
        return toolCall("read", { path: location }, "enabled-skill-read");
      }
      const got = (id: string) => toolResult(body, id);
      if (!got("memory"))
        return toolCall(
          "katafit_rest_request",
          { method: "GET", path: "/api/coach/memory?query=Native%20ordinary" },
          "memory",
        );
      assert.match(got("memory"), /Native ordinary private preference/);
      if (!got("docs"))
        return toolCall(
          "katafit_rest_request",
          { method: "GET", path: "/api/docs/coach" },
          "docs",
        );
      if (!got("create")) {
        selected = true;
        return toolCall(
          "katafit_rest_request",
          {
            method: "POST",
            path: "/api/plans",
            body: {
              title: "Synthetic automatic plan",
              goal_statement: "Bounded work-action proof",
            },
          },
          "create",
        );
      }
      const created = JSON.parse(got("create"));
      assert.equal(
        created.observation?.status,
        "response_received",
        JSON.stringify(created),
      );
      assert.equal(created.observation.effect_receipt, false);
      planId = created.response._id;
      assert.match(planId, /^[a-f0-9]{24}$/);
      if (!got("memory-later")) {
        await saveMemory({
          idempotency_key: "ordinary-dynamic-second",
          kind: "preference",
          text: "Later native ordinary private dynamic recall",
        });
        return toolCall(
          "katafit_rest_request",
          {
            method: "GET",
            path: "/api/coach/memory?query=Later%20native%20ordinary",
          },
          "memory-later",
        );
      }
      assert.match(
        got("memory-later"),
        /Later native ordinary private dynamic recall/,
      );
      if (!got("update"))
        return toolCall(
          "katafit_rest_request",
          {
            method: "PUT",
            path: "/api/plans/" + planId,
            body: { title: "Synthetic automatic plan updated" },
          },
          "update",
        );
      assert.equal(JSON.parse(got("update")).observation.effect_receipt, false);
      if (!got("readback"))
        return toolCall(
          "katafit_rest_request",
          { method: "GET", path: "/api/plans/" + planId },
          "readback",
        );
      assert.match(got("readback"), /Synthetic automatic plan updated/);
      if (!got("catalog"))
        return toolCall("coach_discover_integrations", {}, "catalog");
      if (!got("remote"))
        return toolCall(
          "coach_call_integration",
          {
            slot: "after-plan",
            tool: JSON.parse(got("catalog")).tools[0].name,
            arguments: { value: "acquired plan readback" },
          },
          "remote",
        );
      assert.equal(t.remote.calls.length, 1, got("remote"));
      return emptyOutcome();
    });
    try {
      const skill = t.store.skills.view("katafit-api");
      await t.store.skills.save(
        "katafit-api",
        {
          enabled: true,
          purpose: skill.skill!.purpose,
          triggers: skill.skill!.triggers,
          instructions:
            skill.skill!.instructions + "\nNATIVE_ORDINARY_ENABLED_SKILL",
        },
        skill.revision,
      );
      await saveMemory({
        idempotency_key: "ordinary-dynamic-first",
        kind: "preference",
        text: "Native ordinary private preference: no generic success claims",
      });
      t.b.app.use("/api", t.b.backendModule("./routes/plans"));
      const human = t.b
        .backendModule("jsonwebtoken")
        .sign({ user_id: String(t.b.user) }, process.env.JWT_SECRET);
      const {
        protocol,
        mandate_id,
        dojo_id,
        chief_id,
        revision,
        status,
        suspended_reason,
        updated_at,
        updated_by,
        capabilities,
        ...policy
      } = t.mandate;
      const p = await fetch(t.origin + "/api/coach/autonomy/mandate", {
        method: "PUT",
        headers: {
          authorization: "Bearer " + human,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          expected_revision: revision,
          idempotency_key: "ordinary-rest-policy",
          mandate: {
            ...policy,
            delegated_actions: [
              "rest_mutation",
              "manager_report",
              "configured_integration",
            ],
          },
        }),
      });
      assert.equal(p.status, 200);
      const work = await t.enqueue("ordinary-plan-native"),
        host = t.host();
      await host.start();
      const deadline = Date.now() + 15000;
      while (host.snapshot().lastWorkId !== String(work._id)) {
        t.check();
        assert.ok(
          Date.now() < deadline,
          JSON.stringify({
            failure: "native ordinary generation deadline",
            snapshot: host.snapshot(),
            providerCalls: t.bodies.length,
            requests: t.requests,
          }),
        );
        await new Promise((r) => setTimeout(r, 25));
      }
      await host.stop();
      t.check();
      assert.ok(selected);
      const plan = await t.b.db
        .collection("activity_plans")
        .findOne({ _id: new (t.b.backendModule("mongodb").ObjectId)(planId) });
      assert.equal(plan.title, "Synthetic automatic plan updated");
      assert.equal(String(plan.user_id), String(t.b.user));
      const occurrences = await t.b.db
        .collection("coach_autonomy_rest_occurrences")
        .find({ work_id: work._id })
        .toArray();
      assert.equal(occurrences.length, 2);
      assert.ok(
        occurrences.every((o: any) => o.status === "response_received"),
      );
      assert.equal(t.remote.calls.length, 1);
      const writes = t.requests.filter(
        (r) => r.path.startsWith("/api/plans") && r.method !== "GET",
      );
      assert.equal(writes.length, 2);
      for (const r of writes) {
        const digest = immutableWorkRequest({
          method: r.method,
          path: r.path,
          body: r.body,
        }).request_sha256;
        assert.equal(r.workBinding?.work_id, String(work._id));
        assert.equal(r.workBinding?.request_sha256, digest);
        const o = occurrences.find((o: any) => o.slot === r.workBinding.slot);
        assert.equal(o.request_sha256, digest);
        assert.equal(
          o.dispatch_lease_generation,
          r.workBinding.lease_generation,
        );
      }
      assert.ok(
        t.requests
          .filter((r) => r.method === "GET")
          .every((r) => !r.workBinding),
        "private work binding is write-only and host-authored",
      );
      const canonical = await t.b.db
        .collection("coach_autonomy_work")
        .findOne({ _id: work._id });
      assert.equal(
        canonical.actions.filter(
          (a: any) => a.type === "rest_mutation" && a.effect_receipt === false,
        ).length,
        2,
      );
      if (process.env.NATIVE_ACCEPTANCE_EVIDENCE) {
        await mkdir(process.env.NATIVE_ACCEPTANCE_EVIDENCE, {
          recursive: true,
        });
        await writeFile(
          process.env.NATIVE_ACCEPTANCE_EVIDENCE + "/ordinary-plan-native.json",
          JSON.stringify(
            {
              plan,
              occurrences,
              canonical,
              requests: t.requests,
              providerPayloads: t.bodies,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      await t.close();
    }
  },
);
