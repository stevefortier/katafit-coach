import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { Store } from "../../src/config/store.js";
import { admin } from "../../src/server/admin.js";
import { AutoUpdateSetting } from "../../src/update/auto.js";
import { Updates } from "../../src/update/updates.js";

// Studio preview is an isolated, read-only inference over the saved revision.
// It must never stop, start or restart the worker or close native sessions,
// on success, failure, cancellation or connection loss.
export const PREVIEW = "Synthetic PREVIEW-QUESTION";
export const held = () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  return { started, gate, entered, release };
};
export const bounded = <T>(promise: Promise<T>, label: string, ms = 5000) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(label + " timeout")), ms);
      t.unref();
    }),
  ]);
export const aborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new Error("CANCELLED"));
    signal.addEventListener("abort", () => reject(new Error("CANCELLED")), {
      once: true,
    });
  });

type Infer = NonNullable<Parameters<typeof admin>[2]>;
export async function harness(
  preview: (signal: AbortSignal, provider: any) => Promise<string>,
  options: { updates?: Updates; auto?: boolean } = {},
) {
  let request: any = null;
  let publications = 0;
  const calls: string[] = [];
  const native = { hold: false, ...held() };
  // Optionally hold one backend tool call to keep an admin operation busy.
  const backendHold = { name: "", ...held() };
  // Opt-in worker presence, so Worker.stop awaits a backend stop report.
  const presence = { enabled: false };
  const backend = createServer(async (req, res) => {
    if (req.method === "GET")
      return void res.end(
        "# Kata.fit external Coach agent v1\nUse server-authorized context.",
      );
    let raw = "";
    for await (const part of req) raw += part;
    const msg = JSON.parse(raw);
    const name = msg.params?.name;
    calls.push(name ?? msg.method);
    if (name && name === backendHold.name) {
      backendHold.entered();
      await backendHold.gate;
    }
    if (msg.method === "notifications/initialized")
      return void res.writeHead(202).end();
    let value: any = {};
    if (msg.method === "initialize") value = { protocolVersion: "2025-03-26" };
    else if (msg.method === "tools/list")
      value = {
        tools: [
          { name: "coach_list_requests", inputSchema: { type: "object" } },
          { name: "studio_operator_open_session" },
          { name: "studio_operator_close_session" },
          { name: "studio_operator_list_members" },
          ...(presence.enabled
            ? [{ name: "coach_report_worker_presence" }]
            : []),
        ],
      };
    else if (name === "coach_report_worker_presence")
      value = {
        state: msg.params.arguments.state,
        generation: "0123456789abcdef0123456789abcdef",
      };
    else if (name === "studio_operator_open_session") {
      if (native.hold) {
        native.entered();
        await native.gate;
      }
      value = {
        schema_version: 1,
        mode: "dojo_operator",
        session_id: "native-preview-session",
        status: "active",
        expires_at: new Date(Date.now() + 600000).toISOString(),
        allowed_tools: ["studio_operator_list_members"],
      };
    } else if (name === "studio_operator_close_session")
      value = {
        schema_version: 1,
        session_id: "native-preview-session",
        status: "closed",
      };
    else if (name === "coach_list_requests")
      value = { requests: request ? [request] : [] };
    else if (name === "coach_claim_request") {
      if (request?.status === "queued") {
        request = {
          ...request,
          status: "claimed",
          lease_generation: request.lease_generation + 1,
          lease_expires_at: new Date(Date.now() + 120000).toISOString(),
        };
        value = { request };
      } else value = { request: null };
    } else if (name === "coach_start_request") {
      request.status = "working";
      value = { request };
    } else if (name === "coach_read_context")
      value = { request, conversation: [], authorized_member_data: [] };
    else if (name === "coach_respond") {
      if (request.status !== "completed") {
        publications++;
        request.status = "completed";
        request.reply = { text: msg.params.arguments.text };
      }
      value = { request };
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: ["initialize", "tools/list"].includes(msg.method)
          ? value
          : { structuredContent: value },
      }),
    );
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(backend.address() as any).port}`;
  const dir = await mkdtemp(tmpdir() + "/preview-nondisruptive-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin,
    provider: { baseUrl: origin + "/v1", model: "synthetic-model" },
    token: "synthetic-preview-backend-token",
    apiKey: "synthetic-preview-provider-key",
  });
  // The live worker's inference is held open so a restart, stop or abort
  // caused by preview would be observable as an aborted signal.
  const work = { signals: [] as AbortSignal[], ...held() };
  const infer: Infer = async (provider, _system, context, signal) => {
    if (JSON.stringify(context).includes("PREVIEW-QUESTION"))
      return preview(signal, provider);
    work.signals.push(signal);
    work.entered();
    await Promise.race([work.gate, aborted(signal)]);
    return "Synthetic worker reply";
  };
  const app = await admin(
    store,
    0,
    infer,
    undefined,
    options.updates,
    options.auto ? new AutoUpdateSetting(dir) : undefined,
  );
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  const post = (path: string, body: unknown = {}, signal?: AbortSignal) =>
    fetch(app.origin + "/api/" + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  const status = async () =>
    (await (
      await fetch(app.origin + "/api/status", { headers })
    ).json()) as any;
  const sockets: WebSocket[] = [];
  return {
    store,
    app,
    post,
    status,
    work,
    native,
    backendHold,
    presence,
    calls,
    get publications() {
      return publications;
    },
    enqueue(text: string) {
      request = {
        id: "preview-live-request",
        text,
        requester_id: "member",
        scope: "dojo",
        attachment_count: 0,
        lease_generation: 0,
        status: "queued",
        timeout_at: new Date(Date.now() + 180000).toISOString(),
      };
    },
    async connectNative() {
      const ticket = (await (await post("terminal/ticket")).json()) as any;
      const ws = new WebSocket(
        app.origin.replace("http:", "ws:") + "/api/terminal/ws",
        { origin: app.origin },
      );
      sockets.push(ws);
      const closed = new Promise<number>((r) => ws.once("close", r));
      await new Promise<void>((r, j) => {
        ws.once("open", r);
        ws.once("error", j);
      });
      ws.send(JSON.stringify({ ticket: ticket.ticket }));
      return { ws, closed };
    },
    async close() {
      native.release();
      work.release();
      backendHold.release();
      for (const ws of sockets) ws.terminate();
      await bounded(app.close(), "admin close", 10000);
      backend.closeAllConnections();
      await new Promise<void>((r) => backend.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
