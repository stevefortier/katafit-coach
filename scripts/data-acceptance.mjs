// Synthetic-only packed runtime acceptance. No hosted APIs or customer data.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
const root = resolve(process.argv[2] ?? ".");
const { Worker } = await import(pathToFileURL(root + "/dist/worker/runner.js"));
const { complete } = await import(
  pathToFileURL(root + "/dist/runtime/piAdapter.js")
);
const image =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=";
let request = {
  id: "synthetic-packed-request",
  requester_id: "synthetic-requester",
  scope: "personal",
  text: "Read my original authorized image",
  attachment_count: 1,
  status: "queued",
  lease_generation: 0,
  timeout_at: new Date(Date.now() + 120000).toISOString(),
};
const calls = [],
  payloads = [];
const inputSchema = {
  type: "object",
  properties: {
    request_id: { type: "string" },
    lease_generation: { type: "integer" },
    media_ref: { type: "string" },
  },
  required: ["request_id", "lease_generation", "media_ref"],
  additionalProperties: false,
};
const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET") {
      res.end(
        "# Kata.fit external Coach agent v1\nRead-only negotiated v2 fixture.",
      );
      return;
    }
    let raw = "";
    for await (const c of req) raw += c;
    const m = JSON.parse(raw);
    if (req.url === "/v1/chat/completions") {
      payloads.push(m);
      const delta =
        payloads.length === 1
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "read1",
                  type: "function",
                  function: {
                    name: "coach_read_media",
                    arguments: JSON.stringify({ media_ref: "opaque-original" }),
                  },
                },
              ],
            }
          : {
              role: "assistant",
              content: "Packed Pi consumed the original image.",
            };
      res.setHeader("Content-Type", "text/event-stream");
      res.end(
        "data: " +
          JSON.stringify({
            id: "synthetic",
            choices: [{ index: 0, delta, finish_reason: null }],
          }) +
          "\n\ndata: " +
          JSON.stringify({
            id: "synthetic",
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: payloads.length === 1 ? "tool_calls" : "stop",
              },
            ],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
      return;
    }
    calls.push(m.params?.name ?? m.method);
    if (m.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    let result;
    if (m.method === "initialize") result = { protocolVersion: "2025-03-26" };
    else if (m.method === "tools/list")
      result = {
        tools: [
          { name: "coach_get_capabilities" },
          { name: "coach_read_media", inputSchema },
          { name: "coach_respond", inputSchema },
        ],
      };
    else {
      const a = m.params.arguments;
      let v;
      switch (m.params.name) {
        case "coach_list_requests":
          v = { requests: [request] };
          break;
        case "coach_claim_request":
          assert.equal(a.lease_seconds, 120);
          request = {
            ...request,
            status: "claimed",
            lease_generation: 1,
            lease_expires_at: new Date(Date.now() + 120000).toISOString(),
          };
          v = { request };
          break;
        case "coach_start_request":
          request.status = "working";
          v = { request };
          break;
        case "coach_read_context":
          v = { request, authorized_media_ref: "opaque-original" };
          break;
        case "coach_get_capabilities":
          assert.equal(a.request_id, request.id);
          assert.equal(a.lease_generation, 1);
          v = {
            contract_version: 2,
            allowed_tools: ["coach_read_media", "coach_respond"],
            domains: { media: { available: true } },
            limits: {},
          };
          break;
        case "coach_read_media":
          assert.deepEqual(a, {
            media_ref: "opaque-original",
            request_id: request.id,
            lease_generation: 1,
          });
          result = {
            structuredContent: { representation: "original" },
            content: [{ type: "image", mimeType: "image/png", data: image }],
          };
          break;
        case "coach_respond":
          request.status = "completed";
          request.reply = { text: a.text };
          v = { request };
          break;
        case "coach_fail_request":
          request.status = "failed";
          v = { request };
          break;
        default:
          throw new Error("Unexpected tool");
      }
      result ??= { structuredContent: v };
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
  } catch {
    res.writeHead(500).end("Synthetic harness failure");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const worker = new Worker({
  origin,
  token: "synthetic-private-connection",
  secrets: ["synthetic-private-provider"],
  system: "Coach",
  vision: true,
  complete: (context, signal, system, tools) =>
    complete(
      {
        baseUrl: origin + "/v1",
        model: "synthetic",
        apiKey: "synthetic-private-provider",
        vision: true,
      },
      system,
      context,
      signal,
      tools,
    ),
});
try {
  await worker.pollOnce();
  assert.equal(worker.state, "reply-persisted");
  assert.equal(request.reply.text, "Packed Pi consumed the original image.");
  assert.equal(payloads.length, 2);
  assert.deepEqual(
    payloads[0].tools.map((t) => t.function.name),
    ["coach_read_media"],
  );
  const blocks = payloads[1].messages.flatMap((m) =>
    Array.isArray(m.content) ? m.content : [],
  );
  const actual = Buffer.from(
    blocks.find((c) => c.type === "image_url").image_url.url.split(",")[1],
    "base64",
  );
  assert.deepEqual(actual, Buffer.from(image, "base64"));
  assert.equal(JSON.stringify(payloads).includes("synthetic-private"), false);
  console.log(
    JSON.stringify({
      proof: "packed real Pi + synthetic MCP/provider",
      providerTurns: payloads.length,
      modelTools: payloads[0].tools.map((t) => t.function.name),
      originalImageBytes: actual.length,
      originalImageSha256: createHash("sha256").update(actual).digest("hex"),
      canonicalReply: request.reply.text,
      lifecycleCalls: calls,
      cleanup: "worker/server closed in finally",
    }),
  );
} finally {
  await worker.stop();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
