import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { Worker } from "../src/worker/runner.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("timed out waiting for wire event");
}
async function backend(
  options: {
    supported?: boolean;
    failRunning?: boolean;
    holdRunning?: boolean;
    queued?: boolean;
  } = {},
) {
  const reports: Array<{ instance_id: string; state: string }> = [];
  const calls: string[] = [];
  const entered = deferred<void>();
  const release = deferred<void>();
  const server = createServer(async (req, res) => {
    if (
      req.method === "POST" &&
      req.headers.authorization !== "Bearer synthetic-token"
    ) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === "GET") {
      res.end("# Kata.fit external Coach agent v1\nSynthetic policy");
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const msg = JSON.parse(raw);
    const name = msg.params?.name ?? msg.method;
    calls.push(name);
    const args = msg.params?.arguments;
    let result: any = {};
    if (name === "initialize") result = { protocolVersion: "2025-03-26" };
    else if (name === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    } else if (name === "tools/list")
      result = {
        tools:
          options.supported === false
            ? []
            : [{ name: "coach_report_worker_presence" }],
      };
    else if (name === "coach_report_worker_presence") {
      reports.push(args);
      if (args.state === "running" && options.holdRunning) {
        entered.resolve();
        await release.promise;
      }
      result = {
        structuredContent: { ok: true },
        ...(args.state === "running" && options.failRunning
          ? { isError: true }
          : {}),
      };
    } else if (name === "coach_list_requests")
      result = {
        structuredContent: {
          requests: options.queued ? [{ status: "queued" }] : [],
        },
      };
    else if (name === "coach_claim_request")
      result = {
        structuredContent: {
          request: {
            id: "synthetic",
            requester_id: "member",
            scope: "personal",
            lease_generation: 1,
            lease_expires_at: new Date(Date.now() + 120000).toISOString(),
            timeout_at: new Date(Date.now() + 180000).toISOString(),
          },
        },
      };
    else if (name === "coach_read_context")
      result = {
        structuredContent: {
          request: {
            id: "synthetic",
            requester_id: "member",
            scope: "personal",
            lease_generation: 1,
            attachment_count: 0,
          },
          conversation: [],
        },
      };
    else result = { structuredContent: {} };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    origin: `http://127.0.0.1:${(server.address() as any).port}`,
    calls,
    reports,
    entered: entered.promise,
    release: () => release.resolve(),
    async close() {
      release.resolve();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(r));
    },
  };
}
function worker(origin: string, options: Record<string, unknown> = {}) {
  return new Worker({
    origin,
    token: "synthetic-token",
    system: "Coach",
    complete: async () => "reply",
    pollMs: 10000,
    ...options,
  });
}

test("start awaits authenticated running report; stop sends same instance stopped; restart uses new ID", async () => {
  const f = await backend();
  try {
    const first = worker(f.origin);
    assert.equal(await first.start(), "reported");
    assert.equal(first.presence, "reported");
    assert.equal(f.reports[0].state, "running");
    assert.match(f.reports[0].instance_id, /^[0-9a-f-]{36}$/);
    await first.stop();
    await assert.rejects(first.start(), /CANCELLED/);
    assert.deepEqual(f.reports.slice(0, 2), [
      { ...f.reports[0], state: "running" },
      { ...f.reports[0], state: "stopped" },
    ]);
    const second = worker(f.origin);
    await second.start();
    await waitFor(() => f.calls.includes("coach_list_requests"));
    assert.notEqual(f.reports[2].instance_id, f.reports[0].instance_id);
    await second.stop();
    assert.equal(f.reports[3].instance_id, f.reports[2].instance_id);
    assert.ok(f.calls.includes("coach_list_requests"), "polling still runs");
  } finally {
    await f.close();
  }
});

test("old backend continues polling without claiming reported presence", async () => {
  const f = await backend({ supported: false });
  try {
    const w = worker(f.origin);
    assert.equal(await w.start(), "unsupported");
    await waitFor(() => f.calls.includes("coach_list_requests"));
    await w.stop();
    assert.deepEqual(f.reports, []);
  } finally {
    await f.close();
  }
});

test("failed advertised report rejects start without polling or false running state", async () => {
  const f = await backend({ failRunning: true });
  try {
    const w = worker(f.origin);
    await assert.rejects(() => w.start());
    assert.equal(w.state, "stopped");
    assert.equal(w.presence, "unconfirmed");
    assert.equal(f.calls.includes("coach_list_requests"), false);
    await w.stop();
  } finally {
    await f.close();
  }
});

test("concurrent stop and start cannot report running after stopped", async () => {
  const f = await backend({ holdRunning: true });
  try {
    const w = worker(f.origin);
    const start = w.start();
    await f.entered;
    const stop = w.stop();
    f.release();
    await Promise.allSettled([start, stop]);
    assert.equal(w.state, "stopped");
    assert.equal(f.reports.at(-1)?.state, "stopped");
    assert.equal(f.calls.includes("coach_list_requests"), false);
  } finally {
    await f.close();
  }
});

test("heartbeat reports running while inference is busy, then stops cleanly", async () => {
  const f = await backend({ queued: true });
  const inference = deferred<string>();
  const entered = deferred<void>();
  try {
    // A pending model call must not block a separate presence RPC.
    const w = worker(f.origin, {
      presenceMs: 20,
      complete: () => {
        entered.resolve();
        return inference.promise;
      },
    });
    await w.start();
    await entered.promise;
    await waitFor(
      () => f.reports.filter((r) => r.state === "running").length >= 2,
    );
    const n = f.reports.length;
    await w.stop();
    assert.equal(f.reports.at(-1)?.state, "stopped");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(f.reports.length, n + 1);
  } finally {
    inference.resolve("reply");
    await f.close();
  }
});

test("Studio run and shutdown report presence through real MCP before success", async () => {
  const f = await backend();
  const dir = await mkdtemp(tmpdir() + "/coach-presence-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
    apiKey: "synthetic-key",
  });
  const app = await admin(
    store,
    0,
    async () => "reply",
    () => {},
  );
  const post = (path: string) =>
    fetch(app.origin + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + store.secrets.admin,
        Origin: app.origin,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
  try {
    const run = await post("/api/run");
    assert.equal(run.status, 200);
    assert.equal((await run.json()).presence, "reported");
    assert.equal(f.reports[0].state, "running");
    const shutdown = await post("/api/shutdown");
    assert.equal(shutdown.status, 200);
    await app.close();
    assert.equal(f.reports.at(-1)?.state, "stopped");
  } finally {
    await app.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Studio on old backend marks presence unsupported but remains runnable", async () => {
  const f = await backend({ supported: false });
  const dir = await mkdtemp(tmpdir() + "/coach-presence-old-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
    apiKey: "synthetic-key",
  });
  const app = await admin(store, 0, async () => "reply");
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  try {
    const run = await fetch(app.origin + "/api/run", {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(run.status, 200);
    assert.equal((await run.json()).presence, "unsupported");
    const status = await (
      await fetch(app.origin + "/api/status", { headers })
    ).json();
    assert.equal(status.presence, "unsupported");
    await waitFor(() => f.calls.includes("coach_list_requests"));
    assert.equal(
      (
        await fetch(app.origin + "/api/stop", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      200,
    );
    assert.deepEqual(f.reports, []);
  } finally {
    await app.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
