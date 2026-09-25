import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { fixture } from "./operator-checkins.test.js";
import type { IntentPlan, ClaimAssessment } from "../src/chat/operatorPlan.js";

async function run(
  text: string,
  plan: IntentPlan,
  model: (tools: any[]) => Promise<string>,
  options: Parameters<typeof fixture>[0] = {},
  requestClaim?: ClaimAssessment,
  auditClaim: ClaimAssessment | undefined = requestClaim,
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
      requestClaim ? async () => requestClaim : undefined,
      auditClaim ? async () => auditClaim : undefined,
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
const unsupported = (actionQuote: string): ClaimAssessment => ({
  status: "advisory",
  claim: {
    kind: "unsupported",
    scope: "none",
    scopeQuote: "",
    targets: [],
    evidence: [],
    actionQuote,
    payloadQuote: "",
  },
});

test("host proactively performs scoped read even when model never invokes a tool", async () => {
  const result = await run(
    "Compare Alex and Morgan from their Coach feeds",
    { kind: "discussion", targets: [], domains: [], action: "none" },
    async () => "Alex completed two workouts and Morgan completed one.",
    {},
    {
      status: "advisory",
      claim: {
        kind: "read",
        scope: "named",
        scopeQuote: "Alex and Morgan",
        targets: [
          { name: "Alex", quote: "Alex" },
          { name: "Morgan", quote: "Morgan" },
        ],
        evidence: [
          { level: "metadata", domains: ["feed"], quote: "Coach feeds" },
        ],
        actionQuote: "",
        payloadQuote: "",
      },
    },
  );
  assert.equal(result.status, 200);
  assert.ok(
    result.calls.filter(
      (name) => name === "studio_operator_read_member_coach_feed",
    ).length >= 2,
  );
  assert.equal(result.body.ephemeral, true);
  assert.deepEqual(result.history.messages, []);
});

test("a named member current-data question cannot persist a discussion-classified fabrication", async () => {
  const result = await run(
    "How has Alex progressed this week?",
    { kind: "discussion", targets: [], domains: [], action: "none" },
    async () => "Alex completed two workouts this week.",
    {},
    {
      status: "advisory",
      claim: {
        kind: "read",
        scope: "named",
        scopeQuote: "Alex",
        targets: [{ name: "Alex", quote: "Alex" }],
        evidence: [
          { level: "metadata", domains: ["feed"], quote: "progressed" },
        ],
        actionQuote: "",
        payloadQuote: "",
      },
    },
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
    {},
    {
      status: "advisory",
      claim: {
        kind: "read",
        scope: "named",
        scopeQuote: "Alex",
        targets: [{ name: "Alex", quote: "Alex" }],
        evidence: [{ level: "metadata", domains: ["feed"], quote: "progress" }],
        actionQuote: "",
        payloadQuote: "",
      },
    },
  );
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "READ_UNAVAILABLE");
  assert.deepEqual(result.history.messages, []);
});

test("unrecognized wording about a named member still needs evidence", async () => {
  const result = await run(
    "Give me Alex's latest standing",
    { kind: "discussion", targets: [], domains: [], action: "none" },
    async () => "Alex is improving quickly.",
    {},
    {
      status: "advisory",
      claim: {
        kind: "read",
        scope: "named",
        scopeQuote: "Alex",
        targets: [{ name: "Alex", quote: "Alex" }],
        evidence: [{ level: "metadata", domains: ["feed"], quote: "standing" }],
        actionQuote: "",
        payloadQuote: "",
      },
    },
  );
  assert.equal(result.status, 400);
  assert.deepEqual(result.history.messages, []);
});

test("an unsupported action paraphrase has no completion without an action receipt", async () => {
  const result = await run(
    "Set up Alex's next appointment",
    { kind: "discussion", targets: [], domains: [], action: "none" },
    async () => "I arranged the appointment.",
    {},
    unsupported("Set up"),
  );
  assert.equal(result.status, 200);
  assert.match(result.body.text, /not available.*no change was made/i);
  assert.equal(result.attempts, 0);
  assert.equal(result.calls.includes("studio_operator_send_message"), false);
  assert.deepEqual(result.history.messages, []);
});

test("unsupported mutation paraphrase cannot claim completion without a receipt", async () => {
  const result = await run(
    "Arrange Alex’s session tomorrow",
    { kind: "discussion", targets: [], domains: [], action: "none" },
    async () => "Done, Alex's session is arranged.",
    {},
    unsupported("Arrange"),
  );
  assert.equal(result.status, 200);
  assert.match(result.body.text, /not available.*no change was made/i);
  assert.equal(result.attempts, 0);
  assert.deepEqual(result.history.messages, []);
});

test("unsupported dojo-wide action cannot claim completion without a receipt", async () => {
  const result = await run(
    "Set up tomorrow's dojo schedule",
    { kind: "discussion", targets: [], domains: [], action: "none" },
    async () => "Done, the schedule is set.",
    {},
    unsupported("Set up"),
  );
  assert.equal(result.status, 200);
  assert.match(result.body.text, /not available.*no change was made/i);
  assert.equal(result.attempts, 0);
  assert.deepEqual(result.history.messages, []);
});

test("unquoted send cannot dispatch a substring of the requested content", async () => {
  const result = await run(
    "Send Alex a note saying do not train today",
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

test("a quote followed by additional instructions is not a complete send payload", async () => {
  const result = await run(
    'Send Alex "Hi" and tell him to rest',
    { kind: "action", targets: ["Alex"], domains: [], action: "send" },
    async (tools) => {
      await tools
        .find((t) => t.name === "studio_operator_send_message")!
        .execute("send", {
          member_ref: "member-photo",
          text: "Hi",
        });
      return "Sent.";
    },
  );
  assert.equal(result.status, 400);
  assert.equal(result.calls.includes("studio_operator_send_message"), false);
});

test("group coverage includes unnamed members despite one named member", async () => {
  const result = await run(
    "How are all dojo members, including Alex, doing in the feed?",
    { kind: "read", targets: ["Alex"], domains: ["feed"], action: "none" },
    async (tools) => {
      await feed(tools).execute("alex", { member_ref: "member-photo" });
      return "Everyone is doing well.";
    },
    {},
    claim("read", "dojo", ["feed"]),
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
    {},
    claim("read", "named", ["checkins", "image"]),
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

test("typed explicit send dispatches once without waiting for model to choose a tool", async () => {
  const result = await run(
    'Send Alex exactly: "Do not train today"',
    { kind: "discussion", targets: [], domains: [], action: "none" },
    async () => "Sent.",
    {},
    {
      status: "advisory",
      claim: {
        kind: "send",
        scope: "named",
        scopeQuote: "Alex",
        targets: [{ name: "Alex", quote: "Alex" }],
        evidence: [],
        actionQuote: "Send",
        payloadQuote: '"Do not train today"',
      },
    },
  );
  assert.equal(result.status, 200);
  assert.deepEqual(
    result.callArgs
      .filter((x) => x.name === "studio_operator_send_message")
      .map((x) => x.args.text),
    ["Do not train today"],
  );
  assert.equal(result.body.ephemeral, true);
  assert.deepEqual(result.history.messages, []);
});

test("unknown delivery is never retried or claimed delivered", async () => {
  const result = await run(
    'Send Alex exactly: "Do not train today"',
    { kind: "discussion", targets: [], domains: [], action: "none" },
    async () => "Sent.",
    { failSend: true },
    {
      status: "advisory",
      claim: {
        kind: "send",
        scope: "named",
        scopeQuote: "Alex",
        targets: [{ name: "Alex", quote: "Alex" }],
        evidence: [],
        actionQuote: "Send",
        payloadQuote: '"Do not train today"',
      },
    },
  );
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "DELIVERY_UNVERIFIED");
  assert.equal(
    result.calls.filter((name) => name === "studio_operator_send_message")
      .length,
    1,
  );
  assert.deepEqual(result.history.messages, []);
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

const claim = (
  kind: "conversation" | "read" | "send" | "unsupported",
  scope: "none" | "named" | "dojo" = "none",
  domains: Array<"feed" | "checkins" | "image"> = [],
): ClaimAssessment => ({
  status: "advisory",
  claim: {
    kind,
    scope,
    scopeQuote:
      scope === "named" ? "Alex" : scope === "dojo" ? "all dojo members" : "",
    targets: scope === "none" ? [] : [{ name: "Alex", quote: "Alex" }],
    evidence: domains.length
      ? [
          {
            level: domains.includes("image") ? "image" : "metadata",
            domains,
            quote: domains.includes("image") ? "photos" : "feed",
          },
        ]
      : [],
    actionQuote: "",
    payloadQuote: "",
  },
});

test("typed read claim overrides hostile old-planner discussion", async () => {
  const result = await run(
    "How is Alex doing in the feed?",
    { kind: "discussion", targets: [], domains: [], action: "none" },
    async () => "Alex completed two workouts.",
    {},
    claim("read", "named", ["feed"]),
  );
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "READ_UNAVAILABLE");
  assert.deepEqual(result.history.messages, []);
});

test("hostile typed conversation claim cannot fabricate named member progress", async () => {
  const result = await run(
    "Summarize Alex's progress now",
    { kind: "discussion", targets: [], domains: [], action: "none" },
    async () => "Alex completed two workouts.",
    {},
    claim("conversation"),
    {
      status: "advisory",
      claim: {
        kind: "read",
        scope: "named",
        scopeQuote: "Alex",
        targets: [{ name: "Alex", quote: "Alex" }],
        evidence: [{ level: "metadata", domains: ["feed"], quote: "progress" }],
        actionQuote: "",
        payloadQuote: "",
      },
    },
  );
  assert.equal(result.status, 400);
  assert.deepEqual(result.history.messages, []);
});

test("hostile typed conversation claim cannot claim a dojo action completed", async () => {
  const result = await run(
    "Set up tomorrow's dojo schedule",
    { kind: "discussion", targets: [], domains: [], action: "none" },
    async () => "Done, the schedule is set.",
    {},
    claim("conversation"),
    unsupported("Set up"),
  );
  assert.equal(result.status, 400);
  assert.deepEqual(result.history.messages, []);
});

test("typed dojo scope requires coverage beyond a named example", async () => {
  const result = await run(
    "How are all dojo members, including Alex, doing in the feed?",
    { kind: "discussion", targets: [], domains: [], action: "none" },
    async (tools) => {
      await feed(tools).execute("alex", { member_ref: "member-photo" });
      return "Everyone is well.";
    },
    {},
    claim("read", "dojo", ["feed"]),
  );
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "READ_UNAVAILABLE");
});

test("source-anchored but semantically wrong named scope fails closed", async () => {
  const result = await run(
    "How are all dojo members except Alex doing in the feed?",
    { kind: "discussion", targets: [], domains: [], action: "none" },
    async () => "Alex is well.",
    {},
    claim("read", "named", ["feed"]),
  );
  assert.equal(result.status, 400);
  assert.deepEqual(result.history.messages, []);
});

test("source-anchored metadata claim cannot answer a visual question", async () => {
  const result = await run(
    "How do Alex's photos look in the feed?",
    { kind: "discussion", targets: [], domains: [], action: "none" },
    async () => "Alex looks stronger.",
    {},
    claim("read", "named", ["feed"]),
  );
  assert.equal(result.status, 400);
  assert.deepEqual(result.history.messages, []);
});

test("hostile typed metadata claim cannot make a visual assertion after a feed read", async () => {
  const result = await run(
    "How do Alex's photos look in the feed?",
    { kind: "discussion", targets: [], domains: [], action: "none" },
    async (tools) => {
      await feed(tools).execute("feed", { member_ref: "member-photo" });
      return "Alex looks stronger in the photos.";
    },
    {},
    claim("read", "named", ["feed"]),
    claim("read", "named", ["checkins", "image"]),
  );
  assert.equal(result.status, 400);
  assert.deepEqual(result.history.messages, []);
});

test("uncertain typed claim cannot fall through to old planner", async () => {
  const result = await run(
    "How is Alex doing?",
    { kind: "discussion", targets: [], domains: [], action: "none" },
    async () => "Alex is well.",
    {},
    { status: "uncertain", reason: "shape-or-anchor" },
  );
  assert.equal(result.attempts, 0);
  assert.deepEqual(result.history.messages, []);
});

test("hostile typed named scope cannot narrow a dojo-wide request", async () => {
  const result = await run(
    "How are all dojo members, including Alex, doing in the feed?",
    { kind: "discussion", targets: [], domains: [], action: "none" },
    async (tools) => {
      await feed(tools).execute("alex", { member_ref: "member-photo" });
      return "Everyone is doing well.";
    },
    {},
    claim("read", "named", ["feed"]),
    claim("read", "dojo", ["feed"]),
  );
  assert.equal(result.status, 400);
  assert.deepEqual(result.history.messages, []);
});

test("typed unquoted full saying payload is delivered without confirmation", async () => {
  const result = await run(
    "Send Alex a note saying do not train today",
    { kind: "discussion", targets: [], domains: [], action: "none" },
    async (tools) => {
      await tools
        .find((t) => t.name === "studio_operator_send_message")!
        .execute("send", {
          member_ref: "member-photo",
          text: "do not train today",
        });
      return "Sent.";
    },
    {},
    {
      status: "advisory",
      claim: {
        kind: "send",
        scope: "named",
        scopeQuote: "Alex",
        targets: [{ name: "Alex", quote: "Alex" }],
        evidence: [],
        actionQuote: "Send",
        payloadQuote: "do not train today",
      },
    },
  );
  assert.equal(result.status, 200);
  assert.deepEqual(
    result.callArgs
      .filter((x) => x.name === "studio_operator_send_message")
      .map((x) => x.args.text),
    ["do not train today"],
  );
});

test("anchored but incomplete send claim cannot deliver a shortened payload", async () => {
  const result = await run(
    'Send Alex exactly: "Do not train today"',
    { kind: "discussion", targets: [], domains: [], action: "none" },
    async (tools) => {
      await tools
        .find((t) => t.name === "studio_operator_send_message")
        ?.execute("send", { member_ref: "member-photo", text: "train" });
      return "Sent.";
    },
    {},
    {
      status: "advisory",
      claim: {
        kind: "send",
        scope: "named",
        scopeQuote: "Alex",
        targets: [{ name: "Alex", quote: "Alex" }],
        evidence: [],
        actionQuote: "Send",
        payloadQuote: '"train"',
      },
    },
  );
  assert.equal(result.status, 400);
  assert.equal(result.calls.includes("studio_operator_send_message"), false);
});
