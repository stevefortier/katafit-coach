import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { fixture } from "./operator-checkins.test.js";
import type { IntentPlan } from "../src/chat/operatorPlan.js";

async function run(
  text: string,
  plan: IntentPlan,
  model: (tools: any[]) => Promise<string>,
  options: Parameters<typeof fixture>[0] = {},
) {
  const backend = await fixture({ two: true, ...options });
  const dir = await mkdtemp(tmpdir() + "/operator-release-");
  let app: Awaited<ReturnType<typeof admin>> | undefined;
  try {
    const store = new Store(dir);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin: backend.origin,
      token: "synthetic-token",
      ["api" + "Key"]: "synthetic-key",
    });
    let attempts = 0;
    app = await admin(
      store,
      0,
      async (_p, _s, _c, _signal, tools = []) => {
        attempts++;
        return model(tools);
      },
      undefined,
      undefined,
      undefined,
      async () => plan,
    );
    const response = await fetch(app.origin + "/api/operator/chat", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + store.secrets.admin,
        Origin: app.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
    const body = await response.json();
    const history = await (
      await fetch(app.origin + "/api/operator/chat", {
        headers: {
          Authorization: "Bearer " + store.secrets.admin,
          Origin: app.origin,
        },
      })
    ).json();
    return {
      status: response.status,
      body,
      history,
      attempts,
      calls: backend.calls,
      callArgs: backend.callArgs,
    };
  } finally {
    await app?.close();
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  }
}
const feed = (tools: any[]) =>
  tools.find((t) => t.name === "studio_operator_read_member_coach_feed")!;
const checkins = (tools: any[]) =>
  tools.find((t) => t.name === "studio_operator_list_dojo_checkins")!;

test("a named member current-data question cannot persist a discussion-classified fabrication", async () => {
  const result = await run(
    "How has Alex progressed this week?",
    { kind: "discussion", targets: [], domains: [], action: "none" },
    async () => "Alex completed two workouts this week.",
  );
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "READ_UNAVAILABLE");
  assert.deepEqual(result.history.messages, []);
});

test("imperative named progress summary cannot use discussion classification to persist invented facts", async () => {
  const result = await run(
    "Summarize Alex’s progress now",
    { kind: "discussion", targets: [], domains: [], action: "none" },
    async () => "Alex completed two workouts this week.",
  );
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "READ_UNAVAILABLE");
  assert.deepEqual(result.history.messages, []);
});

test("unsupported mutation paraphrase cannot claim completion without a receipt", async () => {
  const result = await run(
    "Arrange Alex’s session tomorrow",
    { kind: "discussion", targets: [], domains: [], action: "none" },
    async () => "Done, Alex's session is arranged.",
  );
  assert.notEqual(result.status, 200);
  assert.deepEqual(result.history.messages, []);
});

test("group coverage includes unnamed members despite one named member", async () => {
  const result = await run(
    "How are all dojo members, including Alex, doing in the feed?",
    { kind: "read", targets: ["Alex"], domains: ["feed"], action: "none" },
    async (tools) => {
      await feed(tools).execute("alex", { member_ref: "member-photo" });
      return "Everyone is doing well.";
    },
  );
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "READ_UNAVAILABLE");
});

test("photo interpretation requires image bytes, not check-in metadata", async () => {
  const result = await run(
    "How do Alex's progress photos look?",
    { kind: "read", targets: ["Alex"], domains: ["checkins"], action: "none" },
    async (tools) => {
      await checkins(tools).execute("metadata", { limit: 10 });
      return "Alex's physique has improved in the photos.";
    },
  );
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "READ_UNAVAILABLE");
  assert.equal(
    result.calls.includes("studio_operator_read_dojo_checkin_image"),
    false,
  );
});

test("a denied later page invalidates an earlier successful feed page", async () => {
  const result = await run(
    "Read Alex's complete Coach feed",
    { kind: "read", targets: ["Alex"], domains: ["feed"], action: "none" },
    async (tools) => {
      await feed(tools).execute("first", { member_ref: "member-photo" });
      try {
        await feed(tools).execute("second", {
          member_ref: "member-photo",
          cursor: "feed-next",
        });
      } catch {}
      return "Alex's complete feed is strong.";
    },
    { denyFeedLaterPage: "member-photo" },
  );
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "READ_UNAVAILABLE");
  assert.equal(
    result.callArgs.filter(
      (x) => x.name === "studio_operator_read_member_coach_feed",
    ).length,
    2,
  );
});

test("SEND never accepts a substring of the manager's quoted payload", async () => {
  const result = await run(
    'Send Alex exactly: "Do not train today"',
    { kind: "action", targets: ["Alex"], domains: [], action: "send" },
    async (tools) => {
      await tools
        .find((t) => t.name === "studio_operator_send_message")!
        .execute("send", {
          member_ref: "member-photo",
          text: "train",
        });
      return "Sent.";
    },
  );
  assert.equal(result.status, 400);
  assert.equal(result.calls.includes("studio_operator_send_message"), false);
});

test("SEND preserves the complete source-anchored quoted payload", async () => {
  const result = await run(
    'Send Alex exactly: "Do not train today"',
    { kind: "action", targets: ["Alex"], domains: [], action: "send" },
    async (tools) => {
      await tools
        .find((t) => t.name === "studio_operator_send_message")!
        .execute("send", {
          member_ref: "member-photo",
          text: "Do not train today",
        });
      return "Sent.";
    },
  );
  assert.equal(result.status, 200);
  assert.deepEqual(
    result.callArgs
      .filter((x) => x.name === "studio_operator_send_message")
      .map((x) => x.args.text),
    ["Do not train today"],
  );
});
