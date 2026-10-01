import test from "node:test";
import assert from "node:assert/strict";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { Actions } from "../src/chat/actions.js";
import { startRelay, loadExtension, piTurn } from "./helpers/native-relay.js";
import {
  ALICE,
  MODEL,
  nativeSendHarness,
  sendArgs,
  sse,
} from "./helpers/native-member-send.js";

const rejected = { code: "NATIVE_REQUEST_REJECTED" };
const unverified = { code: "NATIVE_DELIVERY_UNVERIFIED" };

test("a consumed provider-selected occurrence is never posted again", async () => {
  const h = await nativeSendHarness();
  try {
    const gateway = await h.open();
    const args = sendArgs("Keep going.");
    await h.select(gateway, [{ id: "call_send", args }]);
    const first = await h.call(gateway, "call_send", args);
    assert.equal(JSON.parse(first.content[0].text).status, "delivered");
    // Retransmission after a lost host->Pi acknowledgement: same occurrence.
    const again = await h.call(gateway, "call_send", args);
    assert.deepEqual(again, first);
    assert.equal(h.backend.posts().length, 1);
    assert.equal(h.backend.messages.length, 1);
    assert.equal(new Actions(h.store).memberDeliveries().length, 1);
  } finally {
    await h.close();
  }
});

test("a genuine new selection may repeat exact words even when the provider reuses the call ID", async () => {
  const h = await nativeSendHarness();
  try {
    const gateway = await h.open();
    const args = sendArgs("Same reminder");
    for (let i = 0; i < 2; i++) {
      await h.select(gateway, [{ id: "reused", args }]);
      const result = await h.call(gateway, "reused", args);
      assert.equal(JSON.parse(result.content[0].text).status, "delivered");
    }
    assert.equal(h.backend.posts().length, 2);
    assert.deepEqual(
      h.backend.messages.map((m) => m.text),
      ["Same reminder", "Same reminder"],
    );
    const keys = h.backend.posts().map((p) => p.body.idempotency_key);
    assert.notEqual(keys[0], keys[1]);
  } finally {
    await h.close();
  }
});

test("unselected, unidentified, altered, foreign and ambiguous calls are rejected before any send", async () => {
  const h = await nativeSendHarness();
  try {
    const gateway = await h.open();
    const args = sendArgs("Hi");
    await assert.rejects(h.call(gateway, "never-selected", args), rejected);
    await h.select(gateway, [
      { id: "a", args },
      { id: "other-tool", name: "send_to_operator", args },
    ]);
    for (const [id, attempt] of [
      ["b", args],
      [undefined, args],
      ["a", sendArgs("Hello")],
      ["a", sendArgs("Hi", "/api/coach/member-messages/" + "1".repeat(24))],
      ["a", { ...args, body: { text: "Hi", extra: true } }],
      ["other-tool", args],
    ] as const)
      await assert.rejects(h.call(gateway, id as any, attempt), rejected);
    assert.equal(h.backend.posts().length, 0);
    // Rejections consume nothing: the exact selected slot still sends once.
    await h.call(gateway, "a", args);
    await h.select(gateway, [
      { id: "dup", args },
      { id: "dup", args },
    ]);
    await assert.rejects(h.call(gateway, "dup", args), rejected);
    // A newer selection retires older slots, consumed or not.
    await assert.rejects(h.call(gateway, "a", args), rejected);
    assert.equal(h.backend.posts().length, 1);
  } finally {
    await h.close();
  }
});

test("truncated, filtered, failed or malformed provider bodies never admit a send slot", async () => {
  const args = sendArgs("Hi");
  const calls = [{ id: "s", args }];
  const variants: [string, () => { status?: number; body: string }][] = [
    ["no finish_reason", () => ({ body: sse(calls, null) })],
    ["length", () => ({ body: sse(calls, "length") })],
    ["content_filter", () => ({ body: sse(calls, "content_filter") })],
    [
      "malformed chunk",
      () => ({ body: "data: {not json\n\n" + sse(calls, "tool_calls") }),
    ],
    [
      "error chunk",
      () => ({
        body: sse(calls, "tool_calls").replace(
          "data: [DONE]",
          'data: {"error":{"message":"x"}}\n\ndata: [DONE]',
        ),
      }),
    ],
    [
      "truncated arguments",
      () => ({
        body: sse([{ id: "s", args: JSON.stringify(args).slice(0, -2) }]),
      }),
    ],
    ["provider error", () => ({ status: 500, body: '{"error":{}}' })],
    [
      "oversized",
      () => ({
        body:
          sse(calls, null, { done: false }) +
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "x".repeat(2200000) }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
      }),
    ],
  ];
  for (const [name, reply] of variants) {
    const h = await nativeSendHarness();
    try {
      const gateway = await h.open();
      // A valid earlier selection is retired by the failed request too.
      await h.select(gateway, calls);
      h.reply = reply;
      await gateway
        .handle({
          kind: "provider",
          body: { model: MODEL, messages: [{ role: "user", content: "x" }] },
        })
        .catch(() => {});
      await assert.rejects(h.call(gateway, "s", args), rejected, name);
      assert.equal(h.backend.posts().length, 0, name);
    } finally {
      await h.close();
    }
  }
});

test("framing and tool-call assembly that actual Pi would not execute never admit a send", async () => {
  const args = sendArgs("Synthetic framing differential");
  const raw = JSON.stringify(args);
  const chunk = (delta: unknown, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  const standard = sse([{ id: "selected", args }]);
  // [name, body, content type, actual Pi executes, host admits]
  const variants: [string, string, string, boolean, boolean][] = [
    ["standard", standard, "text/event-stream", true, true],
    ["extra blank line", standard + "\n", "text/event-stream", true, true],
    [
      "CRLF framing",
      standard.replaceAll("\n", "\r\n"),
      "text/event-stream",
      true,
      true,
    ],
    [
      "thread.* event names",
      standard.replaceAll("data:", "event: thread.message.delta\ndata:"),
      "text/event-stream",
      false,
      false,
    ],
    // Pi executes the next two; the host fails closed on nonstandard framing.
    [
      "other event names",
      standard.replaceAll("data:", "event: message\ndata:"),
      "text/event-stream",
      true,
      false,
    ],
    [
      "lone carriage-return framing",
      standard.replaceAll("\n", "\r"),
      "text/event-stream",
      true,
      false,
    ],
    [
      "unterminated final event",
      standard.replace(/\n\ndata: \[DONE\]\n\n$/, ""),
      "text/event-stream",
      false,
      false,
    ],
    [
      "index reassigned to an existing ID",
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "selected",
            function: { name: "katafit_rest_request", arguments: "" },
          },
        ],
      }) +
        chunk({
          tool_calls: [
            {
              index: 1,
              id: "selected",
              function: { arguments: raw.slice(0, 20) },
            },
          ],
        }) +
        chunk({
          tool_calls: [{ index: 1, function: { arguments: raw.slice(20) } }],
        }) +
        chunk({}, "tool_calls") +
        "data: [DONE]\n\n",
      "text/event-stream",
      false,
      false,
    ],
    [
      "unframed JSON completion",
      JSON.stringify({
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              tool_calls: [
                {
                  id: "selected",
                  type: "function",
                  function: { name: "katafit_rest_request", arguments: raw },
                },
              ],
            },
          },
        ],
      }),
      "application/json",
      false,
      false,
    ],
  ];
  const observed: unknown[] = [];
  const expected: unknown[] = [];
  for (const [name, body, type, pi, host] of variants) {
    const h = await nativeSendHarness();
    let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
    try {
      h.reply = () => ({ body, type });
      const gateway = await h.open();
      relay = await startRelay(gateway);
      const ext = await loadExtension(relay);
      const selected = await piTurn(relay, MODEL, [
        { role: "user", content: "Synthetic differential", timestamp: 1 },
      ]);
      const calls = selected.content.filter((c: any) => c.type === "toolCall");
      const piExecutes =
        selected.stopReason === "toolUse" &&
        calls.length === 1 &&
        calls[0].id === "selected" &&
        JSON.stringify(calls[0].arguments) === raw;
      // The shipped extension dispatches the disputed call regardless.
      await ext.tools
        .get("katafit_rest_request")
        .execute("selected", args)
        .catch(() => {});
      const posts = h.backend.posts().length;
      observed.push([name, piExecutes, posts]);
      expected.push([name, pi, host ? 1 : 0]);
      // The host never admits what actual Pi did not select.
      assert.ok(posts === 0 || piExecutes, name);
    } finally {
      await relay?.close();
      await h.close();
    }
  }
  assert.deepEqual(observed, expected);
});

test("duplicate concurrent dispatches of one selected slot post once", async () => {
  const h = await nativeSendHarness();
  try {
    const gateway = await h.open();
    const args = sendArgs("Once");
    await h.select(gateway, [{ id: "c", args }]);
    const settled = await Promise.allSettled([
      h.call(gateway, "c", args),
      h.call(gateway, "c", args),
    ]);
    assert.ok(settled.some((r) => r.status === "fulfilled"));
    assert.equal(h.backend.posts().length, 1);
    const replay = await h.call(gateway, "c", args);
    assert.equal(JSON.parse(replay.content[0].text).status, "delivered");
    assert.equal(h.backend.posts().length, 1);
  } finally {
    await h.close();
  }
});

test("a new session or fabricated call ID cannot clear an unknown send", async () => {
  const h = await nativeSendHarness();
  try {
    h.backend.state.post = "destroy";
    h.backend.state.receiptsVisible = false;
    const first = await h.open();
    const args = sendArgs("Uncertain");
    await h.select(first, [{ id: "u", args }]);
    await assert.rejects(h.call(first, "u", args), unverified);
    // Same consumed slot: receipt read only, never a second POST.
    await assert.rejects(h.call(first, "u", args), unverified);
    await first.close();
    const second = await h.open();
    await assert.rejects(h.call(second, "u", args), rejected);
    await h.select(second, [{ id: "v", args: sendArgs("Something new") }]);
    await assert.rejects(
      h.call(second, "v", sendArgs("Something new")),
      unverified,
    );
    assert.equal(h.backend.posts().length, 1);
    assert.equal(new Actions(h.store).memberDeliveries()[0].status, "unknown");
  } finally {
    await h.close();
  }
});

test("actual Pi selection binds through the shipped extension; a continuation reusing the ID is distinct", async () => {
  const h = await nativeSendHarness();
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  try {
    const args = sendArgs("Hydrate before practice.");
    h.reply = (body) => {
      const results = body.messages.filter((m: any) => m.role === "tool");
      return {
        body:
          results.length === 2
            ? `data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: "Both sent." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
            : sse([{ id: "call_send", args }]),
      };
    };
    const gateway = await h.open();
    relay = await startRelay(gateway);
    const ext = await loadExtension(relay);
    const tool = ext.tools.get("katafit_rest_request");
    const messages: any[] = [
      { role: "user", content: "Send it twice, separately.", timestamp: 1 },
    ];
    for (let i = 0; i < 2; i++) {
      const selected = await piTurn(relay, MODEL, messages);
      assert.equal(selected.stopReason, "toolUse", JSON.stringify(selected));
      const call = selected.content.find((c: any) => c.type === "toolCall");
      assert.equal(call.id, "call_send");
      // Pi's own argument preparation before execute().
      const prepared = validateToolArguments(tool, call);
      const result = await tool.execute(call.id, prepared);
      assert.equal(Boolean(result.isError), false);
      // A retransmitted dispatch of the same selection reads the same result.
      assert.deepEqual(await tool.execute(call.id, prepared), result);
      messages.push(selected, {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: result.content,
        isError: false,
        timestamp: 2 + i,
      });
    }
    const answer = await piTurn(relay, MODEL, messages);
    assert.equal(answer.stopReason, "stop");
    assert.equal(h.backend.posts().length, 2);
    assert.deepEqual(
      h.backend.messages.map((m) => [m.recipient, m.text]),
      [
        [ALICE, "Hydrate before practice."],
        [ALICE, "Hydrate before practice."],
      ],
    );
  } finally {
    await relay?.close();
    await h.close();
  }
});
