import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { modelPlanner } from "../src/chat/operatorPlan.js";

for (const mode of [
  "valid",
  "markup",
  "oversize",
  "tool",
  "bad-schema",
] as const) {
  test(`structured planner rejects unsafe response: ${mode}`, async () => {
    let request: any;
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      request = JSON.parse(raw);
      res.setHeader("content-type", "application/json");
      if (mode === "oversize") return res.end("x".repeat(20000));
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  mode === "markup"
                    ? "<tool_call>{}</tool_call>"
                    : JSON.stringify({
                        kind: "read",
                        targets: ["Alex"],
                        domains: ["feed"],
                        action: "none",
                        ...(mode === "bad-schema" ? { extra: true } : {}),
                      }),
                ...(mode === "tool"
                  ? { tool_calls: [{ function: { name: "send" } }] }
                  : {}),
              },
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("address");
      const run = modelPlanner(
        "How is Alex doing?",
        [
          {
            name: "studio_operator_read_member_coach_feed",
            description: "feed",
          } as any,
        ],
        AbortSignal.timeout(5000),
        {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          model: "synthetic",
          apiKey: "synthetic-secret",
        },
        Date.now() + 5000,
      );
      if (mode === "valid")
        assert.deepEqual(await run, {
          kind: "read",
          targets: ["Alex"],
          domains: ["feed"],
          action: "none",
        });
      else await assert.rejects(run);
      assert.equal(request?.response_format?.type, "json_schema");
      assert.equal(request?.tools, undefined);
      assert.equal(request?.tool_choice, undefined);
      assert.equal(request?.stream, false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
