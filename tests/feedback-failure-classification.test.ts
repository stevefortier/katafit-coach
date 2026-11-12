import { isolatedWorkerCompletion } from "../src/runtime/isolatedInvocation.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { complete } from "../src/runtime/piAdapter.js";
import { Worker } from "../src/worker/runner.js";
import { Diagnostics } from "../src/diagnostics/log.js";
import { taskFixture } from "./task-fixtures.js";

for (const advertised of [false, true]) {
  test(`real pre-provider MCP refusal preserves context category (details ${advertised})`, async () => {
    const f = await taskFixture({
      memory: true,
      memoryRecallFailure: "MEMORY_NOT_AUTHORIZED",
      failureDetails: advertised,
      contextFailureDetails: advertised,
    });
    let calls = 0;
    const w = new Worker({
      origin: f.origin,
      token: "worker-secret",
      system: "Coach",
      complete: async () => {
        calls++;
        return "{}";
      },
    });
    try {
      f.enqueue("exercise_suggestions");
      await assert.rejects(w.pollOnce());
      assert.equal(calls, 0);
      const failure = f.calls.find((c) => c.name === "coach_fail_task")!;
      assert.equal(failure.args.code, "TASK_CONTEXT_UNAVAILABLE");
      assert.equal(
        failure.args.detail_code,
        advertised ? "TASK_CONTEXT_PREPARE" : undefined,
      );
      assert.equal(failure.args.timing, undefined);
      assert.equal(w.state, "task-failure-reported");
      assert.ok(f.calls.some((c) => c.name === "coach_read_task_receipt"));
    } finally {
      await w.stop();
      await f.close();
    }
  });
}

test("successful empty memory remains successful with evidence absent after log reload", async () => {
  const home = await mkdtemp(tmpdir() + "/feedback-provenance-");
  const f = await taskFixture({ memory: true });
  const log = new Diagnostics(home);
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    onDiagnostic: (e) => log.record(e),
    complete: async () => '{"text":"Synthetic"}',
  });
  try {
    f.enqueue("activity_followup");
    await w.pollOnce();
    const rows = new Diagnostics(home)
      .snapshot()
      .entries.filter(
        (e) =>
          e.stage === "memory-preparation" && e.metadata.memoryTerminal === 1,
      );
    assert.ok(
      rows.some(
        (e) =>
          e.metadata.memoryOutcomeCode === 1 &&
          e.metadata.memoryEvidenceCode === 1 &&
          e.metadata.memoryItems === 0,
      ),
    );
    assert.doesNotMatch(JSON.stringify(rows), /worker-secret|Synthetic/);
  } finally {
    await w.stop();
    await f.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("real adapter preparation failure before HTTP is context preparation, never provider inference", async () => {
  const f = await taskFixture({
    failureDetails: true,
    contextFailureDetails: true,
  });
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: (context, signal, system, tools, _ref, budget) =>
      complete(
        { baseUrl: "http://127.0.0.1:1", model: "synthetic-model", apiKey: "" },
        system,
        context,
        signal,
        tools,
        budget,
      ),
  });
  try {
    f.enqueue("activity_followup");
    await assert.rejects(w.pollOnce());
    const failure = f.calls.find((c) => c.name === "coach_fail_task")!;
    assert.equal(failure.args.code, "TASK_CONTEXT_UNAVAILABLE");
    assert.equal(failure.args.detail_code, "TASK_CONTEXT_PREPARE");
    assert.equal(w.lastError?.code, "PROVIDER_KEY_REQUIRED");
    assert.equal(w.state, "task-failure-reported");
  } finally {
    await w.stop();
    await f.close();
  }
});

test("installed completion preparation failure has zero provider dispatches and stays context", async () => {
  const f = await taskFixture({
    failureDetails: true,
    contextFailureDetails: true,
  });
  let runtimePreparations = 0;
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: isolatedWorkerCompletion({} as any, async () => {
      runtimePreparations++;
      throw new Error("PRIVATE-RUNTIME-FAILURE");
    }),
  });
  try {
    f.enqueue("activity_followup");
    await assert.rejects(w.pollOnce());
    assert.equal(runtimePreparations, 1);
    const failure = f.calls.find((c) => c.name === "coach_fail_task")!;
    assert.equal(failure.args.code, "TASK_CONTEXT_UNAVAILABLE");
    assert.equal(failure.args.detail_code, "TASK_CONTEXT_PREPARE");
    assert.doesNotMatch(JSON.stringify(failure.args), /PRIVATE/);
    assert.equal(w.state, "task-failure-reported");
  } finally {
    await w.stop();
    await f.close();
  }
});

test("a real admission wait expiring before completion stays preparation", async () => {
  const { Admission } = await import("../src/runtime/admission.js");
  const admission = new Admission();
  let release!: () => void;
  const held = admission.run(
    "autonomy",
    undefined,
    () =>
      new Promise<void>((r) => {
        release = r;
      }),
  );
  await new Promise<void>((r) => setImmediate(r));
  const f = await taskFixture({
    failureDetails: true,
    contextFailureDetails: true,
  });
  let calls = 0;
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    admission,
    modelMs: 150,
    complete: async () => {
      calls++;
      return '{"text":"Unexpected"}';
    },
  });
  try {
    f.enqueue("activity_followup");
    await assert.rejects(w.pollOnce());
    assert.equal(calls, 0);
    const failure = f.calls.find((c) => c.name === "coach_fail_task")!;
    assert.equal(failure.args.code, "TASK_CONTEXT_UNAVAILABLE");
    assert.equal(failure.args.detail_code, "TASK_CONTEXT_PREPARE");
    assert.equal(w.state, "task-failure-reported");
  } finally {
    release();
    await held;
    await w.stop();
    await f.close();
  }
});
