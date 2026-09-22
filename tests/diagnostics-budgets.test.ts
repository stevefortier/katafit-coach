import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { complete } from "../src/runtime/piAdapter.js";

for (const mode of ["turns", "calls", "output", "six-turn-success"] as const) {
  test(`real Pi retains bounded ${mode} with diagnostic counters`, async () => {
    let requests = 0,
      executions = 0;
    const events: any[] = [];
    const server = createServer(async (req, res) => {
      for await (const _ of req) {
      }
      requests++;
      const finish =
        mode === "output" || (mode === "six-turn-success" && requests === 6);
      const delta = finish
        ? { role: "assistant", content: "Safe final" }
        : {
            role: "assistant",
            tool_calls: Array.from(
              { length: mode === "calls" ? 13 : 1 },
              (_, i) => ({
                index: i,
                id: `call_${requests}_${i}`,
                type: "function",
                function: { name: "coach_read_profile", arguments: "{}" },
              }),
            ),
          };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        "data: " +
          JSON.stringify({
            id: "x",
            choices: [
              {
                index: 0,
                delta,
                finish_reason: finish ? "stop" : "tool_calls",
              },
            ],
            usage: {
              prompt_tokens: 1,
              completion_tokens: mode === "output" ? 12001 : 1,
              total_tokens: mode === "output" ? 12002 : 2,
            },
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const promise = complete(
        {
          baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
          model: "synthetic",
          apiKey: "key-fixture",
          onDiagnostic: (e) => events.push(e),
        },
        "Coach",
        "x".repeat(800000),
        AbortSignal.timeout(5000),
        [
          {
            name: "coach_read_profile",
            label: "Read",
            description: "Read",
            parameters: { type: "object", properties: {} } as any,
            execute: async () => {
              executions++;
              return {
                content: [{ type: "text", text: "Safe read" }],
                details: {},
              };
            },
          },
        ],
      );
      if (mode === "six-turn-success") {
        assert.equal(await promise, "Safe final");
        assert.equal(requests, 6);
        assert.ok(events.at(-1).metadata.totalBytes > 4 * 1024 * 1024);
        assert.ok(events.at(-1).metadata.totalBytes <= 6 * 1024 * 1024);
      } else {
        await assert.rejects(promise, (e: any) => {
          assert.equal(e.code, "MODEL_BUDGET_EXHAUSTED");
          if (mode === "turns") {
            assert.equal(e.metadata.turns, 6);
            assert.equal(e.metadata.turnLimit, 6);
          }
          if (mode === "calls") {
            assert.equal(e.metadata.calls, 13);
            assert.equal(e.metadata.callLimit, 12);
          }
          if (mode === "output") {
            assert.equal(e.metadata.outputTokens, 12001);
            assert.equal(e.metadata.outputTokenLimit, 12000);
          }
          return true;
        });
      }
      assert.ok(requests <= 6);
      assert.ok(executions <= 12);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
}
