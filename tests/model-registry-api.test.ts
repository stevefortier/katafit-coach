import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { History } from "../src/chat/history.js";
import { admin } from "../src/server/admin.js";

const keyA = "synthetic-api-registry-alpha";
const keyB = "synthetic-api-registry-bravo";
const keyC = "synthetic-api-registry-charlie";

// Minimal Kata.fit backend: instructions GET plus an empty MCP surface.
async function backend() {
  const server = createServer(async (req, res) => {
    if (req.method === "GET")
      return void res.end(
        "# Kata.fit external Coach agent v1\nSynthetic policy",
      );
    let raw = "";
    for await (const part of req) raw += part;
    const msg = JSON.parse(raw);
    if (msg.method === "notifications/initialized")
      return void res.writeHead(202).end();
    res.setHeader("Content-Type", "application/json");
    const result =
      msg.method === "initialize"
        ? { protocolVersion: "2025-03-26" }
        : msg.method === "tools/list"
          ? { tools: [] }
          : { structuredContent: { requests: [] } };
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return server;
}

async function harness(
  infer: Parameters<typeof admin>[2] = async () => "synthetic reply",
  prepare?: (dir: string) => void,
) {
  const dir = await mkdtemp(tmpdir() + "/registry-api-");
  const kata = await backend();
  // A provider endpoint that must never be contacted by registry editing.
  const providerRequests: string[] = [];
  const provider = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.invalid");
    providerRequests.push(url.pathname);
    res.writeHead(500).end();
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const providerOrigin = `http://127.0.0.1:${(provider.address() as any).port}`;
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(kata.address() as any).port}`,
    token: "synthetic-api-kata-token",
  });
  prepare?.(dir);
  const app = await admin(store, 0, infer);
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
  const registry = (active = "alpha") => ({
    active: { provider: active, model: active === "alpha" ? "a1" : "b1" },
    providers: [
      {
        id: "alpha",
        name: "Alpha",
        baseUrl: providerOrigin + "/alpha/v1",
        apiKey: keyA,
        models: [{ id: "a1", name: "Alpha", model: "alpha-1", vision: false }],
      },
      {
        id: "bravo",
        name: "Bravo",
        baseUrl: providerOrigin + "/bravo/v1",
        apiKey: keyB,
        models: [{ id: "b1", name: "Bravo", model: "bravo-1", vision: true }],
      },
    ],
  });
  const save = (models: unknown) => {
    const { origin, persona } = store.publicConfig();
    return call("config", { origin, persona, models });
  };
  return {
    dir,
    store,
    app,
    call,
    save,
    registry,
    providerOrigin,
    providerRequests,
    async close() {
      await app.close();
      for (const server of [kata, provider]) {
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("registry API saves, switches and exports without keys or provider contact", async () => {
  const h = await harness();
  try {
    assert.equal((await h.save(h.registry())).status, 200);
    const config = await (await h.call("config")).json();
    assert.equal(config.hasApiKey, true);
    assert.equal(config.provider.baseUrl, h.providerOrigin + "/alpha/v1");
    assert.deepEqual(
      config.models.providers.map((p: any) => [p.id, p.hasCredential]),
      [
        ["alpha", true],
        ["bravo", true],
      ],
    );
    assert.deepEqual(config.models.active, { provider: "alpha", model: "a1" });
    // Switch the saved active selection without redefining credentials.
    const next = structuredClone(config.models);
    delete next.limits;
    for (const p of next.providers) delete p.hasCredential;
    next.active = { provider: "bravo", model: "b1" };
    assert.equal((await h.save(next)).status, 200);
    const switched = await (await h.call("config")).json();
    assert.deepEqual(switched.provider, {
      baseUrl: h.providerOrigin + "/bravo/v1",
      model: "bravo-1",
      vision: true,
    });
    assert.equal(h.store.secrets.apiKey, keyB);
    // Endpoint edits without key intent fail closed with a fixed code.
    const moved = structuredClone(next);
    moved.providers[0].baseUrl = "https://exfiltrate.synthetic.invalid/v1";
    const rejected = await h.save(moved);
    assert.equal(rejected.status, 400);
    const text = await rejected.text();
    assert.equal(JSON.parse(text).error, "CREDENTIAL_REQUIRED");
    assert.match(JSON.parse(text).hint, /re-enter/i);
    const logs = await (await h.call("logs")).text();
    const all = [
      JSON.stringify(config),
      JSON.stringify(switched),
      text,
      logs,
      await readFile(h.dir + "/config.json", "utf8"),
    ].join("\n");
    for (const secret of [keyA, keyB, "synthetic-api-kata-token"])
      assert.equal(all.includes(secret), false, secret);
    assert.equal(JSON.stringify(switched).includes("credential"), false);
    assert.deepEqual(h.providerRequests, []);
  } finally {
    await h.close();
  }
});

test("preview uses the saved active provider and rejects output with any inactive key", async () => {
  const seen: any[] = [];
  let reply = "clean synthetic preview";
  const h = await harness(async (provider) => {
    seen.push(provider);
    return reply;
  });
  try {
    assert.equal((await h.save(h.registry("bravo"))).status, 200);
    const ok = await h.call("preview", { text: "Question" });
    assert.equal(ok.status, 200);
    assert.equal(seen[0].baseUrl, h.providerOrigin + "/bravo/v1");
    assert.equal(seen[0].model, "bravo-1");
    assert.equal(seen[0].vision, true);
    assert.equal(seen[0].apiKey, keyB);
    assert.ok(seen[0].secrets.includes(keyA), "inactive key is redacted too");
    reply = "leaked " + keyA;
    const leaked = await h.call("preview", { text: "Question" });
    assert.equal(leaked.status, 400);
    const body = await leaked.text();
    assert.equal(JSON.parse(body).error, "OUTPUT_REJECTED");
    assert.equal(body.includes(keyA), false);
  } finally {
    await h.close();
  }
});

test("registry saves share preview, worker and operator guards without mutation", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (entered = r));
  const h = await harness(async () => {
    entered();
    await gate;
    return "synthetic";
  });
  try {
    assert.equal((await h.save(h.registry())).status, 200);
    const before = await readFile(h.dir + "/secrets.json", "utf8");
    const revision = h.store.publicConfig().revision;
    const preview = h.call("preview", { text: "synthetic preview" });
    await started;
    const change = h.registry("bravo");
    change.providers[1].apiKey = keyC;
    const busy = await h.save(change);
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).error, "OPERATION_IN_PROGRESS");
    release();
    assert.equal((await preview).status, 200);
    assert.equal((await h.call("run", {})).status, 200);
    const running = await h.save(change);
    assert.equal(running.status, 409);
    assert.equal((await running.json()).error, "STOP_WORKER_BEFORE_CONFIGURE");
    assert.equal(h.store.publicConfig().revision, revision);
    assert.equal(await readFile(h.dir + "/secrets.json", "utf8"), before);
    assert.equal(Object.values(h.store.secrets).includes(keyC), false);
    await h.call("stop", {});
    assert.equal((await h.save(change)).status, 200);
    assert.ok(Object.values(h.store.secrets).includes(keyC));
  } finally {
    release();
    await h.close();
  }
});

for (const where of ["chat", "actions"] as const)
  test(`new inactive keys are scanned against persisted operator ${where} before save`, async () => {
    const h = await harness(undefined, (dir) => {
      if (where === "chat")
        new History(dir).save([
          { role: "user", text: "remember " + keyC },
          { role: "assistant", text: "noted" },
        ]);
      else
        new History(dir, "operator-actions.json").save([
          { role: "user", text: "0".repeat(64) },
          {
            role: "assistant",
            text: JSON.stringify({
              session_id: "session-" + keyC,
              idempotency_key: "synthetic-idempotency",
              status: "delivered",
            }),
          },
        ]);
    });
    try {
      assert.equal((await h.save(h.registry())).status, 200);
      const before = await readFile(h.dir + "/secrets.json", "utf8");
      const revision = h.store.publicConfig().revision;
      const change = h.registry();
      change.providers[1].apiKey = keyC; // inactive provider only
      const response = await h.save(change);
      assert.equal(response.status, 400);
      const text = await response.text();
      assert.equal(JSON.parse(text).error, "SECRET_IN_CONFIG");
      assert.equal(text.includes(keyC), false);
      assert.equal(h.store.publicConfig().revision, revision);
      assert.equal(await readFile(h.dir + "/secrets.json", "utf8"), before);
      // A brand-new provider's key is scanned as well.
      const added = h.registry();
      added.providers.push({
        id: "charlie",
        name: "Charlie",
        baseUrl: h.providerOrigin + "/charlie/v1",
        apiKey: keyC,
        models: [{ id: "c1", name: "C", model: "c-1", vision: false }],
      });
      assert.equal((await h.save(added)).status, 400);
      assert.equal(h.store.publicConfig().revision, revision);
      assert.deepEqual(h.providerRequests, []);
    } finally {
      await h.close();
    }
  });
