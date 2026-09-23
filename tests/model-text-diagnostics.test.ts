import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { complete } from "../src/runtime/piAdapter.js";
import { Diagnostics, screenedModelText } from "../src/diagnostics/log.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const ref = "147dc6e5-0e13-4da4-8b38-e9d668b4b445";
async function fixture(reply: (turn: number) => Record<string, unknown>) {
  let turn = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    const delta = reply(++turn);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ id: "synthetic", choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    config: {
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      model: "synthetic",
      apiKey: "synthetic-provider-secret",
      secrets: ["known-exact-secret"],
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

test("actual Pi SSE persists outbound context, native call/receipt and inbound text across restart", async () => {
  const dir = await mkdtemp(tmpdir() + "/model-text-");
  const model = await fixture((turn) =>
    turn === 1
      ? {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: {
                name: "coach_read_media",
                arguments: '{"activity_id":"synthetic-id"}',
              },
            },
          ],
        }
      : { content: "Assessment: media read completed." },
  );
  const log = new Diagnostics(dir);
  const tool: AgentTool = {
    name: "coach_read_media",
    label: "read",
    description: "read",
    parameters: {
      type: "object",
      properties: { activity_id: { type: "string" } },
    } as any,
    execute: async () => ({
      content: [
        { type: "text", text: "Read receipt: image loaded" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
      details: {},
    }),
  };
  try {
    const result = await complete(
      {
        ...model.config,
        vision: true,
        onDiagnostic: (e) => log.record({ ...e, ref }),
      },
      "System policy for exercise review",
      "User asks for an assessment of a photo",
      AbortSignal.timeout(5000),
      [tool],
    );
    assert.equal(result, "Assessment: media read completed.");
    const rows = new Diagnostics(dir).snapshot().entries;
    assert.ok(
      rows.some(
        (e) =>
          e.stage === "provider-payload" &&
          e.ref === ref &&
          e.metadata.turn === 1 &&
          e.texts?.some(
            (t) => t.role === "system" && t.text.includes("System policy"),
          ) &&
          e.texts?.some((t) => t.role === "user" && t.text.includes("photo")),
      ),
    );
    assert.ok(
      rows.some(
        (e) =>
          e.stage === "provider-response" &&
          e.metadata.turn === 1 &&
          e.calls?.some(
            (c) =>
              c.name === "coach_read_media" &&
              c.argumentKeys.includes("activity_id"),
          ),
      ),
    );
    assert.ok(
      rows.some(
        (e) =>
          e.stage === "tool-execution" &&
          e.receipt?.name === "coach_read_media" &&
          e.receipt.outcome === "ok" &&
          e.receipt.media === true,
      ),
    );
    assert.ok(
      rows.some(
        (e) =>
          e.stage === "provider-payload" &&
          e.metadata.turn === 2 &&
          e.texts?.some(
            (t) => t.role === "tool" && t.text.includes("Read receipt"),
          ),
      ),
    );
    assert.ok(
      rows.some(
        (e) =>
          e.stage === "provider-response" &&
          e.metadata.turn === 2 &&
          e.texts?.some((t) => t.text.includes("Assessment")),
      ),
    );
    assert.ok(
      !(await readFile(dir + "/diagnostics.jsonl", "utf8")).includes(
        "aGVsbG8=",
      ),
    );
  } finally {
    await model.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("pseudo-tool rejection keeps model text but never executes tools", async () => {
  const dir = await mkdtemp(tmpdir() + "/model-pseudo-");
  const model = await fixture(() => ({
    content: '<function=coach_read_media>{"activity_id":"example"}',
  }));
  const log = new Diagnostics(dir);
  let executed = 0;
  try {
    await assert.rejects(
      complete(
        {
          ...model.config,
          vision: true,
          onDiagnostic: (e) => log.record({ ...e, ref }),
        },
        "System",
        "User question",
        AbortSignal.timeout(5000),
        [
          {
            name: "coach_read_media",
            label: "read",
            description: "read",
            parameters: { type: "object", properties: {} } as any,
            execute: async () => {
              executed++;
              return { content: [], details: {} };
            },
          },
        ],
      ),
      (e: any) => e.code === "MODEL_TOOL_FORMAT_UNSUPPORTED",
    );
    assert.equal(executed, 0);
    assert.ok(
      new Diagnostics(dir)
        .snapshot()
        .entries.some(
          (e) =>
            e.stage === "provider-response" &&
            e.texts?.some((t) =>
              t.text.includes("<function=coach_read_media>"),
            ),
        ),
    );
  } finally {
    await model.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("record and restart redact credential spans, escaped JSON, URLs and base64 while keeping prose bounded", async () => {
  const dir = await mkdtemp(tmpdir() + "/model-redaction-");
  try {
    const log = new Diagnostics(dir);
    log.record({
      source: "provider",
      stage: "provider-response",
      metadata: { turn: 1 },
      texts: [
        {
          role: "assistant",
          text:
            'Useful assessment sk-1234567890123456 Bearer secret-value api_key: "sensitive-value" https://host.test/media?token=secret data:image/png;base64,aGVsbG8= and \\u0073k-1234567890123456 ' +
            "A".repeat(50000),
        },
      ],
    });
    const row = new Diagnostics(dir).snapshot().entries.at(-1)!;
    assert.ok(row.texts?.[0].text.includes("Useful assessment"));
    assert.ok(row.texts?.[0].text.includes("[redacted]"));
    assert.ok(Buffer.byteLength(JSON.stringify(row)) < 9000);
    for (const forbidden of [
      "sk-1234567890123456",
      "secret-value",
      "sensitive-value",
      "https://host.test",
      "aGVsbG8=",
      "\\u0073k-",
    ])
      assert.ok(!JSON.stringify(row).includes(forbidden), forbidden);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("actual Pi SSE screens known inbound secret without dropping adjacent answer", async () => {
  const dir = await mkdtemp(tmpdir() + "/model-secret-");
  const model = await fixture(() => ({
    content:
      "Answer first; known-exact-secret should not be stored; answer last.",
  }));
  try {
    const log = new Diagnostics(dir);
    await complete(
      { ...model.config, onDiagnostic: (e) => log.record({ ...e, ref }) },
      "System",
      "Question",
      AbortSignal.timeout(5000),
    );
    const text = new Diagnostics(dir)
      .snapshot()
      .entries.find((e) => e.stage === "provider-response")?.texts?.[0].text;
    assert.match(
      text ?? "",
      /Answer first; \[redacted\] should not be stored; answer last/,
    );
    assert.ok(
      !(await readFile(dir + "/diagnostics.jsonl", "utf8")).includes(
        "known-exact-secret",
      ),
    );
  } finally {
    await model.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("JSON credential fields and tool failure keep safe context and error receipt", async () => {
  const dir = await mkdtemp(tmpdir() + "/model-error-");
  const model = await fixture((turn) =>
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
      : { content: "No read available" },
  );
  const log = new Diagnostics(dir);
  try {
    await complete(
      { ...model.config, onDiagnostic: (e) => log.record({ ...e, ref }) },
      "Policy",
      'Useful request {"api_key":"opaque-credential","note":"exercise"}',
      AbortSignal.timeout(5000),
      [
        {
          name: "coach_list_activities",
          label: "list",
          description: "list",
          parameters: { type: "object", properties: {} } as any,
          execute: async () => {
            throw new Error("internal failed: opaque-credential");
          },
        },
      ],
    );
    const rows = new Diagnostics(dir).snapshot().entries;
    assert.ok(
      rows.some(
        (e) =>
          e.receipt?.name === "coach_list_activities" &&
          e.receipt.outcome === "error",
      ),
    );
    assert.ok(
      rows.some(
        (e) =>
          e.stage === "provider-payload" &&
          e.texts?.some(
            (t) =>
              t.text.includes("Useful request") &&
              t.text.includes("[redacted]"),
          ),
      ),
    );
    assert.ok(
      !(await readFile(dir + "/diagnostics.jsonl", "utf8")).includes(
        "opaque-credential",
      ),
    );
  } finally {
    await model.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("private key blocks and JWTs are screened without dropping adjacent text", () => {
  const text = screenedModelText(
    "Keep this note. -----BEGIN PRIVATE KEY-----\nopaque-private-material\n-----END PRIVATE KEY----- eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature More useful context.",
  );
  assert.match(text ?? "", /Keep this note.*More useful context/s);
  assert.ok(!text?.includes("opaque-private-material"));
  assert.ok(!text?.includes("eyJhbGciOiJIUzI1NiJ9"));
});
