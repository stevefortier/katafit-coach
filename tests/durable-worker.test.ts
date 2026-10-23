import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Worker } from "../src/worker/runner.js";
import { IsolatedTaskJournal } from "../src/worker/isolatedTaskJournal.js";
import { taskFixture } from "./task-fixtures.js";
import { taskBinding } from "../src/worker/isolatedTaskJournal.js";
import { archiveTaskInvalidation } from "../src/worker/taskInvalidationArchive.js";

test("failed preservation fsync retains pending ownership and replacement guard", async () => {
  const home = await mkdtemp(tmpdir() + "/failed-isolation-");
  let fail = false;
  const journal = await IsolatedTaskJournal.open(home, {
    sync: async (h, path) => {
      if (fail && path.endsWith("isolated-tasks"))
        throw new Error("fsync failed");
      await h.sync();
    },
  });
  const f = await taskFixture({
    dropCompleteBeforeAcceptance: true,
    reconcileDenial: "TASK_SOURCE_CHANGED",
  });
  const task = f.enqueue();
  f.deny(task.id);
  const w = new Worker({
    origin: f.origin,
    token: "synthetic-worker-credential",
    system: "Coach",
    complete: async () => '{"text":"synthetic"}',
    isolatedJournal: journal,
  });
  try {
    fail = true;
    await assert.rejects(w.pollOnce());
    await w.stop();
    assert.equal(w.safeToReplace, false);
    assert.equal(w.stopConfirmed, true);
    assert.ok((w as any).pendingTask);
    assert.equal(journal.healthy, false);
  } finally {
    await w.stop();
    await f.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("different credential binding neither reads old receipts nor suppresses unrelated same-id work", async () => {
  const home = await mkdtemp(tmpdir() + "/binding-isolation-");
  const f = await taskFixture();
  const task = f.enqueue();
  const journal = await IsolatedTaskJournal.open(home);
  await journal.preserve({
    task,
    digest: "a".repeat(64),
    reason: "TASK_SOURCE_CHANGED",
    binding: taskBinding(f.origin, "old"),
  });
  let calls = 0;
  const w = new Worker({
    origin: f.origin,
    token: "new",
    system: "Coach",
    isolatedJournal: journal,
    complete: async () => {
      calls++;
      return '{"text":"unrelated"}';
    },
  });
  try {
    await w.pollOnce();
    assert.equal(calls, 1);
    assert.equal(journal.snapshot().length, 1);
    assert.equal(
      f.calls.filter((c) => c.name === "coach_read_task_receipt").length,
      0,
      "old history is not read under new credentials; new completion ACK settles directly",
    );
  } finally {
    await w.stop();
    await f.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("durable receipt recovery denies wrong digest, wrong credentials, and failed invalidation archive", async () => {
  const home = await mkdtemp(tmpdir() + "/durable-receipt-");
  const options: any = {};
  const f = await taskFixture(options);
  const task = f.enqueue();
  const record = {
    task: structuredClone(task),
    digest: "a".repeat(64),
    reason: "TASK_SOURCE_CHANGED",
    binding: taskBinding(f.origin, "original"),
  };
  const journal = await IsolatedTaskJournal.open(home);
  await journal.preserve(record);
  const base = {
    origin: f.origin,
    token: "original",
    system: "Coach",
    complete: async () => {
      assert.fail("no replay");
    },
    isolatedJournal: journal,
  };
  const wrong = new Worker({ ...base, token: "changed" });
  const w = new Worker({
    ...base,
    archiveTaskInvalidation: async () => {
      throw new Error("archive unavailable");
    },
  });
  try {
    await wrong.reconcilePublications();
    assert.equal(
      f.calls.length,
      0,
      "old identity is never sent with changed auth",
    );
    options.receipt = {
      task: { ...task, status: "completed" },
      status: "completed",
      result_sha256: "b".repeat(64),
      completed_at: new Date().toISOString(),
      consumed_at: null,
      failure_code: null,
    };
    await w.reconcilePublications();
    assert.equal(journal.snapshot().length, 1);
    options.receipt = {
      task: { ...task, status: "invalidated" },
      status: "invalidated",
      result_sha256: null,
      completed_at: null,
      consumed_at: null,
      failure_code: null,
      invalidation_code: "TASK_SOURCE_CHANGED",
      invalidated_at: new Date().toISOString(),
    };
    await w.reconcilePublications();
    assert.equal(
      journal.snapshot().length,
      1,
      "archive failure keeps durable exclusion",
    );
    (w as any).options.archiveTaskInvalidation = (record: any) =>
      archiveTaskInvalidation(home, record);
    await w.reconcilePublications();
    assert.equal(journal.snapshot().length, 0);
    assert.equal(w.incidents.length, 0);
    assert.equal(
      f.calls.every((c) =>
        [
          "initialize",
          "notifications/initialized",
          "coach_read_task_receipt",
        ].includes(c.name),
      ),
      true,
    );
  } finally {
    await wrong.stop();
    await w.stop();
    await f.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("durable isolated worker can be replaced and reopened successor refuses same task even with newer lease", async () => {
  const home = await mkdtemp(tmpdir() + "/durable-worker-");
  const options: any = {
    dropCompleteBeforeAcceptance: true,
    reconcileDenial: "TASK_SOURCE_CHANGED",
  };
  const f = await taskFixture(options);
  let modelCalls = 0;
  const base = {
    origin: f.origin,
    token: "synthetic-secret",
    system: "Coach",
    complete: async () => {
      modelCalls++;
      return '{"text":"synthetic"}';
    },
  };
  const journal = await IsolatedTaskJournal.open(home);
  const w = new Worker({ ...base, isolatedJournal: journal } as any);
  let next: Worker | undefined;
  try {
    const task = f.enqueue();
    f.deny(task.id);
    await assert.rejects(w.pollOnce(), /DELIVERY_UNVERIFIED/);
    await w.stop();
    assert.equal(w.stopConfirmed, true);
    assert.equal(
      w.safeToReplace,
      true,
      "durable isolation is not a live publication owner",
    );
    assert.equal(journal.snapshot().length, 1);
    const reopened = await IsolatedTaskJournal.open(home);
    next = new Worker({ ...base, isolatedJournal: reopened } as any);
    assert.equal(next.incidents.length, 1);
    const before = f.calls.filter((c) =>
      [
        "coach_read_task_context",
        "coach_complete_task",
        "coach_fail_task",
      ].includes(c.name),
    ).length;
    f.enqueue(task.kind, {
      id: task.id,
      lease_generation: task.lease_generation + 1,
    });
    await next.pollOnce();
    assert.equal(modelCalls, 1);
    assert.equal(
      f.calls.filter((c) =>
        [
          "coach_read_task_context",
          "coach_complete_task",
          "coach_fail_task",
        ].includes(c.name),
      ).length,
      before,
    );
    const claims = f.calls.filter((c) => c.name === "coach_claim_task").length;
    await next.pollOnce();
    assert.equal(
      f.calls.filter((c) => c.name === "coach_claim_task").length,
      claims,
      "duplicate claim puts typed polling on bounded cooldown",
    );
  } finally {
    await next?.stop();
    await w.stop();
    await f.close();
    await rm(home, { recursive: true, force: true });
  }
});
