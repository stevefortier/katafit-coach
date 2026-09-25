import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { complete } from "../src/runtime/piAdapter.js";

for (const name of [
  "studio_operator_read_member_coach_feed",
  "studio_operator_send_message",
  "studio_operator_future_write",
])
  test(`native loop reports the failed ${name} rather than catalog-wide send status`, async () => {
    const bodies: any[] = [];
    let executed = 0;
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const part of req) raw += part;
      bodies.push(JSON.parse(raw));
      const delta =
        bodies.length === 1
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "synthetic-call",
                  type: "function",
                  function: { name, arguments: "{}" },
                },
              ],
            }
          : {
              content:
                "The requested result is unavailable; no successful action is established.",
            };
      const event = (delta: any, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: "synthetic", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      res.setHeader("content-type", "text/event-stream");
      res.end(
        event({ role: "assistant", ...delta }, null) +
          event({}, bodies.length === 1 ? "tool_calls" : "stop") +
          "data: [DONE]\n\n",
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      await complete(
        {
          baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
          model: "synthetic",
          apiKey: "synthetic-key",
        },
        "Answer only from tools",
        "Read my data",
        AbortSignal.timeout(5000),
        (name === "studio_operator_future_write"
          ? [name]
          : [
              "studio_operator_read_member_coach_feed",
              "studio_operator_send_message",
            ]
        ).map((toolName) => ({
          name: toolName,
          label: toolName,
          description: toolName,
          parameters: { type: "object", properties: {} } as any,
          async execute() {
            executed++;
            throw new Error(
              toolName !== "studio_operator_read_member_coach_feed"
                ? "DELIVERY_UNVERIFIED"
                : "READ_NOT_AUTHORIZED",
            );
          },
        })),
      );
      assert.equal(executed, 1);
      const result = bodies[1].messages.find((m: any) => m.role === "tool");
      assert.ok(result);
      if (name !== "studio_operator_read_member_coach_feed")
        assert.match(result.content, /uncertain|unknown|unverified/i);
      else {
        assert.match(
          result.content,
          /READ_NOT_AUTHORIZED|not authorized|denied/i,
        );
        assert.doesNotMatch(result.content, /send was unsent/);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
