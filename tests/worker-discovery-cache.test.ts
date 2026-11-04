import test from "node:test";
import assert from "node:assert/strict";

import { Worker } from "../src/worker/runner.js";
import { taskFixture } from "./task-fixtures.js";

const count = (f: any, name: string) =>
  f.calls.filter((c: any) => c.name === name).length;
const maintenance = [
  "tools/list",
  "coach_task_capabilities",
  "coach_memory_capabilities",
  "coach_memory_pending",
];
const snapshot = (f: any) =>
  Object.fromEntries(
    [...maintenance, "coach_claim_task"].map((n) => [n, count(f, n)]),
  );
const worker = (f: any, options: any = {}) =>
  new Worker({
    origin: f.origin,
    token: "synthetic-worker-credential",
    system: "Coach",
    complete: async () => {
      throw new Error("no inference expected");
    },
    ...options,
  });

test("idle polls reuse task-plane discovery and throttle empty memory recovery", async () => {
  const f = await taskFixture({ memoryRecovery: async () => {} });
  const w = worker(f);
  try {
    await w.pollOnce();
    const first = snapshot(f);
    for (const name of maintenance) assert.ok(first[name] > 0, name);
    for (let i = 0; i < 3; i++) await w.pollOnce();
    const later = snapshot(f);
    for (const name of maintenance)
      assert.equal(later[name], first[name], `${name} is not repeated`);
    assert.equal(later.coach_claim_task, first.coach_claim_task + 3);
  } finally {
    await w.stop();
    await f.close();
  }
});

test("without the cache every idle poll rediscovers and recovers", async () => {
  const f = await taskFixture({ memoryRecovery: async () => {} });
  const w = worker(f, { discoveryMs: 0, recoveryMs: 0 });
  try {
    await w.pollOnce();
    const first = snapshot(f);
    await w.pollOnce();
    const later = snapshot(f);
    for (const name of maintenance)
      assert.equal(later[name], 2 * first[name], name);
  } finally {
    await w.stop();
    await f.close();
  }
});

test("a failed poll drops the cached discovery", async () => {
  let fail = false;
  const f = await taskFixture({
    onMemoryWire: (name: string) =>
      fail && name === "coach_claim_task" ? "SYNTHETIC_FAILURE" : undefined,
  });
  const w = worker(f, { recoveryMs: Infinity });
  try {
    await w.pollOnce();
    await w.pollOnce();
    assert.equal(count(f, "coach_task_capabilities"), 1);
    fail = true;
    await w.pollOnce().catch(() => {});
    fail = false;
    await w.pollOnce();
    assert.equal(count(f, "coach_task_capabilities"), 2);
  } finally {
    await w.stop();
    await f.close();
  }
});
