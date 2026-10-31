import test from "node:test";
import assert from "node:assert/strict";

import { Worker } from "../src/worker/runner.js";
import { taskFixture } from "./task-fixtures.js";

const results = {
  daily_insight: {
    general_advice: "Synthetic daily encouragement.",
    meal_recommendations: [],
    recovery_recommendations: [],
    workout_directives: [],
  },
  activity_reaction: {
    activity_feedback: { reaction: "check", reply_worthwhile: false },
    general_advice: "",
  },
  exercise_chat: { text: "Synthetic set feedback." },
  exercise_suggestions: {
    summary: "",
    reply_worthwhile: false,
    reactions: [{ target_event_key: "set-a", reaction: "eyes" }],
  },
};

for (const [kind, result] of Object.entries(results)) {
  test(`${kind} reaches publication without waiting for deferred memory recovery`, async () => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const f = await taskFixture({
      memoryRecovery: () => {
        entered.resolve();
        return gate.promise;
      },
      memoryRecallFailure: "MEMORY_LIMIT",
      ...(kind === "exercise_suggestions"
        ? {
            evidence: {
              timezone: "UTC",
              conversation: [],
              observations: [
                {
                  label: "Eligible reaction targets",
                  text: JSON.stringify([
                    { target_event_key: "set-a", target_type: "set_completed" },
                  ]),
                },
              ],
            },
          }
        : {}),
    });
    let calls = 0;
    const worker = new Worker({
      origin: f.origin,
      token: "synthetic-worker-credential",
      system: "Coach",
      complete: async () => {
        calls++;
        return JSON.stringify(result);
      },
    });
    let poll: Promise<void> | undefined;
    try {
      f.enqueue(kind);
      poll = worker.pollOnce();
      const outcome = await Promise.race([
        poll.then(() => "published"),
        entered.promise.then(() => "blocked"),
      ]);
      assert.equal(
        outcome,
        "published",
        "recovery must not gate new task discovery",
      );
      assert.equal(calls, 1);
      assert.equal(f.saved.length, 1);
      assert.equal(
        f.calls.filter((c) => c.name === "coach_memory_pending").length,
        0,
      );
    } finally {
      gate.resolve();
      await poll?.catch(() => {});
      await worker.stop();
      await f.close();
    }
  });
}

test("an idle poll still owns and awaits deferred recovery", async () => {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const f = await taskFixture({
    memoryRecovery: async () => {
      entered.resolve();
      await gate.promise;
    },
  });
  const worker = new Worker({
    origin: f.origin,
    token: "synthetic-worker-credential",
    system: "Coach",
    complete: async () => {
      throw new Error("no inference expected");
    },
  });
  let settled = false;
  const poll = worker.pollOnce().then(() => {
    settled = true;
  });
  try {
    await entered.promise;
    assert.equal(settled, false);
    gate.resolve();
    await poll;
    assert.equal(worker.state, "idle");
    assert.equal(
      f.calls.filter((c) => c.name === "coach_memory_pending").length,
      1,
    );
  } finally {
    gate.resolve();
    await poll.catch(() => {});
    await worker.stop();
    await f.close();
  }
});

test("busy feedback cannot starve recovery and a fourth idle poll recovers only once", async () => {
  let recoveries = 0;
  const f = await taskFixture({
    memoryRecovery: async () => {
      recoveries++;
    },
    memoryRecallFailure: "MEMORY_LIMIT",
  });
  const worker = new Worker({
    origin: f.origin,
    token: "synthetic-worker-credential",
    system: "Coach",
    complete: async () => JSON.stringify(results.activity_reaction),
  });
  try {
    for (let i = 0; i < 3; i++) {
      f.enqueue("activity_reaction");
      await worker.pollOnce();
      assert.equal(recoveries, 0);
    }
    await worker.pollOnce();
    assert.equal(recoveries, 1, "only one recovery attempt per poll");
    for (let i = 0; i < 4; i++) {
      f.enqueue("activity_reaction");
      await worker.pollOnce();
    }
    assert.equal(recoveries, 2, "continuous feedback still yields to recovery");
    assert.equal(f.saved.length, 7);
  } finally {
    await worker.stop();
    await f.close();
  }
});

for (const plane of ["request", "task"] as const) {
  test(`${plane} publication uncertainty survives periodic recovery without replay`, async () => {
    let recoveries = 0;
    const options: any = {
      memoryRecovery: async () => {
        recoveries++;
      },
      memoryRecallFailure: "MEMORY_LIMIT",
      ...(plane === "request"
        ? {
            main: true,
            requestMessage: "Synthetic request",
            dropRespond: true,
            mainReceipts: [],
          }
        : {
            receiptError: true,
            completionReceipt: (r: any) => ({
              ...r,
              result_sha256: "0".repeat(64),
            }),
          }),
    };
    const f = await taskFixture(options);
    let inference = 0;
    const worker = new Worker({
      origin: f.origin,
      token: "synthetic-worker-credential",
      system: "Coach",
      complete: async () => {
        inference++;
        return plane === "request"
          ? "Synthetic reply"
          : '{"text":"Synthetic task reply"}';
      },
    });
    const claim =
      plane === "request" ? "coach_claim_request" : "coach_claim_task";
    const publish =
      plane === "request" ? "coach_respond" : "coach_complete_task";
    try {
      if (plane === "task") {
        f.enqueue();
        f.enqueue();
      }
      await assert.rejects(worker.pollOnce(), /DELIVERY_UNVERIFIED/);
      options.main = plane === "request";
      for (let i = 0; i < 3; i++) await worker.pollOnce();
      assert.equal(recoveries, 1);
      assert.equal(worker.safeToReplace, false);
      assert.equal(inference, 1);
      assert.equal(f.calls.filter((c) => c.name === claim).length, 1);
      assert.equal(f.calls.filter((c) => c.name === publish).length, 1);
    } finally {
      await worker.stop();
      await f.close();
    }
  });
}

test("Stop aborts held idle recovery without launching inference", async () => {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const f = await taskFixture({
    memoryRecovery: async () => {
      entered.resolve();
      await gate.promise;
    },
  });
  let inference = 0;
  const worker = new Worker({
    origin: f.origin,
    token: "synthetic-worker-credential",
    system: "Coach",
    complete: async () => {
      inference++;
      return "unexpected";
    },
  });
  const poll = worker.pollOnce();
  const settled = poll.catch(() => {});
  try {
    await entered.promise;
    await worker.stop();
    await settled;
    assert.equal(worker.state, "stopped");
    assert.equal(worker.stopConfirmed, true);
    assert.equal(inference, 0);
    assert.equal(
      f.calls.filter((c) => c.name === "coach_memory_commit").length,
      0,
    );
  } finally {
    gate.resolve();
    await settled;
    await worker.stop();
    await f.close();
  }
});
