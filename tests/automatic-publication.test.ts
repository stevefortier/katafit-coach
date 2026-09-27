import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "../src/worker/runner.js";
import { taskFixture } from "./task-fixtures.js";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { Updates } from "../src/update/updates.js";
import { AutoUpdater, AutoUpdateSetting } from "../src/update/auto.js";
import { setTimeout as sleep } from "node:timers/promises";

for (const scenario of [
  "ready",
  "denied",
  "missing",
  "archive-blocked",
  "stopped",
  "stopped-denied",
  "held-archive",
])
  test(`automatic cycle ${scenario}: archives invalidation before stop and resumes without replay`, async () => {
    const options: any = {
      dropCompleteBeforeAcceptance: true,
      reconcileDenial: "TASK_SOURCE_CHANGED",
    };
    const f = await taskFixture(options);
    const task = f.enqueue();
    const retained = structuredClone(task);
    f.deny(task.id);
    const home = await mkdtemp(tmpdir() + "/auto-publication-");
    const store = new Store(home);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin: f.origin,
      token: "synthetic-token",
      apiKey: "synthetic-key",
    });
    const setting = new AutoUpdateSetting(home);
    await setting.write(true);
    let applied = 0;
    const updates = new Updates("a".repeat(40), async () => {
      applied++;
    });
    updates.latest = "b".repeat(40);
    updates.checkedAt = Date.now();
    const start = Worker.prototype.start;
    let owned: Worker | undefined;
    Worker.prototype.start = function () {
      owned = this;
      (this as any).options.complete = async () => '{"text":"synthetic"}';
      (this as any).options.pollMs = 1000;
      return start.call(this);
    };
    const app = await admin(store, 0, undefined, undefined, updates, setting);
    const headers = {
      Authorization: "Bearer " + store.secrets.admin,
      Origin: app.origin,
      "Content-Type": "application/json",
    };
    const post = (path: string) =>
      fetch(app.origin + path, { method: "POST", headers, body: "{}" });
    const scheduler = new AutoUpdater(setting, {
      check: async () => ({
        installed: updates.installed,
        latest: updates.latest,
      }),
      isDescendant: async () => true,
      apply: async (sha) => {
        const paused = await post("/api/update/auto/quiesce");
        if (!paused.ok) {
          assert.equal(paused.status, 409);
          return;
        }
        const { wasRunning } = await paused.json();
        assert.equal(owned!.safeToReplace, true);
        assert.equal(owned!.state, "stopped");
        assert.equal(
          (await readdir(home + "/task-terminal-receipts")).length,
          1,
        );
        await updates.apply(sha);
        assert.equal((await post("/api/update/auto/release")).status, 200);
        if (wasRunning) assert.equal((await post("/api/run")).status, 200);
      },
    });
    const now = Date.now;
    try {
      await post("/api/run");
      for (
        let n = 0;
        n < 500 &&
        !(
          owned?.state === "idle" &&
          owned.incidents.length &&
          !(owned as any).active
        );
        n++
      )
        await sleep(10);
      assert.equal(owned!.incidents.length, 1);
      assert.equal(owned!.state, "idle");
      const original = owned!;
      const digest = original.incidents[0].digest;
      options.reconcileDenial = "";
      options.receipt = {
        task: { ...retained, status: "invalidated" },
        status: "invalidated",
        result_sha256: null,
        completed_at: null,
        consumed_at: null,
        failure_code: null,
        invalidation_code: "TASK_SOURCE_CHANGED",
        invalidated_at: new Date().toISOString(),
      };
      if (scenario.startsWith("stopped")) await post("/api/stop");
      if (
        ["denied", "missing", "archive-blocked", "stopped-denied"].includes(
          scenario,
        )
      ) {
        const receipt = options.receipt;
        if (scenario.endsWith("denied"))
          options.reconcileDenial = "TASK_SOURCE_CHANGED";
        if (scenario === "missing") options.receipt = {};
        if (scenario === "archive-blocked")
          await writeFile(home + "/task-terminal-receipts", "blocked");
        const reads = () =>
          f.calls.filter((c) => c.name === "coach_read_task_receipt").length;
        const before = reads();
        await scheduler.tick();
        assert.equal(applied, 0);
        assert.equal(owned, original);
        assert.equal(
          original.state,
          scenario.startsWith("stopped") ? "stopped" : "idle",
          "deferral preserves original running/stopped intent",
        );
        assert.equal(original.safeToReplace, false);
        assert.equal(original.incidents[0].digest, digest);
        assert.equal(reads(), before + 1);
        await scheduler.tick();
        await scheduler.tick();
        assert.equal(
          reads(),
          before + 1,
          "owner retries must not hot-loop receipt reads",
        );
        assert.equal(await setting.failedTarget(), null);
        if (scenario === "stopped-denied") {
          assert.equal((await post("/api/update/auto/release")).status, 409);
          assert.equal((await post("/api/terminal/ticket")).status, 409);
          assert.equal(reads(), before + 1);
        }
        options.reconcileDenial = "";
        options.receipt = receipt;
        if (scenario === "archive-blocked")
          await rm(home + "/task-terminal-receipts");
        Date.now = () => now() + 61000;
        if (scenario === "stopped-denied") {
          assert.equal((await post("/api/update/auto/release")).status, 200);
          assert.equal(original.safeToReplace, true);
          assert.equal(original.state, "stopped");
        }
      }
      if (scenario === "held-archive") {
        let entered!: () => void, release!: () => void;
        const inside = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const originalArchive = (original as any).options
          .archiveTaskInvalidation;
        (original as any).options.archiveTaskInvalidation = async (
          value: unknown,
        ) => {
          entered();
          await gate;
          await originalArchive(value);
        };
        const cycle = scheduler.tick();
        try {
          await inside;
          const before = f.calls.length;
          assert.equal((await post("/api/terminal/ticket")).status, 409);
          assert.equal((await post("/api/run")).status, 409);
          await assert.rejects(original.pollOnce(), /CANCELLED/);
          await sleep(1100); // Cross the real poll-loop wakeup while fenced.
          assert.equal(original.state, "idle");
          assert.equal(original.safeToReplace, false);
          assert.equal(f.calls.length, before);
          assert.equal(applied, 0);
        } finally {
          release();
          await cycle;
        }
      } else await scheduler.tick();
      assert.equal(applied, 1);
      if (scenario.startsWith("stopped")) {
        assert.equal(owned, original);
        assert.equal(owned!.state, "stopped");
      } else {
        assert.notEqual(owned, original);
        assert.notEqual(owned!.state, "stopped");
      }
      const names = await readdir(home + "/task-terminal-receipts");
      const archive = JSON.parse(
        await readFile(home + "/task-terminal-receipts/" + names[0], "utf8"),
      );
      assert.equal(archive.attempted_result_sha256, digest);
      assert.deepEqual(archive.receipt, options.receipt);
      assert.equal(f.saved.length, 0);
      assert.equal(
        f.calls.filter((c) => c.name === "coach_complete_task").length,
        1,
      );
      assert.equal(original.lastError?.code, "DELIVERY_UNVERIFIED");
    } finally {
      Date.now = now;
      Worker.prototype.start = start;
      await app.close();
      await f.close();
      await rm(home, { recursive: true, force: true });
    }
  });

test("stable owner automatically replaces child after terminal archive and resumes on same origin", async () => {
  const { activateLegacyFixture, supervise } = await import(
    "./helpers/legacy-supervisor.js"
  );
  const { cp, mkdir } = await import("node:fs/promises");
  const options: any = {
    dropCompleteBeforeAcceptance: true,
    reconcileDenial: "TASK_SOURCE_CHANGED",
  };
  const f = await taskFixture(options);
  const task = f.enqueue();
  const retained = structuredClone(task);
  f.deny(task.id);
  const home = await mkdtemp(tmpdir() + "/owner-publication-");
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
    apiKey: "synthetic-key",
  });
  await activateLegacyFixture(home);
  const initial = home + "/versions/" + "1".repeat(40);
  // Synthetic model boundary only; the actual compiled Worker, admin, owner,
  // receipt transport, durable archive and process replacement all run.
  const runner = initial + "/dist/worker/runner.js";
  await writeFile(
    runner,
    (await readFile(runner, "utf8")) +
      `
const originalStart = Worker.prototype.start;
Worker.prototype.start = function() {
  this.options.complete = async () => '{"text":"synthetic"}';
  this.options.pollMs = 1000;
  return originalStart.call(this);
};
`,
  );
  const target = "b".repeat(40);
  const setting = new AutoUpdateSetting(home);
  await setting.write(true);
  let prepared = 0;
  const owner = await supervise(store, 0, undefined, {
    prepare: async (sha) => {
      prepared++;
      const candidate = home + "/versions/" + sha;
      await mkdir(candidate, { recursive: true });
      await cp(initial, candidate, { recursive: true });
      await writeFile(
        candidate + "/dist/build.json",
        JSON.stringify({ revision: sha, protocol: 1 }),
      );
      return candidate;
    },
    request: async (url) =>
      new Response(
        JSON.stringify(
          String(url).includes("/compare/")
            ? { status: "ahead", ahead_by: 1 }
            : { object: { sha: target } },
        ),
      ),
  });
  const origin = owner.origin;
  const pid = owner.pid;
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: origin,
    "Content-Type": "application/json",
  };
  const status = async () =>
    (await fetch(origin + "/api/status", { headers })).json();
  try {
    assert.equal(
      (
        await fetch(origin + "/api/run", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      200,
    );
    let current: any;
    for (let n = 0; n < 500; n++) {
      current = await status();
      if (current.state === "idle" && !current.safeToReplace) break;
      await sleep(10);
    }
    assert.equal(current.safeToReplace, false);
    options.reconcileDenial = "";
    options.receipt = {
      task: { ...retained, status: "invalidated" },
      status: "invalidated",
      result_sha256: null,
      completed_at: null,
      consumed_at: null,
      failure_code: null,
      invalidation_code: "TASK_SOURCE_CHANGED",
      invalidated_at: new Date().toISOString(),
    };
    await owner.auto.tick();
    assert.equal(prepared, 1);
    assert.equal(owner.updates.installed, target);
    assert.notEqual(owner.pid, pid);
    assert.equal(owner.origin, origin);
    assert.equal(owner.updates.autoOutcome?.state, "running");
    for (let n = 0; n < 100; n++) {
      current = await status();
      if (current.state === "idle") break;
      await sleep(20);
    }
    assert.equal(current.state, "idle");
    assert.equal(current.safeToReplace, true);
    assert.equal((await readdir(home + "/task-terminal-receipts")).length, 1);
    assert.equal(f.saved.length, 0);
    assert.equal(
      f.calls.filter((c) => c.name === "coach_complete_task").length,
      1,
    );
    assert.equal(await setting.failedTarget(), null);
  } finally {
    await owner.close();
    await f.close();
    await rm(home, { recursive: true, force: true });
  }
});
