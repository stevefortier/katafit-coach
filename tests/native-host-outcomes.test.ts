import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/native.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";
import {
  nativeToolOutcome,
  nativeToolResultTooLarge,
} from "../sandbox/katafit.mjs";
import { NATIVE_RESPONSE_FRAME_LIMIT } from "../src/sandbox/failures.js";

// Host outcomes are transient; only explicit action receipts are durable.
test("invalid host tool arguments fail without an action receipt; a later provider turn works", async () => {
  const f = await fixture();
  const gateway = await openNativeGateway(f.store);
  try {
    await assert.rejects(
      gateway.handle({
        kind: "tool",
        name: "studio_operator_list_members",
        args: { limit: -1 },
      }),
      (error: any) => error.code === "NATIVE_TOOL_FAILED",
    );
    const response = await gateway.handle({
      kind: "provider",
      body: {
        model: "approved-custom-model",
        stream: true,
        messages: [{ role: "user", content: "continue after failure" }],
      },
    });
    assert.match(JSON.stringify(response), /studio_operator_list_members/);
  } finally {
    await gateway.close();
    await f.close();
  }
});

test("malformed host tool frames and unknown tool cannot dispatch", async () => {
  const f = await fixture();
  const gateway = await openNativeGateway(f.store);
  try {
    for (const request of [
      {
        kind: "tool",
        name: "studio_operator_list_members",
        args: {},
        toolCallId: "",
      },
      {
        kind: "tool",
        name: "studio_operator_list_members",
        args: {},
        extra: true,
      },
      { kind: "tool", name: "not_a_host_tool", args: {} },
    ])
      await assert.rejects(
        gateway.handle(request),
        (error: any) => error.code === "NATIVE_REQUEST_REJECTED",
      );
    assert.equal(
      f.calls.filter(
        (call) => call.body?.params?.name === "studio_operator_list_members",
      ).length,
      0,
    );
  } finally {
    await gateway.close();
    await f.close();
  }
});

for (const scenario of ["success", "failure", "unknown"] as const)
  test(`host outcome ${scenario} is normalized for the current Pi turn`, async () => {
    const f = await fixture((name, value) =>
      name === "studio_operator_list_members" && scenario === "failure"
        ? {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({ code: "SYNTHETIC_FAILURE" }),
              },
            ],
          }
        : value,
    );
    const gateway = await openNativeGateway(f.store);
    try {
      let result: any, code: string | undefined;
      try {
        result = await gateway.handle({
          kind: "tool",
          name:
            scenario === "unknown"
              ? "unknown_tool"
              : "studio_operator_list_members",
          args: {},
        });
      } catch (error: any) {
        code = error.code;
      }
      const outcome = nativeToolOutcome(
        scenario === "unknown"
          ? "unknown_tool"
          : "studio_operator_list_members",
        result,
        code,
      );
      assert.equal(Boolean(outcome.isError), scenario !== "success");
      assert.ok(outcome.content.every((part: any) => part.type === "text"));
      if (scenario === "success")
        assert.match(JSON.stringify(outcome), /Synthetic Alice/);
      else
        assert.match(
          JSON.stringify(outcome),
          scenario === "unknown"
            ? /NATIVE_REQUEST_REJECTED/
            : /Kata.fit tool failed; do not replay uncertain actions/,
        );
    } finally {
      await gateway.close();
      await f.close();
    }
  });

test("busy attachment attempt cannot publish a second panel item", async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (entered = resolve));
  let publications = 0;
  const gateway = await openNativeGateway(f.store, undefined, {
    attachments: {
      read: async () => {
        entered();
        await held;
        return Buffer.from("synthetic file");
      },
      publish: () => {
        publications++;
        return true;
      },
    },
  });
  let first: Promise<any> | undefined;
  try {
    first = gateway.handle({
      kind: "tool",
      name: "send_to_operator",
      args: { workspace_path: "first.txt" },
      toolCallId: "first",
    });
    await Promise.race([
      started,
      first.then(() => {
        throw Error("attachment did not start");
      }),
    ]);
    const busy = await gateway.handle({
      kind: "tool",
      name: "send_to_operator",
      args: { workspace_path: "second.txt" },
      toolCallId: "second",
    });
    assert.deepEqual(busy, { attachmentError: { code: "ATTACHMENT_BUSY" } });
    assert.equal(publications, 0);
    release();
    assert.match(JSON.stringify(await first), /accepted_to_operator_panel/);
    assert.equal(publications, 1);
  } finally {
    release();
    await first?.catch(() => {});
    await gateway.close();
    await f.close();
  }
});

test("unobserved image receipt is denied without publishing", async () => {
  const f = await fixture();
  let publications = 0;
  const gateway = await openNativeGateway(f.store, undefined, {
    attachments: {
      read: async () => Buffer.from("unused"),
      publish: () => {
        publications++;
        return true;
      },
    },
  });
  try {
    const result = await gateway.handle({
      kind: "tool",
      name: "send_to_operator",
      args: { image_receipt: "ir_" + "a".repeat(32) },
    });
    assert.match(JSON.stringify(result), /ATTACHMENT_/);
    assert.equal(publications, 0);
  } finally {
    await gateway.close();
    await f.close();
  }
});

test("shared shipped contract withholds oversized results", () => {
  const large = {
    content: [{ type: "text", text: "x".repeat(16 * 1024 * 1024) }],
  };
  const outcome = nativeToolOutcome("studio_operator_send_message", large);
  assert.equal(outcome.isError, true);
  assert.match(outcome.content[0].text, /^NATIVE_RESULT_TOO_LARGE:/);
  assert.match(outcome.content[0].text, /do not replay/);
  assert.ok(JSON.stringify(outcome).length < 1024);
});

test("shared contract cap reserves the largest runtime response frame ID", () => {
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
