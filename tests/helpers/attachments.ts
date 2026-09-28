import { WebSocket } from "ws";
import { admin } from "../../src/server/admin.js";
import { NativeTerminal } from "../../src/server/terminal.js";
import { AttachmentFailure } from "../../src/sandbox/attachments.js";
import assert from "node:assert/strict";
import { openNativeGateway } from "./legacy-gateway.js";
import { continuityFixture, CHECKINS, IMAGE } from "./continuity.js";

// Real admin server, ticketed WebSocket, gateway and synthetic continuity
// backend; only the Docker runtime is replaced by an in-memory stand-in whose
// workspace reader returns fixed bytes. Actual Docker Pi is covered by the
// NATIVE_DOCKER_TEST attachment tests.
export async function attachmentHarness(
  options: Parameters<typeof continuityFixture>[0] = {},
  makeFixture: typeof continuityFixture = continuityFixture,
) {
  const f = await makeFixture({ images: true, ...options });
  const files = new Map<string, Buffer>();
  const runtimes: any[] = [];
  const proto: any = NativeTerminal.prototype;
  const original = {
    createRuntime: proto.createRuntime,
    openGateway: proto.openGateway,
    resolveImage: proto.resolveImage,
  };
  proto.openGateway = openNativeGateway;
  proto.resolveImage = async () => "sha256:" + "b".repeat(64);
  const terminals = new Set<any>();
  proto.createRuntime = function (this: any) {
    terminals.add(this);
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
  const connect = async (waitForSnapshot = true) => {
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
    if (waitForSnapshot)
      await until(
        () => frames.some((m) => m.type === "attachments"),
        "snapshot",
      );
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
    /** Abruptly drops the server side of the admitted socket (browser sees 1006). */
    dropSocket: () => {
      for (const terminal of terminals) terminal.ws?.terminate();
    },
    connect,
    get,
    send,
    headers,
    close: async () => {
      for (const ws of sockets) ws.terminate();
      await app!.close();
      Object.assign(proto, original);
      await f.close();
    },
  };
}

// Gateway with a host attachment owner over the synthetic continuity backend.
export async function gatewayHarness(
  options: Parameters<typeof continuityFixture>[0] = {},
  hooks: Record<string, any> = {},
  beforeOpen?: (f: Awaited<ReturnType<typeof continuityFixture>>) => unknown,
) {
  const f = await continuityFixture({ images: true, ...options });
  const files = new Map<string, Buffer | Error>();
  const reads: string[][] = [];
  const published: any[] = [];
  const terminated: string[] = [];
  let gateway: Awaited<ReturnType<typeof openNativeGateway>>;
  try {
    await beforeOpen?.(f);
    gateway = await openNativeGateway(f.store, undefined, {
      onTerminate: (reason) => terminated.push(reason),
      attachments: {
        read: async (parts: string[], limit: number) => {
          reads.push(parts);
          const value = files.get(parts.join("/"));
          if (value instanceof Error) throw value;
          if (!value) throw new AttachmentFailure("ATTACHMENT_FILE_NOT_FOUND");
          assert.equal(limit, 8 * 1024 * 1024);
          return value;
        },
        publish: (item: any) => {
          published.push(item);
          return true;
        },
      },
      ...hooks,
    });
  } catch (error) {
    await f.close();
    throw error;
  }
  const tool = (name: string, args: any) =>
    gateway.handle({ kind: "tool", name, args });
  const text = (result: any) => JSON.parse(result.content[0].text);
  const receipt = async () => {
    await tool(CHECKINS, {});
    const image = await tool(IMAGE, {
      member_ref: "fixture-member",
      media_ref: "media-1",
    });
    return text(image).image_receipt as string;
  };
  return {
    f,
    gateway: gateway!,
    files,
    reads,
    published,
    terminated,
    tool,
    text,
    receipt,
    close: async () => {
      await gateway!.close().catch(() => {});
      await f.close();
    },
  };
}
