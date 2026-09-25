import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { fixture } from "./operator-checkins.test.js";

const scenarios = [
  {
    text: "Hey Coach, good morning",
    plan: { kind: "discussion", targets: [], domains: [], action: "none" },
    read: [],
    send: false,
    status: 200,
  },
  {
    text: "How is Alex doing in their Coach feed?",
    plan: {
      kind: "read",
      targets: ["feed"], // provider hallucinated a domain as a member
      domains: ["feed"],
      action: "none",
    },
    read: ["member-photo"],
    send: false,
    status: 200,
  },
  {
    text: "How is Alex doing in their Coach feed?",
    plan: {
      kind: "read",
      targets: ["Alex"],
      domains: ["feed"],
      action: "none",
    },
    read: ["member-two"],
    send: false,
    status: 400,
  },
  {
    text: "How is Alex doing in their Coach feed?",
    plan: { kind: "clarify", targets: [], domains: [], action: "uncertain" },
    read: ["member-photo"],
    send: false,
    status: 200,
  },
  {
    text: "What's the dojo check-in picture situation?",
    plan: { kind: "read", targets: [], domains: ["checkins"], action: "none" },
    read: [],
    send: false,
    status: 400,
  },
  {
    text: "How do Alex and Morgan stack up in the feed?",
    plan: {
      kind: "read",
      targets: ["Alex", "Morgan"],
      domains: ["feed"],
      action: "none",
    },
    read: ["member-photo"],
    send: false,
    status: 400,
  },
  {
    text: "Compare Alex vs Kai in the feed",
    plan: {
      kind: "read",
      targets: ["Alex", "Kai"],
      domains: ["feed"],
      action: "none",
    },
    read: ["member-photo"],
    send: false,
    status: 400,
  },
  {
    text: "Send Alex a note saying hello",
    plan: { kind: "action", targets: ["Alex"], domains: [], action: "send" },
    read: [],
    send: true,
    status: 200,
  },
  {
    text: "Maybe send Alex a note?",
    plan: {
      kind: "clarify",
      targets: ["Alex"],
      domains: [],
      action: "uncertain",
    },
    read: [],
    send: false,
    status: 200,
  },
  {
    text: "Schedule Alex's session tomorrow",
    plan: {
      kind: "clarify",
      targets: ["Alex"],
      domains: [],
      action: "uncertain",
    },
    read: [],
    send: false,
    status: 200,
  },
  {
    text: "Schedule Alex's session tomorrow",
    plan: { kind: "discussion", targets: [], domains: [], action: "none" },
    read: [],
    send: false,
    status: 200,
  },
  {
    text: "Who's in my dojo?",
    plan: { kind: "read", targets: [], domains: ["roster"], action: "none" },
    read: [],
    send: false,
    status: 200,
  },
  {
    text: "How are dojo members doing in the feed?",
    plan: { kind: "read", targets: [], domains: ["feed"], action: "none" },
    read: [],
    send: false,
    status: 400,
  },
  {
    text: "How are dojo members doing in the feed?",
    plan: {
      kind: "read",
      targets: ["feed"],
      domains: ["feed"],
      action: "none",
    },
    read: ["member-photo", "member-two", "member-denied"],
    send: false,
    status: 200,
  },
  {
    text: "How is Pat doing in the feed?",
    plan: { kind: "read", targets: ["Pat"], domains: ["feed"], action: "none" },
    read: ["member-denied"],
    send: false,
    status: 400,
  },
  {
    text: "Send me Alex's progress",
    plan: { kind: "action", targets: ["Alex"], domains: [], action: "send" },
    read: [],
    send: false,
    status: 400,
  },
  {
    text: "Hey Coach, good morning",
    plan: { kind: "action", targets: ["Alex"], domains: [], action: "send" },
    read: [],
    send: false,
    status: 400,
  },
] as const;

for (const [index, scenario] of scenarios.entries())
  test(`typed intent HTTP scenario ${index}: ${scenario.text}`, async () => {
    const f = await fixture({
      two: true,
      ...(scenario.text.includes("Pat") ? { denyFeed: "member-denied" } : {}),
    });
    const dir = await mkdtemp(tmpdir() + "/operator-plan-");
    let app: Awaited<ReturnType<typeof admin>> | undefined;
    try {
      const store = new Store(dir);
      await store.init();
      await store.save({
        ...store.publicConfig(),
        origin: f.origin,
        token: "synthetic-token",
        ["api" + "Key"]: "synthetic-key",
      });
      let attempts = 0;
      app = await admin(
        store,
        0,
        async (_p, _s, _c, _signal, tools = []) => {
          attempts++;
          const send = tools.find(
            (t) => t.name === "studio_operator_send_message",
          );
          assert.equal(!!send, scenario.send);
          for (const member_ref of scenario.read) {
            try {
              await tools
                .find(
                  (t) => t.name === "studio_operator_read_member_coach_feed",
                )!
                .execute("read", { member_ref });
            } catch {
              /* denied receipt; model may not treat it as success */
            }
          }
          if (send)
            await send.execute("send", {
              member_ref: "member-photo",
              text: "hello",
            });
          return scenario.send
            ? "Sent hello."
            : "Alex's feed looks strong; all requested evidence was checked.";
        },
        undefined,
        undefined,
        undefined,
        async () => scenario.plan,
      );
      const response = await fetch(app.origin + "/api/operator/chat", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + store.secrets.admin,
          Origin: app.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: scenario.text }),
      });
      assert.equal(
        response.status,
        scenario.status,
        await response.clone().text(),
      );
      const body = await response.json();
      if (scenario.status === 400) assert.equal(body.error, "READ_UNAVAILABLE");
      if (scenario.plan.kind === "read")
        assert.equal(
          attempts,
          scenario.text.includes("Kai")
            ? 0
            : scenario.plan.domains.includes("roster") ||
                (scenario.status === 200 && !scenario.send)
              ? 1
              : 2,
        );
      if (scenario.plan.kind === "action" && !scenario.send)
        assert.equal(attempts, 0);
      assert.equal(
        f.calls.filter((x) => x === "studio_operator_send_message").length,
        scenario.send ? 1 : 0,
      );
      if (
        scenario.plan.kind === "clarify" &&
        scenario.text.startsWith("How is")
      ) {
        assert.equal(attempts, 1);
        assert.equal(body.ephemeral, true);
      }
      if (scenario.text.startsWith("Schedule")) {
        assert.match(body.text, /not available/i);
        assert.equal(attempts, 0);
      }
      if (scenario.plan.kind === "clarify" && scenario.text.startsWith("Maybe"))
        assert.equal(attempts, 0);
      if (scenario.plan.kind === "discussion")
        assert.equal(
          f.calls.filter((x) => x.startsWith("studio_operator_read_")).length,
          0,
        );
    } finally {
      await app?.close();
      await f.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
