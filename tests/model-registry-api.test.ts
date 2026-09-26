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
    assert.equal((await running.json()).error, "RESTART_CONFIRMATION_REQUIRED");
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

test("confirmed config change restarts a running Coach once with fresh provider credentials", async () => {
  const seen: any[] = [];
  const h = await harness(async (provider) => {
    seen.push(provider);
    return "synthetic preview";
  });
  try {
    assert.equal((await h.save(h.registry())).status, 200);
    assert.equal((await h.call("run", {})).status, 200);
    const revision = h.store.publicConfig().revision;
    const payload = {
      origin: h.store.publicConfig().origin,
      persona: h.store.publicConfig().persona,
      models: h.registry("bravo"),
      confirmRestart: true,
    };
    const result = await h.call("config", payload);
    assert.equal(result.status, 200, await result.clone().text());
    const data = await result.json();
    assert.equal(data.lifecycle.applied, true);
    assert.equal(data.lifecycle.resumed, true);
    assert.equal(h.store.publicConfig().revision, revision + 1);
    assert.notEqual((await (await h.call("status")).json()).state, "stopped");
    const preview = await h.call("preview", {
      text: "Synthetic",
      confirmRestart: true,
    });
    assert.equal(preview.status, 200, await preview.clone().text());
    assert.equal(seen.at(-1).apiKey, keyB);
    assert.equal(seen.at(-1).baseUrl, h.providerOrigin + "/bravo/v1");
    assert.notEqual((await (await h.call("status")).json()).state, "stopped");
  } finally {
    await h.close();
  }
});

test("accepted config operations are idempotent and fence competing lifecycle admission", async () => {
  const h = await harness();
  const save = h.store.save.bind(h.store);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (entered = r));
  try {
    await h.save(h.registry());
    await h.call("run", {});
    const revision = h.store.publicConfig().revision;
    h.store.save = async (...args) => {
      entered();
      await gate;
      return save(...args);
    };
    const payload = {
      origin: h.store.publicConfig().origin,
      persona: h.store.publicConfig().persona,
      models: h.registry("bravo"),
      confirmRestart: true,
      operationId: "11111111-1111-4111-8111-111111111111",
      expectedRevision: revision,
    };
    const saving = h.call("config", payload);
    await started;
    for (const path of [
      "run",
      "stop",
      "config",
      "rollback",
      "persona-restore",
      "terminal/ticket",
      "update/apply",
    ])
      assert.equal((await h.call(path, {})).status, 409, path);
    release();
    assert.equal((await saving).status, 200);
    const repeated = await h.call("config", payload);
    assert.equal(repeated.status, 200, await repeated.clone().text());
    assert.equal(
      h.store.publicConfig().revision,
      revision + 1,
      "response loss must not save twice",
    );
    const stale = await h.call("config", {
      ...payload,
      operationId: "22222222-2222-4222-8222-222222222222",
    });
    assert.equal(stale.status, 409);
  } finally {
    release();
    h.store.save = save;
    await h.close();
  }
});

test("validation and disk save failure restore prior running configuration; stopped restore and rollback stay stopped", async () => {
  const h = await harness();
  const atomic = h.store.atomic.bind(h.store);
  try {
    await h.save(h.registry());
    await h.call("run", {});
    const before = h.store.publicConfig();
    const invalid = await h.call("config", {
      origin: before.origin,
      persona: { ...before.persona, name: "" },
      models: h.registry(),
      confirmRestart: true,
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).lifecycle.resumed, true);
    assert.equal(h.store.publicConfig().revision, before.revision);
    h.store.atomic = async (file, data) => {
      if (file === "config") throw Error("synthetic disk failure");
      return atomic(file, data);
    };
    const failed = await h.call("config", {
      origin: before.origin,
      persona: before.persona,
      models: h.registry("bravo"),
      confirmRestart: true,
    });
    assert.equal(failed.status, 400);
    assert.equal((await failed.json()).lifecycle.resumed, true);
    const disk = new Store(h.dir);
    await disk.init();
    assert.deepEqual(disk.publicConfig(), before);
    assert.equal(disk.secrets.apiKey, keyA);
    h.store.atomic = atomic;
    const restore = await h.call("persona-restore", {
      revision: 1,
      confirmRestart: true,
    });
    assert.equal(restore.status, 200);
    assert.equal((await restore.json()).lifecycle.resumed, true);
    const rollback = await h.call("rollback", { confirmRestart: true });
    assert.equal(rollback.status, 200);
    assert.equal((await rollback.json()).lifecycle.resumed, true);
    await h.call("stop", {});
    const stopped = await h.call("persona-restore", { revision: 1 });
    assert.equal(stopped.status, 200);
    assert.equal((await stopped.json()).lifecycle.resumed, false);
    assert.equal((await (await h.call("status")).json()).state, "stopped");
  } finally {
    h.store.atomic = atomic;
    await h.close();
  }
});

test("ambiguous config publication does not restart from stale in-memory credentials", async () => {
  const h = await harness();
  const atomic = h.store.atomic.bind(h.store);
  try {
    await h.save(h.registry());
    await h.call("run", {});
    h.store.atomic = async (file, data) => {
      await atomic(file, data);
      if (file === "config")
        throw Error("synthetic lost write acknowledgement");
    };
    const result = await h.call("config", {
      origin: h.store.publicConfig().origin,
      persona: h.store.publicConfig().persona,
      models: h.registry("bravo"),
      confirmRestart: true,
    });
    assert.equal(result.status, 400);
    const state = await (await h.call("status")).json();
    assert.equal(state.state, "stopped");
    assert.equal(state.lifecycle.applicationUncertain, true);
    assert.equal((await h.call("run", {})).status, 400);
  } finally {
    h.store.atomic = atomic;
    await h.close();
  }
});

test("server shutdown settles an accepted save without restarting after close", async () => {
  const h = await harness();
  const save = h.store.save.bind(h.store);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (entered = r));
  let request: Promise<unknown> | undefined;
  try {
    await h.save(h.registry());
    await h.call("run", {});
    h.store.save = async (...args) => {
      entered();
      await gate;
      return save(...args);
    };
    request = h
      .call("config", {
        origin: h.store.publicConfig().origin,
        persona: h.store.publicConfig().persona,
        models: h.registry("bravo"),
        confirmRestart: true,
      })
      .catch(() => {});
    await started;
    const closing = h.app.close();
    assert.equal(
      await Promise.race([
        closing.then(() => true),
        new Promise((r) => setTimeout(() => r(false), 50)),
      ]),
      false,
      "shutdown awaits accepted transition",
    );
    release();
    await closing;
    await request;
  } finally {
    release();
    await request;
    h.store.save = save;
    await h.close();
  }
});

test("cancelled preview resumes prior running Coach without a config revision", async () => {
  let entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  const h = await harness(async (_provider, _system, _text, signal) => {
    entered();
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(Error("CANCELLED")), {
        once: true,
      }),
    );
    return "never";
  });
  try {
    await h.save(h.registry());
    await h.call("run", {});
    const revision = h.store.publicConfig().revision;
    const preview = h.call("preview", {
      text: "Synthetic cancelled preview",
      confirmRestart: true,
    });
    await started;
    assert.equal((await h.call("run", {})).status, 409);
    assert.equal((await h.call("cancel", {})).status, 200);
    const result = await preview;
    assert.equal(result.status, 400);
    assert.equal((await result.json()).lifecycle.resumed, true);
    assert.equal(h.store.publicConfig().revision, revision);
    assert.notEqual((await (await h.call("status")).json()).state, "stopped");
  } finally {
    await h.close();
  }
});
