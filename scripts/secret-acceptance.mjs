// Bounded reviewer reproduction against an installed package; synthetic peers only.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(process.argv[2] ?? ".");
const load = (path) => import(pathToFileURL(`${root}/dist/${path}.js`));
const { Client } = await load("katafit/client");
const { discoverReads } = await load("katafit/readTools");
const { complete } = await load("runtime/piAdapter");
const receipts = [];
for (const mode of ["structured-key", "escaped-json-key", "outbound-body"]) {
  const token =
    mode === "structured-key"
      ? "synthetic-known-backend-token"
      : 'synthetic-"backend\\token"';
  const payloads = [];
  let reads = 0;
  const fence = { request_id: "synthetic-request", lease_generation: 7 };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (req.url === "/v1/chat/completions") {
      payloads.push(body);
      const delta =
        payloads.length === 1
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "read1",
                  type: "function",
                  function: { name: "coach_list_activities", arguments: "{}" },
                },
              ],
            }
          : { role: "assistant", content: "Done" };
      res.setHeader("Content-Type", "text/event-stream");
      res.end(
        `data: ${JSON.stringify({ id: "synthetic", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "synthetic", choices: [{ index: 0, delta: {}, finish_reason: payloads.length === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    let result;
    if (body.method === "tools/list")
      result = {
        tools: [
          { name: "coach_get_capabilities" },
          {
            name: "coach_list_activities",
            inputSchema: {
              type: "object",
              properties: {
                request_id: { type: "string" },
                lease_generation: { type: "integer" },
              },
              required: ["request_id", "lease_generation"],
              additionalProperties: false,
            },
          },
        ],
      };
    else if (body.params.name === "coach_get_capabilities")
      result = {
        structuredContent: {
          contract_version: 2,
          allowed_tools: ["coach_list_activities"],
          domains: {},
        },
      };
    else {
      assert.deepEqual(body.params.arguments, fence);
      reads++;
      const value = { rows: [{ [token]: "innocuous value" }] };
      result =
        mode === "escaped-json-key"
          ? { content: [{ type: "text", text: JSON.stringify(value) }] }
          : { structuredContent: value };
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const signal = AbortSignal.timeout(5000);
    const provider = {
      baseUrl: origin + "/v1",
      model: mode === "outbound-body" ? token : "synthetic",
      apiKey: "synthetic-provider-key",
      secrets: [token],
    };
    const tools = (
      await discoverReads(new Client(origin, token, signal), fence, {
        vision: false,
        secrets: [token, provider.apiKey],
      })
    ).tools;
    if (mode === "outbound-body") {
      await assert.rejects(complete(provider, "Coach", "Read", signal, tools));
      assert.equal(payloads.length, 0);
      assert.equal(reads, 0);
    } else {
      assert.equal(
        await complete(provider, "Coach", "Read", signal, tools),
        "Done",
      );
      assert.equal(payloads.length, 2);
      assert.equal(reads, 1);
      assert.equal(
        payloads[1].messages.find((m) => m.role === "tool").content,
        "Read unavailable within the authorized scope. Do not change authorization or infer inaccessible records; state what remains unverified.",
      );
    }
    // Independent of the production secret checker: inspect raw/escaped bytes
    // and the exact provider-visible tool text above, not just a rejected call.
    const serialized = JSON.stringify(payloads);
    const leaked =
      serialized.includes(token) ||
      serialized.includes(JSON.stringify(token).slice(1, -1));
    assert.equal(leaked, false);
    receipts.push({
      mode,
      providerCalls: payloads.length,
      backendReads: reads,
      backendCredentialLeakedToProvider: leaked,
    });
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
console.log(
  JSON.stringify({
    proof:
      "packed real Pi; synthetic loopback MCP/provider; bounded reviewer rerun",
    cases: receipts,
    cleanup: "all owned servers closed",
  }),
);
