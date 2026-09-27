import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { archiveFixture } from "./helpers/archive.js";
import { answer, toolCall, sse } from "./helpers/continuity.js";
import { NativeTerminal } from "../src/server/terminal.js";
import type { NativeGateway } from "../src/sandbox/gateway.js";
import type { NativeRuntime } from "../src/sandbox/runtime.js";

class Terminal extends NativeTerminal {
  latest?: NativeGateway;
  protected async resolveImage() {
    return "sha256:" + "a".repeat(64);
  }
  protected createRuntime() {
    return {
      start: async (g: NativeGateway) => {
        this.latest = g;
      },
      attach: async () => {},
      stop: async () => {},
    } as unknown as NativeRuntime;
  }
  begin() {
    return (this as any).start();
  }
}

test("host observed invalid arguments error survives next provider and archive resume", async () => {
  const name = "studio_operator_list_members",
    args = { limit: -1 };
  let rounds = 0;
  const f = await archiveFixture({
    provider: () =>
      rounds++ === 0
        ? toolCall(name, args, "failed_call")
        : answer("RECOVERED"),
  });
  const server = createServer(),
    terminal = new Terminal(f.store, server, () => "http://127.0.0.1");
  try {
    await terminal.begin();
    const body = {
      model: "approved-custom-model",
      stream: true,
      messages: [{ role: "user", content: "try" }],
    };
    await terminal.latest!.handle({ kind: "provider", body });
    await assert.rejects(
      terminal.latest!.handle({ kind: "tool", name, args }),
      (error: any) => error.code === "NATIVE_TOOL_FAILED",
    );
    await terminal.latest!.handle({
      kind: "provider",
      body: {
        ...body,
        messages: [
          ...body.messages,
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "failed_call",
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "failed_call",
            content: "Kata.fit tool failed; do not replay uncertain actions.",
          },
        ],
      },
    });
    const id = (await terminal.historyList()).sessions[0].id;
    assert.equal((await terminal.historyRead(id)).reason, null);
    assert.match(
      JSON.stringify((await terminal.historyRead(id)).entries),
      /RECOVERED/,
    );
    await terminal.stop();
    await terminal.begin();
    assert.match(
      JSON.stringify(
        (await terminal.latest!.handle({ kind: "catalog" })).history,
      ),
      /uncertain actions/,
    );
  } finally {
    await terminal.close();
    await f.close();
    server.close();
  }
});

import { openNativeGateway } from "../src/sandbox/gateway.js";
import {
  nativeToolOutcome,
  nativeToolResultTooLarge,
} from "../sandbox/katafit.mjs";
import { NATIVE_RESPONSE_FRAME_LIMIT } from "../src/sandbox/failures.js";
import { CanonicalNativeHistory } from "../src/sandbox/sessionCapture.js";
const asWire = (entries: any[], raw: Record<string, any> = {}): any[] =>
  entries
    .filter((e) => e.type === "message")
    .map(({ message: m }) => {
      if (m.role === "user") return { role: "user", content: m.content };
      if (m.role === "toolResult")
        return {
          role: "tool",
          tool_call_id: m.toolCallId,
          content: (raw[m.toolCallId]?.content ?? m.content)
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text)
            .join("\n"),
        };
      const calls = m.content.filter((p: any) => p.type === "toolCall");
      return {
        role: "assistant",
        content:
          m.content
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text)
            .join("") || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((c: any) => ({
                id: c.id,
                type: "function",
                function: {
                  name: c.name,
                  arguments: JSON.stringify(c.arguments),
                },
              })),
            }
          : {}),
      };
    });
for (const scenario of [
  "success",
  "ToolFailure",
  "unknown",
  "attachment_success",
  "attachment_error",
  "image_error",
  "wrong_error",
  "explicit_wrong_state",
]) {
  test(`host emitted inventory ${scenario}`, async () => {
    const name = scenario.startsWith("attachment")
      ? "send_to_operator"
      : scenario === "unknown"
        ? "unknown_tool"
        : scenario === "image_error"
          ? "studio_operator_read_dojo_checkin_image"
          : "studio_operator_list_members";
    const args = scenario.startsWith("attachment")
      ? { workspace_path: "report.txt" }
      : {};
    let rounds = 0,
      capture: any;
    const f = await archiveFixture({
      provider: () =>
        rounds++ === 0 ? toolCall(name, args, "observed") : answer("CONTINUE"),
      response(tool, _args, value) {
        return tool === name && scenario !== "success"
          ? {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ code: "SYNTHETIC_FAILURE" }),
                },
              ],
            }
          : value;
      },
    });
    const gateway = await openNativeGateway(f.store, undefined, {
      onExchange: async (c) => {
        capture = c;
      },
      attachments: {
        read: async () => {
          if (scenario === "attachment_error") throw new Error("unavailable");
          return Buffer.from("synthetic file");
        },
        publish: () => true,
      },
    });
    try {
      await gateway.handle({
        kind: "provider",
        body: {
          model: "approved-custom-model",
          messages: [{ role: "user", content: "test" }],
          stream: true,
        },
      });
      let result, code;
      try {
        result = await gateway.handle({ kind: "tool", name, args });
      } catch (e: any) {
        code = e.code;
      }
      const outcome = nativeToolOutcome(name, result, code);
      const messages = asWire(capture.entries, { observed: outcome });
      assert.equal(messages.at(-1).role, "tool");
      assert.equal(
        messages.at(-1).content,
        outcome.content.map((p: any) => p.text).join("\n"),
      );
      if (scenario === "wrong_error") messages.at(-1).content += " forged";
      if (scenario === "explicit_wrong_state")
        messages.at(-1).isError = !outcome.isError;
      const next = gateway.handle({
        kind: "provider",
        body: { model: "approved-custom-model", messages, stream: true },
      });
      if (["wrong_error", "explicit_wrong_state"].includes(scenario))
        await assert.rejects(next, /NATIVE_HISTORY_UNTRUSTED_RESULT/);
      else await next;
    } finally {
      await gateway.close();
      await f.close();
    }
  });
}

test("shared shipped contract withholds oversized results before history capture", () => {
  const large = {
    content: [{ type: "text", text: "x".repeat(16 * 1024 * 1024) }],
  };
  const outcome = nativeToolOutcome("studio_operator_send_message", large);
  assert.equal(outcome.isError, true);
  assert.match(outcome.content[0].text, /^NATIVE_RESULT_TOO_LARGE:/);
  assert.match(outcome.content[0].text, /do not replay/);
  assert.ok(JSON.stringify(outcome).length < 1024);
});

for (const name of [
  "send_to_operator",
  "studio_operator_read_dojo_checkin_image",
  "studio_operator_list_members",
]) {
  test(`busy ${name} outcome is captured before admission releases`, async () => {
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((r) => (release = r)),
      started = new Promise<void>((r) => (entered = r));
    let capture: any,
      rounds = 0,
      publications = 0;
    const args =
      name === "send_to_operator" ? { workspace_path: "second.txt" } : {};
    const calls = [
      {
        name: "send_to_operator",
        args: { workspace_path: "first.txt" },
        id: "first",
      },
      { name, args, id: "busy" },
    ];
    const f = await archiveFixture({
      provider: () =>
        rounds++ === 0
          ? sse(
              {
                tool_calls: calls.map((c, index) => ({
                  index,
                  id: c.id,
                  type: "function",
                  function: { name: c.name, arguments: JSON.stringify(c.args) },
                })),
              },
              false,
            )
          : answer("BUSY_CONTINUED"),
    });
    const gateway = await openNativeGateway(f.store, undefined, {
      onExchange: async (c) => {
        capture = c;
      },
      attachments: {
        read: async () => {
          entered();
          await held;
          return Buffer.from("synthetic");
        },
        publish: () => {
          publications++;
          return true;
        },
      },
    });
    let first: Promise<any> | undefined;
    try {
      await gateway.handle({
        kind: "provider",
        body: {
          model: "approved-custom-model",
          messages: [{ role: "user", content: "busy test" }],
          stream: true,
        },
      });
      first = gateway.handle({
        kind: "tool",
        name: calls[0].name,
        args: calls[0].args,
      });
      await started;
      const busy = gateway
        .handle({ kind: "tool", name, args, toolCallId: "busy" })
        .then(
          (value) => ({ value, code: undefined }),
          (error) => ({ value: undefined, code: error.code }),
        );
      assert.equal(publications, 0);
      await new Promise((resolve) => setImmediate(resolve));
      release();
      const firstResult = await first;
      const { value, code } = await busy;
      const outcome = nativeToolOutcome(name, value, code);
      assert.match(outcome.content[0].text, /BUSY:/);
      assert.equal(capture.entries.at(-1).message.toolCallId, "busy");
      assert.equal(publications, 1);
      await gateway.handle({
        kind: "provider",
        body: {
          model: "approved-custom-model",
          messages: asWire(capture.entries, { first: firstResult }),
          stream: true,
        },
      });
      assert.match(JSON.stringify(capture), /BUSY_CONTINUED/);
    } finally {
      release();
      await first?.catch(() => {});
      await gateway.close();
      await f.close();
    }
  });
}

test("admission remains busy until emitted outcome persistence completes", async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (entered = r));
  let hold = true;
  const name = "studio_operator_list_members";
  const f = await archiveFixture({
    provider: () =>
      sse(
        {
          tool_calls: ["first", "busy"].map((id, index) => ({
            index,
            id,
            type: "function",
            function: { name, arguments: "{}" },
          })),
        },
        false,
      ),
  });
  const gateway = await openNativeGateway(f.store, undefined, {
    onExchange: async (capture) => {
      if (
        hold &&
        (capture.entries.at(-1) as any).message?.role === "toolResult"
      ) {
        hold = false;
        entered();
        await held;
      }
    },
  });
  let first: Promise<any> | undefined, busy: Promise<any> | undefined;
  try {
    await gateway.handle({
      kind: "provider",
      body: {
        model: "approved-custom-model",
        messages: [{ role: "user", content: "hold seal" }],
        stream: true,
      },
    });
    first = gateway.handle({
      kind: "tool",
      name,
      args: {},
      toolCallId: "first",
    });
    await started;
    const dispatched = f.named(name).length;
    busy = gateway.handle({ kind: "tool", name, args: {}, toolCallId: "busy" });
    // Queue inspection is deterministic: no backend dispatch while capture waits.
    await new Promise((r) => setImmediate(r));
    assert.equal(f.named(name).length, dispatched);
    release();
    await first;
    await assert.rejects(
      busy,
      (error: any) => error.code === "NATIVE_REQUEST_BUSY",
    );
    assert.equal(f.named(name).length, dispatched);
  } finally {
    release();
    await first?.catch(() => {});
    await busy?.catch(() => {});
    await gateway.close();
    await f.close();
  }
});

test("identical parallel host calls retain each Pi ID and selection order", async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (entered = resolve));
  const name = "send_to_operator",
    args = { workspace_path: "same.txt" };
  let rounds = 0,
    capture: any,
    publications = 0;
  const f = await archiveFixture({
    provider: () =>
      rounds++ === 0
        ? sse(
            {
              tool_calls: ["A", "B"].map((id, index) => ({
                index,
                id,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              })),
            },
            false,
          )
        : answer("IDENTICAL_CALLS_CONTINUED"),
  });
  const gateway = await openNativeGateway(f.store, undefined, {
    onExchange: async (value) => {
      capture = value;
    },
    attachments: {
      read: async () => {
        entered();
        await held;
        return Buffer.from("synthetic");
      },
      publish: () => {
        publications++;
        return true;
      },
    },
  });
  let first: Promise<any> | undefined, second: Promise<any> | undefined;
  try {
    await gateway.handle({
      kind: "provider",
      body: {
        model: "approved-custom-model",
        messages: [{ role: "user", content: "parallel" }],
        stream: true,
      },
    });
    first = gateway.handle({ kind: "tool", name, args, toolCallId: "A" });
    await Promise.race([
      started,
      first.then(() => {
        throw new Error("first call did not start");
      }),
    ]);
    second = gateway.handle({ kind: "tool", name, args, toolCallId: "B" });
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const accepted = await first;
    const busy = await second;
    assert.deepEqual(busy, { attachmentError: { code: "ATTACHMENT_BUSY" } });
    assert.equal(publications, 1);
    const recorded = capture.entries
      .filter((e: any) => e.message?.role === "toolResult")
      .map((e: any) => [e.message.toolCallId, e.message.content[0].text]);
    assert.equal(recorded.length, 2);
    assert.equal(recorded[0][0], "A");
    assert.match(recorded[0][1], /operator_panel/);
    assert.equal(recorded[1][0], "B");
    assert.match(recorded[1][1], /ATTACHMENT_BUSY/);
    await gateway.handle({
      kind: "provider",
      body: {
        model: "approved-custom-model",
        messages: asWire(capture.entries, {
          A: nativeToolOutcome(name, accepted),
          B: nativeToolOutcome(name, busy),
        }),
        stream: true,
      },
    });
    assert.match(JSON.stringify(capture), /IDENTICAL_CALLS_CONTINUED/);
  } finally {
    release();
    await first?.catch(() => {});
    await second?.catch(() => {});
    await gateway.close();
    await f.close();
  }
});

test("ephemeral receipt arguments match exact observed selection without retaining tokens", () => {
  const log = new CanonicalNativeHistory();
  const wire = {
    model: "synthetic",
    messages: [{ role: "user", content: "send image" }],
  };
  const args = { image_receipt: "ir_" + "a".repeat(32) };
  log.request(wire);
  log.response(
    wire,
    toolCall("send_to_operator", args, "receipt_send"),
    "text/event-stream",
  );
  const outcome = { content: [{ type: "text", text: "panel accepted" }] };
  assert.equal(
    log.dispatch(
      "send_to_operator",
      { image_receipt: "ir_" + "b".repeat(32) },
      outcome,
    ),
    false,
  );
  assert.equal(log.dispatch("send_to_operator", args, outcome), true);
  assert.ok(!JSON.stringify(log.snapshot()).includes(args.image_receipt));
});

test("archive host image success retains text outcome, omits pixels and continues", async () => {
  const name = "studio_operator_read_dojo_checkin_image";
  const args = { member_ref: "fixture-member", media_ref: "media-1" };
  let rounds = 0,
    capture: any;
  const f = await archiveFixture({
    images: true,
    provider: () =>
      rounds++ === 0
        ? toolCall(name, args, "image")
        : answer("IMAGE_CONTINUED"),
  });
  const gateway = await openNativeGateway(f.store, undefined, {
    onExchange: async (c) => {
      capture = c;
    },
  });
  try {
    await gateway.handle({
      kind: "tool",
      name: "studio_operator_list_dojo_checkins",
      args: {},
    });
    await gateway.handle({
      kind: "provider",
      body: {
        model: "approved-custom-model",
        messages: [{ role: "user", content: "image test" }],
        stream: true,
      },
    });
    const result = await gateway.handle({ kind: "tool", name, args });
    assert.equal(capture.imagesOmitted, true);
    assert.ok(!JSON.stringify(capture).includes(result.content[1].data));
    const messages = asWire(capture.entries);
    messages.push({
      role: "user",
      content: [
        { type: "text", text: "Attached image(s) from tool result:" },
        {
          type: "image_url",
          image_url: {
            url: `data:${result.content[1].mimeType};base64,${result.content[1].data}`,
          },
        },
      ],
    });
    await gateway.handle({
      kind: "provider",
      body: { model: "approved-custom-model", messages, stream: true },
    });
    assert.match(JSON.stringify(capture), /IMAGE_CONTINUED/);
  } finally {
    await gateway.close();
    await f.close();
  }
});

test("observed image-receipt attachment sends capture the actual panel outcome", async () => {
  let receipt = "",
    rounds = 0,
    capture: any,
    published = 0;
  const f = await archiveFixture({
    images: true,
    provider: () =>
      rounds++ === 0
        ? toolCall("send_to_operator", { image_receipt: receipt }, "send")
        : answer("RECEIPT_CONTINUED"),
  });
  const gateway = await openNativeGateway(f.store, undefined, {
    onExchange: async (c) => {
      capture = c;
    },
    attachments: {
      read: async () => Buffer.from("unused"),
      publish: () => {
        published++;
        return true;
      },
    },
  });
  try {
    await gateway.handle({
      kind: "tool",
      name: "studio_operator_list_dojo_checkins",
      args: {},
    });
    const image = await gateway.handle({
      kind: "tool",
      name: "studio_operator_read_dojo_checkin_image",
      args: { member_ref: "fixture-member", media_ref: "media-1" },
    });
    receipt = JSON.parse(image.content[0].text).image_receipt;
    assert.match(receipt, /^ir_[a-f0-9]{32}$/);
    await gateway.handle({
      kind: "provider",
      body: {
        model: "approved-custom-model",
        messages: [{ role: "user", content: "send observed image" }],
        stream: true,
      },
    });
    const sent = await gateway.handle({
      kind: "tool",
      name: "send_to_operator",
      args: { image_receipt: receipt },
    });
    assert.equal(published, 1);
    assert.equal(capture.entries.at(-1).message.toolName, "send_to_operator");
    assert.ok(!JSON.stringify(capture).includes(receipt));
    await gateway.handle({
      kind: "provider",
      body: {
        model: "approved-custom-model",
        messages: asWire(capture.entries, { send: sent }),
        stream: true,
      },
    });
    assert.match(JSON.stringify(capture), /RECEIPT_CONTINUED/);
    assert.equal(published, 1);
  } finally {
    await gateway.close();
    await f.close();
  }
});

test("shared contract cap exactly reserves the largest runtime response frame ID", () => {
  const empty = { content: [{ type: "text", text: "" }] };
  const overhead = Buffer.byteLength(
    JSON.stringify({ id: Number.MAX_SAFE_INTEGER, result: empty }) + "\n",
  );
  const exact = {
    content: [
      {
        type: "text",
        text: "x".repeat(NATIVE_RESPONSE_FRAME_LIMIT - overhead),
      },
    ],
  };
  assert.equal(nativeToolResultTooLarge(exact), false);
  exact.content[0].text += "x";
  assert.equal(nativeToolResultTooLarge(exact), true);
  assert.match(
    nativeToolOutcome("tool", exact).content[0].text,
    /NATIVE_RESULT_TOO_LARGE/,
  );
});

test("altering a live host-emitted receipt token is refused before archive redaction", () => {
  const log = new CanonicalNativeHistory();
  const messages: any[] = [{ role: "user", content: "send" }];
  const wire = { model: "synthetic", messages };
  log.request(wire);
  const call = {
    id: "send",
    type: "function",
    function: {
      name: "send_to_operator",
      arguments: '{"workspace_path":"a.txt"}',
    },
  };
  log.response(
    wire,
    JSON.stringify({
      choices: [
        {
          message: { content: null, tool_calls: [call] },
          finish_reason: "tool_calls",
        },
      ],
    }),
    "application/json",
  );
  const text = JSON.stringify({
    attachment_id: "at_" + "a".repeat(32),
    status: "accepted_to_operator_panel",
  });
  log.dispatch(
    "send_to_operator",
    { workspace_path: "a.txt" },
    { content: [{ type: "text", text }] },
  );
  messages.push(
    { role: "assistant", content: null, tool_calls: [call] },
    { role: "tool", tool_call_id: "send", content: text },
  );
  log.validateResultClaims(wire);
  messages.at(-1).content = text.replace(
    "at_" + "a".repeat(32),
    "at_" + "b".repeat(32),
  );
  assert.throws(
    () => log.validateResultClaims(wire),
    /NATIVE_HISTORY_UNTRUSTED_RESULT/,
  );
  assert.ok(!JSON.stringify(log.snapshot()).includes("at_"));
});
