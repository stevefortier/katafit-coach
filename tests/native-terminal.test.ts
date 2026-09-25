import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { admin } from "../src/server/admin.js";
import { fixture } from "./helpers/native.js";
import { Actions } from "../src/chat/actions.js";

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
