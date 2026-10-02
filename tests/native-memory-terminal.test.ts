import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { NativeTerminal } from "../src/server/terminal.js";
import { providerStub } from "./helpers/native-relay.js";
import { startAccountMemoryBackend } from "./helpers/account-memory-backend.js";
import { sse as selection } from "./helpers/native-member-send.js";
import { isExtraction, sseText, until } from "./helpers/native-memory.js";

// Real admin server, ticketed WebSocket and host gateway over the synthetic
// account backend; only the Docker runtime is an in-memory stand-in.
async function harness() {
  const backend = await startAccountMemoryBackend();
  const provider = await providerStub();
  const dir = await mkdtemp(tmpdir() + "/native-memory-terminal-");
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
  const proto: any = NativeTerminal.prototype;
  const original = {
    createRuntime: proto.createRuntime,
    resolveImage: proto.resolveImage,
  };
  const runtimes: any[] = [];
  proto.resolveImage = async () => "sha256:" + "c".repeat(64);
  proto.createRuntime = function () {
    const runtime: any = {
      cleanupPending: false,
      onOutput: () => {},
      onExit: () => {},
      async start(gateway: any) {
        runtime.gateway = gateway;
      },
      async attach() {},
      input() {},
      async resize() {},
      async stop() {},
    };
    runtimes.push(runtime);
    return runtime;
  };
  const app = await admin(store, 0);
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  const sockets: WebSocket[] = [];
  const connect = async () => {
    const ticket: any = await (
      await fetch(app.origin + "/api/terminal/ticket", {
        method: "POST",
        headers,
        body: "{}",
      })
    ).json();
    const ws = new WebSocket(app.origin.replace("http:", "ws:") + ticket.path, {
      origin: app.origin,
    });
    sockets.push(ws);
    const frames: any[] = [];
    ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
    await new Promise<void>((r, j) => {
      ws.once("open", r);
      ws.once("error", j);
    });
    ws.send(JSON.stringify({ ticket: ticket.ticket }));
    await until(() => frames.some((m) => m.type === "ready"));
    return { ws, frames };
  };
  return {
    backend,
    provider,
    store,
    app,
    runtimes,
    connect,
    gateway: () => runtimes.at(-1).gateway,
    async close() {
      for (const ws of sockets) ws.terminate();
      await app.close();
      Object.assign(proto, original);
      await provider.close();
      await backend.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const turn = (gateway: any, content: string) =>
  gateway.handle({
    kind: "provider",
    body: {
      model: "synthetic-memory-model",
      stream: true,
      messages: [
        { role: "system", content: "Synthetic native system prompt." },
        { role: "user", content },
      ],
    },
  });

test("committed memory notices reach the Coach pane and are replayed once on reconnect", async () => {
  const h = await harness();
  try {
    const first = await h.connect();
    const args = {
      method: "POST",
      path: "/api/coach/memory",
      body: { kind: "preference", text: "Prefers short morning workouts." },
    };
    h.provider.reply = () => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: selection([{ id: "call_remember", args }]),
    });
    await turn(h.gateway(), "Remember I prefer short morning workouts.");
    await h.gateway().handle({
      kind: "tool",
      name: "katafit_rest_request",
      args,
      toolCallId: "call_remember",
    });
    const frame = await until(() =>
      first.frames.find((m) => m.type === "memory-notice"),
    );
    assert.equal(frame.notice.action, "remembered");
    assert.equal(frame.notice.items[0].text, "Prefers short morning workouts.");
    first.ws.terminate();
    const second = await h.connect();
    const replay = await until(() =>
      second.frames.find((m) => m.type === "memory-notices"),
    );
    assert.equal(replay.notices.length, 1);
    assert.equal(replay.learning_off, false);
  } finally {
    await h.close();
  }
});

test("the pane's Don't save this chat control turns learning off for this runtime only", async () => {
  const h = await harness();
  try {
    const socket = await h.connect();
    socket.ws.send(JSON.stringify({ type: "memory-capture", enabled: false }));
    const state = await until(() =>
      socket.frames.find(
        (m) => m.type === "memory-notice" && m.notice.action === "learning-off",
      ),
    );
    assert.match(state.notice.note, /off for this chat/);
    h.provider.reply = (body: any) => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: isExtraction(body)
        ? sseText(
            JSON.stringify({
              proposals: [
                {
                  kind: "preference",
                  text: "Prefers rowing.",
                  confidence: 0.9,
                  importance: 0.8,
                },
              ],
            }),
          )
        : sseText("Noted."),
    });
    const result = await turn(h.gateway(), "I prefer rowing.");
    h.gateway().confirmDelivery(result.completion_id);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(
      h.backend.requests.filter((r) => r.path.endsWith("/interactions")).length,
      0,
    );
    const replay = await h.connect();
    const notices = await until(() =>
      replay.frames.find((m) => m.type === "memory-notices"),
    );
    assert.equal(notices.learning_off, true);
  } finally {
    await h.close();
  }
});
