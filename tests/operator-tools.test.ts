import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "../src/katafit/client.js";
import { openOperatorTools } from "../src/katafit/operatorTools.js";

export async function operatorBackend(
  transform?: (name: string, result: any, body: any) => any | Promise<any>,
) {
  const calls: any[] = [];
  const server = createServer(async (req, res) => {
    if (req.url?.endsWith("coach.md")) {
      res.end("# Kata.fit external Coach agent v1\nCoach policy");
      return;
    }
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    calls.push(body);
    const name = body.params?.name;
    let result: any = {};
    if (body.method === "initialize")
      result = { protocolVersion: "2025-03-26" };
    if (body.method === "tools/list")
      result = {
        tools: [
          "studio_operator_open_session",
          "studio_operator_read_member_coach_feed",
          "studio_operator_send_message",
          "studio_operator_get_action",
          "studio_operator_close_session",
        ].map((name) => ({ name })),
      };
    if (name === "studio_operator_open_session")
      result = {
        schema_version: 1,
        session_id: "session-fixture",
        member_ref: "member-fixture",
        status: "active",
        expires_at: new Date(Date.now() + 600000).toISOString(),
        allowed_tools: [
          "studio_operator_read_member_coach_feed",
          "studio_operator_send_message",
        ],
      };
    if (name === "studio_operator_read_member_coach_feed")
      result = {
        schema_version: 1,
        member_ref: "member-fixture",
        items: [{ text: "PRIVATE_MEMBER lower trust" }],
        has_more: false,
      };
    if (name === "studio_operator_send_message")
      result = {
        schema_version: 1,
        session_id: "session-fixture",
        action_id: "action-fixture",
        message_id: "message-fixture",
        status: "delivered",
        idempotent: false,
      };
    if (name === "studio_operator_close_session")
      result = {
        schema_version: 1,
        session_id: "session-fixture",
        status: "closed",
      };
    result = (await transform?.(name ?? body.method, result, body)) ?? result;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result:
          body.method === "tools/call" ? { structuredContent: result } : result,
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    calls,
    origin: `http://127.0.0.1:${(server.address() as any).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
test("explicit operator session supplies only two scoped tools, strict args and durable action callbacks", async () => {
  const f = await operatorBackend();
  const events: any[] = [];
  try {
    const session = await openOperatorTools(
      new Client(f.origin, "synthetic-token", AbortSignal.timeout(5000)),
      "member-fixture",
      { secrets: ["synthetic-token"], onAction: (e) => events.push(e) },
    );
    assert.deepEqual(
      session.tools.map((t) => t.name),
      [
        "studio_operator_read_member_coach_feed",
        "studio_operator_send_message",
      ],
    );
    const read = session.tools[0],
      send = session.tools[1];
    await assert.rejects(
      send.execute("bad", { text: "Hello", session_id: "forged" } as any),
    );
    await assert.rejects(send.execute("bad", { text: 42 } as any));
    await assert.rejects(
      send.execute("bad", { text: "synthetic-token" } as any),
    );
    await read.execute("read", {});
    const result = await send.execute("send", { text: "Hello" });
    assert.match(JSON.stringify(result), /delivered/);
    assert.deepEqual(
      events.map((e) => e.status),
      ["pending", "delivered"],
    );
    assert.equal(
      f.calls.filter((c) => c.params?.name === "studio_operator_send_message")
        .length,
      1,
    );
    await send.execute("repeat", { text: "Hello" });
    assert.equal(
      f.calls.filter((c) => c.params?.name === "studio_operator_send_message")
        .length,
      1,
    );
    await session.dispose();
    await assert.rejects(read.execute("late", {}));
    assert.equal(
      f.calls.filter((c) => c.params?.name === "studio_operator_close_session")
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("negotiates finite optional category-authorized activity tools, never arbitrary capabilities", async () => {
  const extra = [
    "studio_operator_list_activities",
    "studio_operator_read_activity",
  ];
  const f = await operatorBackend((name, result) => {
    if (name === "tools/list")
      result.tools.push(...extra.map((name) => ({ name })));
    if (name === "studio_operator_open_session")
      result.allowed_tools.push(...extra, "arbitrary_shell");
    if (name === extra[0] || name === extra[1])
      return {
        schema_version: 1,
        member_ref: "member-fixture",
        items: [],
        has_more: false,
        next_cursor: null,
      };
    return result;
  });
  try {
    const session = await openOperatorTools(
      new Client(f.origin, "synthetic-token", AbortSignal.timeout(5000)),
      "member-fixture",
      { secrets: ["synthetic-token"], onAction: () => {} },
    );
    assert.deepEqual(
      session.tools.map((t) => t.name),
      [
        "studio_operator_read_member_coach_feed",
        "studio_operator_send_message",
        ...extra,
      ],
    );
    await session.tools[2].execute("list", {});
    await assert.rejects(
      session.tools[3].execute("forged", {
        activity_ref: "x",
        user_id: "foreign",
      }),
    );
    await session.tools[3].execute("read", {
      activity_ref: "opaque-fixture",
      section: "workout_sets",
      limit: 5,
    });
    assert.deepEqual(
      f.calls.find((c) => c.params?.name === extra[1]).params.arguments,
      {
        session_id: "session-fixture",
        activity_ref: "opaque-fixture",
        section: "workout_sets",
        limit: 5,
      },
    );
    await session.dispose();
  } finally {
    await f.close();
  }
});
