import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../../src/config/store.js";
import { openNativeGateway } from "../../src/sandbox/gateway.js";
import { startRelay, piTurn, providerStub } from "./native-relay.js";
import {
  startAccountMemoryBackend,
  type AccountMemoryBackend,
} from "./account-memory-backend.js";

// Real relay process + actual pi-ai OpenAI-completions client + host gateway +
// contract-faithful synthetic account backend. Inference is synthetic.
export async function memoryFixture(
  options: { backend?: AccountMemoryBackend } = {},
) {
  const backend = options.backend ?? (await startAccountMemoryBackend());
  const provider = await providerStub();
  const dir = await mkdtemp(tmpdir() + "/native-account-memory-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: backend.origin,
    provider: {
      baseUrl: provider.origin + "/v1",
      model: "synthetic-memory-model",
    },
    token: backend.token,
    apiKey: "synthetic-provider-secret",
  });
  const notices: any[] = [];
  const gateway = await openNativeGateway(store, undefined, {
    memory: { notice: (event) => notices.push(event) },
  });
  const relay = await startRelay(gateway);
  return {
    backend,
    provider,
    store,
    gateway,
    relay,
    notices,
    turn: (messages: any[]) =>
      piTurn(relay, "synthetic-memory-model", messages),
    async close() {
      await relay.close();
      await gateway.close();
      await provider.close();
      await backend.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
export const systems = (body: any) =>
  body.messages.filter((m: any) => ["system", "developer"].includes(m.role));

/** Synthetic OpenAI-compatible SSE text answer. */
export const sseText = (text: string) =>
  `data: ${JSON.stringify({ id: "memory", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "memory", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
export const isExtraction = (body: any) =>
  JSON.stringify(body.messages?.[0] ?? {}).includes(
    "You maintain the long-term memory",
  );
/** Route extraction requests to `proposals`; chat gets `reply`. */
export function scriptProvider(
  f: Awaited<ReturnType<typeof memoryFixture>>,
  options: {
    proposals?: () => unknown;
    reply?: (body: any) => string;
  },
) {
  f.provider.reply = (body: any) => {
    if (isExtraction(body)) {
      const value = options.proposals?.();
      if (value === "fail") return { status: 500, body: "{}" };
      return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: sseText(JSON.stringify(value ?? { proposals: [] })),
      };
    }
    const text = options.reply?.(body);
    return text === undefined
      ? undefined
      : {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: text,
        };
  };
}
export async function until<T>(
  read: () => T | undefined,
  ms = 8000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}
export const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
