import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { Store } from "../../src/config/store.js";
/** Synthetic agent session the backend would mint (see regimen#1140). */
export const AGENT_TOKEN = `rgn_agent_${"a".repeat(24)}_${"b".repeat(43)}`;
export const agentSession = () => ({
  id: "a".repeat(24),
  token: AGENT_TOKEN,
  expires_at: new Date(Date.now() + 4 * 3600e3).toISOString(),
});
/** Wraps a synthetic backend so it answers the gateway's agent-session calls. */
export function withAgentSessions(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => unknown,
) {
  return async (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => {
    if (req.url?.startsWith("/api/coach/agent-sessions")) {
      for await (const _ of req);
      if (req.method === "DELETE") return void res.writeHead(204).end();
      res.writeHead(201, { "content-type": "application/json" });
      return void res.end(JSON.stringify(agentSession()));
    }
    return handler(req, res);
  };
}
/** The same for a stubbed global fetch. */
export function withAgentSessionFetch(stub: typeof fetch): typeof fetch {
  return (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (new URL(url).pathname.startsWith("/api/coach/agent-sessions"))
      return (init?.method ?? "GET") === "DELETE"
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(agentSession()), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
    return stub(input, init);
  }) as typeof fetch;
}
export async function fixture(
  transform?: (name: string, result: any, body: any) => any,
  get?: (
    url: string,
    headers: import("node:http").IncomingHttpHeaders,
  ) => {
    status?: number;
    type?: string;
    body?: Buffer | string;
    location?: string;
  },
) {
  const calls: any[] = [];
  const server = createServer(
    withAgentSessions(async (req, res) => {
      if (req.method === "GET") {
        calls.push({
          path: req.url,
          auth: req.headers.authorization,
          headers: req.headers,
          method: req.method,
        });
        const reply = get?.(req.url!, req.headers) ?? { status: 404 };
        res.writeHead(reply.status ?? 200, {
          "content-type": reply.type ?? "application/json",
          ...(reply.location ? { location: reply.location } : {}),
        });
        res.end(reply.body ?? "");
        return;
      }
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
          (m: any) =>
            m.role === "tool" && m.content.includes("Synthetic Alice"),
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
            body.method === "tools/call" && !result?.isError
              ? { structuredContent: result }
              : result,
        }),
      );
    }),
  );
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
  if (process.env.NATIVE_DOCKER_TEST === "1" && process.env.NATIVE_TEST_IMAGE) {
    try {
      const { provisionArtifact } = await import(
        "../../src/sandbox/artifact.js"
      );
      await provisionArtifact(
        dir,
        process.env.COACH_PACKAGED_ROOT ?? process.cwd(),
        process.env.NATIVE_TEST_IMAGE,
      );
    } catch (error) {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }
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
