import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "../src/worker/runner.js";
import { taskFixture } from "./task-fixtures.js";

for (const bound of [
  "original timeout",
  "returned lease",
  "configured model",
] as const) {
  test(`typed budget alignment preserves ${bound} and refuses late publication`, async () => {
    const f = await taskFixture();
    let finish: ((text: string) => void) | undefined;
    let admittedMs = Infinity;
    const w = new Worker({
      origin: f.origin,
      token: "worker-secret",
      system: "Coach",
      ...(bound === "configured model" ? { modelMs: 30 } : {}),
      complete: async (_message, _signal, _prompt, _tools, _ref, budget) => {
        admittedMs = budget!.deadlineAt! - Date.now();
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      },
    });
    try {
      f.enqueue("activity_followup", {
        lease_expires_at: new Date(
          Date.now() + (bound === "returned lease" ? 12200 : 120000),
        ).toISOString(),
        timeout_at: new Date(
          Date.now() + (bound === "original timeout" ? 12200 : 900000),
        ).toISOString(),
      });
      await assert.rejects(w.pollOnce());
      assert.ok(finish, "generation actually started before its short cutoff");
      assert.ok(
        admittedMs > 0 &&
          admittedMs <= (bound === "configured model" ? 30 : 200),
      );
      assert.equal(w.lastError?.code, "PROVIDER_TIMEOUT");
      assert.equal(f.saved.length, 0);
      assert.equal(
        f.calls.find((c) => c.name === "coach_fail_task")?.args.code,
        "TASK_PROVIDER_FAILED",
      );
      assert.equal(
        f.calls.find((c) => c.name === "coach_claim_task")?.args.lease_seconds,
        120,
      );
      finish!('{"text":"Late result must not publish"}');
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(f.saved.length, 0);
      assert.equal(
        f.calls.filter((c) => c.name === "coach_complete_task").length,
        0,
      );
    } finally {
      finish?.('{"text":"Late result must not publish"}');
      await w.stop();
      await f.close();
    }
  });
}

test("typed task cancellation still aborts active inference without publication", async () => {
  const f = await taskFixture();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: (text: string) => void;
  let signal: AbortSignal | undefined;
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async (_message, abort) => {
      signal = abort;
      entered();
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    },
  });
  try {
    f.enqueue("activity_followup", {
      lease_expires_at: new Date(Date.now() + 120000).toISOString(),
    });
    const polled = w.pollOnce().catch((error) => error);
    await started;
    const stopped = w.stop();
    assert.equal(signal?.aborted, true);
    finish('{"text":"Cancelled result must not publish"}');
    await stopped;
    await polled;
    assert.equal(f.saved.length, 0);
    assert.equal(
      f.calls.filter((c) => c.name === "coach_complete_task").length,
      0,
    );
  } finally {
    finish?.('{"text":"Cancelled"}');
    await w.stop();
    await f.close();
  }
});
