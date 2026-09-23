import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { complete } from "../src/runtime/piAdapter.js";
import { hints } from "../src/runtime/errors.js";

for (const mode of [
  "turns",
  "calls",
  "output",
  "seven-turn-success",
] as const) {
  test(`real Pi retains bounded ${mode} with diagnostic counters`, async () => {
    let requests = 0,
      executions = 0;
    const events: any[] = [];
    const server = createServer(async (req, res) => {
      for await (const _ of req) {
      }
      requests++;
      const finish =
        mode === "output" || (mode === "seven-turn-success" && requests === 7);
      const delta = finish
        ? { role: "assistant", content: "Safe final" }
        : {
            role: "assistant",
            tool_calls: Array.from(
              { length: mode === "calls" ? 49 : 1 },
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
              completion_tokens: mode === "output" ? 48001 : 1,
              total_tokens: mode === "output" ? 48002 : 2,
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
      if (mode === "seven-turn-success") {
        assert.equal(await promise, "Safe final");
        assert.equal(requests, 7);
        assert.ok(events.at(-1).metadata.totalBytes > 5 * 1024 * 1024);
        assert.ok(events.at(-1).metadata.totalBytes <= 24 * 1024 * 1024);
        assert.equal(events.at(-1).metadata.totalLimit, 24 * 1024 * 1024);
      } else {
        await assert.rejects(promise, (e: any) => {
          assert.equal(e.code, "MODEL_BUDGET_EXHAUSTED");
          assert.equal(e.hint, hints.MODEL_BUDGET_EXHAUSTED);
          assert.match(
            e.hint,
            /24 MiB.*24 turns.*48 tool calls.*48000 output tokens/,
          );
          if (mode === "turns") {
            assert.equal(e.metadata.turns, 24);
            assert.equal(e.metadata.turnLimit, 24);
          }
          if (mode === "calls") {
            assert.equal(e.metadata.calls, 49);
            assert.equal(e.metadata.callLimit, 48);
          }
          if (mode === "output") {
            assert.equal(e.metadata.outputTokens, 48001);
            assert.equal(e.metadata.outputTokenLimit, 48000);
          }
          assert.equal(e.metadata.totalLimit, 24 * 1024 * 1024);
          return true;
        });
      }
      assert.ok(requests <= 24);
      assert.ok(executions <= 48);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
}
