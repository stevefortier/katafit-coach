import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/native.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";

test("on a backend without account memory, native provider relays current Pi messages without memory or delivery capture", async () => {
  const f = await fixture((name, result) =>
    name === "provider"
      ? `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Current answer" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
      : result,
  );
  const gateway = await openNativeGateway(f.store);
  try {
    const messages = [
      { role: "system", content: "Current persona" },
      { role: "user", content: "Current question" },
    ];
    const response = await gateway.handle({
      kind: "provider",
      body: { model: "approved-custom-model", messages },
    });
    assert.equal(Object.hasOwn(response, "completion_id"), false);
    assert.deepEqual(
      f.calls.find((call) => call.path === "/v1/chat/completions")?.body
        .messages,
      messages,
    );
    assert.equal(
      f.calls.filter((call) =>
        /memory|record_interaction/i.test(call.body?.params?.name ?? ""),
      ).length,
      0,
    );
  } finally {
    await gateway.close();
    await f.close();
  }
});
