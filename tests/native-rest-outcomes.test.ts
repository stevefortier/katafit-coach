// Operator REST outcomes over the actual relay and extension: concurrent reads
// wait their turn, failed reads name their cause, and a definite backend
// rejection of a write does not fence later writes.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";
import { startRelay, loadExtension } from "./helpers/native-relay.js";

async function setup() {
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    calls.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/slow") await slow;
    if (req.url === "/api/large")
      return res.end(JSON.stringify({ rows: "x".repeat(300 * 1024) }));
    if (req.url === "/api/invalid")
      return res.writeHead(400).end('{"error":"synthetic validation"}');
    return res.end(JSON.stringify({ path: req.url }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const dir = await mkdtemp(tmpdir() + "/native-rest-outcomes-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin,
    provider: { baseUrl: origin + "/v1", model: "approved-custom-model" },
    token: "synthetic-backend-credential",
    apiKey: "synthetic-provider-credential",
  });
  const gateway = await openNativeGateway(store);
  const relay = await startRelay(gateway);
  const ext = await loadExtension(relay);
  return {
    ext,
    calls,
    release,
    async close() {
      release();
      await relay.close();
      await gateway.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const get = (path: string) => ({ method: "GET", path });

test("reads sent together wait their turn instead of failing", async () => {
  const f = await setup();
  try {
    const first = f.ext.call("katafit_rest_request", get("/api/slow"));
    // Let the first read reach the backend before the second arrives.
    while (!f.calls.length) await new Promise((r) => setTimeout(r, 10));
    const second = f.ext.call("katafit_rest_request", get("/api/fast"));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(f.calls, ["GET /api/slow"], "the second read waits");
    f.release();
    const [a, b] = await Promise.all([first, second]);
    assert.match(a.content[0].text, /\/api\/slow/);
    assert.match(b.content[0].text, /\/api\/fast/);
    assert.deepEqual(f.calls, ["GET /api/slow", "GET /api/fast"]);
  } finally {
    await f.close();
  }
});

test("an oversized read names its cause and how to narrow it", async () => {
  const f = await setup();
  try {
    await assert.rejects(
      () => f.ext.call("katafit_rest_request", get("/api/large")),
      (e: any) =>
        /^NATIVE_REST_TOO_LARGE: .*256 KiB.*\?fields=a,b\.c/.test(e.message) &&
        !/xxxx/.test(e.message),
    );
  } finally {
    await f.close();
  }
});

test("a rejected write reports its HTTP status and does not fence the next write", async () => {
  const f = await setup();
  try {
    await assert.rejects(
      () =>
        f.ext.call("katafit_rest_request", {
          method: "POST",
          path: "/api/invalid",
          body: { value: 1 },
        }),
      (e: any) =>
        /^NATIVE_REST_REJECTED \(HTTP 400\): .*not apply it/.test(e.message) &&
        !/synthetic validation/.test(e.message),
    );
    const next = await f.ext.call("katafit_rest_request", {
      method: "POST",
      path: "/api/valid",
      body: { value: 2 },
    });
    assert.match(next.content[0].text, /\/api\/valid/);
    assert.deepEqual(f.calls, ["POST /api/invalid", "POST /api/valid"]);
  } finally {
    await f.close();
  }
});
