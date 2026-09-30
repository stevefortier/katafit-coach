import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";
import { Actions } from "../src/chat/actions.js";
import { fixture } from "./helpers/native.js";

test("native catalog never advertises or dispatches legacy Operator tools", async () => {
  const f = await fixture();
  const gateway = await openNativeGateway(f.store);
  try {
    const catalog = await gateway.handle({ kind: "catalog" });
    assert.deepEqual(
      catalog.tools
        .map((t: any) => t.name)
        .filter((n: string) => n.startsWith("studio_operator_")),
      [],
    );
    assert.ok(
      catalog.tools.some((t: any) => t.name === "katafit_rest_request"),
    );
    await assert.rejects(() =>
      gateway.handle({
        kind: "tool",
        name: "studio_operator_send_message",
        args: { text: "hello", member_ref: "x" },
      }),
    );
    assert.equal(
      f.calls.filter((c) => c.body?.method === "tools/call").length,
      0,
    );
  } finally {
    await gateway.close();
    await f.close();
  }
});

test("native ordinary REST send injects one key and verifies canonical receipt", async () => {
  const calls: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    calls.push({
      method: req.method,
      path: req.url,
      auth: req.headers.authorization,
      body: raw && JSON.parse(raw),
    });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.method === "POST"
          ? { status: "delivered", message_id: "msg-1" }
          : {
              status: "delivered",
              message_id: "msg-1",
              recipient_id: "user-1",
              idempotency_key: calls[0].body.idempotency_key,
            },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = await mkdtemp(tmpdir() + "/native-rest-send-");
  try {
    const store = new Store(dir);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin: `http://127.0.0.1:${(server.address() as any).port}`,
      token: "synthetic-backend-credential",
    });
    const gateway = await openNativeGateway(store);
    try {
      const result = await gateway.handle({
        kind: "tool",
        name: "katafit_rest_request",
        args: {
          method: "POST",
          path: "/api/coach/member-messages/user-1",
          body: { text: "Hello" },
        },
      });
      assert.match(result.content[0].text, /msg-1/);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].method, "POST");
      assert.equal(calls[0].body.text, "Hello");
      assert.match(calls[0].body.idempotency_key, /^[0-9a-f]{64}$/);
      assert.equal(calls[1].method, "GET");
      assert.equal(
        calls[1].path,
        `${calls[0].path}/receipts/${calls[0].body.idempotency_key}`,
      );
      assert.equal(calls[0].auth, "Bearer synthetic-backend-credential");
      await assert.rejects(() =>
        gateway.handle({
          kind: "tool",
          name: "katafit_rest_request",
          args: {
            method: "POST",
            path: "/api/coach/member-messages/user-1",
            body: { text: "Hello", idempotency_key: "model-key" },
          },
        }),
      );
      assert.equal(calls.length, 2);
    } finally {
      await gateway.close();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("static native dispatch cannot execute studio_operator tools", async () => {
  for (const path of [
    "src/sandbox/gateway.ts",
    "src/katafit/restSession.ts",
    "src/chat/actions.ts",
  ]) {
    const source = await readFile(
      new URL(`../${path}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /(?:call|rpc|invoke|execute)\(\s*["'`]studio_operator_/,
    );
  }
  const source = await readFile(
    new URL("../src/sandbox/gateway.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /openOperatorTools|openLegacy|session\.tools\.find/,
  );
});

test("lost POST acknowledgement uses exact read-only receipt and never resends", async () => {
  const calls: { method: string; path: string; body?: any }[] = [];
  let key = "";
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    calls.push({
      method: req.method!,
      path: req.url!,
      body: raw ? JSON.parse(raw) : undefined,
    });
    if (req.method === "POST") {
      key = JSON.parse(raw).idempotency_key;
      res.destroy();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        status: "delivered",
        message_id: "msg-recovered",
        recipient_id: "user-1",
        idempotency_key: key,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = await mkdtemp(tmpdir() + "/native-lost-ack-");
  try {
    const store = new Store(dir);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin: `http://127.0.0.1:${(server.address() as any).port}`,
      token: "synthetic-backend-credential",
    });
    const gateway = await openNativeGateway(store);
    try {
      const result = await gateway.handle({
        kind: "tool",
        name: "katafit_rest_request",
        args: {
          method: "POST",
          path: "/api/coach/member-messages/user-1",
          body: { text: "Hello" },
        },
      });
      assert.match(result.content[0].text, /msg-recovered/);
      assert.deepEqual(
        calls.map((c) => c.method),
        ["POST", "GET"],
      );
      assert.equal(
        calls[1].path,
        `/api/coach/member-messages/user-1/receipts/${key}`,
      );
      const { Actions } = await import("../src/chat/actions.js");
      assert.equal(new Actions(store).snapshot().at(-1)?.status, "delivered");
    } finally {
      await gateway.close();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("denied send and mismatched receipt never settle or replay", async () => {
  for (const denied of [true, false]) {
    let posts = 0;
    const server = createServer(async (req, res) => {
      for await (const _ of req) {
        /* drain */
      }
      res.setHeader("content-type", "application/json");
      if (req.method === "POST") {
        posts++;
        if (denied) {
          res.writeHead(403);
          res.end('{"error":"denied"}');
          return;
        }
        res.end('{"status":"delivered","message_id":"msg-1"}');
      } else
        res.end(
          JSON.stringify({
            status: "delivered",
            message_id: "msg-1",
            recipient_id: "someone-else",
            idempotency_key: "wrong-key",
          }),
        );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const dir = await mkdtemp(tmpdir() + "/native-denied-send-");
    try {
      const store = new Store(dir);
      await store.init();
      await store.save({
        ...store.publicConfig(),
        origin: `http://127.0.0.1:${(server.address() as any).port}`,
        token: "synthetic-backend-credential",
      });
      const gateway = await openNativeGateway(store);
      try {
        const send = () =>
          gateway.handle({
            kind: "tool",
            name: "katafit_rest_request",
            args: {
              method: "POST",
              path: "/api/coach/member-messages/user-1",
              body: { text: "Hello" },
            },
          });
        await assert.rejects(send);
        await assert.rejects(send);
        assert.equal(posts, 1);
        const { Actions } = await import("../src/chat/actions.js");
        assert.equal(new Actions(store).snapshot().at(-1)?.status, "unknown");
      } finally {
        await gateway.close();
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("restart checks exact REST receipt for a pending member send without another POST", async () => {
  const calls: string[] = [];
  let key = "";
  let committed = false;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    calls.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") {
      key = JSON.parse(raw).idempotency_key;
      res.destroy();
      return;
    }
    if (!committed) {
      res.writeHead(404);
      res.end('{"error":"receipt not yet visible"}');
      return;
    }
    res.end(
      JSON.stringify({
        status: "delivered",
        message_id: "msg-after-restart",
        recipient_id: "user-1",
        idempotency_key: key,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = await mkdtemp(tmpdir() + "/native-reconcile-send-");
  try {
    const store = new Store(dir);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin: `http://127.0.0.1:${(server.address() as any).port}`,
      token: "synthetic-backend-credential",
    });
    const first = await openNativeGateway(store);
    try {
      await assert.rejects(
        first.handle({
          kind: "tool",
          name: "katafit_rest_request",
          args: {
            method: "POST",
            path: "/api/coach/member-messages/user-1",
            body: { text: "Hello" },
          },
        }),
      );
      assert.equal(new Actions(store).snapshot().at(-1)?.status, "unknown");
    } finally {
      await first.close();
    }
    committed = true;
    const restarted = await openNativeGateway(store);
    try {
      const receipt = new Actions(store).snapshot().at(-1);
      assert.equal(receipt?.status, "delivered");
      assert.equal(receipt?.message_id, "msg-after-restart");
      assert.equal(calls.filter((c) => c.startsWith("POST ")).length, 1);
      assert.equal(
        calls.at(-1),
        `GET /api/coach/member-messages/user-1/receipts/${key}`,
      );
    } finally {
      await restarted.close();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
