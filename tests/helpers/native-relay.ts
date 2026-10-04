// Host-side harness for the actual sandbox relay: the real relay.mjs runs as a
// child process wired to the real NativeRuntime JSON-line framing and a real
// (or stub) gateway. Docker is not involved; everything is synthetic.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { NativeRuntime } from "../../src/sandbox/runtime.js";
import type { NativeGateway } from "../../src/sandbox/gateway.js";

const sandbox = fileURLToPath(new URL("../../sandbox/", import.meta.url));

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

export async function startRelay(gateway: NativeGateway) {
  const root = await mkdtemp(tmpdir() + "/native-relay-");
  await mkdir(root + "/home");
  await mkdir(root + "/tmp");
  const port = await freePort();
  const original = childProcess.spawn;
  let relay: childProcess.ChildProcessWithoutNullStreams | undefined;
  const frames = { toHost: 0, toRelay: 0 };
  (childProcess as any).spawn = (
    _file: string,
    _args: string[],
    options: any,
  ) =>
    (relay = original(process.execPath, [sandbox + "relay.mjs"], {
      ...options,
      env: {
        PATH: process.env.PATH,
        HOME: root + "/home",
        TMPDIR: root + "/tmp",
        KATAFIT_RELAY_PORT: String(port),
      },
    }));
  syncBuiltinESMExports();
  const runtime: any = new NativeRuntime("unused");
  let stops = 0;
  runtime.created = true;
  runtime.gateway = {
    handle: (request: any, signal?: AbortSignal) => {
      frames.toHost++;
      return gateway.handle(request, signal);
    },
    close: () => gateway.close(),
    confirmDelivery: (id: string) => gateway.confirmDelivery?.(id),
  };
  runtime.api = async () => {};
  runtime.stop = async () => {
    stops++;
    relay?.kill();
  };
  try {
    await runtime.attach();
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
  }
  const write = relay!.stdin.write.bind(relay!.stdin);
  relay!.stdin.write = ((chunk: any, ...rest: any[]) => {
    frames.toRelay++;
    return (write as any)(chunk, ...rest);
  }) as any;
  const deadline = Date.now() + 10000;
  let models: any;
  for (;;) {
    try {
      models = JSON.parse(
        await readFile(root + "/home/.pi/agent/models.json", "utf8"),
      );
      break;
    } catch {
      if (Date.now() > deadline || relay!.exitCode !== null)
        throw new Error("relay did not start");
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  return {
    port,
    root,
    base: `http://127.0.0.1:${port}`,
    models,
    frames,
    stops: () => stops,
    alive: () => relay!.exitCode === null && !relay!.killed,
    async close() {
      relay?.kill();
      await rm(root, { recursive: true, force: true });
    },
  };
}
export type Relay = Awaited<ReturnType<typeof startRelay>>;

/** Load the actual Pi extension against this relay and return its tools. */
export async function loadExtension(relay: Relay) {
  const saved = {
    TMPDIR: process.env.TMPDIR,
    KATAFIT_RELAY_PORT: process.env.KATAFIT_RELAY_PORT,
  };
  process.env.TMPDIR = relay.root + "/tmp";
  process.env.KATAFIT_RELAY_PORT = String(relay.port);
  const tools = new Map<string, any>();
  try {
    const module = await import(
      pathToFileURL(sandbox + "katafit.mjs").href +
        "?relay=" +
        relay.port +
        "-" +
        Date.now()
    );
    module.default({
      registerTool: (tool: any) => tools.set(tool.name, tool),
      registerCommand: () => {},
    });
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
  // The extension resolves its relay port at import; restore env per call.
  return {
    tools,
    async call(name: string, args: any, signal?: AbortSignal) {
      const tool = tools.get(name);
      if (!tool) throw new Error("tool not registered: " + name);
      return tool.execute("call-" + name, args, signal);
    },
  };
}

export function model(relay: Relay, id: string) {
  return {
    id,
    name: id,
    provider: "katafit",
    api: "openai-completions" as const,
    baseUrl: relay.base + "/v1",
    reasoning: false,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

/** Drive the actual pi-ai OpenAI-completions client (the Pi UI protocol). */
export async function piTurn(relay: Relay, id: string, messages: any[]) {
  return streamSimple(
    model(relay, id) as any,
    { systemPrompt: "Synthetic native system prompt.", messages },
    { apiKey: "runtime-only", maxRetries: 0 } as any,
  ).result();
}

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
/** The Pi transcript shape after an image tool call returned `images`. */
export function imageTranscript(
  images: { data: string; mimeType: string }[],
  prompt = "What do you think of Steve's latest pictures?",
) {
  return [
    { role: "user", content: prompt, timestamp: 1 },
    {
      role: "assistant",
      content: images.map((_, i) => ({
        type: "toolCall",
        id: "call_image_" + i,
        name: "studio_operator_read_dojo_checkin_image",
        arguments: { member_ref: "member-photo", media_ref: "media-" + i },
      })),
      api: "openai-completions",
      provider: "katafit",
      model: "synthetic",
      usage,
      stopReason: "toolUse",
      timestamp: 2,
    },
    ...images.map((image, i) => ({
      role: "toolResult",
      toolCallId: "call_image_" + i,
      toolName: "studio_operator_read_dojo_checkin_image",
      content: [
        { type: "text", text: '{"representation":"original"}' },
        { type: "image", data: image.data, mimeType: image.mimeType },
      ],
      isError: false,
      timestamp: 3 + i,
    })),
  ];
}
export function assistantText(text: string, timestamp: number) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "katafit",
    model: "synthetic",
    usage,
    stopReason: "stop",
    timestamp,
  };
}

type Reply =
  | { status: number; body?: string; headers?: Record<string, string> }
  | "destroy"
  | undefined;
/** Synthetic upstream provider; records complete parsed request bodies. */
export async function providerStub() {
  const bodies: any[] = [];
  let reply: (body: any) => Reply | Promise<Reply> = () => undefined;
  const server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    bodies.push(body);
    const override = await reply(body);
    if (override === "destroy") {
      req.socket.destroy();
      return;
    }
    if (override) {
      res.writeHead(override.status, {
        "content-type": "application/json",
        ...override.headers,
      });
      res.end(override.body ?? "");
      return;
    }
    const images = body.messages.flatMap((m: any) =>
      Array.isArray(m.content)
        ? m.content.filter((p: any) => p?.type === "image_url")
        : [],
    ).length;
    res.setHeader("content-type", "text/event-stream");
    const chunk = (delta: any, finish: string | null) =>
      `data: ${JSON.stringify({ id: "stub", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.end(
      chunk({ content: `Synthetic review of ${images} photos.` }, null) +
        chunk({}, "stop") +
        "data: [DONE]\n\n",
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    origin: `http://127.0.0.1:${(server.address() as any).port}`,
    bodies,
    set reply(fn: (body: any) => Reply | Promise<Reply>) {
      reply = fn;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export const imageParts = (body: any) =>
  body.messages.flatMap((m: any) =>
    Array.isArray(m.content)
      ? m.content.filter((p: any) => p?.type === "image_url")
      : [],
  );
