import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { complete } from "../src/runtime/piAdapter.js";

test("ambiguous local mutation result is outcome unknown and does not invite retry", async () => {
  const bodies: any[] = [];
  let commits = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw));
    const anotherCall = bodies.length <= 2;
    const delta = anotherCall
      ? {
          tool_calls: [
            {
              index: 0,
              id: bodies.length === 1 ? "call-one" : "call-retry",
              type: "function",
              function: { name: "local_mcp__fixture__change", arguments: "{}" },
            },
          ],
        }
      : { content: "I cannot confirm whether the change happened." };
    res.setHeader("content-type", "text/event-stream");
    res.end(
      `data: ${JSON.stringify({ id: "synthetic", choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "synthetic", choices: [{ index: 0, delta: {}, finish_reason: anotherCall ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const text = await complete(
      {
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        model: "synthetic-mutation",
        apiKey: "synthetic-provider-key",
      },
      "Coach",
      "Change fixture",
      AbortSignal.timeout(5000),
      [
        {
          name: "local_mcp__fixture__change",
          label: "change",
          description: "change",
          parameters: { type: "object", properties: {} },
          execute: async () => {
            commits++;
            throw new Error("timeout after commit");
          },
        },
      ],
    );
    assert.equal(text, "I cannot confirm whether the change happened.");
    assert.equal(commits, 1);
    assert.equal(bodies.length, 3);
    const second = JSON.stringify(bodies[1]);
    assert.match(second, /outcome unknown/i);
    assert.match(second, /never retry automatically/i);
    assert.doesNotMatch(second, /timeout after commit/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
