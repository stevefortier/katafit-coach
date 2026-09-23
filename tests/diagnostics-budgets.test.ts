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
  "beyond-old-cap",
  "exact-cap-final",
  "short-time",
] as const) {
  test(`real Pi retains bounded ${mode} with diagnostic counters`, async () => {
    let requests = 0,
      executions = 0;
    const events: any[] = [];
    const notices: string[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      notices.push(
        payload.messages?.find((m: any) => m.role === "system")?.content ?? "",
      );
      requests++;
      const finish =
        mode === "output" ||
        ((mode === "seven-turn-success" || mode === "short-time") &&
          requests === 7) ||
        (mode === "beyond-old-cap" && requests === 25) ||
        (mode === "exact-cap-final" && requests === 40);
      const delta = finish
        ? { role: "assistant", content: "Safe final" }
        : {
            role: "assistant",
            tool_calls: Array.from(
              { length: mode === "calls" ? 65 : 1 },
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
        {
          deadlineAt: Date.now() + (mode === "short-time" ? 25000 : 120000),
          readBudget: () => ({ used: executions, limit: 48 }),
        },
      );
      if (
        mode === "seven-turn-success" ||
        mode === "short-time" ||
        mode === "beyond-old-cap" ||
        mode === "exact-cap-final"
      ) {
        assert.equal(await promise, "Safe final");
        assert.equal(
          requests,
          mode === "seven-turn-success" || mode === "short-time"
            ? 7
            : mode === "beyond-old-cap"
              ? 25
              : 40,
        );
        assert.equal(
          events.filter((e) => e.stage === "provider-payload").at(-1).metadata
            .totalLimit,
          48 * 1024 * 1024,
        );
        assert.match(
          notices[0],
          /40 turns remaining.*64 tool calls remaining.*48 scoped reads remaining.*approximately \d+ seconds/,
        );
        assert.match(
          notices[1],
          mode === "short-time"
            ? /39 turns remaining.*64 tool calls remaining.*48 scoped reads remaining/
            : /39 turns remaining.*63 tool calls remaining.*47 scoped reads remaining/,
        );
        if (mode === "short-time") {
          assert.match(notices[0], /final answer now/);
          assert.equal(executions, 0);
        }
        if (mode === "exact-cap-final") {
          assert.match(notices[30], /10 turns remaining.*Consolidate/);
          assert.match(notices[39], /1 turns remaining.*final answer now/);
          assert.match(notices[39], /9 scoped reads remaining/);
        }
      } else {
        await assert.rejects(promise, (e: any) => {
          assert.equal(e.code, "MODEL_BUDGET_EXHAUSTED");
          assert.equal(e.hint, hints.MODEL_BUDGET_EXHAUSTED);
          assert.match(
            e.hint,
            /48 MiB.*40 turns.*64 tool calls.*48000 output tokens/,
          );
          if (mode === "turns") {
            assert.ok(e.metadata.turns === 39 || e.metadata.turns === 40);
            assert.equal(e.metadata.turnLimit, 40);
            assert.equal(e.metadata.reads, 39);
            assert.equal(e.metadata.readLimit, 48);
          }
          if (mode === "calls") {
            assert.equal(e.metadata.calls, 65);
            assert.equal(e.metadata.callLimit, 64);
          }
          if (mode === "output") {
            assert.equal(e.metadata.outputTokens, 48001);
            assert.equal(e.metadata.outputTokenLimit, 48000);
          }
          assert.equal(e.metadata.totalLimit, 48 * 1024 * 1024);
          return true;
        });
      }
      assert.ok(requests <= 40);
      assert.ok(executions <= 64);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
}
