import { WebSocket } from "ws";
import { admin } from "../../src/server/admin.js";
import { NativeTerminal } from "../../src/server/terminal.js";
import { AttachmentFailure } from "../../src/sandbox/attachments.js";
import { continuityFixture } from "./continuity.js";

// Real admin server, ticketed WebSocket, gateway and synthetic continuity
// backend; only the Docker runtime is replaced by an in-memory stand-in whose
// workspace reader returns fixed bytes. Actual Docker Pi is covered by the
// NATIVE_DOCKER_TEST attachment tests.
export async function attachmentHarness(
  options: Parameters<typeof continuityFixture>[0] = {},
) {
  const f = await continuityFixture({ images: true, ...options });
  const files = new Map<string, Buffer>();
  const runtimes: any[] = [];
  const proto: any = NativeTerminal.prototype;
  const original = {
    createRuntime: proto.createRuntime,
    resolveImage: proto.resolveImage,
  };
  proto.resolveImage = async () => "sha256:" + "b".repeat(64);
  proto.createRuntime = () => {
    const runtime: any = {
      cleanupPending: false,
      onOutput: () => {},
      onExit: () => {},
      stopped: 0,
      async start(gateway: any) {
        runtime.gateway = gateway;
      },
      async attach() {
        runtime.onOutput("synthetic pi ready\r\n");
      },
      input() {},
      async resize() {},
      async stop() {
        runtime.stopped++;
      },
      async readWorkspaceFile(parts: string[]) {
        const value = files.get(parts.join("/"));
        if (!value) throw new AttachmentFailure("ATTACHMENT_FILE_NOT_FOUND");
        return value;
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
  let app: Awaited<ReturnType<typeof admin>>;
  try {
    app = await admin(f.store, 0);
  } catch (error) {
    Object.assign(proto, original);
    await f.close();
    throw error;
  }
  const headers = {
    Authorization: "Bearer " + f.store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  const sockets: WebSocket[] = [];
  const connect = async () => {
    const ticket = (await (
      await fetch(app.origin + "/api/terminal/ticket", {
        method: "POST",
        headers,
        body: "{}",
      })
    ).json()) as any;
    const ws = new WebSocket(app.origin.replace("http:", "ws:") + ticket.path, {
      origin: app.origin,
    });
    sockets.push(ws);
    const frames: any[] = [];
    let closeCode: number | undefined;
    ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
    ws.on("close", (code) => (closeCode = code));
    await new Promise<void>((r, j) => {
      ws.once("open", r);
      ws.once("error", j);
    });
    ws.send(JSON.stringify({ ticket: ticket.ticket }));
    const until = async (predicate: () => boolean, label: string) => {
      const deadline = Date.now() + 5000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error("timeout: " + label);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    await until(() => frames.some((m) => m.type === "attachments"), "snapshot");
    return { ws, frames, until, closed: () => closeCode };
  };
  const get = (path: string, auth = true) =>
    fetch(app.origin + path, {
      headers: auth ? { Authorization: headers.Authorization } : {},
    });
  const send = (args: any) =>
    runtimes.at(-1).gateway.handle({
      kind: "tool",
      name: "send_to_operator",
      args,
    });
  return {
    f,
    app: app!,
    files,
    runtimes,
    connect,
    get,
    send,
    headers,
    close: async () => {
      for (const ws of sockets) ws.terminate();
      await app!.close();
      Object.assign(proto, original);
      (NativeTerminal as any).attachmentFreshnessMs = 30000;
      await f.close();
    },
  };
}
