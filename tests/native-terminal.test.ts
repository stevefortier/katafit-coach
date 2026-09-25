import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { admin } from "../src/server/admin.js";
import { fixture } from "./helpers/native.js";
import { Actions } from "../src/chat/actions.js";
import { execFileSync } from "node:child_process";
import {
  continuityFixture,
  GENERIC,
  answer,
  toolCall,
} from "./helpers/continuity.js";

test(
  "Stop aborts a pending MCP startup rather than waiting for its backend",
  { timeout: 10000 },
  async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => (entered = r)),
      gate = new Promise<void>((r) => (release = r));
    const f = await fixture(async (name, result) => {
      if (name === "initialize") {
        entered();
        await gate;
      }
      return result;
    });
    const app = await admin(f.store, 0);
    let ws: WebSocket | undefined;
    const headers = {
      Authorization: "Bearer " + f.store.secrets.admin,
      Origin: app.origin,
    };
    try {
      const ticket = (await (
        await fetch(app.origin + "/api/terminal/ticket", {
          method: "POST",
          headers,
        })
      ).json()) as any;
      ws = new WebSocket(app.origin.replace("http:", "ws:") + ticket.path, {
        origin: app.origin,
      });
      await new Promise<void>((r, j) => {
        ws!.once("open", r);
        ws!.once("error", j);
      });
      ws.send(JSON.stringify({ ticket: ticket.ticket }));
      await started;
      const stopped = fetch(app.origin + "/api/terminal/stop", {
        method: "POST",
        headers,
      });
      assert.equal(
        await Promise.race([
          stopped.then((r) => r.status),
          new Promise((r) => setTimeout(() => r("blocked"), 1000)),
        ]),
        200,
      );
    } finally {
      release();
      ws?.terminate();
      await app.close();
      await f.close();
    }
  },
);

test(
  "real native terminal ticket replay is denied and saving config tears down its session",
  { skip: process.env.NATIVE_DOCKER_TEST !== "1", timeout: 30000 },
  async () => {
    const f = await fixture();
    const app = await admin(f.store, 0);
    const headers = {
      Authorization: "Bearer " + f.store.secrets.admin,
      Origin: app.origin,
      "Content-Type": "application/json",
    };
    const post = (path: string, body: any = {}) =>
      fetch(app.origin + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    const connect = async (ticket: string) => {
      const ws = new WebSocket(
        app.origin.replace("http:", "ws:") + "/api/terminal/ws",
        { origin: app.origin },
      );
      await new Promise<void>((r, j) => {
        ws.once("open", r);
        ws.once("error", j);
      });
      ws.send(JSON.stringify({ ticket }));
      return ws;
    };
    let ws: WebSocket | undefined;
    try {
      const ticket = (await (await post("/api/terminal/ticket")).json()) as any;
      ws = await connect(ticket.ticket);
      await new Promise<void>((r, j) => {
        const timer = setTimeout(() => j(new Error("not ready")), 10000);
        ws!.on("message", (raw) => {
          if (JSON.parse(raw.toString()).type === "ready") {
            clearTimeout(timer);
            r();
          }
        });
      });
      const replay = await connect(ticket.ticket);
      assert.equal(
        await new Promise<number>((r) => replay.once("close", r)),
        1008,
      );
      const closed = new Promise<number>((r) => ws!.once("close", r));
      assert.equal(
        (await post("/api/config", f.store.publicConfig())).status,
        200,
      );
      assert.equal(
        await Promise.race([
          closed,
          new Promise((r) => setTimeout(() => r("still-open"), 1000)),
        ]),
        1008,
      );
      assert.ok(
        f.calls.some(
          (c) => c.body.params?.name === "studio_operator_close_session",
        ),
      );
    } finally {
      ws?.terminate();
      await app.close();
      await f.close();
    }
  },
);

test("native and compatibility receipt writers cannot erase each other's journal entries", async () => {
  const f = await fixture();
  try {
    const first = new Actions(f.store),
      second = new Actions(f.store);
    first.save({
      session_id: "first-session",
      idempotency_key: "first-key",
      status: "unknown",
    });
    second.save({
      session_id: "second-session",
      idempotency_key: "second-key",
      status: "completed",
    });
    assert.deepEqual(
      first.snapshot().map((a) => a.session_id),
      ["first-session", "second-session"],
    );
    assert.equal(new Actions(f.store).snapshot().length, 2);
  } finally {
    await f.close();
  }
});

test("native action receipts are read from current journal without closing active backend sessions", async () => {
  const f = await fixture();
  const app = await admin(f.store, 0);
  try {
    const action = {
      session_id: "native-fixture-session",
      idempotency_key: "fixture-key",
      status: "unknown" as const,
      tool_name: "studio_operator_future_write",
    };
    new Actions(f.store).save(action);
    const response = await fetch(app.origin + "/api/terminal/receipts", {
      headers: { Authorization: "Bearer " + f.store.secrets.admin },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(((await response.json()) as any).actions, [action]);
    assert.equal(
      f.calls.length,
      0,
      "reading receipt must not close or replay a running action",
    );
  } finally {
    await app.close();
    await f.close();
  }
});

test(
  "terminal tickets require existing admin bearer and exact origin, expire on stop, never URL secrets",
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    const app = await admin(f.store, 0);
    const post = (path: string, headers: any = {}) =>
      fetch(app.origin + path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: "{}",
      });
    try {
      assert.equal((await post("/api/terminal/ticket")).status, 401);
      assert.equal(
        (
          await post("/api/terminal/ticket", {
            Authorization: "Bearer " + f.store.secrets.admin,
            Origin: "http://evil.invalid",
          })
        ).status,
        403,
      );
      const headers = {
        Authorization: "Bearer " + f.store.secrets.admin,
        Origin: app.origin,
      };
      const response = await post("/api/terminal/ticket", headers);
      assert.equal(response.status, 200);
      const data = (await response.json()) as any;
      assert.match(data.ticket, /^[0-9a-f]{64}$/);
      assert.equal(data.path, "/api/terminal/ws");
      assert.equal((await post("/api/terminal/stop", headers)).status, 200);
      const ws = new WebSocket(app.origin.replace("http:", "ws:") + data.path, {
        origin: app.origin,
      });
      await new Promise<void>((r, j) => {
        ws.once("open", r);
        ws.once("error", j);
      });
      const closed = new Promise<number>((r) => ws.once("close", r));
      ws.send(JSON.stringify({ ticket: data.ticket }));
      assert.equal(await closed, 1008);
      assert.equal(
        f.calls.length,
        0,
        "invalidated ticket must never launch or contact backend",
      );
    } finally {
      await app.close();
      await f.close();
    }
  },
);

// Real admin server, ticket, WebSocket, NativeTerminal, Docker Pi and relay.
// Only the continuity backend and model provider are synthetic loopback.
async function continuityTerminal(
  provider: Parameters<typeof continuityFixture>[0]["provider"],
) {
  const f = await continuityFixture({ provider });
  const app = await admin(f.store, 0);
  const headers = {
    Authorization: "Bearer " + f.store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
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
  let output = "";
  const errors: string[] = [];
  let closeCode: number | undefined;
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "output") output = (output + m.data).slice(-150000);
    if (m.type === "error") errors.push(m.message);
  });
  ws.on("close", (code) => (closeCode = code));
  await new Promise<void>((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  ws.send(JSON.stringify({ ticket: ticket.ticket }));
  const waitFor = async (check: () => boolean, what: string) => {
    const end = Date.now() + 40000;
    while (!check()) {
      if (Date.now() > end)
        throw new Error("Missing " + what + "\n" + output.slice(-4000));
      await new Promise((r) => setTimeout(r, 40));
    }
  };
  await waitFor(() => output.includes("ripgrep not found"), "Pi ready");
  await new Promise((r) => setTimeout(r, 150));
  return {
    f,
    app,
    headers,
    errors,
    closeCode: () => closeCode,
    output: () => output,
    waitFor,
    type: (data: string) => ws.send(JSON.stringify({ type: "input", data })),
    resize: () =>
      ws.send(JSON.stringify({ type: "resize", cols: 110, rows: 32 })),
    close: async () => {
      ws.terminate();
      await app.close();
      await f.close();
    },
  };
}
const turnOf = (body: any) => {
  const index = body.messages.findLastIndex((m: any) => m.role === "user");
  const text = JSON.stringify(body.messages[index]);
  return {
    turn: text.includes("second") ? "second" : "first",
    results: body.messages
      .slice(index + 1)
      .filter((m: any) => m.role === "tool")
      .map((m: any) => JSON.stringify(m.content)),
  };
};
const owned = () =>
  execFileSync(
    "docker",
    ["ps", "-a", "--filter", "name=katafit-pi-", "--format", "{{.Names}}"],
    { encoding: "utf8" },
  ).trim();

test(
  "real terminal: authenticated browser Enter renews Pi turns; model loops and resize frames cannot",
  { skip: process.env.NATIVE_DOCKER_TEST !== "1", timeout: 150000 },
  async () => {
    const h = await continuityTerminal((body) => {
      const { turn, results } = turnOf(body);
      if (results.length < 11)
        return toolCall(
          "studio_operator_list_members",
          {},
          `r_${turn}_${results.length}`,
        );
      if (results.length === 11)
        return toolCall(
          "studio_operator_send_message",
          { member_ref: "fixture-member", text: `Intentional ${turn}` },
          `s_${turn}`,
        );
      return answer(
        `TERM_${turn}_${results.at(-1)!.includes("delivered") ? "SENT" : "UNSENT"}`,
      );
    });
    try {
      h.type("Perform the first synthetic task\r");
      await h.waitFor(() => h.output().includes("TERM_first_SENT"), "first");
      h.resize();
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(h.f.named("studio_operator_advance_turn").length, 0);
      assert.ok(h.f.providerCalls() >= 13, "model loop alone never advanced");
      h.type("Perform the second synthetic task\r");
      await h.waitFor(() => h.output().includes("TERM_second_SENT"), "second");
      assert.equal(h.f.named("studio_operator_advance_turn").length, 1);
      assert.equal(h.f.named("studio_operator_list_members").length, 22);
      assert.deepEqual(
        h.f.state.messages.map((m) => [m.text, m.generation]),
        [
          ["Intentional first", 0],
          ["Intentional second", 1],
        ],
      );
      assert.equal(h.f.named("studio_operator_open_session").length, 1);
      assert.deepEqual(h.errors, []);
    } finally {
      await h.close();
    }
  },
);

test(
  "real terminal: continuity denial closes the browser session and destroys the runtime without reopening",
  { skip: process.env.NATIVE_DOCKER_TEST !== "1", timeout: 150000 },
  async () => {
    const h = await continuityTerminal((body) => {
      const { turn, results } = turnOf(body);
      if (turn === "first" && !results.length)
        return toolCall(GENERIC, { topic: "private" }, "g_first");
      return answer(`TERM_${turn}_ANSWERED`);
    });
    try {
      h.type("Read the first private synthetic source\r");
      await h.waitFor(
        () => h.output().includes("TERM_first_ANSWERED"),
        "first answer",
      );
      assert.notEqual(owned(), "");
      const before = h.f.providerCalls();
      h.f.state.revoked = true;
      h.type("Answer the second question from retained context\r");
      await h.waitFor(() => h.closeCode() !== undefined, "browser close");
      assert.equal(h.closeCode(), 1008);
      assert.match(h.errors.join("\n"), /revoked or expired/);
      await h.waitFor(() => owned() === "", "runtime destruction");
      assert.equal(h.f.providerCalls(), before);
      assert.equal(h.f.named("studio_operator_open_session").length, 1);
      assert.ok(h.f.named("studio_operator_close_session").length >= 1);
      assert.notEqual(h.f.state.status, "active");
      // A later Start is a new, empty runtime; nothing reopened this one.
      assert.equal(
        (
          await fetch(h.app.origin + "/api/terminal/ticket", {
            method: "POST",
            headers: h.headers,
            body: "{}",
          })
        ).status,
        200,
      );
      assert.equal(h.f.named("studio_operator_open_session").length, 1);
    } finally {
      await h.close();
    }
  },
);
