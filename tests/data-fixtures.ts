import { createServer } from "node:http";
export const fence = { request_id: "synthetic-request", lease_generation: 7 };
export const schema = {
  type: "object",
  properties: {
    request_id: { type: "string" },
    lease_generation: { type: "integer" },
    limit: { type: "integer", minimum: 1, maximum: 100 },
  },
  required: ["request_id", "lease_generation"],
  additionalProperties: false,
};
export async function wire(handler: (method: string, params: any) => any) {
  const calls: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const m = JSON.parse(raw);
    calls.push(m);
    const result = await handler(m.method, m.params);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    calls,
    origin: `http://127.0.0.1:${(server.address() as any).port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
export async function readFixture(
  result: any = {
    structuredContent: { activities: [{ type: "run" }], has_more: false },
  },
  extra: any = {},
) {
  return wire((method, p) =>
    method === "tools/list"
      ? {
          tools: [
            { name: "coach_get_capabilities", inputSchema: schema },
            {
              name: "coach_list_activities",
              description: "List authorized activities",
              inputSchema: schema,
            },
            {
              name: "coach_read_media",
              inputSchema: {
                ...schema,
                properties: {
                  ...schema.properties,
                  media_ref: { type: "string" },
                },
              },
            },
            { name: "coach_respond", inputSchema: schema },
          ],
        }
      : p.name === "coach_get_capabilities"
        ? {
            structuredContent: {
              contract_version: 2,
              allowed_tools: [
                "coach_list_activities",
                "coach_respond",
                "coach_read_media",
              ],
              domains: {},
              limits: {},
              ...extra,
            },
          }
        : result,
  );
}
