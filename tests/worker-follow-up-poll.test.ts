import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import { Worker } from "../src/worker/runner.js";
import { taskFixture } from "./task-fixtures.js";

const reaction = JSON.stringify({
  activity_feedback: { reaction: "check", reply_worthwhile: false },
  general_advice: "",
});
const claims = (f: Awaited<ReturnType<typeof taskFixture>>) =>
  f.calls.filter((c) => c.name === "coach_claim_task").length;

test("queued work is claimed right after the previous task instead of a poll interval later", async () => {
  const f = await taskFixture({ memoryRecallFailure: "MEMORY_LIMIT" });
  // An interval far longer than the test: only a follow-up poll can reach
  // the second and third task in time.
  const worker = new Worker({
    origin: f.origin,
    token: "synthetic-worker-credential",
    system: "Coach",
    pollMs: 600000,
    complete: async () => reaction,
  });
  try {
    f.enqueue("activity_reaction");
    f.enqueue("activity_reaction");
    f.enqueue("activity_reaction");
    await worker.start();
    for (let n = 0; n < 1000 && f.saved.length < 3; n++) await sleep(20);
    assert.equal(f.saved.length, 3);
    // The follow-up after the last task finds nothing, and the worker then
    // returns to its ordinary interval instead of polling in a tight loop.
    for (let n = 0; n < 250 && claims(f) < 4; n++) await sleep(20);
    const settled = claims(f);
    assert.equal(settled, 4);
    await sleep(1000);
    assert.equal(claims(f), settled);
  } finally {
    await worker.stop();
    await f.close();
  }
});

test("an idle poll keeps the ordinary interval", async () => {
  const f = await taskFixture({});
  const worker = new Worker({
    origin: f.origin,
    token: "synthetic-worker-credential",
    system: "Coach",
    pollMs: 600000,
    complete: async () => {
      throw new Error("no inference expected");
    },
  });
  try {
    await worker.start();
    for (let n = 0; n < 250 && claims(f) < 1; n++) await sleep(20);
    await sleep(1000);
    assert.equal(claims(f), 1);
  } finally {
    await worker.stop();
    await f.close();
  }
});
