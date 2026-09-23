import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "../src/worker/runner.js";
import { taskCatalog } from "../src/katafit/taskCatalog.js";
import { taskFixture } from "./task-fixtures.js";
const capabilities = () => ({
  protocol: "coach.tasks.v1",
  kinds: taskCatalog.contracts.map((c) => c.kind),
  contracts: structuredClone(taskCatalog.contracts),
  limits: {
    result_bytes: 24000,
    evidence_bytes: 65536,
    task_lifetime_seconds: 900,
    lease_seconds_min: 15,
    lease_seconds_max: 300,
    lease_seconds_default: 60,
  },
  direct_mutations_forbidden: true,
  completion_is_publication: false,
});
test("capability intersection includes only exact local schemas and advertised registered kinds", async () => {
  const cap: any = capabilities();
  cap.kinds = ["activity_followup", "recipe"];
  cap.contracts.push({
    kind: "recipe",
    schema_id: "remote/arbitrary",
    result_schema: { type: "object" },
  });
  const f = await taskFixture({ capabilities: cap });
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async () => '{"text":"ok"}',
  });
  try {
    f.enqueue();
    await w.pollOnce();
    assert.deepEqual(f.calls.find((c) => c.name === "coach_claim_task").args, {
      protocol: "coach.tasks.v1",
      kinds: ["activity_followup"],
      lease_seconds: 60,
    });
  } finally {
    await w.stop();
    await f.close();
  }
});
test("unknown protocol, schema mismatch, missing contracts and bad limits never claim", async () => {
  for (const change of [
    (c: any) => (c.protocol = "future"),
    (c: any) => (c.contracts = []),
    (c: any) => (c.limits.result_bytes = 999999),
    (c: any) => {
      c.kinds = ["activity_followup"];
      c.contracts.find(
        (x: any) => x.kind === "activity_followup",
      ).result_schema.properties.text.maxLength = 999999;
    },
    (c: any) => (c.direct_mutations_forbidden = false),
    (c: any) => (c.completion_is_publication = true),
  ]) {
    const cap: any = capabilities();
    change(cap);
    const f = await taskFixture({ capabilities: cap, main: true });
    const w = new Worker({
      origin: f.origin,
      token: "worker-secret",
      system: "Coach",
      complete: async () => "legacy",
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
test("oversized UTF8 evidence, legacy grants, changed schema and known credentials fail before inference", async () => {
  for (const context of [
    {
      evidence: {
        timezone: "UTC",
        observations: Array.from({ length: 20 }, () => ({
          label: "activity",
          text: "界".repeat(4000),
        })),
        conversation: [],
      },
    },
    { allowed_tools: ["coach_read_media"] },
    { provider_settings: {} },
    { instructions: "worker-secret" },
    { result_schema: { type: "object" } },
  ]) {
    const f = await taskFixture({ context });
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
      assert.equal(
        f.calls.find((c) => c.name === "coach_fail_task")?.args.code,
        "TASK_CONTEXT_UNAVAILABLE",
      );
    } finally {
      await w.stop();
      await f.close();
    }
  }
});
test("failure receipt validates complete task identity not just id and lease", async () => {
  const f = await taskFixture({
    receipt: {
      task: {
        id: "000000000000000000000001",
        lease_generation: 1,
        schema_id: "wrong",
      },
    },
  });
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async () => "bad JSON",
  });
  try {
    f.enqueue();
    await assert.rejects(w.pollOnce());
    assert.equal(w.state, "task-failure-unverified");
  } finally {
    await w.stop();
    await f.close();
  }
});
test("main listing failures yield the next turn to typed tasks", async () => {
  const f = await taskFixture({ mainListError: true });
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async () => '{"text":"task"}',
  });
  try {
    f.enqueue();
    f.enqueue();
    await w.pollOnce();
    await assert.rejects(w.pollOnce());
    await w.pollOnce();
    assert.equal(f.saved.length, 2);
  } finally {
    await w.stop();
    await f.close();
  }
});
test("main chat still progresses after a task error or unresolved completion", async () => {
  for (const dropComplete of [false, true]) {
    const f = await taskFixture({
      main: true,
      dropComplete,
      receiptError: dropComplete,
    });
    const w = new Worker({
      origin: f.origin,
      token: "worker-secret",
      system: "Coach",
      complete: async (context) =>
        context.includes("generation_task")
          ? dropComplete
            ? '{"text":"stored"}'
            : "bad JSON"
          : "Main reply",
    });
    try {
      f.enqueue();
      await assert.rejects(w.pollOnce());
      await w.pollOnce();
      assert.equal(w.state, "reply-persisted");
      assert.equal(
        f.calls.filter((c) => c.name === "coach_claim_request").length,
        1,
      );
    } finally {
      await w.stop();
      await f.close();
    }
  }
});
