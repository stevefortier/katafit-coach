import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "../src/katafit/client.js";
import { wire } from "./data-fixtures.js";
test("context-only transport allows bounded duplicated MCP context, ordinary calls stay at 1MiB", async () => {
  const context = {
    conversation: [{ role: "user", text: "é".repeat(300000) }],
  };
  const f = await wire(() => ({
    structuredContent: context,
    content: [{ type: "text", text: JSON.stringify(context) }],
  }));
  try {
    const c = new Client(f.origin, "synthetic", AbortSignal.timeout(5000));
    assert.deepEqual(await c.call("coach_read_context", {}), context);
    await assert.rejects(
      c.call("coach_list_requests", {}),
      /RESPONSE_TOO_LARGE/,
    );
    context.conversation[0].text = "x".repeat(5 * 1024 * 1024);
    await assert.rejects(
      c.call("coach_read_context", {}),
      /RESPONSE_TOO_LARGE/,
    );
  } finally {
    await f.close();
  }
});
