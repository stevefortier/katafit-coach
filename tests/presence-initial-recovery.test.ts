import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { Updates } from "../src/update/updates.js";
import { Worker } from "../src/worker/runner.js";

// Issue 170: the replacement Worker's initial presence registration commits
// on the backend but its reply is lost, so no generation reaches the Worker.

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
async function waitFor(check: () => boolean, ms = 3000) {
  for (let i = 0; i < ms / 10; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("timed out waiting for wire event");
}

type Report = { instance_id: string; state: string; generation?: string };
type Plan = {
  /** Defer the backend transaction until released (deferred HTTP response). */
  hold?: Promise<void>;
  /** Commit only after the client gave up (the live 2-second call timeout). */
  commitAfterAbort?: boolean;
  /** "lost": committed, then the reply is lost in transit. */
  respond?: "lost" | "malformed" | "unavailable" | "not-committed";
};

/** Real HTTP MCP backend implementing the canonical reportWorkerPresence
 * contract (regimen-backend core/personalExternalCoach.js). */
async function backend() {
  const rows = new Map<
    string,
    { state: "running" | "stopped"; generation: string; previous?: string }
  >();
  const reports: Report[] = [];
  const committed: Report[] = [];
  const calls: string[] = [];
  const plans: Record<string, Plan[]> = { running: [], stopped: [] };
  const queue = { requests: false };
  const progress = { settled: 0 };
  let sequence = 0;
  const next = () => (++sequence).toString(16).padStart(32, "0");
  const stale = { code: "WORKER_PRESENCE_STALE" };
  const apply = (args: Report): { value?: any; error?: any } => {
    const row = rows.get(args.instance_id);
    if (args.state === "running") {
      if (args.generation === undefined) {
        // Generation-less: refresh only a still-running row (idempotent, no
        // rotation); never revive a stopped instance ID; else register.
        if (row?.state === "running")
          return {
            value: {
              instance_id: args.instance_id,
              state: "running",
              generation: row.generation,
              idempotent: true,
            },
          };
        if (row) return { error: stale };
        const generation = next();
        rows.set(args.instance_id, { state: "running", generation });
        return {
          value: {
            instance_id: args.instance_id,
            state: "running",
            generation,
          },
        };
      }
      if (row?.state === "running" && row.generation === args.generation) {
        const generation = next();
        rows.set(args.instance_id, {
          state: "running",
          generation,
          previous: args.generation,
        });
        return {
          value: {
            instance_id: args.instance_id,
            state: "running",
            generation,
          },
        };
      }
      if (row?.state === "running" && row.previous === args.generation)
        return {
          value: {
            instance_id: args.instance_id,
            state: "running",
            generation: row.generation,
            idempotent: true,
          },
        };
      return { error: stale };
    }
    if (args.generation === undefined)
      return { error: { code: "WORKER_PRESENCE_GENERATION_REQUIRED" } };
    const matches =
      row &&
      (row.generation === args.generation || row.previous === args.generation);
    if (matches && row.state === "running") {
      row.state = "stopped";
      return { value: { instance_id: args.instance_id, state: "stopped" } };
    }
    if (matches)
      return {
        value: {
          instance_id: args.instance_id,
          state: "stopped",
          idempotent: true,
        },
      };
    return { error: stale };
  };
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
    let result: any = { structuredContent: {} };
    if (name === "initialize") result = { protocolVersion: "2025-03-26" };
    else if (name === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    } else if (name === "tools/list")
      result = { tools: [{ name: "coach_report_worker_presence" }] };
    else if (name === "coach_report_worker_presence") {
      reports.push({ ...args });
      const plan = plans[args.state]?.shift() ?? {};
      if (plan.respond === "unavailable") {
        res.writeHead(503).end();
        return;
      }
      if (plan.respond === "not-committed") {
        res.destroy();
        return;
      }
      if (plan.commitAfterAbort)
        await new Promise<void>((r) => res.once("close", () => r()));
      await plan.hold;
      const outcome = apply(args);
      progress.settled++;
      if (outcome.value) committed.push({ ...args });
      if (outcome.value && (plan.respond === "lost" || plan.commitAfterAbort)) {
        res.destroy();
        return;
      }
      result = outcome.value
        ? {
            structuredContent:
              plan.respond === "malformed"
                ? { ...outcome.value, generation: "not-a-generation" }
                : outcome.value,
          }
        : { structuredContent: outcome.error, isError: true };
    } else if (name === "coach_list_requests")
      result = {
        structuredContent: {
          requests: queue.requests ? [{ status: "queued" }] : [],
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
    if (res.destroyed) return;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    origin: `http://127.0.0.1:${(server.address() as any).port}`,
    rows,
    reports,
    committed,
    calls,
    queue,
    progress,
    plan(state: "running" | "stopped", plan: Plan) {
      plans[state].push(plan);
    },
    /** Out-of-band generation-bound stop (e.g. an operator), not Worker proof. */
    stopOutOfBand(instanceId: string) {
      rows.get(instanceId)!.state = "stopped";
    },
    instances: () => [
      ...new Set(
        reports.filter((r) => r.state === "running").map((r) => r.instance_id),
      ),
    ],
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

type Provider = { model: string; apiKey: string };
async function studio(options: { updates?: boolean } = {}) {
  const f = await backend();
  const dir = await mkdtemp(tmpdir() + "/presence-initial-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
    provider: {
      baseUrl: "http://127.0.0.1:9/old",
      model: "synthetic-old",
      vision: false,
    },
    apiKey: "synthetic-old-key",
  });
  const inferred: Provider[] = [];
  const app = await admin(
    store,
    0,
    async (provider: any, _system, _context, signal) => {
      inferred.push({ model: provider.model, apiKey: provider.apiKey });
      // Never publishes: replay would be visible as a second claim/inference.
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(Error("CANCELLED"));
        else
          signal.addEventListener("abort", () => reject(Error("CANCELLED")), {
            once: true,
          });
      });
      return "never published";
    },
    undefined,
    options.updates ? new Updates(null, async () => {}) : undefined,
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
  const status = async () =>
    (await fetch(app.origin + "/api/status", { headers })).json();
  const logs = async () =>
    (await (await fetch(app.origin + "/api/logs", { headers })).json())
      .entries as any[];
  /** Run, then save a provider change whose replacement's initial
   * registration is answered according to `initial`. */
  const strand = async (initial: Plan) => {
    const run = await post("run");
    assert.equal(run.status, 200);
    await waitFor(() => f.calls.includes("coach_list_requests"));
    f.plan("running", initial);
    const saved = await post("config", {
      ...store.publicConfig(),
      provider: {
        baseUrl: "http://127.0.0.1:9/new",
        model: "synthetic-new",
        vision: false,
      },
      apiKey: "synthetic-new-key",
      confirmRestart: true,
    });
    const body = await saved.json();
    assert.equal(saved.status, 200, JSON.stringify(body));
    assert.equal(body.lifecycle.applied, true);
    assert.equal(body.lifecycle.wasRunning, true);
    assert.equal(body.lifecycle.resumed, false);
    assert.equal(body.lifecycle.error, "COACH_RESTART_FAILED");
    const [old, stranded] = f.instances();
    assert.equal(f.rows.get(old)?.state, "stopped", "old Worker stopped");
    const state = await status();
    assert.equal(state.state, "stopped");
    assert.equal(state.presence, "unconfirmed");
    assert.equal(state.stopConfirmed, false);
    assert.equal(state.safeToReplace, true);
    return {
      stranded,
      revision: store.publicConfig().revision,
      callsAfterStrand: f.calls.length,
    };
  };
  /** No poll, claim, task or provider work happened since `from`. */
  const noWorkSince = (from: number) => {
    const work = f.calls
      .slice(from)
      .filter(
        (name) =>
          ![
            "initialize",
            "notifications/initialized",
            "tools/list",
            "coach_report_worker_presence",
          ].includes(name),
      );
    assert.deepEqual(work, [], "no work under the stranded Worker");
    assert.equal(inferred.length, 0, "no provider/native dispatch");
  };
  return {
    f,
    store,
    app,
    post,
    status,
    logs,
    strand,
    noWorkSince,
    inferred,
    async close() {
      await app.close();
      await f.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const diskRevision = async (store: Store) => {
  const disk = new Store(store.dir);
  await disk.init();
  return disk.publicConfig().revision;
};

test("issue170: committed initial registration with a timed-out reply recovers through Retry to exactly one replacement", async () => {
  const s = await studio();
  try {
    // Live shape: the 2-second call boundary expires; the backend commits
    // running slightly later. No generation ever reaches the Worker.
    const { stranded, revision, callsAfterStrand } = await s.strand({
      commitAfterAbort: true,
    });
    await waitFor(() => s.f.rows.get(stranded)?.state === "running");
    assert.equal(
      (await s.status()).presenceStopRecovery,
      "identity-unavailable",
    );
    s.f.queue.requests = true;
    s.noWorkSince(callsAfterStrand);

    const retry = await s.post("run");
    const retried = await retry.json();
    assert.equal(retry.status, 200, JSON.stringify(retried));
    assert.equal(retried.presence, "reported");

    // The stranded instance itself is settled first: its generation-less
    // same-instance report returns the committed generation unrotated, and
    // only that generation is stopped. No guessed generation, no new identity.
    const strandedReports = s.f.reports.filter(
      (r) => r.instance_id === stranded,
    );
    const generation = s.f.rows.get(stranded)!.generation;
    assert.deepEqual(strandedReports, [
      { instance_id: stranded, state: "running" },
      { instance_id: stranded, state: "running" },
      { instance_id: stranded, state: "stopped", generation },
    ]);
    assert.equal(s.f.rows.get(stranded)?.state, "stopped");
    const instances = s.f.instances();
    assert.equal(instances.length, 3, "exactly one replacement Worker");
    const replacement = instances[2];
    assert.equal(s.f.rows.get(replacement)?.state, "running");
    const firstReplacementReport = s.f.reports.findIndex(
      (r) => r.instance_id === replacement,
    );
    const strandedStop = s.f.reports.findIndex(
      (r) => r.instance_id === stranded && r.state === "stopped",
    );
    assert.ok(strandedStop < firstReplacementReport, "stop before replace");

    // The replacement runs the saved revision; nothing was saved again.
    await waitFor(() => s.inferred.length === 1);
    assert.deepEqual(s.inferred, [
      { model: "synthetic-new", apiKey: "synthetic-new-key" },
    ]);
    assert.equal(s.store.publicConfig().revision, revision);
    assert.equal(await diskRevision(s.store), revision);
    assert.equal(
      s.f.calls.filter((c) => c === "coach_claim_request").length,
      1,
      "one claim, no replay",
    );
    const state = await s.status();
    assert.equal(state.presence, "reported");
    assert.equal(state.presenceStopRecovery, "none");
    assert.equal(state.lifecycle?.error, undefined);
    const logs = await s.logs();
    assert.ok(
      logs.some(
        (e) => e.stage === "presence-stop-recovery" && e.level === "info",
      ),
    );
  } finally {
    await s.close();
  }
});

test("issue170: initial registration that never committed is registered and stopped under the same instance", async () => {
  const s = await studio();
  try {
    const { stranded, callsAfterStrand } = await s.strand({
      respond: "not-committed",
    });
    assert.equal(s.f.rows.has(stranded), false);
    s.noWorkSince(callsAfterStrand);
    const retry = await s.post("run");
    assert.equal(retry.status, 200, await retry.clone().text());
    assert.deepEqual(
      s.f.reports
        .filter((r) => r.instance_id === stranded)
        .map((r) => [r.state, r.generation]),
      [
        ["running", undefined],
        ["running", undefined],
        ["stopped", s.f.rows.get(stranded)!.generation],
      ],
    );
    assert.equal(s.f.rows.get(stranded)?.state, "stopped");
    assert.equal(s.f.instances().length, 3);
    assert.equal(s.inferred.length, 0);
  } finally {
    await s.close();
  }
});

test("issue170: repeated reply loss stays unconfirmed and bounded until a later Retry proves stop", async () => {
  const s = await studio();
  try {
    const { stranded, revision } = await s.strand({ respond: "lost" });
    // Retry 1: the recovery registration reply is lost again.
    s.f.plan("running", { respond: "lost" });
    const first = await s.post("run");
    assert.equal(first.status, 400);
    assert.equal((await first.json()).error, "WORKER_STOP_UNCONFIRMED");
    assert.equal(s.f.instances().length, 2, "no replacement");
    assert.equal(
      s.f.reports.filter((r) => r.instance_id === stranded).length,
      2,
      "one bounded recovery report per Retry",
    );
    assert.equal(
      (await s.status()).presenceStopRecovery,
      "identity-unavailable",
    );
    // Retry 2: the registration is acknowledged but the stop reply is lost.
    s.f.plan("stopped", { respond: "lost" });
    const second = await s.post("run");
    assert.equal(second.status, 400);
    assert.equal(s.f.rows.get(stranded)?.state, "stopped");
    assert.equal(s.f.instances().length, 2, "committed stop is not proof");
    assert.equal((await s.status()).presenceStopRecovery, "pending");
    // Retry 3: the retained generation's stop is acknowledged idempotently.
    const third = await s.post("run");
    assert.equal(third.status, 200, await third.clone().text());
    const strandedReports = s.f.reports.filter(
      (r) => r.instance_id === stranded,
    );
    const generation = s.f.rows.get(stranded)!.generation;
    assert.deepEqual(
      strandedReports.map((r) => [r.state, r.generation]),
      [
        ["running", undefined],
        ["running", undefined],
        ["running", undefined],
        ["stopped", generation],
        ["stopped", generation],
      ],
      "same instance, never rotated, never guessed",
    );
    assert.equal(s.f.instances().length, 3, "exactly one replacement");
    assert.equal(s.store.publicConfig().revision, revision);
    assert.equal(s.inferred.length, 0);
    const warns = (await s.logs()).filter(
      (e) => e.stage === "presence-stop-recovery" && e.level === "warn",
    );
    assert.equal(warns.length, 2);
  } finally {
    await s.close();
  }
});

for (const shape of ["stale", "malformed", "unavailable"] as const)
  test(`issue170: ${shape} recovery evidence fails closed without replacement or work`, async () => {
    const s = await studio();
    try {
      const { stranded, callsAfterStrand, revision } = await s.strand({
        respond: "lost",
      });
      if (shape === "stale")
        // A stopped row denies revival; the denial is not this Worker's proof.
        s.f.stopOutOfBand(stranded);
      for (let i = 0; i < 2; i++) {
        if (shape !== "stale") s.f.plan("running", { respond: shape });
        const retry = await s.post("run");
        assert.equal(retry.status, 400);
        assert.equal((await retry.json()).error, "WORKER_STOP_UNCONFIRMED");
      }
      const state = await s.status();
      assert.equal(state.state, "stopped");
      assert.equal(state.presence, "unconfirmed");
      assert.equal(state.stopConfirmed, false);
      assert.equal(state.presenceStopRecovery, "identity-unavailable");
      assert.equal(s.f.instances().length, 2, "no replacement Worker");
      assert.deepEqual(
        s.f.reports
          .filter((r) => r.instance_id === stranded)
          .map((r) => [r.state, r.generation]),
        [
          ["running", undefined],
          ["running", undefined],
          ["running", undefined],
        ],
        "no stop without an issued generation; one report per Retry",
      );
      s.noWorkSince(callsAfterStrand);
      assert.equal(s.store.publicConfig().revision, revision);
      const warns = (await s.logs()).filter(
        (e) => e.stage === "presence-stop-recovery" && e.level === "warn",
      );
      assert.equal(warns.length, 2);
      assert.ok(warns.every((e) => typeof e.code === "string"));
      if (shape !== "stale") {
        // The same instance still recovers once evidence is well formed.
        const retry = await s.post("run");
        assert.equal(retry.status, 200, await retry.clone().text());
        assert.equal(s.f.rows.get(stranded)?.state, "stopped");
        assert.equal(s.f.instances().length, 3);
      }
    } finally {
      await s.close();
    }
  });

test("issue170: Stop, configuration, Run and shutdown serialize with a deferred recovery reply", async () => {
  const s = await studio();
  try {
    const { stranded, revision } = await s.strand({ respond: "lost" });
    const hold = deferred();
    s.f.plan("running", { hold: hold.promise });
    const reportsBefore = s.f.reports.length;
    const retry = s.post("run");
    await waitFor(() => s.f.reports.length === reportsBefore + 1);
    // While the recovery transaction is deferred, nothing else is admitted.
    for (const [path, body] of [
      ["stop", {}],
      ["run", {}],
      [
        "config",
        {
          ...s.store.publicConfig(),
          persona: { ...s.store.publicConfig().persona, name: "Late" },
          confirmRestart: true,
        },
      ],
    ] as const) {
      const response = await s.post(path, body);
      assert.equal(response.status, 409, path);
      assert.equal((await response.json()).error, "OPERATION_IN_PROGRESS");
    }
    assert.equal(s.store.publicConfig().revision, revision);
    hold.resolve();
    const settled = await retry;
    assert.equal(settled.status, 200, await settled.clone().text());
    assert.equal(s.f.rows.get(stranded)?.state, "stopped");
    assert.equal(s.f.instances().length, 3, "exactly one replacement");
    assert.equal(s.store.publicConfig().revision, revision);
  } finally {
    await s.close();
  }
});

test("issue170: shutdown during a deferred recovery waits for it and never starts a replacement", async () => {
  const s = await studio();
  try {
    const { stranded } = await s.strand({ respond: "lost" });
    const hold = deferred();
    s.f.plan("running", { hold: hold.promise });
    const reportsBefore = s.f.reports.length;
    const retry = s.post("run").catch(() => undefined);
    await waitFor(() => s.f.reports.length === reportsBefore + 1);
    let closed = false;
    const closing = s.app.close().then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(closed, false, "shutdown joins the in-flight recovery");
    hold.resolve();
    await closing;
    await retry;
    assert.equal(s.f.rows.get(stranded)?.state, "stopped");
    assert.equal(s.f.instances().length, 2, "no replacement after shutdown");
  } finally {
    await s.close();
  }
});

test("issue170: a late original registration cannot revive the stopped instance or touch its replacement", async () => {
  const s = await studio();
  try {
    // The original transaction is still pending when the client gives up.
    const original = deferred();
    const { stranded } = await s.strand({
      commitAfterAbort: true,
      hold: original.promise,
    });
    assert.equal(s.f.rows.has(stranded), false);
    const retry = await s.post("run");
    assert.equal(retry.status, 200, await retry.clone().text());
    assert.equal(s.f.rows.get(stranded)?.state, "stopped");
    const replacement = s.f.instances()[2];
    const replacementRow = { ...s.f.rows.get(replacement)! };
    const committed = s.f.committed.length;
    const settled = s.f.progress.settled;
    original.resolve();
    await waitFor(() => s.f.progress.settled === settled + 1);
    assert.equal(s.f.committed.length, committed, "late write denied");
    assert.equal(s.f.rows.get(stranded)?.state, "stopped");
    assert.deepEqual(s.f.rows.get(replacement), replacementRow);
    assert.equal((await s.status()).presence, "reported");
  } finally {
    await s.close();
  }
});

test("issue170: update release settles a stranded initial registration before resuming", async () => {
  const s = await studio({ updates: true });
  try {
    const { stranded } = await s.strand({ respond: "lost" });
    const quiesce = await s.post("update/quiesce", { confirm: true });
    assert.equal(quiesce.status, 409);
    assert.equal((await quiesce.json()).error, "WORKER_STOP_UNCONFIRMED");
    assert.equal((await s.post("run")).status, 409, "update barrier holds");
    const release = await s.post("update/release");
    assert.equal(release.status, 200, await release.clone().text());
    assert.equal(s.f.rows.get(stranded)?.state, "stopped");
    assert.equal((await s.status()).stopConfirmed, true);
    assert.equal(s.f.instances().length, 2, "release does not start a Worker");
    assert.equal((await s.post("run")).status, 200);
    assert.equal(s.f.instances().length, 3);
  } finally {
    await s.close();
  }
});

test("issue170: Worker recovery is single-flight, requires settled Stop, and Stop joins it", async () => {
  const f = await backend();
  try {
    f.plan("running", { respond: "lost" });
    const w = new Worker({
      origin: f.origin,
      token: "synthetic-token",
      system: "Coach",
      complete: async () => "reply",
      pollMs: 10000,
    });
    await assert.rejects(w.start());
    // start() failed, but Stop has not settled: no recovery may begin.
    await w.recoverStoppedPresence();
    assert.equal(f.reports.length, 1);
    await w.stop();
    assert.equal(w.presenceStopRecovery, "identity-unavailable");
    const hold = deferred();
    f.plan("running", { hold: hold.promise });
    const one = w.recoverStoppedPresence();
    const two = w.recoverStoppedPresence();
    await waitFor(() => f.reports.length === 2);
    let stopped = false;
    const stop = w.stop().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(stopped, false);
    hold.resolve();
    await Promise.all([one, two, stop]);
    assert.equal(f.reports.length, 3, "one recovery sequence");
    assert.equal(w.stopConfirmed, true);
    assert.equal(w.presenceStopRecovery, "none");
    assert.equal(f.calls.includes("coach_list_requests"), false);
  } finally {
    await f.close();
  }
});
