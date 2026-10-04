import test from "node:test";
import assert from "node:assert/strict";
import { NativeTerminal } from "../src/server/terminal.js";
import { Updates } from "../src/update/updates.js";
import {
  autonomyAdmin,
  holdingProxy,
  until,
} from "./helpers/autonomy-admin.js";
import { outcome, ScriptedRuntime } from "./helpers/autonomy-cycle.js";
import { MEMBER } from "./helpers/autonomy-fake.js";
import { REPORT_TOOL } from "../src/autonomy/tools.js";
import { AutonomyHost } from "../src/autonomy/host.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

test(
  "manual queue rechecks configuration after asynchronous autonomy proof",
  { timeout: 15000 },
  async (t) => {
    const entered = deferred(),
      release = deferred();
    let applications = 0;
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
    const env = await autonomyAdmin({ updates });
    const reconcile = AutonomyHost.prototype.reconcile;
    let applying: ReturnType<typeof env.call> | undefined;
    try {
      t.mock.method(
        AutonomyHost.prototype,
        "reconcile",
        async function (this: AutonomyHost) {
          entered.resolve();
          await release.promise;
          return reconcile.call(this);
        },
      );
      applying = env.call("POST", "/api/update/apply", {
        confirm: true,
        sha: updates.latest,
      });
      await entered.promise;
      const config = env.store.publicConfig();
      const changed = await env.call("POST", "/api/config", {
        ...config,
        persona: { ...config.persona, name: "Revised during proof" },
        expectedRevision: config.revision,
      });
      assert.equal(changed.status, 200, JSON.stringify(changed.body));
      release.resolve();
      const result = await applying;
      assert.equal(
        result.status,
        409,
        "a changed configuration must not queue after proof await",
      );
      assert.equal(result.body.error, "OPERATION_IN_PROGRESS");
      assert.equal(applications, 0);
    } finally {
      release.resolve();
      await applying?.catch(() => {});
      t.mock.restoreAll();
      await env.close();
    }
  },
);

test(
  "manual apply refuses active autonomy and unknown action before Stop or activation",
  { timeout: 15000 },
  async () => {
    let applications = 0,
      stops = 0;
    const originalStop = NativeTerminal.prototype.stop;
    NativeTerminal.prototype.stop = async function () {
      stops++;
      return originalStop.call(this);
    };
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
    const env = await autonomyAdmin({
      updates,
      proofThrottleMs: 0,
      planners: [
        new ScriptedRuntime([
          async ({ call }) => {
            await call(REPORT_TOOL, { slot: "r1", text: "Private." });
            return outcome();
          },
        ]),
      ],
    });
    const proxy = await holdingProxy(env.fake.origin);
    try {
      await env.store.save({
        ...env.store.publicConfig(),
        origin: proxy.origin,
      });
      proxy.state.hold = true;
      await env.call("POST", "/api/autonomy/participate", {
        participate: true,
      });
      const id = env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
      await until(
        () => proxy.state.entered.length === 1,
        "held autonomy action",
      );
      const active = await env.call("POST", "/api/update/apply", {
        confirm: true,
        sha: updates.latest,
      });
      assert.equal(active.status, 409);
      assert.equal(active.body.error, "UPDATE_BUSY");
      assert.equal((await env.status()).local.busy, true);
      assert.equal(stops, 0);
      proxy.state.intercept = (method, path) =>
        method === "GET" && /\/actions\/r1$/.test(path.split("?")[0])
          ? { status: 503, body: { code: "AUTONOMY_UNAVAILABLE" } }
          : undefined;
      await env.call("POST", "/api/autonomy/participate", {
        participate: false,
      });
      proxy.release();
      await until(
        () => env.fake.state.work.get(id).actions.length === 1,
        "action committed after abort",
      );
      const unknown = await env.call("POST", "/api/update/apply", {
        confirm: true,
        sha: updates.latest,
      });
      assert.equal(unknown.status, 409);
      assert.equal(unknown.body.error, "WORKER_STOP_UNCONFIRMED");
      assert.equal((await env.status()).local.unknownOutcome, true);
      assert.equal(stops, 0);
      assert.equal(applications, 0);
      assert.equal(
        (await env.call("GET", "/api/update")).body.manualQueue,
        undefined,
      );
    } finally {
      proxy.release();
      NativeTerminal.prototype.stop = originalStop;
      await env.close();
      await proxy.close();
    }
  },
);

test(
  "manual queue reserves idle autonomy until cancel then resumes participation",
  { timeout: 15000 },
  async () => {
    const idle = Object.getOwnPropertyDescriptor(
      NativeTerminal.prototype,
      "idle",
    )!;
    Object.defineProperty(NativeTerminal.prototype, "idle", {
      configurable: true,
      get: () => false,
    });
    let applications = 0;
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
    updates.manualRestartSupported = true;
    const env = await autonomyAdmin({
      updates,
      planners: [new ScriptedRuntime([async () => outcome()])],
    });
    try {
      await env.call("POST", "/api/autonomy/participate", {
        participate: true,
      });
      await until(
        async () => (await env.status()).local.state === "idle",
        "idle autonomy",
      );
      const response = await env.call("POST", "/api/update/apply", {
        confirm: true,
        sha: updates.latest,
      });
      assert.equal(response.status, 202, JSON.stringify(response.body));
      await until(
        async () =>
          (await env.call("GET", "/api/update")).body.manualQueue?.phase ===
          "waiting-native",
        "native wait",
      );
      const mark = env.fake.calls.length;
      const id = env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
      await new Promise((r) => setTimeout(r, 180));
      assert.equal(
        env.fake.calls.slice(mark).filter((c) => /\/work\/claim$/.test(c.path))
          .length,
        0,
        "queued upgrade must fence autonomy claims",
      );
      assert.equal(env.fake.state.work.get(id).status, "queued");
      assert.equal(applications, 0);
      assert.equal((await env.status()).participate, true);
      const cancel = await env.call("POST", "/api/update/cancel", {
        id: response.body.id,
      });
      assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
      await until(
        () => env.fake.state.work.get(id).status === "completed",
        "cancel resumes autonomy",
      );
      assert.equal(applications, 0);
    } finally {
      Object.defineProperty(NativeTerminal.prototype, "idle", idle);
      await env.close();
    }
  },
);

test(
  "Stats waits for accepted autonomy and holds shared claim admission through response",
  { timeout: 15000 },
  async () => {
    const entered = deferred(),
      release = deferred();
    const planner = new ScriptedRuntime([
      async () => {
        entered.resolve();
        await release.promise;
        return outcome();
      },
    ]);
    const env = await autonomyAdmin({ planners: [planner] });
    const proxy = await holdingProxy(env.fake.origin);
    proxy.state.holds = (_method, path) =>
      path.startsWith("/api/friends/dojo/member-stats");
    proxy.state.intercept = (_method, path) =>
      !proxy.state.hold && path.startsWith("/api/friends/dojo/member-stats")
        ? { status: 200, body: { member: MEMBER } }
        : undefined;
    let stats: ReturnType<typeof env.call> | undefined;
    try {
      await env.store.save({
        ...env.store.publicConfig(),
        origin: proxy.origin,
      });
      await env.call("POST", "/api/autonomy/participate", {
        participate: true,
      });
      env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
      await entered.promise;
      proxy.state.hold = true;
      stats = env.call("GET", "/api/dashboard/stats?user_id=" + MEMBER);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(
        proxy.state.entered.length,
        0,
        "Stats must not overlap active cycle",
      );
      assert.equal(
        (await env.status()).local.busy,
        true,
        "read does not abort active cycle",
      );
      release.resolve();
      await until(
        () => proxy.state.entered.length === 1,
        "Stats starts after cycle",
      );
      const mark = env.fake.calls.length;
      const next = env.fake.enqueue({
        kind: "reconcile",
        subject_ids: [MEMBER],
      });
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(
        env.fake.calls.slice(mark).filter((c) => /\/work\/claim$/.test(c.path))
          .length,
        0,
        "held Stats prevents new autonomy claim",
      );
      assert.equal(env.fake.state.work.get(next).status, "queued");
      proxy.release();
      assert.equal((await stats).status, 200);
    } finally {
      release.resolve();
      proxy.release();
      await stats?.catch(() => {});
      await env.close();
      await proxy.close();
    }
  },
);
