import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../../src/config/store.js";
import { openNativeGateway } from "../../src/sandbox/gateway.js";
import { memberBackend } from "./member-backend.js";

export const OWNER = "64b7f0c2a1b2c3d4e5f60718";
export const ALICE = "64b7f0c2a1b2c3d4e5f60799";
export const MODEL = "approved-custom-model";
export const TOKEN = "synthetic-backend-credential";

type Call = { id: string; name?: string; args: unknown };
/**
 * Realistic OpenAI-compatible streamed tool selection: the id/name arrive in
 * the first delta and the JSON arguments are split across chunks.
 */
export function sse(
  calls: Call[],
  finish: string | null = "tool_calls",
  { done = true }: { done?: boolean } = {},
) {
  const chunk = (delta: unknown, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({ id: "synthetic-selection", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  let out = "";
  calls.forEach((call, index) => {
    const args =
      typeof call.args === "string" ? call.args : JSON.stringify(call.args);
    const cut = Math.floor(args.length / 2);
    out += chunk({
      tool_calls: [
        {
          index,
          id: call.id,
          type: "function",
          function: {
            name: call.name ?? "katafit_rest_request",
            arguments: args.slice(0, cut),
          },
        },
      ],
    });
    out += chunk({
      tool_calls: [{ index, function: { arguments: args.slice(cut) } }],
    });
  });
  if (finish !== null) out += chunk({}, finish);
  return out + (done ? "data: [DONE]\n\n" : "");
}
export const sendArgs = (
  text: string,
  path = `/api/coach/member-messages/${ALICE}`,
) => ({
  method: "POST",
  path,
  body: { text },
});

/** Loopback backend + synthetic provider + store for native send tests. */
export async function nativeSendHarness(
  accounts: Record<string, string> = { [TOKEN]: OWNER },
) {
  const backend = await memberBackend(accounts);
  const bodies: any[] = [];
  let reply: (body: any) => {
    status?: number;
    type?: string;
    body: string;
  } = () => ({ body: sse([]) });
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    bodies.push(body);
    const answer = reply(body);
    res.writeHead(answer.status ?? 200, {
      "content-type": answer.type ?? "text/event-stream",
    });
    res.end(answer.body);
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const dir = await mkdtemp(tmpdir() + "/native-member-send-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: backend.origin,
    token: Object.keys(accounts)[0],
    provider: {
      baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
      model: MODEL,
    },
    apiKey: "synthetic-provider-credential",
  });
  const gateways: { close(): Promise<void> }[] = [];
  return {
    backend,
    store,
    bodies,
    set reply(fn: typeof reply) {
      reply = fn;
    },
    async open() {
      const gateway = await openNativeGateway(store);
      gateways.push(gateway);
      return gateway;
    },
    /** One completed provider selection observed by the host gateway. */
    select(
      gateway: Awaited<ReturnType<typeof openNativeGateway>>,
      calls: Call[],
      finish: string | null = "tool_calls",
    ) {
      reply = () => ({ body: sse(calls, finish) });
      return gateway.handle({
        kind: "provider",
        body: {
          model: MODEL,
          stream: true,
          messages: [{ role: "user", content: "Send the synthetic message." }],
        },
      });
    },
    call(
      gateway: Awaited<ReturnType<typeof openNativeGateway>>,
      toolCallId: string | undefined,
      args: unknown,
    ) {
      return gateway.handle({
        kind: "tool",
        name: "katafit_rest_request",
        args,
        ...(toolCallId === undefined ? {} : { toolCallId }),
      });
    },
    async close() {
      for (const gateway of gateways) await gateway.close().catch(() => {});
      provider.closeAllConnections();
      await new Promise<void>((r) => provider.close(() => r()));
      await backend.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
