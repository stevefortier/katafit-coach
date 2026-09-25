import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import {
  modelRequestPlanner,
  modelRequestAudit,
} from "../src/chat/operatorPlan.js";
import { fixture } from "./operator-checkins.test.js";

function traceRequest(scenario: string) {
  const log = (
    stage: string,
    value: Awaited<ReturnType<typeof modelRequestPlanner>>,
  ) =>
    console.log(
      JSON.stringify({
        scenario,
        stage,
        status: value.status,
        reason: value.status === "uncertain" ? value.reason : undefined,
        kind: value.status === "advisory" ? value.claim.kind : undefined,
        scope: value.status === "advisory" ? value.claim.scope : undefined,
        targetCount:
          value.status === "advisory" ? value.claim.targets.length : undefined,
        evidence:
          value.status === "advisory"
            ? value.claim.evidence.map((e) => ({
                level: e.level,
                domains: e.domains,
              }))
            : undefined,
      }),
    );
  return {
    plan: async (...args: Parameters<typeof modelRequestPlanner>) => {
      const value = await modelRequestPlanner(...args);
      log("plan", value);
      return value;
    },
    audit: async (...args: Parameters<typeof modelRequestAudit>) => {
      const value = await modelRequestAudit(...args);
      log("audit", value);
      return value;
    },
  };
}

// Opt-in: real model, synthetic authorized roster and HTTP MCP; never customer records.
test(
  "selected model compares two synthetic dojo members using real native reads",
  {
    skip:
      process.env.OPERATOR_TEST_LIVE !== "1" ||
      !process.env.UBUNTU3090_LM_STUDIO_TOKEN,
    timeout: 360000,
  },
  async () => {
    const f = await fixture({ two: true });
    const dir = await mkdtemp(tmpdir() + "/operator-live-synthetic-");
    let app: Awaited<ReturnType<typeof admin>> | undefined;
    try {
      const store = new Store(dir);
      await store.init();
      await store.save({
        ...store.publicConfig(),
        origin: f.origin,
        provider: {
          baseUrl: process.env.UBUNTU3090_LM_STUDIO_BASE_URL!,
          model: process.env.OPERATOR_TEST_MODEL ?? "qwen/qwen3.8-27b",
          vision: false,
        },
        token: "synthetic-token",
        ["api" + "Key"]: process.env.UBUNTU3090_LM_STUDIO_TOKEN!,
      });
      const traced = traceRequest("comparison");
      app = await admin(
        store,
        0,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        traced.plan,
        traced.audit,
      );
      const response = await fetch(app.origin + "/api/operator/chat", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + store.secrets.admin,
          Origin: app.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: "Compare Alex vs Morgan from their currently authorized Coach feeds. If a domain was not read, say so.",
        }),
        signal: AbortSignal.timeout(340000),
      });
      const result = await response.json();
      const calls = f.calls;
      const list = calls.filter((name) =>
        [
          "studio_operator_list_members",
          "studio_operator_list_dojo_checkins",
        ].includes(name),
      ).length;
      const feed = calls.filter(
        (name) => name === "studio_operator_read_member_coach_feed",
      ).length;
      console.log(
        JSON.stringify({
          status: response.status,
          list,
          feed,
          checkins: calls.filter(
            (name) => name === "studio_operator_list_dojo_checkins",
          ).length,
          ephemeral: result.ephemeral,
          answer: result.text?.slice(0, 500),
          error: result.error,
        }),
      );
      assert.equal(response.status, 200);
      assert.ok(list > 0);
      assert.ok(feed >= 2);
      assert.match(result.text, /Alex/i);
      assert.match(result.text, /Morgan/i);
      assert.match(result.text, /two|2/i);
      assert.match(result.text, /one|1/i);
      assert.doesNotMatch(
        result.text,
        /provide (?:their|the) (?:files|evidence)/i,
      );
    } finally {
      await app?.close();
      await f.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

for (const scenario of [
  {
    text: "How is Alex doing?",
    name: "single member",
    expected: "studio_operator_read_member_coach_feed",
    answer: /Alex/i,
  },
  {
    text: "What's the dojo-wide check-in situation?",
    name: "group check-in",
    expected: "studio_operator_list_dojo_checkins",
    answer: /check.in|photo|shared/i,
  },
])
  test(
    `selected model answers synthetic ${scenario.name} with authorized reads`,
    {
      skip:
        process.env.OPERATOR_TEST_LIVE !== "1" ||
        !process.env.UBUNTU3090_LM_STUDIO_TOKEN,
      timeout: 360000,
    },
    async () => {
      const f = await fixture({ two: true });
      const dir = await mkdtemp(tmpdir() + "/operator-live-synthetic-");
      let app: Awaited<ReturnType<typeof admin>> | undefined;
      try {
        const store = new Store(dir);
        await store.init();
        await store.save({
          ...store.publicConfig(),
          origin: f.origin,
          provider: {
            baseUrl: process.env.UBUNTU3090_LM_STUDIO_BASE_URL!,
            model: process.env.OPERATOR_TEST_MODEL ?? "qwen/qwen3.8-27b",
            vision: false,
          },
          token: "synthetic-token",
          ["api" + "Key"]: process.env.UBUNTU3090_LM_STUDIO_TOKEN!,
        });
        const traced = traceRequest(scenario.name);
        app = await admin(
          store,
          0,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          traced.plan,
          traced.audit,
        );
        const response = await fetch(app.origin + "/api/operator/chat", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + store.secrets.admin,
            Origin: app.origin,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ text: scenario.text }),
          signal: AbortSignal.timeout(340000),
        });
        const result = await response.json();
        console.log(
          JSON.stringify({
            scenario: scenario.name,
            status: response.status,
            readCount: f.calls.filter((name) => name === scenario.expected)
              .length,
            ephemeral: result.ephemeral,
            error: result.error,
          }),
        );
        assert.equal(response.status, 200);
        assert.ok(f.calls.includes(scenario.expected));
        assert.equal(result.ephemeral, true);
        assert.match(result.text, scenario.answer);
        assert.equal(
          f.calls.filter((name) => name === "studio_operator_send_message")
            .length,
          0,
        );
      } finally {
        await app?.close();
        await f.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

test(
  "selected model dispatches one exact synthetic send with canonical receipt",
  {
    skip:
      process.env.OPERATOR_TEST_LIVE !== "1" ||
      !process.env.UBUNTU3090_LM_STUDIO_TOKEN,
    timeout: 360000,
  },
  async () => {
    const f = await fixture({ two: true });
    const dir = await mkdtemp(tmpdir() + "/operator-live-send-");
    let app: Awaited<ReturnType<typeof admin>> | undefined;
    try {
      const store = new Store(dir);
      await store.init();
      await store.save({
        ...store.publicConfig(),
        origin: f.origin,
        provider: {
          baseUrl: process.env.UBUNTU3090_LM_STUDIO_BASE_URL!,
          model: process.env.OPERATOR_TEST_MODEL ?? "qwen/qwen3.8-27b",
          vision: false,
        },
        token: "synthetic-token",
        ["api" + "Key"]: process.env.UBUNTU3090_LM_STUDIO_TOKEN!,
      });
      const traced = traceRequest("exact send");
      app = await admin(
        store,
        0,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        traced.plan,
        traced.audit,
      );
      const response = await fetch(app.origin + "/api/operator/chat", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + store.secrets.admin,
          Origin: app.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: 'Send Alex exactly: "Do not train today"',
        }),
        signal: AbortSignal.timeout(340000),
      });
      const result = await response.json();
      const sends = f.callArgs.filter(
        (call) => call.name === "studio_operator_send_message",
      );
      console.log(
        JSON.stringify({
          scenario: "exact send",
          status: response.status,
          sends: sends.length,
          error: result.error,
        }),
      );
      assert.equal(response.status, 200);
      assert.deepEqual(
        sends.map((call) => call.args.text),
        ["Do not train today"],
      );
      assert.match(result.text, /delivered to Alex/i);
      assert.equal(result.ephemeral, true);
    } finally {
      await app?.close();
      await f.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "selected model truthfully rejects an unsupported synthetic action",
  {
    skip:
      process.env.OPERATOR_TEST_LIVE !== "1" ||
      !process.env.UBUNTU3090_LM_STUDIO_TOKEN,
    timeout: 360000,
  },
  async () => {
    const f = await fixture({ two: true });
    const dir = await mkdtemp(tmpdir() + "/operator-live-unsupported-");
    let app: Awaited<ReturnType<typeof admin>> | undefined;
    try {
      const store = new Store(dir);
      await store.init();
      await store.save({
        ...store.publicConfig(),
        origin: f.origin,
        provider: {
          baseUrl: process.env.UBUNTU3090_LM_STUDIO_BASE_URL!,
          model: process.env.OPERATOR_TEST_MODEL ?? "qwen/qwen3.8-27b",
          vision: false,
        },
        token: "synthetic-token",
        ["api" + "Key"]: process.env.UBUNTU3090_LM_STUDIO_TOKEN!,
      });
      const traced = traceRequest("unsupported action");
      app = await admin(
        store,
        0,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        traced.plan,
        traced.audit,
      );
      const response = await fetch(app.origin + "/api/operator/chat", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + store.secrets.admin,
          Origin: app.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: "Arrange Alex's training appointment tomorrow",
        }),
        signal: AbortSignal.timeout(340000),
      });
      const result = await response.json();
      const sends = f.calls.filter(
        (name) => name === "studio_operator_send_message",
      ).length;
      console.log(
        JSON.stringify({
          scenario: "unsupported action",
          status: response.status,
          sends,
          error: result.error,
        }),
      );
      assert.equal(sends, 0);
      if (response.status === 200) {
        assert.match(result.text, /not available|cannot|can't/i);
      } else {
        assert.equal(response.status, 400);
        assert.equal(result.error, "PLAN_UNAVAILABLE");
        assert.match(result.hint, /no action was taken/i);
      }
    } finally {
      await app?.close();
      await f.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
