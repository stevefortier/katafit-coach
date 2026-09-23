import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Worker } from "../src/worker/runner.js";
import { parseTaskResult } from "../src/katafit/tasks.js";
import { taskFixture, names } from "./task-fixtures.js";
test("task output rejects backend-denied credential-shaped text locally", () => {
  for (const text of [
    "Bearer synthetic-unrelated-token",
    "kcoach_synthetic_other_token",
    "sk-abcdefghijklmnop",
  ])
    assert.throws(
      () => parseTaskResult("activity_followup", JSON.stringify({ text }), []),
      /OUTPUT_REJECTED/,
    );
});
test("strict task output rejects whitespace-only, semantic silent mismatch and empty recommendations", () => {
  for (const [kind, value] of [
    ["activity_followup", { text: "   " }],
    [
      "activity_reaction",
      {
        activity_feedback: { reaction: "flex", reply_worthwhile: false },
        general_advice: "not silent",
      },
    ],
    [
      "activity_reaction",
      {
        activity_feedback: { reaction: "flex", reply_worthwhile: true },
        general_advice: "",
      },
    ],
    ["workout_suggestions", { recommendations: {} }],
  ])
    assert.throws(
      () => parseTaskResult(kind as string, JSON.stringify(value), []),
      /OUTPUT_REJECTED/,
    );
  assert.deepEqual(
    parseTaskResult("activity_followup", '{"text":"  OK  "}', []),
    { text: "OK" },
  );
});
test("task context rejects evidence extras and byte overflow before inference", async () => {
  for (const evidence of [
    {
      timezone: "UTC",
      observations: [],
      conversation: [],
      provider_settings: {},
    },
    {
      timezone: "UTC",
      observations: [{ label: "activity", text: "x".repeat(4001) }],
      conversation: [],
    },
  ]) {
    const f = await taskFixture({ evidence });
    let calls = 0;
    const w = new Worker({
      origin: f.origin,
      token: "worker-secret",
      system: "Coach",
      complete: async () => {
        calls++;
        return '{"text":"bad"}';
      },
    });
    try {
      f.enqueue();
      await assert.rejects(w.pollOnce());
      assert.equal(calls, 0);
      assert.equal(f.saved.length, 0);
    } finally {
      await w.stop();
      await f.close();
    }
  }
});
test("invalid provider JSON is failed with fixed code and read back independently", async () => {
  const f = await taskFixture();
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async () => "not JSON",
  });
  try {
    f.enqueue();
    await assert.rejects(w.pollOnce());
    assert.equal(f.saved.length, 0);
    assert.deepEqual(
      f.calls
        .filter((c) => c.name === "coach_fail_task")
        .map((c) => c.args.code),
      ["TASK_INVALID_OUTPUT"],
    );
    assert.equal(
      f.calls.filter((c) => c.name === "coach_read_task_receipt").length,
      1,
    );
  } finally {
    await w.stop();
    await f.close();
  }
});
test("expired original task deadline rejects before provider", async () => {
  const f = await taskFixture();
  let calls = 0;
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async () => {
      calls++;
      return '{"text":"late"}';
    },
  });
  try {
    f.enqueue("activity_followup", { timeout_at: new Date(0).toISOString() });
    await assert.rejects(w.pollOnce());
    assert.equal(calls, 0);
  } finally {
    await w.stop();
    await f.close();
  }
});
test("model deadline bounds noncooperative task inference and reports provider failure", async () => {
  const f = await taskFixture();
  let finish!: (v: string) => void;
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    modelMs: 20,
    complete: async () => new Promise((r) => (finish = r)),
  });
  try {
    f.enqueue();
    await assert.rejects(
      Promise.race([
        w.pollOnce(),
        new Promise((_, reject) => {
          const t = setTimeout(() => reject(new Error("TEST_TIMEOUT")), 500);
          t.unref();
        }),
      ]),
      (e) => (e as Error).message !== "TEST_TIMEOUT",
    );
    assert.equal(f.saved.length, 0);
    assert.equal(w.lastError?.code, "PROVIDER_TIMEOUT");
    assert.equal(
      f.calls.find((c) => c.name === "coach_fail_task")?.args.code,
      "TASK_PROVIDER_FAILED",
    );
  } finally {
    finish?.('{"text":"late"}');
    await w.stop();
    await f.close();
  }
});
test("both busy queues alternate so tasks cannot starve main chat", async () => {
  const f = await taskFixture({ main: true });
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async (context) =>
      context.includes("generation_task") ? '{"text":"task"}' : "main reply",
  });
  try {
    f.enqueue();
    f.enqueue();
    f.enqueue();
    await w.pollOnce();
    await w.pollOnce();
    await w.pollOnce();
    assert.deepEqual(
      f.calls
        .filter((c) =>
          ["coach_claim_task", "coach_claim_request"].includes(c.name),
        )
        .map((c) => c.name),
      ["coach_claim_task", "coach_claim_request", "coach_claim_task"],
    );
  } finally {
    await w.stop();
    await f.close();
  }
});
test("dropped completion response reconciles original receipt without resubmit or failure", async () => {
  const f = await taskFixture({ dropComplete: true });
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async () => '{"text":"stored once"}',
  });
  try {
    f.enqueue();
    await w.pollOnce();
    assert.equal(w.state, "task-result-stored");
    assert.equal(f.saved.length, 1);
    assert.equal(
      f.calls.filter((c) => c.name === "coach_complete_task").length,
      1,
    );
    assert.equal(
      f.calls.filter((c) => c.name === "coach_reconcile_task").length,
      1,
    );
    assert.ok(!f.calls.some((c) => c.name === "coach_fail_task"));
  } finally {
    await w.stop();
    await f.close();
  }
});
test("pre-write drop uses atomic resolution and then serves the unrelated queued identity", async () => {
  const f = await taskFixture();
  const original = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    if (
      init?.body &&
      JSON.parse(String(init.body)).params?.name === "coach_complete_task"
    )
      throw new TypeError("pre-write drop");
    return original(input, init);
  }) as typeof fetch;
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async () => '{"text":"generated"}',
  });
  const clock = Date.now;
  try {
    const first = f.enqueue();
    const second = f.enqueue();
    await w.pollOnce();
    Date.now = () => Date.parse(first.lease_expires_at) + 1;
    await w.pollOnce();
    Date.now = clock;
    await w.pollOnce();
    const claims = f.calls.filter((c) => c.name === "coach_claim_task");
    assert.deepEqual(claims.length, 2);
    assert.equal(
      f.calls.filter((c) => c.name === "coach_read_task_receipt").length,
      0,
    );
    assert.equal(
      f.calls.filter((c) => c.name === "coach_reconcile_task").length >= 2,
      true,
    );
    assert.equal(
      f.calls.filter((c) => c.name === "coach_read_task_context")[1]?.args
        .task_id,
      second.id,
    );
    assert.notEqual(first.id, second.id);
    assert.equal(f.saved.length, 0);
    assert.equal(
      f.calls.filter((c) => c.name === "coach_complete_task").length,
      0,
    );
    assert.equal(f.calls.filter((c) => c.name === "coach_fail_task").length, 0);
  } finally {
    Date.now = clock;
    globalThis.fetch = original;
    await w.stop();
    await f.close();
  }
});
test("late completion before authoritative resolution is stored, not retired by clock", async () => {
  const options: any = {};
  const f = await taskFixture(options);
  const original = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    if (
      init?.body &&
      JSON.parse(String(init.body)).params?.name === "coach_complete_task"
    )
      throw new TypeError("pre-write drop");
    return original(input, init);
  }) as typeof fetch;
  const clock = Date.now;
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async () => '{"text":"generated"}',
  });
  try {
    const first = f.enqueue();
    await w.pollOnce();
    options.onReconcile = (task: any) => {
      task.status = "completed";
      task.hash = createHash("sha256")
        .update(JSON.stringify({ text: "generated" }))
        .digest("hex");
      Date.now = () => Date.parse(first.lease_expires_at) + 1;
    };
    await w.pollOnce();
    assert.equal(w.state, "task-result-stored");
    assert.equal(
      f.calls.filter((c) => c.name === "coach_claim_task").length,
      1,
    );
  } finally {
    Date.now = clock;
    globalThis.fetch = original;
    await w.stop();
    await f.close();
  }
});
test("pre-write drop with authoritative failure releases the task slot without a second write", async () => {
  const options: any = {};
  const f = await taskFixture(options);
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    if (
      init?.body &&
      JSON.parse(String(init.body)).params?.name === "coach_complete_task"
    )
      throw new TypeError("synthetic pre-write drop");
    return fetchOriginal(input, init);
  }) as typeof fetch;
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async () => '{"text":"generated"}',
  });
  try {
    const first = f.enqueue();
    f.enqueue();
    await w.pollOnce();
    assert.equal(w.state, "task-result-unknown");
    options.receipt = {
      task: { ...first, status: "failed" },
      status: "failed",
      failure_code: "TASK_PROVIDER_FAILED",
    };
    await w.pollOnce();
    assert.equal(w.state, "task-result-unverified");
    options.receipt = undefined;
    await w.pollOnce();
    assert.equal(
      f.calls.filter((c) => c.name === "coach_claim_task").length,
      2,
    );
    assert.equal(f.saved.length, 0);
    assert.ok(!f.calls.some((c) => c.name === "coach_fail_task"));
  } finally {
    globalThis.fetch = fetchOriginal;
    await w.stop();
    await f.close();
  }
});
test("authoritative expiry fence releases unrelated queued work without a second completion", async () => {
  const f = await taskFixture();
  const fetchOriginal = globalThis.fetch;
  const nowOriginal = Date.now;
  globalThis.fetch = (async (input, init) => {
    if (
      init?.body &&
      JSON.parse(String(init.body)).params?.name === "coach_complete_task"
    )
      throw new TypeError("synthetic pre-write drop");
    return fetchOriginal(input, init);
  }) as typeof fetch;
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async () => '{"text":"generated"}',
  });
  try {
    const first = f.enqueue();
    f.enqueue();
    await w.pollOnce();
    await w.pollOnce();
    assert.equal(
      f.calls.filter((c) => c.name === "coach_claim_task").length,
      1,
    );
    Date.now = () => Date.parse(first.lease_expires_at) + 1;
    await w.pollOnce();
    assert.equal(w.state, "task-result-unverified");
    Date.now = nowOriginal;
    await w.pollOnce();
    assert.equal(
      f.calls.filter((c) => c.name === "coach_claim_task").length,
      2,
    );
    assert.equal(f.saved.length, 0);
    assert.ok(!f.calls.some((c) => c.name === "coach_fail_task"));
  } finally {
    Date.now = nowOriginal;
    globalThis.fetch = fetchOriginal;
    await w.stop();
    await f.close();
  }
});
test("transient receipt read error does not clear uncertain completion", async () => {
  const options = { receiptError: true };
  const f = await taskFixture(options);
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    if (
      init?.body &&
      JSON.parse(String(init.body)).params?.name === "coach_complete_task"
    )
      throw new TypeError("synthetic pre-write drop");
    return fetchOriginal(input, init);
  }) as typeof fetch;
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async () => '{"text":"generated"}',
  });
  try {
    f.enqueue();
    f.enqueue();
    await assert.rejects(w.pollOnce(), /DELIVERY_UNVERIFIED/);
    await w.pollOnce();
    assert.equal(
      f.calls.filter((c) => c.name === "coach_claim_task").length,
      1,
    );
    assert.equal(w.state, "task-result-unknown");
    options.receiptError = false;
    await w.pollOnce();
    assert.equal(
      f.calls.filter((c) => c.name === "coach_claim_task").length,
      1,
    );
    assert.equal(w.state, "task-result-unknown");
    assert.equal(f.saved.length, 0);
  } finally {
    globalThis.fetch = fetchOriginal;
    await w.stop();
    await f.close();
  }
});
test("source denial isolates uncertain digest while queued tasks take priority over expired source", async () => {
  const options = {
    dropComplete: true,
    reconcileDenial: "TASK_SOURCE_CHANGED",
  };
  const f = await taskFixture(options);
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    isolationMs: 1,
    complete: async () => '{"text":"generated"}',
  });
  try {
    const first = f.enqueue();
    f.deny(first.id);
    await assert.rejects(w.pollOnce(), /DELIVERY_UNVERIFIED/);
    const second = f.enqueue();
    await w.pollOnce();
    assert.equal(w.incidents.length, 1);
    assert.equal(w.incidents[0].taskId, first.id);
    assert.match(w.incidents[0].digest, /^[0-9a-f]{64}$/);
    assert.equal(w.incidents[0].reason, "TASK_SOURCE_CHANGED");
    assert.equal(w.state, "task-result-stored");
    assert.equal(f.saved.length, 2);
    assert.equal(f.saved[1].task_id, second.id);
    await new Promise((r) => setTimeout(r, 2));
    await w.pollOnce();
    assert.equal(w.incidents.length, 1);
    assert.ok(
      f.calls.filter(
        (c) => c.name === "coach_reconcile_task" && c.args.task_id === first.id,
      ).length >= 2,
    );
    assert.equal(
      f.calls.filter(
        (c) => c.name === "coach_complete_task" && c.args.task_id === first.id,
      ).length,
      1,
    );
    assert.ok(!f.calls.some((c) => c.name === "coach_fail_task"));
  } finally {
    await w.stop();
    await f.close();
  }
});
test("transient reconcile error never isolates an unknown completion", async () => {
  const options = { dropComplete: true, receiptError: true };
  const f = await taskFixture(options);
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async () => '{"text":"generated"}',
  });
  try {
    f.enqueue();
    f.enqueue();
    await assert.rejects(w.pollOnce());
    await w.pollOnce();
    assert.equal(w.incidents.length, 0);
    assert.equal(
      f.calls.filter((c) => c.name === "coach_claim_task").length,
      1,
    );
  } finally {
    await w.stop();
    await f.close();
  }
});
test("isolated denial stays unknown past expiry and resolves only on restored authoritative receipt", async () => {
  const options: any = {
    dropComplete: true,
    reconcileDenial: "TASK_ROUTING_CHANGED",
  };
  const f = await taskFixture(options);
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    isolationMs: 1,
    complete: async () => '{"text":"generated"}',
  });
  try {
    const first = f.enqueue();
    f.deny(first.id);
    await assert.rejects(w.pollOnce());
    assert.equal(w.incidents.length, 1);
    assert.equal(w.incidents[0].reason, "TASK_ROUTING_CHANGED");
    await new Promise((r) => setTimeout(r, 2));
    await w.pollOnce();
    assert.equal(w.incidents.length, 1);
    options.reconcileDenial = undefined;
    await new Promise((r) => setTimeout(r, 2));
    await w.pollOnce();
    assert.equal(w.incidents.length, 0);
    assert.equal(
      f.calls.filter((c) => c.name === "coach_complete_task").length,
      1,
    );
    assert.ok(!f.calls.some((c) => c.name === "coach_fail_task"));
  } finally {
    await w.stop();
    await f.close();
  }
});
test("bounded incident capacity stops new typed claims rather than discarding uncertainty", async () => {
  const f = await taskFixture({
    dropComplete: true,
    reconcileDenial: "TASK_SOURCE_CHANGED",
  });
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async () => '{"text":"generated"}',
  });
  try {
    for (let i = 0; i < 33; i++) {
      const task = f.enqueue();
      f.deny(task.id);
    }
    for (let i = 0; i < 32; i++)
      await assert.rejects(w.pollOnce(), /DELIVERY_UNVERIFIED/);
    assert.equal(w.incidents.length, 32);
    await w.pollOnce();
    assert.equal(
      f.calls.filter((c) => c.name === "coach_claim_task").length,
      32,
    );
    assert.equal(f.saved.length, 32);
    assert.equal(w.incidents.length, 32);
    assert.ok(!f.calls.some((c) => c.name === "coach_fail_task"));
  } finally {
    await w.stop();
    await f.close();
  }
});
test("unknown completion outcome is reconciled on next poll without another completion", async () => {
  const options = { dropComplete: true, receiptError: true };
  const f = await taskFixture(options);
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async () => '{"text":"stored once"}',
  });
  try {
    f.enqueue();
    await assert.rejects(w.pollOnce());
    options.receiptError = false;
    await w.pollOnce();
    assert.equal(w.state, "task-result-stored");
    assert.equal(f.saved.length, 1);
    assert.equal(
      f.calls.filter((c) => c.name === "coach_complete_task").length,
      1,
    );
    assert.equal(
      f.calls.filter((c) => c.name === "coach_reconcile_task").length,
      2,
    );
    assert.ok(!f.calls.some((c) => c.name === "coach_fail_task"));
  } finally {
    await w.stop();
    await f.close();
  }
});
test("malformed claim identity never grants inference authority", async () => {
  for (const claim of [
    { id: "not-an-id" },
    { requester_id: "" },
    { scope_generation: -1 },
    { kind: "recipe" },
    { lease_generation: 0 },
    { owner_type: "public" },
    { provider_settings: { key: "no" } },
  ]) {
    const f = await taskFixture();
    let count = 0;
    const w = new Worker({
      origin: f.origin,
      token: "worker-secret",
      system: "Coach",
      complete: async () => {
        count++;
        return '{"text":"bad"}';
      },
    });
    try {
      f.enqueue("activity_followup", claim);
      await assert.rejects(w.pollOnce());
      assert.equal(count, 0);
      assert.ok(!f.calls.some((c) => c.name === "coach_read_task_context"));
    } finally {
      await w.stop();
      await f.close();
    }
  }
});
test("all task context identity and original deadline fields are fenced byte for byte", async () => {
  for (const field of [
    "id",
    "requester_id",
    "owner_type",
    "owner_id",
    "scope_generation",
    "requester_generation",
    "conversation_generation",
    "lease_generation",
    "created_at",
    "timeout_at",
    "lease_expires_at",
    "kind",
    "schema_id",
    "protocol",
  ]) {
    const f = await taskFixture({ contextTask: { [field]: "changed" } });
    let count = 0;
    const w = new Worker({
      origin: f.origin,
      token: "worker-secret",
      system: "Coach",
      complete: async () => {
        count++;
        return '{"text":"bad"}';
      },
    });
    try {
      f.enqueue();
      await assert.rejects(w.pollOnce());
      assert.equal(count, 0);
      assert.equal(f.saved.length, 0);
    } finally {
      await w.stop();
      await f.close();
    }
  }
});
test("missing any required task tool stays main-only without claiming tasks", async () => {
  for (const missing of names) {
    const f = await taskFixture({
      tools: names.filter((n) => n !== missing),
      main: true,
    });
    const w = new Worker({
      origin: f.origin,
      token: "worker-secret",
      system: "Coach",
      complete: async () => "legacy reply",
    });
    try {
      f.enqueue();
      await w.pollOnce();
      assert.equal(w.state, "reply-persisted");
      assert.ok(!f.calls.some((c) => c.name === "coach_claim_task"));
    } finally {
      await w.stop();
      await f.close();
    }
  }
});
test("task diagnostics distinguish stored result from a published main chat reply", async () => {
  const f = await taskFixture();
  const events: any[] = [];
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    onDiagnostic: (e) => events.push(e),
    complete: async () => '{"text":"stored"}',
  });
  try {
    f.enqueue();
    await w.pollOnce();
    assert.ok(events.some((e) => e.stage === "task-result-stored"));
    assert.ok(!events.some((e) => e.stage === "reply-persisted"));
  } finally {
    await w.stop();
    await f.close();
  }
});
test("stop fences noncooperative typed provider without late completion", async () => {
  const f = await taskFixture();
  let enter!: () => void;
  let finish!: (s: string) => void;
  const entered = new Promise<void>((r) => (enter = r));
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async () => {
      enter();
      return new Promise((r) => (finish = r));
    },
  });
  try {
    f.enqueue();
    const pending = w.pollOnce();
    pending.catch(() => {});
    await entered;
    await w.stop();
    finish('{"text":"late"}');
    await assert.rejects(pending);
    assert.equal(f.saved.length, 0);
    assert.ok(!f.calls.some((c) => c.name === "coach_complete_task"));
  } finally {
    finish?.('{"text":"late"}');
    await w.stop();
    await f.close();
  }
});
test("receipt digest mismatch stays unknown and never resubmits or downgrades", async () => {
  const f = await taskFixture({ receiptHash: "f".repeat(64) });
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async () => '{"text":"stored"}',
  });
  try {
    f.enqueue();
    await assert.rejects(w.pollOnce(), /DELIVERY_UNVERIFIED/);
    await w.pollOnce();
    assert.equal(f.saved.length, 1);
    assert.ok(!f.calls.some((c) => c.name === "coach_fail_task"));
  } finally {
    await w.stop();
    await f.close();
  }
});
test("malformed independent receipt cannot establish stored success", async () => {
  for (const receipt of [
    { completed_at: null },
    { failure_code: "TASK_PROVIDER_FAILED" },
    { consumed_at: "not-a-date" },
    { extra: "unexpected" },
  ]) {
    const f = await taskFixture({ receipt });
    const w = new Worker({
      origin: f.origin,
      token: "worker-secret",
      system: "Coach",
      complete: async () => '{"text":"stored"}',
    });
    try {
      f.enqueue();
      await assert.rejects(w.pollOnce(), /DELIVERY_UNVERIFIED/);
      assert.equal(f.saved.length, 1);
      assert.ok(!f.calls.some((c) => c.name === "coach_fail_task"));
    } finally {
      await w.stop();
      await f.close();
    }
  }
});
test("stop during completion uses independent live receipt transport", async () => {
  let stopped: Promise<void> | undefined;
  let w: Worker;
  const f = await taskFixture({
    dropComplete: true,
    onComplete: () => {
      stopped = w.stop();
    },
  });
  w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async () => '{"text":"stored"}',
  });
  try {
    f.enqueue();
    await w.pollOnce();
    await stopped;
    assert.equal(f.saved.length, 1);
    assert.equal(
      f.calls.filter((c) => c.name === "coach_reconcile_task").length,
      1,
    );
    assert.ok(!f.calls.some((c) => c.name === "coach_fail_task"));
  } finally {
    await w.stop();
    await f.close();
  }
});
test("strict local schemas deny coerced numbers, unknown fields, enums, secrets and UTF8 overflow", () => {
  for (const [kind, value] of [
    [
      "workout_suggestions",
      {
        recommendations: {
          ["a".repeat(24)]: { summary: "", target_reps: "8" },
        },
      },
    ],
    [
      "workout_suggestions",
      {
        recommendations: {
          ["a".repeat(24)]: { summary: "", target_weight: 2001 },
        },
      },
    ],
    [
      "exercise_suggestions",
      { summary: "", reply_worthwhile: false, reactions: [], tool: "swap" },
    ],
    [
      "activity_reaction",
      {
        activity_feedback: { reaction: "muscle", reply_worthwhile: false },
        general_advice: "",
      },
    ],
    ["activity_followup", { text: "secret-marker" }],
    ["activity_followup", { text: "😀".repeat(7000) }],
  ])
    assert.throws(() =>
      parseTaskResult(kind as string, JSON.stringify(value), ["secret-marker"]),
    );
  for (const raw of [
    "null",
    '```json\n{"text":"ok"}\n```',
    '{"text":"ok","unknown":true}',
  ])
    assert.throws(() => parseTaskResult("activity_followup", raw, []));
});
test("negotiated task lifecycle submits structured result once and independently reads receipt", async () => {
  const f = await taskFixture();
  let seen: any;
  const w = new Worker({
    origin: f.origin,
    token: "synthetic-worker-credential",
    system: "Saved Coach persona",
    complete: async (context, signal, system, tools) => {
      seen = { context, system, tools };
      return '{"text":"Steady progress."}';
    },
  });
  try {
    f.enqueue();
    await w.pollOnce();
    assert.equal(f.saved.length, 1);
    assert.deepEqual(f.saved[0].result, { text: "Steady progress." });
    assert.equal(
      f.calls.filter((c) => c.name === "coach_reconcile_task").length,
      1,
    );
    assert.deepEqual(seen.tools, []);
    assert.ok(seen.system.includes("Saved Coach persona"));
    assert.equal(w.state, "task-result-stored");
    assert.ok(!f.calls.some((c) => c.name === "coach_read_context"));
  } finally {
    await w.stop();
    await f.close();
  }
});
