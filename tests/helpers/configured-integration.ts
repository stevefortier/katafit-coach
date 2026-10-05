import { createServer } from "node:http";
import { closeServer } from "./account-backend.js";
import type { startTaskBackend } from "./task-backend.js";

export async function configuredRemote(
  b: NonNullable<Awaited<ReturnType<typeof startTaskBackend>>>,
) {
  const calls: any[] = [];
  let mode = "ok";
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405);
      return res.end();
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const rpc = JSON.parse(raw);
    res.setHeader("content-type", "application/json");
    if (rpc.id === undefined) {
      res.writeHead(202);
      return res.end();
    }
    let result: any;
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
            description: "Synthetic calendar operation",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              additionalProperties: false,
            },
            annotations: { readOnlyHint: true },
          },
        ],
      };
    else if (rpc.method === "tools/call") {
      calls.push(rpc.params);
      if (mode === "lost") {
        req.socket.destroy();
        return;
      }
      result = {
        content: [
          {
            type: "text",
            text:
              mode === "secret"
                ? req.headers["x-api-key"]
                : "Synthetic Tuesday available: " + rpc.params.arguments.value,
          },
        ],
      };
    } else {
      res.writeHead(405);
      return res.end();
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { encryptSecret } = b.backendModule("./core/userMcpServers");
  const registration = {
    id: "configuredcalendar",
    url: `http://127.0.0.1:${(server.address() as any).port}/mcp`,
    transport: "streamable_http",
    headers_encrypted: encryptSecret({
      "x-api-key": "synthetic-upstream-private-secret",
    }),
  };
  await b.db
    .collection("users")
    .updateOne({ _id: b.user }, { $set: { user_mcp_servers: [registration] } });
  return {
    calls,
    registration,
    setMode: (value: string) => {
      mode = value;
    },
    async close() {
      await b.backendModule("./core/agentService").closeRemoteMcpContexts?.();
      await closeServer(server);
    },
  };
}
