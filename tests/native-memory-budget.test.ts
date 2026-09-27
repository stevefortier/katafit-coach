import test from "node:test";
import assert from "node:assert/strict";
import { startRelay } from "./helpers/native-relay.js";
import { nativeProviderEnvelope } from "../src/sandbox/gateway.js";

test("reject above the memory-qualified 32 MiB raw cap before parsing or host dispatch", async () => {
  let calls = 0;
  const r = await startRelay({
    handle: async (request: any) => {
      if (request.kind === "catalog")
        return { model: "m", vision: true, prompt: "p", skills: [], tools: [] };
      calls++;
      return { type: "application/json", body: '{"ok":true}' };
    },
    close: async () => {},
  });
  try {
    const body = { messages: [], padding: "x".repeat(33 * 1024 * 1024) };
    const response = await fetch(r.base + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, "NATIVE_WIRE_TOO_LARGE");
    assert.equal(calls, 0);
    assert.throws(
      () => nativeProviderEnvelope(body),
      (e: any) => e?.code === "NATIVE_WIRE_TOO_LARGE",
    );
  } finally {
    await r.close();
  }
});
