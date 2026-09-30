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
    complete: async () => "",
  });
  assert.equal(worker.quiesceForUpdate(), false); // stopped is not a live idle worker
  worker.state = "idle";
  assert.equal(worker.quiesceForUpdate(), true);
  await assert.rejects(worker.pollOnce(), /CANCELLED/);
  worker.releaseUpdateQuiesce();
});
