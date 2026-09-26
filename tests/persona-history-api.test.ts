import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { createServer } from "node:http";
test("restore respects active operation and worker guards without mutation", async () => {
  const dir = await mkdtemp(tmpdir() + "/history-guards-");
  const store = new Store(dir);
  await store.init();
  const backend = createServer(async (req, res) => {
    if (req.method === "GET")
      return void res.end(
        "# Kata.fit external Coach agent v1\nSynthetic policy",
      );
    let raw = "";
    for await (const part of req) raw += part;
    const msg = JSON.parse(raw);
    if (msg.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    const result =
      msg.method === "initialize"
        ? { protocolVersion: "2025-03-26" }
        : msg.method === "tools/list"
          ? { tools: [] }
          : { structuredContent: { requests: [] } };
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(backend.address() as any).port}`,
    token: "synthetic-token",
    apiKey: "synthetic-key",
  });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (entered = r));
  const app = await admin(store, 0, async () => {
    entered();
    await gate;
    return "synthetic";
  });
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  const post = (path: string, body: unknown = {}) =>
    fetch(app.origin + "/api/" + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  try {
    const preview = post("preview", { text: "synthetic preview" });
    await started;
    const before = store.publicConfig();
    assert.equal((await post("persona-restore", { revision: 1 })).status, 409);
    assert.deepEqual(store.publicConfig(), before);
    release();
    await preview;
    assert.equal((await post("run")).status, 200);
    assert.equal((await post("persona-restore", { revision: 1 })).status, 409);
    assert.deepEqual(store.publicConfig(), before);
    await post("stop");
  } finally {
    release();
    await app.close();
    backend.closeAllConnections();
    await new Promise<void>((r) => backend.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
test("authenticated history is persona-only and restore strictly appends", async () => {
  const dir = await mkdtemp(tmpdir() + "/history-api-");
  const store = new Store(dir);
  await store.init();
  const app = await admin(store, 0);
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  const call = (path: string, body?: unknown) =>
    fetch(app.origin + "/api/" + path, {
      headers,
      method: body === undefined ? "GET" : "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    assert.equal(
      (await fetch(app.origin + "/api/persona-history")).status,
      401,
    );
    assert.equal((await call("persona-history")).status, 200);
    for (const id of [0, -1, 1.2, "1", null, Number.MAX_SAFE_INTEGER + 1, 99])
      assert.equal(
        (await call("persona-restore", { revision: id })).status,
        400,
      );
    for (const id of ["01", "1e0", "-1", "1.0", "9007199254740992"])
      assert.equal((await call("persona-history/" + id)).status, 400);
    assert.equal(
      (await (await call("persona-history/99")).json()).error,
      "REVISION_NOT_FOUND",
    );
    assert.equal(
      (await (await call("persona-history/0")).json()).error,
      "INVALID_REVISION",
    );
    assert.equal(
      (await (await call("persona-history?limit=51")).json()).error,
      "INVALID_PAGE",
    );
    assert.equal(store.publicConfig().revision, 1);
    const detail = await (await call("persona-history/1")).json();
    assert.deepEqual(Object.keys(detail).sort(), [
      "current",
      "persona",
      "revision",
      "savedAt",
    ]);
    assert.equal((await call("persona-restore", { revision: 1 })).status, 200);
    assert.equal(store.publicConfig().revision, 2);
    assert.equal(
      (await (await call("persona-history?limit=1")).json()).nextBefore,
      2,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
