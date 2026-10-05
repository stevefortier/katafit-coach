import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/config/store.js";
import { HeadlessCycleRuntime } from "../src/autonomy/headless.js";
import { productionRuntimes } from "../src/autonomy/host.js";
import { CleanupRegistry } from "../src/autonomy/cleanup.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { INTEND_TOOL } from "../src/autonomy/tools.js";
import {
  closeLeaked,
  outcome,
  ScriptedRuntime,
} from "./helpers/autonomy-cycle.js";
import { autonomyAdmin, until } from "./helpers/autonomy-admin.js";
import { MEMBER } from "./helpers/autonomy-fake.js";

// C5 (work-packages §4 C5): installation-local participation, a host-only
// mandate proxy, autonomy status apart from worker presence, and production
// wiring of a planner plus its own composer headless runtime.

after(closeLeaked);

test("C5: autonomy routes are admin-only; participation is installation-local and outside the config revision", async () => {
  const planner = new ScriptedRuntime([async () => outcome()]);
  const env = await autonomyAdmin({ planners: [planner] });
  try {
    for (const [method, path] of [
      ["GET", "/api/autonomy/status"],
      ["GET", "/api/autonomy/mandate"],
      ["PUT", "/api/autonomy/mandate"],
      ["GET", "/api/autonomy/reports"],
      ["POST", "/api/autonomy/participate"],
    ])
      assert.equal(
        (
          await fetch(env.app.origin + path, {
            method,
            headers: { "Content-Type": "application/json" },
            body: method === "GET" ? undefined : "{}",
          })
        ).status,
        401,
        `${method} ${path} requires the admin bearer`,
      );
    const initial = await env.status();
    assert.equal(initial.participate, false);
    assert.equal(initial.local.state, "stopped");
    assert.equal(initial.backend.mandate.mode, "observe");
    for (const body of [
      {},
      { participate: "yes" },
      { participate: true, extra: 1 },
      { participate: true, confirmRestart: true },
    ])
      assert.deepEqual(
        (await env.call("POST", "/api/autonomy/participate", body)).status,
        400,
        JSON.stringify(body),
      );
    const revision = env.store.publicConfig().revision;
    const on = await env.call("POST", "/api/autonomy/participate", {
      participate: true,
    });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.participate, true);
    assert.notEqual(on.body.local.state, "stopped");
    assert.equal(env.store.publicConfig().revision, revision);
    const disk = new Store(env.store.dir);
    await disk.init();
    assert.deepEqual(disk.autonomySettings(), { participate: true });
    // The continuous loop claims due work with no browser involvement.
    const id = env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
    const done = await until(async () => {
      const s = await env.status();
      return s.local.lastOutcome === "completed" && s;
    }, "a completed cycle");
    assert.equal(done.local.lastWorkId, id);
    assert.equal(planner.runs[0].profile, "planner");
    assert.equal(env.fake.state.work.get(id).status, "completed");
    const off = await env.call("POST", "/api/autonomy/participate", {
      participate: false,
    });
    assert.equal(off.status, 200);
    assert.equal(off.body.local.state, "stopped");
    const again = new Store(env.store.dir);
    await again.init();
    assert.deepEqual(again.autonomySettings(), { participate: false });
  } finally {
    await env.close();
  }
});

test("C5: the mandate is proxied host-side with CAS; backend codes survive and the bearer never leaks", async () => {
  const env = await autonomyAdmin();
  try {
    const got = await env.call("GET", "/api/autonomy/mandate");
    assert.equal(got.status, 200);
    const direct = await env.backend.mandate();
    assert.deepEqual(got.body, direct);
    const {
      capabilities,
      protocol,
      mandate_id,
      dojo_id,
      chief_id,
      revision,
      status,
      suspended_reason,
      updated_at,
      updated_by,
      ...fields
    } = direct;
    const stale = await env.call("PUT", "/api/autonomy/mandate", {
      idempotency_key: "c5-stale",
      expected_revision: revision - 1,
      mandate: { ...fields, paused: true },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "AUTONOMY_CONFLICT");
    const invalid = await env.call("PUT", "/api/autonomy/mandate", {
      idempotency_key: "c5-invalid",
      expected_revision: revision,
      mandate: { ...fields, mode: "rogue" },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, "AUTONOMY_INVALID");
    const put = await env.call("PUT", "/api/autonomy/mandate", {
      idempotency_key: "c5-pause",
      expected_revision: revision,
      mandate: { ...fields, paused: true },
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.mandate.paused, true);
    assert.equal(put.body.mandate.revision, revision + 1);
    assert.equal(env.fake.state.mandate.paused, true);
    const text = await fetch(env.app.origin + "/api/autonomy/mandate", {
      method: "PUT",
      headers: { ...env.headers(), "Content-Type": "text/plain" },
      body: "{}",
    });
    assert.equal(text.status, 415);
    const reports = await env.call("GET", "/api/autonomy/reports");
    assert.equal(reports.status, 200);
    assert.deepEqual(reports.body.items, []);
    for (const value of [got.body, put.body, reports.body, await env.status()])
      assert.ok(!JSON.stringify(value).includes(env.store.secrets.token));
  } finally {
    await env.close();
  }
});

test("C5: terminal stop never stops autonomy; worker presence is reported apart from monitoring", async () => {
  const planner = new ScriptedRuntime([async () => outcome()]);
  const env = await autonomyAdmin({ planners: [planner] });
  try {
    await env.call("POST", "/api/autonomy/participate", { participate: true });
    const stop = await env.call("POST", "/api/terminal/stop", {});
    assert.equal(stop.status, 200);
    assert.notEqual((await env.status()).local.state, "stopped");
    env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
    const s = await until(async () => {
      const v = await env.status();
      return v.local.lastOutcome === "completed" && v;
    }, "a completed cycle");
    assert.equal(typeof s.local.lastCycleAt, "string");
    const worker = (await env.call("GET", "/api/status")).body;
    assert.equal(worker.state, "stopped");
    assert.equal(worker.presence, "unconfirmed");
    assert.equal(s.backend.queue.running, 0);
    assert.equal(s.local.safeToReplace, true);
    // Lifecycle diagnostics: safe numeric metadata only.
    const logs = (await env.call("GET", "/api/logs")).body;
    const stages = logs.entries.map((e: any) => e.stage);
    for (const stage of [
      "autonomy-participation",
      "autonomy-started",
      "autonomy-cycle",
    ])
      assert.ok(stages.includes(stage), stage);
    for (const entry of logs.entries.filter((e: any) =>
      String(e.stage).startsWith("autonomy-"),
    ))
      for (const value of Object.values(entry.metadata ?? {}))
        assert.equal(typeof value, "number", JSON.stringify(entry));
    assert.ok(!JSON.stringify(logs).includes(env.store.secrets.token));
  } finally {
    await env.close();
  }
});

test("C5: message mode wires the composer as its own runtime, so intents are offered", async () => {
  const planner = new ScriptedRuntime([
    async (io) => {
      assert.ok(
        io.catalog.tools.some((t: any) => t.name === INTEND_TOOL),
        "intend offered only when a separate composer is wired",
      );
      return outcome();
    },
  ]);
  const env = await autonomyAdmin({
    mode: "message",
    delegated: ["manager_report", "follow_up", "member_message"],
    planners: [planner],
  });
  try {
    await env.call("POST", "/api/autonomy/participate", { participate: true });
    env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
    await until(
      async () => (await env.status()).local.lastOutcome === "completed",
      "a completed cycle",
    );
    assert.equal(planner.runs.length, 1);
    assert.equal(env.pairs.length, 1);
    assert.notEqual(env.pairs[0].planner, env.pairs[0].composer);
  } finally {
    await env.close();
  }
});

test("C5: production runtimes are two distinct owner-scoped headless runtimes on the verified image", async () => {
  const resolved: string[] = [];
  const home = await mkdtemp(tmpdir() + "/autonomy-runtimes-");
  after(() => rm(home, { recursive: true, force: true }));
  const owner = "b".repeat(32);
  const cleanup = await CleanupRegistry.open(home, owner, {
    sync: async () => {},
  });
  const execs: string[][] = [];
  const pair = await productionRuntimes(home, {
    owner,
    cleanup,
    image: async (h) => {
      resolved.push(h);
      return "sha256:" + "a".repeat(64);
    },
    engine: {
      exec: (async (_file: string, args: string[]) => (
        execs.push(args),
        { stdout: "" }
      )) as any,
    },
  });
  assert.deepEqual(resolved, [home]);
  assert.ok(pair.planner instanceof HeadlessCycleRuntime);
  assert.ok(pair.composer instanceof HeadlessCycleRuntime);
  assert.notEqual(pair.planner, pair.composer);
  assert.ok(
    execs.some((a) => a.includes(`label=fit.kata.native.owner=${owner}`)),
    "startup sweep is owner-scoped",
  );
  await assert.rejects(
    productionRuntimes(home, { image: async () => "sha256:" + "a".repeat(64) }),
    /HEADLESS_OWNER_REQUIRED/,
  );
  await assert.rejects(
    productionRuntimes(home, {
      owner,
      cleanup,
      image: async () => {
        throw new Error("NATIVE_IMAGE_UNVERIFIED");
      },
    }),
    /NATIVE_IMAGE_UNVERIFIED/,
  );
});
