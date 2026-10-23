import "./fixtures/legacy-source-check.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "../src/worker/runner.js";
import { taskFixture } from "./task-fixtures.js";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { Updates } from "../src/update/updates.js";
import { setTimeout as sleep } from "node:timers/promises";
import {
  IsolatedTaskJournal,
  taskBinding,
} from "../src/worker/isolatedTaskJournal.js";

for (const scenario of [
  "ready",
  "denied",
  "missing",
  "archive-blocked",
  "stopped",
  "stopped-denied",
  "held-archive",
])
  test(`confirmed maintenance ${scenario}: retains durable isolation across replacement and settles without replay`, async () => {
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
    let applied = 0;
    const updates = new Updates("a".repeat(40), async () => {
      applied++;
    });
    updates.latest = "b".repeat(40);
    updates.checkedAt = Date.now();
    let inferences = 0;
    const start = Worker.prototype.start;
    let owned: Worker | undefined;
    Worker.prototype.start = function () {
      owned = this;
      (this as any).options.complete = async () => {
        inferences++;
        return '{"text":"synthetic"}';
      };
      (this as any).options.pollMs = 1000;
      return start.call(this);
    };
    const app = await admin(store, 0, undefined, undefined, updates);
    const headers = {
      Authorization: "Bearer " + store.secrets.admin,
      Origin: app.origin,
      "Content-Type": "application/json",
    };
    /** A saved operation's background continuation, once it settles. */
    const settled = async (id: string) => {
      for (let i = 0; i < 1500; i++) {
        const { lifecycle } = await (
          await fetch(app.origin + "/api/status", { headers })
        ).json();
        if (lifecycle?.id === id && lifecycle.phase === "complete")
          return lifecycle;
        await sleep(10);
      }
      assert.fail("lifecycle " + id + " did not settle");
    };
    const post = (path: string) =>
      fetch(app.origin + path, {
        method: "POST",
        headers,
        body: JSON.stringify(path.endsWith("quiesce") ? { confirm: true } : {}),
      });
    const waitIdle = async () => {
      for (
        let n = 0;
        n < 500 && !(owned?.state === "idle" && !(owned as any).active);
        n++
      )
        await sleep(10);
      assert.equal(owned!.state, "idle");
      assert.ok(!(owned as any).active);
    };
    const reads = () =>
      f.calls.filter((c) => c.name === "coach_read_task_receipt").length;
    const journal = async () =>
      (await IsolatedTaskJournal.open(home)).snapshot();
    const confirmedMaintenance = async (running: boolean) => {
      const previous = owned;
      updates.latest = ["b", "c", "d"][applied].repeat(40);
      updates.checkedAt = Date.now();
      const paused = await post("/api/update/quiesce");
      assert.equal(paused.status, 200);
      assert.equal((await paused.json()).wasRunning, running);
      assert.equal(previous!.safeToReplace, true);
      assert.equal(previous!.stopConfirmed, true);
      assert.equal(previous!.state, "stopped");
      // Durable history is replacement authority, not terminal receipt proof.
      await updates.apply(updates.latest);
      assert.equal((await post("/api/update/release")).status, 200);
      if (running) {
        assert.equal((await post("/api/run")).status, 200);
        assert.notEqual(owned, previous);
        await waitIdle();
      } else {
        assert.equal(owned, previous);
        assert.equal(owned!.state, "stopped");
      }
    };
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
      const diagnostic = original.lastError;
      assert.equal(diagnostic?.code, "DELIVERY_UNVERIFIED");
      const record = {
        task: retained,
        digest,
        reason: "TASK_SOURCE_CHANGED",
        binding: taskBinding(f.origin, "synthetic-token"),
      };
      const assertRetained = async () => {
        assert.deepEqual(await journal(), [record]);
        assert.equal(owned!.incidents.length, 1);
        assert.deepEqual(
          { ...owned!.incidents[0], nextCheck: undefined },
          {
            taskId: retained.id,
            leaseGeneration: retained.lease_generation,
            digest,
            reason: record.reason,
            nextCheck: undefined,
          },
        );
        assert.strictEqual(original.lastError, diagnostic);
      };
      const receipt = {
        task: { ...retained, status: "invalidated" },
        status: "invalidated",
        result_sha256: null,
        completed_at: null,
        consumed_at: null,
        failure_code: null,
        invalidation_code: "TASK_SOURCE_CHANGED",
        invalidated_at: new Date().toISOString(),
      };
      options.reconcileDenial = scenario.endsWith("denied")
        ? "TASK_SOURCE_CHANGED"
        : "";
      // The fixture merges receipt overrides; explicit nulls model absent proof.
      options.receipt =
        scenario === "missing" ? { task: null, status: null } : receipt;
      if (scenario === "archive-blocked")
        await writeFile(home + "/task-terminal-receipts", "blocked");
      const stopped = scenario.startsWith("stopped");
      if (stopped) assert.equal((await post("/api/stop")).status, 200);
      if (stopped) {
        const beforeRestore = store.publicConfig().revision;
        const beforeReads = reads();
        const restored = await fetch(app.origin + "/api/persona-restore", {
          method: "POST",
          headers,
          body: JSON.stringify({ revision: 1 }),
        });
        assert.equal(restored.status, 200);
        const result = await restored.json();
        assert.deepEqual(
          (await settled(result.lifecycle.id)).warnings.map((w: any) => w.code),
          ["ISOLATED_TASK_OUTCOME_UNCONFIRMED"],
        );
        assert.equal(store.publicConfig().revision, beforeRestore + 1);
        assert.equal(reads(), beforeReads, "settings do not reconcile history");
        assert.equal(owned, original);
        assert.equal(owned!.state, "stopped");
        assert.equal(owned!.safeToReplace, true);
      }
      await assertRetained();
      const beforeMaintenance = reads();
      for (let cycle = 0; cycle < 3; cycle++) {
        await confirmedMaintenance(!stopped);
        assert.equal(applied, cycle + 1);
        await assertRetained();
      }
      assert.equal(
        reads(),
        beforeMaintenance,
        "repeated maintenance does not demand receipts for durable history",
      );
      if (stopped) {
        // Only explicit Run changes stopped intent, and constructs a fresh owner.
        assert.equal((await post("/api/run")).status, 200);
        assert.notEqual(owned, original);
        await waitIdle();
        await assertRetained();
      }
      const beforeWakeup = reads();
      await sleep(1100); // Real poll wakeup remains inside the periodic receipt cooldown.
      assert.equal(
        reads(),
        beforeWakeup,
        "no hot-loop receipt recovery on a fresh owner",
      );
      if (
        ["denied", "missing", "archive-blocked", "stopped-denied"].includes(
          scenario,
        )
      ) {
        // A due periodic check is permitted, but subsequent polls must respect
        // its new cooldown instead of reading the same incident in a hot loop.
        await waitIdle();
        const tick = now() + 61000;
        Date.now = () => tick;
        try {
          await owned!.pollOnce();
          assert.equal(reads(), beforeWakeup + 1);
          await owned!.pollOnce();
          await owned!.pollOnce();
          assert.equal(
            reads(),
            beforeWakeup + 1,
            "one read per periodic cooldown",
          );
          await assertRetained();
        } finally {
          Date.now = now;
        }
      }
      assert.equal((await post("/api/stop")).status, 200);
      const recoveryOwner = owned!;
      const recoveryDiagnostic = recoveryOwner.lastError;
      if (
        ["denied", "missing", "archive-blocked", "stopped-denied"].includes(
          scenario,
        )
      ) {
        const before = reads();
        const unresolved = await post("/api/worker/reconcile");
        assert.equal(
          unresolved.status,
          200,
          "replacement eligibility is not terminal proof",
        );
        assert.equal((await unresolved.json()).safeToReplace, true);
        assert.equal(reads(), before + 1, "one explicit receipt-only attempt");
        await assertRetained();
        if (scenario === "archive-blocked")
          assert.equal(
            await readFile(home + "/task-terminal-receipts", "utf8"),
            "blocked",
          );
        else
          await assert.rejects(readdir(home + "/task-terminal-receipts"), {
            code: "ENOENT",
          });
      }
      options.reconcileDenial = "";
      options.receipt = receipt;
      if (scenario === "archive-blocked")
        await rm(home + "/task-terminal-receipts");
      const beforeRecovery = f.calls.length;
      let archiveCalls = 0;
      let entered!: () => void, release!: () => void;
      const inside = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const originalArchive = (recoveryOwner as any).options
        .archiveTaskInvalidation;
      (recoveryOwner as any).options.archiveTaskInvalidation = async (
        value: unknown,
      ) => {
        archiveCalls++;
        assert.deepEqual(value, {
          protocol: "coach.tasks.v1",
          attempted_result_sha256: digest,
          receipt,
        });
        await assertRetained();
        if (scenario === "held-archive") {
          entered();
          await gate;
        }
        await originalArchive(value);
        // The immutable evidence is readable before the journal can be removed.
        const names = await readdir(home + "/task-terminal-receipts");
        assert.equal(names.length, 1);
        assert.deepEqual(
          JSON.parse(
            await readFile(
              home + "/task-terminal-receipts/" + names[0],
              "utf8",
            ),
          ),
          value,
        );
        await assertRetained();
      };
      const recovery = post("/api/worker/reconcile");
      try {
        if (scenario === "held-archive") {
          await Promise.race([
            inside,
            recovery.then(async (r) =>
              assert.fail(
                "reconciliation returned before archive gate: " + r.status,
              ),
            ),
            sleep(5000).then(() => assert.fail("archive callback not entered")),
          ]);
          const before = f.calls.length;
          assert.equal((await post("/api/terminal/ticket")).status, 409);
          assert.equal((await post("/api/run")).status, 409);
          await assert.rejects(recoveryOwner.pollOnce(), /CANCELLED/);
          await sleep(1100);
          assert.equal(owned, recoveryOwner);
          assert.equal(recoveryOwner.state, "stopped");
          assert.equal(recoveryOwner.safeToReplace, false);
          assert.equal(f.calls.length, before);
          await assertRetained();
          await assert.rejects(readdir(home + "/task-terminal-receipts"), {
            code: "ENOENT",
          });
        }
      } finally {
        release();
        assert.equal((await recovery).status, 200);
      }
      assert.equal(archiveCalls, 1);
      assert.equal(
        reads(),
        f.calls
          .slice(0, beforeRecovery)
          .filter((c) => c.name === "coach_read_task_receipt").length + 1,
      );
      assert.ok(
        f.calls
          .slice(beforeRecovery)
          .every((c) =>
            [
              "initialize",
              "notifications/initialized",
              "coach_read_task_receipt",
            ].includes(c.name),
          ),
        "settlement is read-only",
      );
      assert.equal(recoveryOwner.state, "stopped");
      assert.equal(recoveryOwner.safeToReplace, true);
      assert.strictEqual(recoveryOwner.lastError, recoveryDiagnostic);
      assert.equal(recoveryOwner.incidents.length, 0);
      assert.deepEqual(await journal(), []);
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
      assert.equal(
        f.calls.filter((c) => c.name === "coach_fail_task").length,
        0,
      );
      assert.equal(
        f.calls.filter((c) => c.name === "coach_read_task_context").length,
        1,
      );
      assert.equal(
        f.calls.filter((c) => c.name === "coach_reconcile_task").length,
        0,
      );
      assert.equal(inferences, 1);
      assert.strictEqual(original.lastError, diagnostic);
    } finally {
      Date.now = now;
      Worker.prototype.start = start;
      await app.close();
      await f.close();
      await rm(home, { recursive: true, force: true });
    }
  });
