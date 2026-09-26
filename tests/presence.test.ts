import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { Worker } from "../src/worker/runner.js";
import { Client } from "../src/katafit/client.js";
import { Updates } from "../src/update/updates.js";
import { AutoUpdateSetting } from "../src/update/auto.js";

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
    holdFirstRunning?: boolean;
    queued?: boolean;
    refuseStopped?: boolean;
    loseRunningReply?: boolean;
    invalidRunningGeneration?: boolean;
  } = {},
) {
  const reports: Array<{
    instance_id: string;
    state: string;
    generation?: string;
  }> = [];
  const accepted: typeof reports = [];
  const generations = new Map<string, string>();
  const seen = new Set<string>();
  let sequence = 0;
  const calls: string[] = [];
  const entered = deferred<void>();
  const release = deferred<void>();
  const deferredWrite = deferred<void>();
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
      if (
        args.state === "running" &&
        ((options.holdRunning &&
          reports.filter((r) => r.state === "running").length > 1) ||
          (options.holdFirstRunning &&
            reports.filter((r) => r.state === "running").length === 1))
      ) {
        entered.resolve();
        await release.promise;
      }
      // Model the backend's atomic state+generation compare-and-swap at write
      // time (after a deliberately deferred request), not request arrival.
      const current = generations.get(args.instance_id);
      const valid =
        args.state === "running"
          ? current === undefined
            ? !seen.has(args.instance_id) && args.generation === undefined
            : args.generation === current
          : args.state === "stopped" &&
            current !== undefined &&
            args.generation === current &&
            !options.refuseStopped;
      if (valid) {
        accepted.push(args);
        if (args.state === "running") {
          seen.add(args.instance_id);
          generations.set(
            args.instance_id,
            (++sequence).toString(16).padStart(32, "0"),
          );
        } else generations.delete(args.instance_id);
      }
      if (
        valid &&
        args.state === "running" &&
        options.loseRunningReply &&
        reports.filter((r) => r.state === "running").length > 1
      ) {
        // Commit succeeded but the transport lost the acknowledgment.
        res.destroy();
        return;
      }
      if (
        options.holdRunning &&
        args.state === "running" &&
        reports.filter((r) => r.state === "running").length > 1
      )
        deferredWrite.resolve();
      result = {
        structuredContent: valid
          ? {
              ok: true,
              state: args.state,
              ...(args.state === "running"
                ? {
                    generation:
                      options.invalidRunningGeneration &&
                      reports.filter((r) => r.state === "running").length > 1
                        ? "not-a-generation"
                        : generations.get(args.instance_id),
                  }
                : {}),
            }
          : { code: "WORKER_PRESENCE_STALE" },
        ...(!valid || (args.state === "running" && options.failRunning)
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
    accepted,
    entered: entered.promise,
    deferredWrite: deferredWrite.promise,
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

test("start and stop use the issued generation; restart has a new incarnation", async () => {
  const f = await backend();
  try {
    const first = worker(f.origin);
    assert.equal(await first.start(), "reported");
    assert.equal(first.presence, "reported");
    assert.equal(f.reports[0].state, "running");
    assert.match(f.reports[0].instance_id, /^[0-9a-f-]{36}$/);
    await first.stop();
    assert.equal(first.presence, "reported");
    await assert.rejects(first.start(), /CANCELLED/);
    assert.deepEqual(f.reports.slice(0, 2), [
      { ...f.reports[0], state: "running" },
      {
        ...f.reports[0],
        state: "stopped",
        generation: "00000000000000000000000000000001",
      },
    ]);
    assert.equal(f.accepted.length, 2);
    const second = worker(f.origin);
    await second.start();
    await waitFor(() => f.calls.includes("coach_list_requests"));
    assert.notEqual(f.reports[2].instance_id, f.reports[0].instance_id);
    await second.stop();
    assert.equal(f.reports[3].instance_id, f.reports[2].instance_id);
    assert.equal(f.reports[3].generation, "00000000000000000000000000000002");
    assert.equal(f.accepted.length, 4);
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
  const f = await backend({ holdFirstRunning: true });
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
    await w.stop();
    assert.equal(f.reports.at(-1)?.state, "stopped");
    assert.equal(
      f.reports.at(-1)?.generation,
      f.reports
        .filter((r) => r.state === "running")
        .length.toString(16)
        .padStart(32, "0"),
    );
    assert.equal(f.accepted.length, f.reports.length);
    const stoppedCount = f.reports.length;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(f.reports.length, stoppedCount);
  } finally {
    inference.resolve("reply");
    await f.close();
  }
});

test("stale stop cannot erase a restarted incarnation with the same instance ID", async () => {
  const f = await backend();
  try {
    const c = new Client(
      f.origin,
      "synthetic-token",
      AbortSignal.timeout(3000),
    );
    await c.connect();
    const first = await c.call("coach_report_worker_presence", {
      instance_id: "same",
      state: "running",
    });
    const second = await c.call("coach_report_worker_presence", {
      instance_id: "same",
      state: "running",
      generation: first.generation,
    });
    assert.notEqual(first.generation, second.generation);
    await assert.rejects(
      c.call("coach_report_worker_presence", {
        instance_id: "same",
        state: "stopped",
        generation: first.generation,
      }),
      /MCP_TOOL_FAILED/,
    );
    assert.equal(f.accepted.length, 2);
    await c.call("coach_report_worker_presence", {
      instance_id: "same",
      state: "stopped",
      generation: second.generation,
    });
    assert.equal(f.accepted.at(-1)?.state, "stopped");
  } finally {
    await f.close();
  }
});

test("old instance heartbeat cannot recreate presence after its generation was stopped", async () => {
  const f = await backend();
  try {
    const c = new Client(
      f.origin,
      "synthetic-token",
      AbortSignal.timeout(3000),
    );
    await c.connect();
    const first = await c.call("coach_report_worker_presence", {
      instance_id: "old-instance",
      state: "running",
    });
    await c.call("coach_report_worker_presence", {
      instance_id: "old-instance",
      state: "stopped",
      generation: first.generation,
    });
    await assert.rejects(
      c.call("coach_report_worker_presence", {
        instance_id: "old-instance",
        state: "running",
        generation: first.generation,
      }),
      /MCP_TOOL_FAILED/,
    );
    assert.deepEqual(
      f.accepted.map((r) => r.state),
      ["running", "stopped"],
    );
  } finally {
    await f.close();
  }
});

test("every heartbeat presents its current generation and rotates before Stop", async () => {
  const f = await backend();
  try {
    const w = worker(f.origin, { presenceMs: 40 });
    await w.start();
    await waitFor(
      () => f.accepted.filter((r) => r.state === "running").length >= 3,
    );
    await w.stop();
    const running = f.accepted.filter((r) => r.state === "running");
    assert.equal(running[0].generation, undefined);
    for (let i = 1; i < running.length; i++)
      assert.equal(running[i].generation, i.toString(16).padStart(32, "0"));
    assert.equal(
      f.accepted.at(-1)?.generation,
      running.length.toString(16).padStart(32, "0"),
    );
    assert.equal(w.presence, "reported");
  } finally {
    await f.close();
  }
});

test("timed-out heartbeat cannot revive a confirmed Stop when its backend write resumes", async () => {
  const f = await backend({ holdRunning: true });
  try {
    const w = worker(f.origin, { presenceMs: 20 });
    await w.start();
    await f.entered;
    const stopping = w.stop();
    await stopping;
    assert.equal(w.presence, "reported");
    assert.equal(f.accepted.at(-1)?.state, "stopped");
    f.release();
    await f.deferredWrite;
    assert.equal(f.accepted.at(-1)?.state, "stopped");
    assert.equal(f.accepted.filter((r) => r.state === "running").length, 1);
  } finally {
    await f.close();
  }
});

test("lost heartbeat reply leaves Stop unconfirmed instead of claiming offline", async () => {
  const f = await backend({ loseRunningReply: true });
  try {
    // Keep the heartbeat well inside waitFor's one-second deadline. The
    // previous equal deadlines raced scheduler latency instead of lost replies.
    const w = worker(f.origin, { presenceMs: 40 });
    await w.start();
    await waitFor(
      () => f.accepted.filter((r) => r.state === "running").length >= 2,
    );
    await waitFor(() => w.presence === "unconfirmed");
    await w.stop();
    assert.equal(f.accepted.at(-1)?.state, "running");
    assert.equal(w.presence, "unconfirmed");
  } finally {
    await f.close();
  }
});

test("invalid heartbeat generation is not retained as a Stop fence", async () => {
  const f = await backend({ invalidRunningGeneration: true });
  try {
    const w = worker(f.origin, { presenceMs: 20 });
    await w.start();
    await waitFor(
      () => f.accepted.filter((r) => r.state === "running").length >= 2,
    );
    await waitFor(() => w.presence === "unconfirmed");
    await w.stop();
    assert.equal(
      f.reports.at(-1)?.generation,
      "00000000000000000000000000000001",
    );
    assert.equal(f.accepted.at(-1)?.state, "running");
    assert.equal(w.presence, "unconfirmed");
  } finally {
    await f.close();
  }
});

test("stop waits for in-flight heartbeat rotation before sending latest generation", async () => {
  const f = await backend({ holdRunning: true });
  try {
    const w = worker(f.origin, { presenceMs: 20 });
    await w.start();
    await f.entered;
    const stopping = w.stop();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(
      f.reports.some((r) => r.state === "stopped"),
      false,
    );
    f.release();
    await stopping;
    assert.equal(
      f.reports.at(-1)?.generation,
      "00000000000000000000000000000002",
    );
    assert.equal(f.accepted.length, 3);
    assert.equal(w.presence, "reported");
  } finally {
    await f.close();
  }
});

test("refused stop remains unconfirmed rather than showing server-confirmed offline", async () => {
  const f = await backend({ refuseStopped: true });
  try {
    const w = worker(f.origin);
    await w.start();
    await w.stop();
    assert.equal(w.state, "stopped");
    assert.equal(w.presence, "unconfirmed");
    assert.deepEqual(
      f.accepted.map((r) => r.state),
      ["running"],
    );
  } finally {
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
    assert.equal(f.accepted.at(-1)?.state, "stopped");
  } finally {
    await app.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Studio Stop exposes refused backend stop as unconfirmed", async () => {
  const f = await backend({ refuseStopped: true });
  const dir = await mkdtemp(tmpdir() + "/coach-presence-refused-");
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
    const stop = await fetch(app.origin + "/api/stop", {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(stop.status, 200);
    assert.equal((await stop.json()).presence, "unconfirmed");
    const status = await (
      await fetch(app.origin + "/api/status", { headers })
    ).json();
    assert.equal(status.state, "stopped");
    assert.equal(status.presence, "unconfirmed");
    assert.equal(f.accepted.at(-1)?.state, "running");
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

test("auto quiesce rejects an unconfirmed stop and retains running intent across lost replies", async () => {
  const f = await backend({ refuseStopped: true });
  const dir = await mkdtemp(tmpdir() + "/auto-presence-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
    apiKey: "synthetic-provider-key",
  });
  const app = await admin(
    store,
    0,
    undefined,
    undefined,
    new Updates(null, async () => {}),
    new AutoUpdateSetting(dir),
  );
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  const post = (path: string) =>
    fetch(app.origin + "/api/" + path, { method: "POST", headers, body: "{}" });
  const status = async () =>
    (await fetch(app.origin + "/api/status", { headers })).json();
  try {
    assert.equal((await post("run")).status, 200);
    for (let i = 0; i < 100 && (await status()).state !== "idle"; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal((await status()).state, "idle");
    // Ignore the first body, as if its acknowledgment were lost in transit.
    assert.equal((await post("update/auto/quiesce")).status, 409);
    for (let i = 0; i < 2; i++) {
      const retry = await post("update/auto/quiesce");
      assert.equal(retry.status, 409, "stopped is not safe to replace");
      assert.equal((await retry.json()).error, "WORKER_STOP_UNCONFIRMED");
      const state = await status();
      assert.equal(state.state, "stopped");
      assert.equal(state.presence, "unconfirmed");
      assert.equal(state.autoQuiesced, true);
      assert.equal(
        state.autoQuiesceReady,
        true,
        "settled for owner recovery, not install approval",
      );
      assert.equal(
        state.autoWasRunning,
        true,
        "retain pre-stop intent until owner reads it",
      );
    }
    assert.equal((await post("terminal/ticket")).status, 409);
    assert.equal((await post("update/auto/release")).status, 200);
    assert.equal(
      (await post("run")).status,
      400,
      "release cannot waive stop safety",
    );
    assert.equal((await post("update/auto/quiesce")).status, 409);
    assert.equal(f.reports.filter((r) => r.state === "running").length, 1);
  } finally {
    await app.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const loseReply of [false, true])
  test(`owner retains unsafe auto-stop recovery without staging (lost reply=${loseReply})`, async () => {
    const { supervise } = await import("./helpers/legacy-supervisor.js");
    const f = await backend({ refuseStopped: true });
    const dir = await mkdtemp(tmpdir() + "/auto-owner-presence-");
    const store = new Store(dir);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin: f.origin,
      token: "synthetic-token",
      apiKey: "synthetic-provider-key",
    });
    let prepares = 0,
      checks = 0;
    const owner = await supervise(store, 0, undefined, {
      prepare: async () => {
        prepares++;
        throw Error("must not stage");
      },
      request: async (url) => {
        checks++;
        return new Response(
          JSON.stringify(
            String(url).includes("/compare/")
              ? { status: "ahead", ahead_by: 1 }
              : { object: { sha: "e".repeat(40) } },
          ),
        );
      },
    });
    owner.updates.installed = "b".repeat(40);
    const setting = new AutoUpdateSetting(dir);
    await setting.write(true);
    const headers = {
      Authorization: "Bearer " + store.secrets.admin,
      Origin: owner.origin,
      "Content-Type": "application/json",
    };
    const originalFetch = globalThis.fetch;
    try {
      assert.equal(
        (
          await fetch(owner.origin + "/api/run", {
            method: "POST",
            headers,
            body: "{}",
          })
        ).status,
        200,
      );
      let state;
      for (let i = 0; i < 100; i++) {
        state = await (
          await fetch(owner.origin + "/api/status", { headers })
        ).json();
        if (state.state === "idle") break;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(state.state, "idle");
      if (loseReply)
        globalThis.fetch = async (input, init) => {
          const result = await originalFetch(input, init);
          if (String(input).endsWith("/api/update/auto/quiesce"))
            throw Error("synthetic lost stop reply");
          return result;
        };
      await owner.auto.tick();
      globalThis.fetch = originalFetch;
      assert.equal(
        owner.updates.snapshot().autoOutcome?.state,
        "resume-failed",
      );
      const checksBefore = checks;
      owner.updates.checkedAt = 0;
      await owner.auto.tick();
      assert.equal(
        checks,
        checksBefore,
        "recover prior intent before source checks",
      );
      assert.equal(
        owner.updates.snapshot().autoOutcome?.state,
        "resume-failed",
      );
      assert.equal(prepares, 0);
      assert.equal(await setting.failedTarget(), null);
      assert.equal(f.reports.filter((r) => r.state === "running").length, 1);
    } finally {
      globalThis.fetch = originalFetch;
      await owner.close();
      await f.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

for (const refuseStopped of [false, true])
  test(`confirmed apply preserves presence fencing (stop refused=${refuseStopped})`, async () => {
    const f = await backend({ refuseStopped });
    const dir = await mkdtemp(tmpdir() + "/apply-presence-");
    const store = new Store(dir);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin: f.origin,
      token: "synthetic-token",
      apiKey: "synthetic-provider-key",
    });
    const app = await admin(store, 0);
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
      assert.equal((await post("run")).status, 200);
      const revision = store.publicConfig().revision;
      const payload = {
        ...store.publicConfig(),
        persona: {
          ...store.publicConfig().persona,
          name: "Synthetic replacement",
        },
      };
      assert.equal((await post("config", payload)).status, 409);
      assert.equal(store.publicConfig().revision, revision);
      assert.equal(
        f.reports.filter((r) => r.state === "stopped").length,
        0,
        "no stop without confirmation",
      );
      const result = await post("config", { ...payload, confirmRestart: true });
      if (refuseStopped) {
        assert.equal(result.status, 400);
        assert.equal((await result.json()).error, "WORKER_STOP_UNCONFIRMED");
        assert.equal(store.publicConfig().revision, revision);
        assert.equal(
          (await post("run")).status,
          400,
          "Run must not bypass stop uncertainty",
        );
        assert.equal(f.reports.filter((r) => r.state === "running").length, 1);
      } else {
        assert.equal(result.status, 200);
        assert.equal((await result.json()).lifecycle.resumed, true);
        assert.deepEqual(
          f.reports.map((r) => r.state),
          ["running", "stopped", "running"],
        );
        assert.notEqual(f.reports[0].instance_id, f.reports[2].instance_id);
      }
    } finally {
      await app.close();
      await f.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

test("running provider switch captures each endpoint with only its bound key", async () => {
  const f = await backend({ queued: true });
  const dir = await mkdtemp(tmpdir() + "/apply-binding-");
  const received: Array<[string, string | undefined]> = [];
  const provider = createServer((req, res) => {
    received.push([req.url!, req.headers.authorization]);
    res.end("synthetic");
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(provider.address() as any).port}`;
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
    provider: { baseUrl: base + "/alpha", model: "synthetic", vision: false },
    apiKey: "synthetic-bound-alpha",
  });
  const app = await admin(
    store,
    0,
    async (provider, _system, _text, signal) => {
      await fetch(provider.baseUrl, {
        headers: { Authorization: "Bearer " + provider.apiKey },
        signal,
      });
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(Error("CANCELLED"));
        else
          signal.addEventListener("abort", () => reject(Error("CANCELLED")), {
            once: true,
          });
      });
      return "never published";
    },
  );
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
    await post("run");
    await waitFor(() => received.length === 1);
    const saved = await post("config", {
      ...store.publicConfig(),
      provider: {
        baseUrl: base + "/bravo",
        model: "synthetic-new",
        vision: true,
      },
      apiKey: "synthetic-bound-bravo",
      confirmRestart: true,
    });
    assert.equal(saved.status, 200, await saved.clone().text());
    await waitFor(() => received.length === 2);
    assert.deepEqual(received, [
      ["/alpha", "Bearer synthetic-bound-alpha"],
      ["/bravo", "Bearer synthetic-bound-bravo"],
    ]);
    assert.equal(
      f.calls.includes("coach_respond_request"),
      false,
      "interrupted old chat is never replayed or published",
    );
  } finally {
    await app.close();
    await f.close();
    provider.closeAllConnections();
    await new Promise<void>((r) => provider.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
