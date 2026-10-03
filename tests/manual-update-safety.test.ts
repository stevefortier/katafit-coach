import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { Updates } from "../src/update/updates.js";
import { createServer } from "node:http";

test("new admin requires explicit preparation capability before stopping a running worker", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-previous-owner-gate-"));
  const backend = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.method === "notifications/initialized")
      return void response.writeHead(202).end();
    const result =
      message.method === "initialize"
        ? { protocolVersion: "2025-03-26" }
        : message.method === "tools/list"
          ? { tools: [] }
          : { structuredContent: { requests: [] } };
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(backend.address() as any).port}`,
    token: "synthetic-previous-owner-token",
    apiKey: "synthetic-previous-owner-provider",
  });
  let applications = 0;
  const updates = new Updates("a".repeat(40), async () => {
    applications++;
  });
  updates.latest = "b".repeat(40);
  updates.checkedAt = Date.now();
  // This is the immediately previous owner snapshot: restart support exists,
  // but the preparation capability and prepare RPC do not.
  updates.manualRestartSupported = true;
  const app = await admin(store, 0, undefined, undefined, updates);
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  try {
    assert.equal(
      (
        await fetch(app.origin + "/api/run", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      200,
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await (
        await fetch(app.origin + "/api/status", { headers })
      ).json();
      if (state.state === "idle") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const response = await fetch(app.origin + "/api/update/apply", {
      method: "POST",
      headers,
      body: JSON.stringify({ sha: updates.latest, confirm: true }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "LAUNCHER_UPGRADE_REQUIRED");
    assert.equal(applications, 0);
    assert.notEqual(
      (await (await fetch(app.origin + "/api/status", { headers })).json())
        .state,
      "stopped",
      "capability rejection happens before worker stop",
    );
  } finally {
    await app.close();
    backend.closeAllConnections();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

test("prepared activation does not turn a long build into stale-check failure", async () => {
  const latest = "a".repeat(40);
  let activated = false;
  let updates!: Updates;
  updates = new Updates(
    "b".repeat(40),
    async () => {
      activated = true;
    },
    fetch,
    undefined,
    async () => {
      updates.checkedAt = Date.now() - 10 * 60 * 1000;
    },
  );
  updates.latest = latest;
  updates.checkedAt = Date.now();
  await updates.apply(latest);
  assert.equal(activated, true);
  assert.equal(updates.installed, latest);
});

test("update quiesce refuses active work and fences new worker claims", async () => {
  const { Worker } = await import("../src/worker/runner.js");
  const worker = new Worker({
    origin: "http://127.0.0.1:1",
    token: "test",
    system: "Coach",
    complete: async () => "",
  });
  assert.equal(worker.quiesceForUpdate(), false); // stopped is not a live idle worker
  worker.state = "idle";
  assert.equal(worker.quiesceForUpdate(), true);
  await assert.rejects(worker.pollOnce(), /CANCELLED/);
  worker.releaseUpdateQuiesce();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

test("manual upgrade queues behind an idle poll, fences claims and installs exactly once", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-idle-poll-update-"));
  const held = deferred(),
    release = deferred(),
    installed = deferred();
  let lists = 0,
    claims = 0,
    applications = 0,
    stopped = false;
  const backend = createServer(async (request, response) => {
    if (request.method === "GET")
      return void response.end("# Kata.fit external Coach agent v1\n");
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.method === "notifications/initialized")
      return void response.writeHead(202).end();
    let value: any = {};
    if (message.method === "initialize")
      value = { protocolVersion: "2025-03-26" };
    else if (message.method === "tools/list")
      value = { tools: [{ name: "coach_report_worker_presence" }] };
    else if (message.params?.name === "coach_report_worker_presence") {
      stopped = message.params.arguments.state === "stopped";
      value = {
        state: message.params.arguments.state,
        generation: "a".repeat(32),
      };
    } else if (message.params?.name === "coach_list_requests") {
      if (++lists === 2) {
        held.resolve();
        await release.promise;
      }
      // Work appears in the already-dispatched poll while admission is fenced.
      value = { requests: lists === 2 ? [{ status: "queued" }] : [] };
    } else if (message.params?.name === "coach_claim_request") {
      claims++;
      value = { request: null };
    }
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: ["initialize", "tools/list"].includes(message.method)
          ? value
          : { structuredContent: value },
      }),
    );
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(backend.address() as any).port}`,
    token: "synthetic-idle-poll-token",
    apiKey: "synthetic-key",
  });
  const updates = new Updates(
    "a".repeat(40),
    async () => {
      assert.equal(
        stopped,
        true,
        "confirmed backend Stop precedes installation",
      );
      applications++;
      installed.resolve();
    },
    fetch,
    undefined,
    async () => {
      await held.promise;
    },
  );
  updates.manualRestartSupported = true;
  updates.latest = "b".repeat(40);
  updates.checkedAt = Date.now();
  const app = await admin(store, 0, undefined, undefined, updates);
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  try {
    assert.equal(
      (
        await fetch(app.origin + "/api/run", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      200,
    );
    const response = await fetch(app.origin + "/api/update/apply", {
      method: "POST",
      headers,
      body: JSON.stringify({ sha: updates.latest, confirm: true }),
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).queued, true);
    const snapshot = await (
      await fetch(app.origin + "/api/update", { headers })
    ).json();
    assert.equal(snapshot.manualQueue.phase, "waiting-worker");
    assert.equal(snapshot.manualQueue.persistence, "process-local");
    assert.equal(applications, 0);
    assert.equal(stopped, false);
    release.resolve();
    await Promise.race([
      installed.promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("installation did not drain")), 3000),
      ),
    ]);
    assert.equal(
      claims,
      0,
      "held discovery must not dispatch a new claim after reservation",
    );
    assert.equal(applications, 1);
  } finally {
    release.resolve();
    await app.close();
    backend.closeAllConnections();
    await new Promise<void>((r) => backend.close(() => r()));
    await rm(home, { recursive: true, force: true });
  }
});

test("queued upgrade never invokes native teardown while the native lifecycle is active", async () => {
  const { NativeTerminal } = await import("../src/server/terminal.js");
  const descriptor = Object.getOwnPropertyDescriptor(
    NativeTerminal.prototype,
    "idle",
  )!;
  const originalStop = NativeTerminal.prototype.stop;
  let nativeActive = true,
    stops = 0,
    applications = 0;
  Object.defineProperty(NativeTerminal.prototype, "idle", {
    ...descriptor,
    get() {
      return !nativeActive && descriptor.get!.call(this);
    },
  });
  NativeTerminal.prototype.stop = function () {
    stops++;
    return originalStop.call(this);
  };
  const home = await mkdtemp(join(tmpdir(), "coach-native-queue-"));
  const store = new Store(home);
  await store.init();
  const updates = new Updates(
    "a".repeat(40),
    async () => {
      applications++;
    },
    fetch,
    undefined,
    async () => {},
  );
  updates.latest = "b".repeat(40);
  updates.checkedAt = Date.now();
  const app = await admin(store, 0, undefined, undefined, updates);
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  try {
    const response = await fetch(app.origin + "/api/update/apply", {
      method: "POST",
      headers,
      body: JSON.stringify({ sha: updates.latest, confirm: true }),
    });
    assert.equal(response.status, 202);
    const queued = await response.json();
    const data = await (
      await fetch(app.origin + "/api/update", { headers })
    ).json();
    assert.equal(data.manualQueue.phase, "waiting-native");
    assert.equal(stops, 0);
    assert.equal(applications, 0);
    assert.equal(
      (
        await fetch(app.origin + "/api/terminal/ticket", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      409,
    );
    const cancelled = await fetch(app.origin + "/api/update/cancel", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: queued.id }),
    });
    assert.equal(cancelled.status, 200);
    assert.equal(stops, 0);
    assert.equal(applications, 0);
  } finally {
    nativeActive = false;
    await app.close();
    Object.defineProperty(NativeTerminal.prototype, "idle", descriptor);
    NativeTerminal.prototype.stop = originalStop;
    await rm(home, { recursive: true, force: true });
  }
});

test("slow preparation cannot queue under a changed configuration scope", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-stale-queue-scope-"));
  const store = new Store(home);
  await store.init();
  let applications = 0,
    cancellations = 0;
  const updates = new Updates(
    "a".repeat(40),
    async () => {
      applications++;
    },
    fetch,
    undefined,
    async () => {
      await store.save({
        ...store.publicConfig(),
        persona: {
          ...store.publicConfig().persona,
          name: "Changed during preparation",
        },
      });
    },
    async () => {
      cancellations++;
    },
  );
  updates.latest = "b".repeat(40);
  updates.checkedAt = Date.now();
  const app = await admin(store, 0, undefined, undefined, updates);
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  try {
    const response = await fetch(app.origin + "/api/update/apply", {
      method: "POST",
      headers,
      body: JSON.stringify({ sha: updates.latest, confirm: true }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "OPERATION_IN_PROGRESS");
    assert.equal(applications, 0);
    assert.equal(cancellations, 1);
    assert.equal(
      store.publicConfig().persona.name,
      "Changed during preparation",
    );
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
