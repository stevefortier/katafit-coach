import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { Store } from "../../src/config/store.js";
export async function fixture(
  transform?: (name: string, result: any, body: any) => any,
) {
  const calls: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    calls.push({ path: req.url, auth: req.headers.authorization, body });
    if (req.url === "/v1/chat/completions") {
      res.setHeader("content-type", "text/event-stream");
      const override = await transform?.("provider", undefined, body);
      if (typeof override === "string") {
        res.end(override);
        return;
      }
      const read = body.messages.find(
        (m: any) => m.role === "tool" && m.content.includes("Synthetic Alice"),
      );
      const delta = read
        ? { content: "Authorized roster contains Synthetic Alice." }
        : {
            tool_calls: [
              {
                index: 0,
                id: "call_fixture",
                type: "function",
                function: {
                  name: "studio_operator_list_members",
                  arguments: "{}",
                },
              },
            ],
          };
      res.end(
        `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: read ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    const name = body.params?.name;
    let result: any = {};
    if (body.method === "initialize")
      result = { protocolVersion: "2025-03-26" };
    if (body.method === "tools/list")
      result = {
        tools: [
          "studio_operator_open_session",
          "studio_operator_close_session",
          "studio_operator_list_members",
        ].map((name) => ({ name })),
      };
    if (name === "studio_operator_open_session")
      result = {
        schema_version: 1,
        mode: "dojo_operator",
        session_id: "native-fixture-session",
        status: "active",
        expires_at: new Date(Date.now() + 600000).toISOString(),
        allowed_tools: ["studio_operator_list_members"],
      };
    if (name === "studio_operator_list_members")
      result = {
        schema_version: 1,
        members: [
          { member_ref: "fixture-member", display_name: "Synthetic Alice" },
        ],
        has_more: false,
        next_cursor: null,
      };
    if (name === "studio_operator_close_session")
      result = {
        schema_version: 1,
        session_id: "native-fixture-session",
        status: "closed",
      };
    result = (await transform?.(name ?? body.method, result, body)) ?? result;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result:
          body.method === "tools/call" ? { structuredContent: result } : result,
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const dir = await mkdtemp(tmpdir() + "/native-gateway-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin,
    provider: { baseUrl: origin + "/v1", model: "approved-custom-model" },
    token: "synthetic-backend-credential",
    apiKey: "synthetic-provider-credential",
  });
  return {
    store,
    calls,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
