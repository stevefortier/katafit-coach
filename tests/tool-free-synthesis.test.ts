import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { complete } from "../src/runtime/piAdapter.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const pseudo =
  "<tool_call>\n<function=coach_read_activities>\n<parameter=limit>10</parameter>";
const receipt = (index: number) => `SYNTHETIC_READ_${index}: observed`;
const answer =
  "Four synthetic read receipts establish observations 1 through 4. Media unverified; no media was read.";

test("Pi HTTP SSE sends four native reads, then a declaration-free evidence-bounded synthesis", async () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  const requests: any[] = [];
  const executed: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(payload);
    const turn = requests.length;
    // Accelerate the provider cadence while retaining an independent real-clock
    // abort. The fixture makes the advertised schema the only final-turn variable.
    now += 17000;
    const final = payload.tool_choice === "none";
    const delta = final
      ? {
          role: "assistant",
          content:
            Array.isArray(payload.tools) && payload.tools.length
              ? pseudo
              : payload.messages.filter((m: any) => m.role === "tool")
                    .length === 4
                ? answer
                : "Read and media evidence unverified.",
        }
      : {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_${turn}`,
              type: "function",
              function: { name: `coach_read_${turn}`, arguments: "{}" },
            },
          ],
        };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({
        id: "synthetic",
        choices: [
          { index: 0, delta, finish_reason: final ? "stop" : "tool_calls" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("deadline", "TimeoutError")),
    5000,
  );
  const tools: AgentTool[] = Array.from({ length: 11 }, (_, index) => ({
    name: `coach_read_${index + 1}`,
    label: `Read ${index + 1}`,
    description: "Synthetic authorized read",
    parameters: { type: "object", properties: {} } as any,
    execute: async () => {
      executed.push(`coach_read_${index + 1}`);
      return {
        content: [{ type: "text" as const, text: receipt(index + 1) }],
        details: {},
      };
    },
  }));
  try {
    const events: any[] = [];
    const result = await complete(
      {
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        model: "synthetic",
        apiKey: "synthetic-key",
        onDiagnostic: (event) => events.push(event),
      },
      "Coach: use executed evidence only",
      "Review synthetic activity, and do not invent media observations",
      controller.signal,
      tools,
      {
        deadlineAt: now + 100000,
        readBudget: () => ({ used: executed.length, limit: 8 }),
      },
    );
    assert.equal(result, answer);
    assert.deepEqual(executed, [
      "coach_read_1",
      "coach_read_2",
      "coach_read_3",
      "coach_read_4",
    ]);
    assert.equal(requests.length, 5);
    for (const request of requests.slice(0, 4))
      assert.equal(request.tools?.length, 11);
    const final = requests[4];
    assert.equal(final.tool_choice, "none");
    assert.ok(
      !Object.hasOwn(final, "tools"),
      `final provider payload must not advertise schemas (tools=${final.tools?.length})`,
    );
    assert.deepEqual(
      final.messages
        .filter((m: any) => m.role === "tool")
        .map((m: any) => m.content),
      [receipt(1), receipt(2), receipt(3), receipt(4)],
    );
    assert.ok(
      final.messages.some(
        (m: any) =>
          m.role === "system" &&
          /Give the final answer now without requesting tools.*unverified.*media has not been read/.test(
            m.content,
          ),
      ),
    );
    assert.equal(
      events.filter((e) => e.stage === "provider-payload").at(-1)?.shape
        ?.toolCount,
      0,
    );
    assert.equal(controller.signal.aborted, false);
  } finally {
    clearTimeout(timer);
    Date.now = originalNow;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("pseudo-tool content still fails closed when synthesis has no declared tools", async () => {
  const requests: any[] = [];
  let sends = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({
        id: "synthetic",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: pseudo },
            finish_reason: "stop",
          },
        ],
      })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(
      complete(
        {
          baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
          model: "synthetic",
          apiKey: "synthetic-key",
        },
        "Coach",
        "Review",
        AbortSignal.timeout(5000),
        [
          {
            name: "studio_operator_send_message",
            label: "Send",
            description: "Send",
            parameters: { type: "object", properties: {} } as any,
            execute: async () => {
              sends++;
              return { content: [], details: {} };
            },
          },
        ],
        { deadlineAt: Date.now() + 1000 },
      ),
      (error: any) => error.code === "MODEL_TOOL_FORMAT_UNSUPPORTED",
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].tool_choice, "none");
    assert.ok(!Object.hasOwn(requests[0], "tools"));
    assert.equal(sends, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
