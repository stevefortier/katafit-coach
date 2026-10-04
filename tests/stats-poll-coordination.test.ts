import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "../src/worker/runner.js";
import { taskFixture } from "./task-fixtures.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

test("Stats cancellation never aborts/replays an already-dispatched typed claim or loses publication", async () => {
  const dispatched = deferred(),
    claimReply = deferred(),
    inference = deferred(),
    modelReply = deferred();
  const backend = await taskFixture({
    onClaimTask: async () => {
      dispatched.resolve();
      await claimReply.promise;
    },
  });
  backend.enqueue("activity_reaction");
  let modelSignal!: AbortSignal;
  const worker = new Worker({
    origin: backend.origin,
    token: "synthetic-token",
    system: "Coach",
    complete: async (_context, signal) => {
      modelSignal = signal;
      inference.resolve();
      await modelReply.promise;
      return JSON.stringify({
        activity_feedback: { reaction: "flex", reply_worthwhile: false },
        general_advice: "",
      });
    },
  });
  worker.state = "idle";
  let reads = 0;
  const caller = new AbortController();
  const polling = worker.pollOnce();
  try {
    await dispatched.promise;
    const stats = worker.withIdlePollingPaused(caller.signal, async () => {
      reads++;
    });
    const rejected = assert.rejects(stats, /CANCELLED/);
    claimReply.resolve();
    await inference.promise;
    caller.abort();
    await rejected;
    assert.equal(reads, 0);
    assert.equal(modelSignal.aborted, false);
    modelReply.resolve();
    await polling;
    assert.equal(
      backend.calls.filter((c) => c.name === "coach_claim_task").length,
      1,
    );
    assert.equal(
      backend.calls.filter((c) => c.name === "coach_complete_task").length,
      1,
    );
    assert.equal(backend.saved.length, 1);
    assert.equal(worker.safeToReplace, true);
  } finally {
    claimReply.resolve();
    modelReply.resolve();
    await polling.catch(() => {});
    await worker.stop();
    await backend.close();
  }
});

test("each read owns its pause; cancellation/failure cannot release another reader or an update reservation", async () => {
  const backend = await taskFixture();
  const worker = new Worker({
    origin: backend.origin,
    token: "synthetic-token",
    system: "Coach",
    complete: async () => "",
  });
  await worker.pollOnce();
  const first = deferred(),
    second = deferred(),
    enteredA = deferred(),
    enteredB = deferred();
  try {
    const a = worker.withIdlePollingPaused(
      new AbortController().signal,
      async () => {
        enteredA.resolve();
        await first.promise;
        throw new Error("synthetic read failure");
      },
    );
    const failed = assert.rejects(a, /synthetic read failure/);
    const b = worker.withIdlePollingPaused(
      new AbortController().signal,
      async () => {
        enteredB.resolve();
        await second.promise;
      },
    );
    await Promise.all([enteredA.promise, enteredB.promise]);
    const calls = backend.calls.length;
    first.resolve();
    await failed;
    await worker.pollOnce();
    assert.equal(backend.calls.length, calls);
    assert.equal(worker.reserveForManualUpdate(), true);
    second.resolve();
    await assert.rejects(b, /CANCELLED/);
    await assert.rejects(worker.pollOnce(), /CANCELLED/);
    worker.releaseUpdateQuiesce();
    await worker.pollOnce();
    assert.ok(backend.calls.length > calls);
  } finally {
    first.resolve();
    second.resolve();
    await worker.stop();
    await backend.close();
  }
});
