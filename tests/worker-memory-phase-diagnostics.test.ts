import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Worker } from "../src/worker/runner.js";
import { numericMetadata } from "../src/runtime/errors.js";
import { taskFixture } from "./task-fixtures.js";

const digest = (id: string, generation: number) =>
  parseInt(
    createHash("sha256")
      .update(`katafit.coach.worker.task-attempt.v1\0${id}\0${generation}`)
      .digest("hex")
      .slice(0, 12),
    16,
  );
const methods = [
  "coach_memory_capabilities",
  "coach_memory_begin",
  "coach_memory_recall",
];
for (const plane of ["task", "request"]) {
  test(`${plane}: awaited memory phase barriers precede actual completion, once-only terminal and exact binding`, async () => {
    const gates = methods.map(() => Promise.withResolvers<void>());
    const entered = methods.map(() => Promise.withResolvers<void>());
    const events: any[] = [];
    const f = await taskFixture({
      main: plane === "request",
      memory: true,
      onMemoryWire: async (name: string) => {
        const i = methods.indexOf(name);
        if (i >= 0) {
          entered[i].resolve();
          await gates[i].promise;
        }
      },
    });
    let calls = 0;
    const w = new Worker({
      origin: f.origin,
      token: "synthetic-secret",
      system: "Coach",
      onDiagnostic: (e) => events.push(e),
      complete: async () => {
        if (calls === 0)
          for (const name of methods)
            assert.equal(
              f.calls.filter((c) => c.name === name).length,
              1,
              "one wire call per preparation phase at actual completion boundary",
            );
        calls++;
        return plane === "request"
          ? "Synthetic reply"
          : '{"text":"Synthetic reply"}';
      },
    });
    const task = plane === "task" ? f.enqueue("activity_followup") : undefined;
    const poll = w.pollOnce();
    try {
      for (let i = 0; i < methods.length; i++) {
        await Promise.race([
          entered[i].promise,
          poll.then(() => {
            throw new Error("phase not entered");
          }),
        ]);
        assert.equal(calls, 0);
        assert.equal(
          events.filter((e) => e.stage === "memory-preparation").length,
          i,
        );
        gates[i].resolve();
      }
      await poll;
      const receipts = events.filter((e) => e.stage === "memory-preparation");
      assert.equal(
        calls,
        2,
        "main inference and existing awaited extraction only",
      );
      assert.deepEqual(
        receipts.map((e) => [
          e.metadata.memoryPhaseCode,
          e.metadata.memoryOutcomeCode,
          e.metadata.memorySubtypeCode,
          e.metadata.memoryTerminal,
        ]),
        [
          [1, 1, 0, 0],
          [2, 1, 0, 0],
          [3, 1, 0, 1],
        ],
      );
      assert.equal(
        receipts.filter((e) => e.metadata.memoryTerminal === 1).length,
        1,
      );
      for (const e of receipts) {
        assert.match(e.ref, /^[0-9a-f-]{36}$/);
        assert.ok(
          Number.isSafeInteger(e.metadata.memoryPhaseMs) &&
            e.metadata.memoryPhaseMs >= 0,
        );
        assert.equal(e.metadata.memoryOriginCode, plane === "task" ? 2 : 1);
        assert.equal(
          e.metadata.attemptDigest,
          task ? digest(task.id, task.lease_generation) : undefined,
        );
      }
      assert.equal(new Set(receipts.map((e) => e.ref)).size, 1);
      for (const [i, name] of methods.entries())
        assert.equal(
          f.calls.filter((c) => c.name === name).length,
          i === 0 ? 2 : 1,
          "existing retention re-negotiates capabilities after publication",
        );
      assert.doesNotMatch(
        JSON.stringify(receipts),
        /synthetic-secret|Synthetic reply|capture_id|query/,
      );
    } finally {
      gates.forEach((g) => g.resolve());
      await poll.catch(() => {});
      await w.stop();
      await f.close();
    }
  });
}
for (const [phase, name] of methods.entries()) {
  for (const [code, subtype, outcome] of [
    ["MEMORY_UNAVAILABLE", 2, 3],
    ["MEMORY_COVERAGE_UNAVAILABLE", 3, 3],
    ["MEMORY_LIMIT", 4, 3],
    ["MEMORY_NOT_AUTHORIZED", 5, 4],
    ["LEASE_LOST", 6, 4],
  ] as const) {
    test(`phase ${phase + 1}: precise ${code}, no extra memory calls, failclosed unchanged`, async () => {
      const events: any[] = [];
      const f = await taskFixture({
        memory: true,
        onMemoryWire: (n: string) => (n === name ? code : undefined),
      });
      let calls = 0;
      const w = new Worker({
        origin: f.origin,
        token: "synthetic-secret",
        system: "Coach",
        onDiagnostic: (e) => events.push(e),
        complete: async () => {
          calls++;
          return '{"text":"Synthetic reply"}';
        },
      });
      const task = f.enqueue("activity_followup");
      try {
        await w.pollOnce().catch(() => {});
        const receipts = events.filter((e) => e.stage === "memory-preparation");
        assert.equal(receipts.length, phase + 1);
        const terminal = receipts.filter(
          (e) => e.metadata.memoryTerminal === 1,
        );
        assert.equal(terminal.length, 1);
        assert.equal(terminal[0].metadata.memoryPhaseCode, phase + 1);
        assert.equal(terminal[0].metadata.memorySubtypeCode, subtype);
        assert.equal(terminal[0].metadata.memoryOutcomeCode, outcome);
        assert.equal(
          terminal[0].metadata.attemptDigest,
          digest(task.id, task.lease_generation),
        );
        assert.equal(calls, outcome === 3 ? 1 : 0);
        assert.equal(f.saved.length, outcome === 3 ? 1 : 0);
        for (let i = 0; i < methods.length; i++)
          assert.equal(
            f.calls.filter((c) => c.name === methods[i]).length,
            i <= phase ? 1 : 0,
          );
      } finally {
        await w.stop();
        await f.close();
      }
    });
  }
}
test("unsupported memory is distinct; throwing diagnostic observer cannot fail a turn", async () => {
  for (const throwing of [false, true]) {
    const events: any[] = [];
    const f = await taskFixture();
    const w = new Worker({
      origin: f.origin,
      token: "synthetic-secret",
      system: "Coach",
      onDiagnostic: (e) => {
        events.push(e);
        if (throwing) throw new Error("private logger error");
      },
      complete: async () => '{"text":"Synthetic reply"}',
    });
    try {
      f.enqueue();
      await w.pollOnce();
      assert.equal(f.saved.length, 1);
      const receipts = events.filter((e) => e.stage === "memory-preparation");
      assert.equal(receipts.length, 1);
      assert.deepEqual(
        [
          receipts[0].metadata.memoryPhaseCode,
          receipts[0].metadata.memoryOutcomeCode,
          receipts[0].metadata.memorySubtypeCode,
          receipts[0].metadata.memoryTerminal,
        ],
        [1, 2, 1, 1],
      );
    } finally {
      await w.stop();
      await f.close();
    }
  }
});
test("memory numeric metadata has finite code/duration bounds and no strings", () => {
  const good = {
    memoryPhaseCode: 3,
    memoryOutcomeCode: 4,
    memorySubtypeCode: 9,
    memoryOriginCode: 2,
    memoryTerminal: 1,
    memoryPhaseMs: 86400000,
  };
  assert.deepEqual(numericMetadata(good), good);
  assert.deepEqual(
    numericMetadata({
      memoryPhaseCode: 4,
      memoryOutcomeCode: 5,
      memorySubtypeCode: 10,
      memoryOriginCode: 3,
      memoryTerminal: 2,
      memoryPhaseMs: 86400001,
      query: "private",
    }),
    {},
  );
  for (const v of [NaN, Infinity, -1, 1.5, "private"])
    assert.deepEqual(
      numericMetadata(Object.fromEntries(Object.keys(good).map((k) => [k, v]))),
      {},
    );
});
