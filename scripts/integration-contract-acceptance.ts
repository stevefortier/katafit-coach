/** Executable required-capability RED against the fixed paired backend.
 * Not a fake connector manifest: hosted discovery first calls a live local MCP.
 * This script is deliberately not part of GREEN suites until the backend
 * supplies an external-credential integration catalog/dispatch contract.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { startTaskBackend } from "../tests/helpers/task-backend.js";
import { Client } from "../src/katafit/client.js";

if (process.env.COACH_REQUIRE_BACKEND !== "1")
  throw new Error("COACH_REQUIRE_BACKEND=1 required");
const root = process.env.COACH_BACKEND_ROOT;
if (!root || root !== process.env.KATAFIT_MEMORY_BACKEND)
  throw new Error("Exact paired backend roots required");
let integrationCalls = 0;
const server = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405);
    return void res.end();
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const rpc = JSON.parse(Buffer.concat(chunks).toString());
  res.setHeader("content-type", "application/json");
  if (rpc.id === undefined) {
    res.writeHead(202);
    return void res.end();
  }
  let result: unknown;
  if (rpc.method === "initialize")
    result = {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "Synthetic configured calendar", version: "1" },
    };
  else if (rpc.method === "tools/list")
    result = {
      tools: [
        {
          name: "availability",
          description: "Synthetic weekly availability",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };
  else if (rpc.method === "tools/call") {
    integrationCalls++;
    result = {
      content: [
        { type: "text", text: "Synthetic Tuesday afternoon available" },
      ],
    };
  } else {
    res.writeHead(400);
    return void res.end();
  }
  res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as any).port;
let b: Awaited<ReturnType<typeof startTaskBackend>> | undefined;
let hosted: any;
try {
  b = await startTaskBackend();
  const require = createRequire(join(root, "package.json"));
  const { encryptSecret } = require("./core/userMcpServers");
  await b.db.collection("users").updateOne(
    { _id: b.user },
    {
      $set: {
        user_mcp_servers: [
          {
            id: "configuredcalendar",
            name: "Synthetic configured calendar",
            url: `http://127.0.0.1:${port}/mcp`,
            transport: "streamable_http",
            headers_encrypted: encryptSecret({}),
          },
        ],
      },
    },
  );
  hosted = require("./core/agentService");
  const name = "custom_mcp__configuredcalendar__availability";
  const configured = await hosted.getToolDefinitionsForUser(String(b.user));
  assert.ok(
    configured.some((t: any) => t.function.name === name),
    "Live hosted discovery must succeed before comparing external parity",
  );
  const result = await hosted.executeTool(name, {}, String(b.user));
  assert.equal(result.success, true);
  assert.equal(
    integrationCalls,
    1,
    "Representative configured integration actually executed under hosted authority",
  );
  const external = await new Client(
    b.origin,
    await b.credential(true),
    AbortSignal.timeout(10000),
  ).rpc("tools/list", {});
  console.log(
    JSON.stringify({
      backend: "3e4b9bccc4bb17eb0ee2a4b4b84791d0138eeff0",
      hostedTool: name,
      hostedExecuted: integrationCalls,
      externalTools: external.tools.map((t: any) => t.name),
      missingContract:
        "External credential discovery and request-scoped execution of configured supported integration tools, including current backend authorization and durable occurrence/unknown-write semantics.",
    }),
  );
  assert.ok(
    external.tools.some((t: any) => t.name === name),
    "BLOCKED: fixed backend external tools/list omits a verified live configured supported integration; connector metadata is not callable parity",
  );
} finally {
  await b?.close();
  await new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
