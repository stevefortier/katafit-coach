import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { complete } from "../src/runtime/piAdapter.js";

// An accelerated clock advances one observed ~16s provider turn per short HTTP delay.
async function scenario(options: {
  deadlineMs: number;
  delayMs?: number;
  abortMs?: number;
  ignoreChoice?: boolean;
  noResponse?: boolean;
  fastFinal?: boolean;
  allowError?: boolean;
  syntheticLatencyMs?: number;
}) {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  let monotonic = performance.now();
  if (options.syntheticLatencyMs !== undefined)
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: () => monotonic,
    });
  const requests: any[] = [];
  let executions = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(payload);
    if (options.noResponse) return;
    await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 40));
    now += 16000;
    monotonic += options.syntheticLatencyMs ?? 0;
    const finish =
      (payload.tool_choice === "none" && !options.ignoreChoice) ||
      (options.fastFinal && requests.length === 3);
    const delta = finish
      ? {
          role: "assistant",
          content: "Known: profile read succeeded. Media was not verified.",
        }
      : {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_${requests.length}`,
              type: "function",
              function: {
                name: "studio_operator_send_message",
                arguments: "{}",
              },
            },
          ],
        };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({
        id: "synthetic",
        choices: [
          { index: 0, delta, finish_reason: finish ? "stop" : "tool_calls" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("deadline", "TimeoutError")),
    options.abortMs ?? 900,
  );
  try {
    const result = await complete(
      {
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        model: "synthetic",
        apiKey: "synthetic-key",
      },
      "Coach",
      "Review the known evidence",
      controller.signal,
      [
        {
          name: "studio_operator_send_message",
          label: "Send",
          description: "Send",
          parameters: { type: "object", properties: {} } as any,
          execute: async () => {
            executions++;
            return { content: [{ type: "text", text: "sent" }], details: {} };
          },
        },
      ],
      { deadlineAt: now + options.deadlineMs },
    );
    return { result, requests, executions };
  } catch (error) {
    if (options.allowError) return { result: "", requests, executions, error };
    throw error;
  } finally {
    clearTimeout(timer);
    Date.now = originalNow;
    if (options.syntheticLatencyMs !== undefined)
      delete (performance as any).now;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("delayed multi-turn provider synthesizes a nonempty bounded answer before deadline", async () => {
  const { result, requests, executions } = await scenario({
    deadlineMs: 100000,
  });
  assert.match(result, /Known: profile read succeeded.*Media was not verified/);
  const synthesis = requests.findIndex((r) => r.tool_choice === "none");
  assert.ok(synthesis > 0 && synthesis < 7);
  assert.equal(executions, synthesis);
  assert.ok(
    requests[synthesis].messages.some(
      (m: any) =>
        m.role === "system" &&
        /unverified.*media|media.*unverified/i.test(m.content),
    ),
  );
});

test("measured high provider latency reserves synthesis earlier than the fixed floor", async () => {
  const { requests, result } = await scenario({
    deadlineMs: 100000,
    syntheticLatencyMs: 16000,
  });
  assert.ok(result.length > 0);
  assert.equal(
    requests.findIndex((r) => r.tool_choice === "none"),
    4,
  );
});

test("tool-choice-ignoring provider cannot execute Operator sends in synthesis", async () => {
  const { requests, executions, error } = await scenario({
    deadlineMs: 100000,
    ignoreChoice: true,
    allowError: true,
  });
  const synthesis = requests.findIndex((r) => r.tool_choice === "none");
  assert.ok(synthesis > 0);
  assert.equal(executions, synthesis);
  assert.ok(error);
});

test("slow unresponsive provider still times out without invented partial answer", async () => {
  await assert.rejects(
    scenario({ deadlineMs: 100000, noResponse: true, abortMs: 80 }),
    (error: any) => error.code === "PROVIDER_TIMEOUT",
  );
});

test("near-deadline first request asks for synthesis without tools", async () => {
  const { result, requests, executions } = await scenario({
    deadlineMs: 20000,
  });
  assert.ok(result.length > 0);
  assert.equal(requests[0].tool_choice, "none");
  assert.equal(executions, 0);
});

test("fast provider with ample deadline retains ordinary tool use", async () => {
  const { result, requests, executions } = await scenario({
    deadlineMs: 1000000,
    fastFinal: true,
  });
  assert.ok(result.length > 0);
  assert.ok(executions > 0);
  assert.notEqual(requests[0].tool_choice, "none");
});
