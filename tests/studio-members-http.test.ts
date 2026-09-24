import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

test("authenticated member views proxy real MCP reads without claiming worker requests", async () => {
  const home = await mkdtemp(tmpdir() + "/studio-member-http-");
  const calls: string[] = [];
  const feedViews: unknown[] = [];
  let deny = false;
  let gate: Promise<void> | undefined;
  let reached: (() => void) | undefined;
  const backend = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    res.setHeader("Content-Type", "application/json");
    if (!body.id) {
      res.writeHead(202);
      res.end();
      return;
    }
    let result: any = {};
    if (body.method === "initialize")
      result = { protocolVersion: "2025-03-26" };
    if (body.method === "tools/call") {
      calls.push(body.params.name);
      if (body.params.name === "studio_read_member_coach_feed")
        feedViews.push(body.params.arguments.view);
      assert.equal(
        req.headers.authorization,
        "Bearer synthetic-studio-connection",
      );
      reached?.();
      if (gate) await gate;
      result = deny
        ? {
            isError: true,
            content: [
              { type: "text", text: "PRIVATE arbitrary error must not render" },
            ],
          }
        : {
            structuredContent:
              body.params.name === "studio_list_members"
                ? {
                    schema_version: 1,
                    owner_type: "dojo",
                    members: [
                      {
                        member_ref: "fixture-member",
                        display_name: "Synthetic",
                        access: "granted",
                      },
                    ],
                    has_more: false,
                    next_cursor: null,
                  }
                : {
                    schema_version: 1,
                    member_ref: "fixture-member",
                    coverage:
                      body.params.arguments.view === "main_conversation"
                        ? "retained_main_coach_conversation"
                        : "retained_main_coach_feed",
                    items: [
                      {
                        id: "fixture-turn",
                        type: "message",
                        role: "coach",
                        text: "Synthetic reply",
                        created_at: "2026-09-22T12:00:00.000Z",
                      },
                    ],
                    has_more: false,
                    next_cursor: null,
                    limitations: [],
                  },
          };
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  let app: Awaited<ReturnType<typeof admin>> | undefined;
  try {
    const store = new Store(home);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin: `http://127.0.0.1:${(backend.address() as any).port}`,
      token: "synthetic-studio-connection",
    });
    app = await admin(store, 0);
    const headers = { Authorization: "Bearer " + store.secrets.admin };
    assert.equal((await fetch(app.origin + "/api/members")).status, 401);
    const members = await fetch(app.origin + "/api/members", { headers });
    assert.equal(members.status, 200);
    assert.equal(members.headers.get("cache-control"), "no-store");
    assert.equal((await members.json()).members[0].display_name, "Synthetic");
    const feed = await fetch(
      app.origin + "/api/members/feed?member_ref=fixture-member",
      { headers },
    );
    assert.equal(feed.status, 200);
    assert.equal((await feed.json()).items[0].text, "Synthetic reply");
    const main = await fetch(
      app.origin +
        "/api/members/feed?member_ref=fixture-member&view=main_conversation",
      { headers },
    );
    assert.equal(main.status, 200);
    assert.equal(
      (await main.json()).coverage,
      "retained_main_coach_conversation",
    );
    assert.deepEqual(feedViews, [undefined, "main_conversation"]);
    assert.deepEqual(calls, [
      "studio_list_members",
      "studio_read_member_coach_feed",
      "studio_read_member_coach_feed",
    ]);
    const wrongOrigin = await fetch(app.origin + "/api/members", {
      headers: { ...headers, Origin: "https://attacker.invalid" },
    });
    assert.equal(wrongOrigin.status, 403);
    const beforeInvalid = calls.length;
    for (const path of [
      "/api/members?user_id=outsider",
      "/api/members?cursor=a&cursor=b",
      "/api/members/feed",
      "/api/members/feed?member_ref=fixture-member&member_ref=other",
      "/api/members/feed?member_ref=fixture-member&action=reply",
      "/api/members/feed?member_ref=fixture-member&view=unknown",
      "/api/members/feed?member_ref=fixture-member&view=main_conversation&view=main_conversation",
      "/api/members/activities?member_ref=fixture-member&view=main_conversation",
    ]) {
      assert.notEqual(
        (await fetch(app.origin + path, { headers })).status,
        200,
      );
    }
    assert.equal(calls.length, beforeInvalid);
    let release!: () => void;
    gate = new Promise<void>((r) => {
      release = r;
    });
    const entered = new Promise<void>((r) => {
      reached = r;
    });
    const pending = fetch(
      app.origin + "/api/members/feed?member_ref=fixture-member",
      { headers },
    );
    await entered;
    try {
      const saved = await fetch(app.origin + "/api/config", {
        method: "POST",
        headers: {
          ...headers,
          Origin: app.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...store.publicConfig(),
          persona: {
            ...store.publicConfig().persona,
            voice: "Changed saved configuration",
          },
        }),
      });
      assert.equal(saved.status, 200);
    } finally {
      release();
      gate = undefined;
      reached = undefined;
    }
    const stale = await pending;
    assert.notEqual(stale.status, 200);
    assert.doesNotMatch(await stale.text(), /Synthetic reply/);
    deny = true;
    const refused = await fetch(
      app.origin + "/api/members/feed?member_ref=fixture-member",
      { headers },
    );
    assert.notEqual(refused.status, 200);
    assert.doesNotMatch(await refused.text(), /PRIVATE/);
  } finally {
    await app?.close();
    await new Promise<void>((r) => backend.close(() => r()));
    await rm(home, { recursive: true, force: true });
  }
});
