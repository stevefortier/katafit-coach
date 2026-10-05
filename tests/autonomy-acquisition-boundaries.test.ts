import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Store } from "../src/config/store.js";
import { InvocationCapability } from "../src/capability/invocation.js";
import { openProfileGateway } from "../src/sandbox/gateway.js";
import { plannerGuidance } from "../src/autonomy/prompt.js";
import { Diagnostics } from "../src/diagnostics/log.js";
import { closeServer } from "./helpers/account-backend.js";
import { MEMBER } from "./helpers/autonomy-fake.js";

// Actual gateway/native-selection/HTTP boundaries with a SCRIPTED provider.
// The fixture checks transport; it does not choose paths using model reasoning.
async function gatewayFixture(
  run: (f: {
    gateway: Awaited<ReturnType<typeof openProfileGateway>>;
    routes: Map<string, { status: number; text: string }>;
    reads: string[];
    wires: string[];
    logs: Diagnostics;
    read: (path: string, legacy?: boolean) => Promise<any>;
    provider: (calls?: any[], tokens?: number) => Promise<any>;
    messages: any[];
  }) => Promise<void>,
) {
  const dir = await mkdtemp(tmpdir() + "/cost1638-");
  const logs = new Diagnostics(dir);
  const routes = new Map<string, { status: number; text: string }>();
  const reads: string[] = [],
    wires: string[] = [];
  let response = "",
    n = 0;
  let gateway: Awaited<ReturnType<typeof openProfileGateway>> | undefined;
  const server = createServer(async (req, res) => {
    if (req.url === "/v1/chat/completions") {
      let wire = "";
      for await (const chunk of req) wire += chunk;
      wires.push(wire);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(response);
    } else {
      reads.push(req.url!);
      const route = routes.get(req.url!) ?? {
        status: 404,
        text: '{"error":"synthetic missing"}',
      };
      res.writeHead(route.status, { "content-type": "application/json" });
      res.end(route.text);
    }
  });
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    const store = {
      publicConfig: () => ({
        revision: 1,
        origin,
        provider: { model: "synthetic-model", baseUrl: origin + "/v1" },
      }),
      secrets: { token: "synthetic-bearer", apiKey: "synthetic-provider-key" },
      skills: { runtime: () => ({ skills: [] }) },
    } as unknown as Store;
    const acquisition = new InvocationCapability({
      plane: "autonomy",
      origin,
      token: "synthetic-bearer",
      secrets: [],
      actions: [],
      current: () => true,
      maxReads: 24,
      maxImages: 0,
      vision: false,
    });
    const forbidden = async () => {
      throw new Error("unexpected action dispatch");
    };
    gateway = await openProfileGateway(store, undefined, {
      profile: "planner",
      prompt: plannerGuidance({ capability: null, rest: true, actions: [] }),
      actions: [],
      tools: acquisition.tools(),
      autonomy: { intend: forbidden, report: forbidden, followUp: forbidden },
      budgets: { tool_calls: 24, provider_tokens: 60000, images_per_cycle: 0 },
      onDiagnostic: (e) => logs.record(e),
    });
    const messages: any[] = [
      { role: "user", content: "Synthetic work question" },
    ];
    const provider = async (calls: any[] = [], tokens = 7) => {
      response = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: calls.map((c, index) => ({ index, id: c.toolCallId, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }, finish_reason: calls.length ? "tool_calls" : "stop" }], usage: { total_tokens: tokens } })}\n\ndata: [DONE]\n\n`;
      return gateway!.handle({
        kind: "provider",
        body: { model: "synthetic-model", messages },
      });
    };
    const read = async (path: string, legacy = false) => {
      const call = {
        kind: "tool",
        name: legacy ? "katafit_rest_get" : "katafit_rest_request",
        toolCallId: `synthetic-${++n}`,
        args: legacy ? { path } : { method: "GET", path },
      };
      await provider([call]);
      const result: any = await gateway!.handle(call);
      messages.push({
        role: "tool",
        tool_call_id: call.toolCallId,
        content: result.content[0].text,
      });
      return result;
    };
    await run({
      gateway,
      routes,
      reads,
      wires,
      logs,
      read,
      provider,
      messages,
    });
  } finally {
    await gateway?.close();
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
}

test("scripted native acquisitions preserve full feed pages, exact opaque cursors, selected details and broad historical access", async () => {
  await gatewayFixture(
    async ({ read, provider, routes, reads, wires, messages, gateway }) => {
      const cursor = "opaque-_feed.tie:boundary";
      const filters =
        "types=workout,meal&startDate=2026-09-01&endDate=2026-10-05&limit=2&pagination=cursor";
      const first = "/api/friends/feed/dojo?" + filters;
      const next = first + "&cursor=" + encodeURIComponent(cursor);
      const final =
        first + "&cursor=" + encodeURIComponent("opaque-next:privacy");
      const detail = "/api/friends/activity/aaaaaaaaaaaaaaaaaaaaaaaa";
      const broad = "/api/friends/feed/dojo?limit=3";
      const rows = [
        {
          id: "aaaaaaaaaaaaaaaaaaaaaaaa",
          user_id: MEMBER,
          type: "workout",
          status: "pending",
          created_at: "2026-09-01T12:00:00Z",
          due_at: "2026-10-05T23:00:00Z",
        },
        {
          id: "bbbbbbbbbbbbbbbbbbbbbbbb",
          user_id: "cccccccccccccccccccccccc",
          type: "meal",
          status: "completed",
          created_at: "2026-09-01T12:00:00Z",
          completed_at: "2026-10-05T01:00:00Z",
        },
      ];
      const texts = [
        ' {\n"activities":' +
          JSON.stringify(rows) +
          ',"hasMore":true,"nextCursor":' +
          JSON.stringify(cursor) +
          "}\n",
        '{"activities":[],"hasMore":true,"oldestDate":null,"nextCursor":"opaque-next:privacy"}',
        JSON.stringify({
          activities: [
            {
              id: "dddddddddddddddddddddddd",
              user_id: MEMBER,
              type: "workout",
              status: "completed",
            },
          ],
          hasMore: false,
          nextCursor: null,
        }),
        JSON.stringify({
          activity: {
            ...rows[0],
            data: {
              files: [
                { id: "synthetic-file", note: "FULL-DETAIL-雪".repeat(500) },
              ],
            },
          },
          owner: { id: MEMBER },
        }),
        JSON.stringify({
          activities: [
            ...rows,
            {
              id: "eeeeeeeeeeeeeeeeeeeeeeee",
              type: "media",
              created_at: "2001-01-01T00:00:00Z",
              note: "BROAD-HISTORICAL-FULL-TEXT".repeat(800),
            },
          ],
          hasMore: false,
        }),
      ];
      const paths = [first, next, final, detail, broad];
      paths.forEach((path, i) =>
        routes.set(path, { status: 200, text: texts[i] }),
      );
      for (let i = 0; i < paths.length; i++) {
        const result = await read(paths[i], i % 2 === 0);
        assert.equal(result.content[0].text, texts[i]);
        assert.equal(
          Buffer.compare(
            Buffer.from(result.content[0].text),
            Buffer.from(texts[i]),
          ),
          0,
        );
      }
      await provider();
      assert.deepEqual(
        reads,
        paths,
        "no extra discovery, hydration, permission reads or retries",
      );
      assert.equal(gateway.usage().tool_calls, paths.length);
      const admitted = JSON.parse(wires.at(-1)!);
      assert.deepEqual(admitted.messages, messages);
      assert.deepEqual(
        admitted.messages
          .filter((m: any) => m.role === "tool")
          .map((m: any) => m.content),
        texts,
      );
      assert.equal(
        new URL(first, "http://synthetic").searchParams.get("limit"),
        "2",
      );
      assert.equal(
        new URL(next, "http://synthetic").searchParams.get("cursor"),
        cursor,
      );
      assert.ok(paths.slice(0, 3).every((p) => p.startsWith(first)));
      assert.equal(
        new URL(broad, "http://synthetic").searchParams.has("type"),
        false,
      );
      assert.equal(
        new URL(broad, "http://synthetic").searchParams.has("startDate"),
        false,
      );
    },
  );
});

test("scripted native conversation preserves newest/historical full text, opaque refs and cursorless bounded acquisition after changed-state response", async () => {
  await gatewayFixture(async ({ read, provider, routes, reads, wires }) => {
    const root = `/api/coach/member-conversations/${MEMBER}`;
    const newest = root + "?view=main_conversation&order=newest&limit=3";
    const historical =
      root +
      "?view=main_conversation&order=oldest&created_after=2000-01-01T00%3A00%3A00Z&created_before=2020-01-01T00%3A00%3A00Z&limit=2";
    const oldCursor = "opaque-_conversation.old:boundary";
    const oldNext = historical + "&cursor=" + encodeURIComponent(oldCursor);
    const changed = newest + "&cursor=" + encodeURIComponent("changed:opaque");
    const recentText = JSON.stringify({
      epoch: 9,
      messages: [
        {
          message_ref: "opaque:unanswered",
          role: "member",
          text: "Recent unanswered synthetic question",
          request_status: "failed",
        },
        {
          message_ref: "opaque:queued",
          role: "member",
          text: "Queued synthetic question",
          request_status: "queued",
        },
        {
          message_ref: "opaque:reply",
          role: "coach",
          text: "A later reply belongs to the request worker",
        },
      ],
      has_more: false,
      limitations: ["retained snapshot only"],
    });
    const oldText = JSON.stringify({
      epoch: 9,
      messages: [
        {
          message_ref: "opaque:2001-not-an-epoch",
          role: "member",
          text: "UNCLIPPED-OLD-雪".repeat(4000),
        },
      ],
      has_more: true,
      next_cursor: oldCursor,
    });
    const lastText = JSON.stringify({
      epoch: 9,
      messages: [
        {
          message_ref: "opaque:2002",
          role: "coach",
          text: "Full historical answer",
        },
      ],
      has_more: false,
      next_cursor: null,
    });
    routes.set(changed, {
      status: 409,
      text: '{"code":"CONVERSATION_CHANGED"}',
    });
    routes.set(newest, { status: 200, text: recentText });
    routes.set(historical, { status: 200, text: oldText });
    routes.set(oldNext, { status: 200, text: lastText });
    const refused = await read(changed);
    assert.match(refused.content[0].text, /REST_READ_UNAVAILABLE/);
    // This cursorless path has not already been acquired. Do not infer cache freshness.
    for (const [path, text] of [
      [newest, recentText],
      [historical, oldText],
      [oldNext, lastText],
    ]) {
      assert.equal((await read(path)).content[0].text, text);
    }
    await provider();
    assert.deepEqual(reads, [changed, newest, historical, oldNext]);
    const toolText = JSON.parse(wires.at(-1)!)
      .messages.filter((m: any) => m.role === "tool")
      .map((m: any) => m.content);
    assert.deepEqual(toolText.slice(1), [recentText, oldText, lastText]);
    assert.equal(
      new URL(oldNext, "http://synthetic").searchParams.get("cursor"),
      oldCursor,
    );
    assert.equal(
      new URL(historical, "http://synthetic").searchParams.get("order"),
      "oldest",
    );
  });
});

test("scripted native guidance does not grant generic writes or relax encoded-path rejection", async () => {
  await gatewayFixture(async ({ gateway, provider, read, reads }) => {
    const call = {
      kind: "tool",
      name: "katafit_rest_request",
      toolCallId: "unadmitted-write",
      args: {
        method: "POST",
        path: "/api/coach/member-messages/" + MEMBER,
        body: { text: "Synthetic unsent message" },
      },
    };
    await provider([call]);
    const result: any = await gateway.handle(call);
    assert.match(result.content[0].text, /ACTION_UNSUPPORTED/);
    const rejected = await read(
      "/api/friends/feed/dojo?type=workout&limit=2&pagination=cursor&cursor=opaque%2Fcursor",
    );
    assert.match(rejected.content[0].text, /ARGUMENTS_REJECTED/);
    assert.deepEqual(reads, [], "zero mutation/GET dispatch or retries");
  });
});

for (const sample of [
  {
    charges: [10263, 10537, 11710, 14137, 14576],
    total: 61223,
    lateBytes: 30165,
    path: "/api/friends/feed/dojo?type=workout&limit=2&pagination=cursor",
  },
  {
    charges: [4845, 5251, 9840, 11365, 13101, 15949],
    total: 60351,
    lateBytes: 40627,
    path: `/api/coach/member-conversations/${MEMBER}?view=main_conversation&order=newest&limit=2`,
  },
])
  test(`scripted recorded charge schedule ${sample.total}: last admitted response succeeds, late result never reaches a refused continuation`, async () => {
    await gatewayFixture(
      async ({ provider, gateway, routes, reads, wires, messages, logs }) => {
        const call = {
          kind: "tool",
          name: "katafit_rest_get",
          toolCallId: "late-acquisition",
          args: { path: sample.path },
        };
        const text = JSON.stringify({
          text: "x".repeat(sample.lateBytes - Buffer.byteLength('{"text":""}')),
        });
        assert.equal(Buffer.byteLength(text), sample.lateBytes);
        routes.set(sample.path, { status: 200, text });
        for (let i = 0; i < sample.charges.length; i++) {
          const result: any = await provider(
            i === sample.charges.length - 1 ? [call] : [],
            sample.charges[i],
          );
          assert.ok(result);
        }
        assert.equal(gateway.usage().provider_tokens, sample.total);
        assert.equal(
          ((await gateway.handle(call)) as any).content[0].text,
          text,
        );
        assert.deepEqual(reads, [sample.path]);
        messages.push({
          role: "tool",
          tool_call_id: call.toolCallId,
          content: text,
        });
        await assert.rejects(provider(), /NATIVE_REQUEST_REJECTED/);
        assert.equal(wires.length, sample.charges.length);
        assert.ok(wires.every((w) => !w.includes(text)));
        assert.equal(gateway.usage().provider_tokens, sample.total);
        const refusal = logs
          .snapshot()
          .entries.find((e) => e.stage === "provider-budget-refused");
        assert.equal(refusal?.metadata.tokenBudget, 60000);
        assert.equal(refusal?.metadata.cumulativeTokens, sample.total);
      },
    );
  });
