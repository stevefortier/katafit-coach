import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { complete } from "../src/runtime/piAdapter.js";
import { Worker } from "../src/worker/runner.js";
import { fixture } from "./worker.test.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const pseudo =
  "<tool_call>\n<function=coach_list_activities>\n<parameter=limit>10</parameter>\n</function>";

async function provider(reply: (request: any, turn: number) => any) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    const delta = reply(request, requests.length);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ id: "synthetic", choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    config: {
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      model: "synthetic",
      apiKey: "synthetic-provider-key",
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function tool(
  name = "coach_list_activities",
  execute = async () => ({
    content: [{ type: "text" as const, text: "READ_RECEIPT: ten activities" }],
    details: {},
  }),
): AgentTool {
  return {
    name,
    label: name,
    description: "Synthetic tool",
    parameters: { type: "object", properties: {} } as any,
    execute,
  };
}

test("HTTP SSE pseudo-tool content fails before worker publication with a safe diagnostic", async () => {
  const backend = await fixture();
  const model = await provider(() => ({
    content: pseudo + "\nprivate-provider-raw-marker",
  }));
  let executions = 0;
  const worker = new Worker({
    origin: backend.origin,
    token: "synthetic-token",
    system: "Coach",
    complete: (context, signal, system, tools, _ref, budget) =>
      complete(
        model.config,
        system,
        context,
        signal,
        [
          ...tools,
          tool("studio_operator_send_message", async () => {
            executions++;
            return { content: [{ type: "text", text: "sent" }], details: {} };
          }),
        ],
        budget,
      ),
  });
  try {
    backend.enqueue("Review my activity");
    await assert.rejects(
      worker.pollOnce(),
      (error: any) =>
        error.code === "MODEL_TOOL_FORMAT_UNSUPPORTED" &&
        !JSON.stringify(error).includes("private-provider-raw-marker"),
    );
    assert.equal(worker.lastError?.code, "MODEL_TOOL_FORMAT_UNSUPPORTED");
    assert.equal(model.requests.length, 1);
    assert.equal(executions, 0);
    assert.equal(backend.publications, 0);
    assert.equal(backend.history.length, 0);
    assert.ok(!backend.calls.includes("coach_respond"));
    assert.equal(backend.current.failure_code, "MODEL_TOOL_FORMAT_UNSUPPORTED");
    assert.ok(
      !JSON.stringify(backend.current).includes("private-provider-raw-marker"),
    );
  } finally {
    await worker.stop();
    await backend.close();
    await model.close();
  }
});

test("native delta.tool_calls still executes and returns grounded reply", async () => {
  const model = await provider((_request, turn) =>
    turn === 1
      ? {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "coach_list_activities", arguments: "{}" },
            },
          ],
        }
      : { content: "Read receipt confirms ten activities; media unverified." },
  );
  let executions = 0;
  const events: any[] = [];
  try {
    const result = await complete(
      { ...model.config, onDiagnostic: (event: any) => events.push(event) },
      "Coach",
      "Review",
      AbortSignal.timeout(5000),
      [
        tool("coach_list_activities", async () => {
          executions++;
          return {
            content: [{ type: "text", text: "READ_RECEIPT: ten activities" }],
            details: {},
          };
        }),
      ],
    );
    assert.equal(
      result,
      "Read receipt confirms ten activities; media unverified.",
    );
    assert.equal(executions, 1);
    assert.equal(model.requests.length, 2);
    assert.deepEqual(
      events
        .filter((e) => e.stage === "provider-response")
        .map((e) => e.metadata.nativeCalls),
      [1, 0],
    );
    assert.equal(
      events.filter((e) => e.stage === "provider-payload").length,
      2,
    );
    assert.equal(
      events.filter((e) => e.stage === "provider-payload")[0].shape?.toolCount,
      1,
    );
    assert.equal(
      events.filter((e) => e.stage === "provider-payload")[0].shape?.toolChoice,
      "default-auto",
    );
    assert.ok(
      model.requests[1].messages.some(
        (message: any) =>
          message.role === "tool" && message.content.includes("READ_RECEIPT"),
      ),
    );
  } finally {
    await model.close();
  }
});

for (const content of [
  pseudo,
  "I will check the activity first.\n" + pseudo,
  "I will invoke " + pseudo,
  "I will invoke <tool_call><function=coach_list_activities></function>",
  'I will invoke "<tool_call><function=coach_list_activities></function>"',
  "<TOOL_CALL><FUNCTION=coach_list_activities></FUNCTION>",
  "- <tool_call><function=coach_list_activities></function>",
  "- " + pseudo,
  "This is not an example:\n```xml\n" + pseudo + "\n```\nThis was a review.",
  "<tool_call><name>studio_operator_send_message</name><arguments>{}</arguments></tool_call>",
  "<tool_call>\n<name>coach_read_media</name>",
  "<tool_call",
  "<tool_cal",
  '<function=coach_list_activities>{"limit":10}</function>',
])
  test(`untyped command-looking content is rejected: ${content.slice(0, 35)}`, async () => {
    const model = await provider(() => ({ content }));
    let executions = 0;
    try {
      await assert.rejects(
        complete(model.config, "Coach", "Review", AbortSignal.timeout(5000), [
          tool("studio_operator_send_message", async () => {
            executions++;
            return { content: [], details: {} };
          }),
        ]),
        (error: any) => error.code === "MODEL_TOOL_FORMAT_UNSUPPORTED",
      );
      assert.equal(executions, 0);
      assert.equal(model.requests.length, 1);
    } finally {
      await model.close();
    }
  });

test("literal quoted markup within prose is not mistaken for a command", async () => {
  const content =
    'The document literally says "<tool_call><name>coach_list_activities</name></tool_call>". No read was performed; media unverified.';
  const model = await provider(() => ({ content }));
  try {
    assert.equal(
      await complete(
        model.config,
        "Coach",
        "Quote this",
        AbortSignal.timeout(5000),
        [tool()],
      ),
      content,
    );
  } finally {
    await model.close();
  }
});

test("fenced markup presented as a quoted example remains legitimate prose", async () => {
  const content =
    "The member quoted this syntax; it was not invoked:\n```xml\n<tool_call>\n<function=coach_list_activities>\n</function>\n```\nNo activity or media read was performed.";
  const model = await provider(() => ({ content }));
  try {
    assert.equal(
      await complete(
        model.config,
        "Coach",
        "Explain quotation",
        AbortSignal.timeout(5000),
        [tool()],
      ),
      content,
    );
  } finally {
    await model.close();
  }
});

test("a command following a benign fenced quotation is still rejected", async () => {
  const content =
    "The member quoted this syntax:\n```xml\n<tool_call>\n</function>\n```\n" +
    pseudo;
  const model = await provider(() => ({ content }));
  try {
    await assert.rejects(
      complete(model.config, "Coach", "Review", AbortSignal.timeout(5000), [
        tool(),
      ]),
      (error: any) => error.code === "MODEL_TOOL_FORMAT_UNSUPPORTED",
    );
  } finally {
    await model.close();
  }
});

test("pseudo-tool in tool_choice none synthesis is rejected without a retry or mutation", async () => {
  const model = await provider(() => ({ content: pseudo }));
  let sends = 0;
  try {
    await assert.rejects(
      complete(
        model.config,
        "Coach",
        "Review",
        AbortSignal.timeout(5000),
        [
          tool("studio_operator_send_message", async () => {
            sends++;
            return { content: [], details: {} };
          }),
        ],
        { deadlineAt: Date.now() + 500 },
      ),
      (error: any) => error.code === "MODEL_TOOL_FORMAT_UNSUPPORTED",
    );
    assert.equal(model.requests[0].tool_choice, "none");
    assert.equal(model.requests.length, 1);
    assert.equal(sends, 0);
  } finally {
    await model.close();
  }
});
