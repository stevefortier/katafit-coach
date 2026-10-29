import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "../src/worker/runner.js";
import {
  taskCatalog,
  legacyDailyInsightContract,
} from "../src/katafit/taskCatalog.js";
import {
  parseTaskResult,
  taskContext,
  taskSchema,
  TaskOutputError,
} from "../src/katafit/tasks.js";
import { taskFixture } from "./task-fixtures.js";

const current = taskCatalog.contracts.find((c) => c.kind === "daily_insight")!;
const capabilities = (daily: any = current) => ({
  protocol: "coach.tasks.v1",
  kinds: taskCatalog.contracts.map((c) => c.kind),
  contracts: structuredClone(
    taskCatalog.contracts.map((c) => (c.kind === "daily_insight" ? daily : c)),
  ),
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
const base = {
  general_advice: "Keep the session easy.",
  meal_recommendations: [],
  recovery_recommendations: [],
  workout_directives: [],
};
const decision = {
  decision: "adjust",
  new_daily_calories: 3180,
  reason: "  Weight fell at fully logged target intake.  ",
  uncertainty: "Fluid and measurement noise.",
  review_after_days: 21,
  monitoring_goal: "Reassess comparable weigh-ins.",
};

async function run(daily: any, output: any, kind = "daily_insight") {
  const f = await taskFixture({
    capabilities: capabilities(daily),
    ...(kind === "daily_insight"
      ? { context: { result_schema: structuredClone(daily.result_schema) } }
      : {}),
  });
  const systems: string[] = [];
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async (
      _context: string,
      _signal: AbortSignal,
      system: string,
    ) => {
      systems.push(system);
      return JSON.stringify(output);
    },
  });
  try {
    f.enqueue(kind);
    await w.pollOnce();
    return {
      kinds: f.calls.find((c) => c.name === "coach_claim_task")?.args.kinds,
      saved: f.saved,
      systems,
    };
  } finally {
    await w.stop();
    await f.close();
  }
}

test("the extended daily schema is exactly the legacy schema plus an optional last nutrition_decision", () => {
  const { nutrition_decision, ...rest } = current.result_schema.properties;
  assert.deepEqual(
    {
      ...current,
      result_schema: { ...current.result_schema, properties: rest },
    },
    legacyDailyInsightContract,
  );
  assert.equal(
    Object.keys(current.result_schema.properties).at(-1),
    "nutrition_decision",
  );
  assert.ok(
    !current.result_schema.required.includes("nutrition_decision" as never),
  );
  assert.equal(
    legacyDailyInsightContract.schema_id,
    "coach.tasks.v1/daily_insight",
  );
});

test("new backend: discovery, context, model schema and normalized output carry nutrition_decision", async () => {
  const out = await run(current, { ...base, nutrition_decision: decision });
  assert.ok(out.kinds.includes("daily_insight"));
  assert.match(out.systems[0], /"nutrition_decision"/);
  assert.equal(out.saved.length, 1);
  assert.deepEqual(out.saved[0].result.nutrition_decision, {
    ...decision,
    reason: "Weight fell at fully logged target intake.",
  });
});

test("legacy backend: delivered legacy schema drives the model prompt and output validation", async () => {
  const out = await run(legacyDailyInsightContract, base);
  assert.ok(out.kinds.includes("daily_insight"));
  assert.doesNotMatch(out.systems[0], /nutrition_decision/);
  assert.equal(out.saved.length, 1);
  assert.equal("nutrition_decision" in out.saved[0].result, false);
  // The legacy strict schema rejects the field exactly as that backend would.
  assert.throws(
    () =>
      parseTaskResult(
        "daily_insight",
        JSON.stringify({ ...base, nutrition_decision: decision }),
        [],
        legacyDailyInsightContract.result_schema,
      ),
    (e: any) => e instanceof TaskOutputError && e.category === "SCHEMA",
  );
});

test("nutrition_decision follows the backend strict, nonblank and nullable constraints", () => {
  const parse = (value: any) =>
    parseTaskResult(
      "daily_insight",
      JSON.stringify(value),
      [],
      current.result_schema,
    );
  assert.equal(
    parse({ ...base, nutrition_decision: null }).nutrition_decision,
    null,
  );
  assert.equal(
    parse({
      ...base,
      nutrition_decision: {
        ...decision,
        decision: "observe",
        new_daily_calories: null,
      },
    }).nutrition_decision.new_daily_calories,
    null,
  );
  for (const bad of [
    { ...decision, reason: "   " },
    { ...decision, new_daily_calories: 3180.5 },
    { ...decision, new_daily_calories: 0 },
    { ...decision, review_after_days: 91 },
    { ...decision, member_id: "a".repeat(24) },
    { ...decision, decision: "apply" },
  ])
    assert.throws(
      () => parse({ ...base, nutrition_decision: bad }),
      (e: any) => e instanceof TaskOutputError && e.category === "SCHEMA",
    );
});

test("a wrong daily schema is not negotiated and other kinds keep their single exact contract", async () => {
  const wrong: any = structuredClone(current);
  wrong.result_schema.properties.nutrition_decision.anyOf[0].properties.reason.maxLength = 999;
  const out = await run(wrong, { text: "ordinary kind" }, "activity_followup");
  assert.equal(out.saved.length, 1);
  assert.ok(!out.kinds.includes("daily_insight"));
  assert.ok(out.kinds.includes("activity_followup"));
  assert.equal(taskSchema("daily_insight", wrong.result_schema), undefined);
  // The legacy variant is daily-only; it never widens another kind.
  assert.equal(
    taskSchema("activity_followup", legacyDailyInsightContract.result_schema),
    undefined,
  );
});

test("context rejects a daily schema that is neither exact local variant", () => {
  const task = {
    id: "a".repeat(24),
    kind: "daily_insight",
    protocol: "coach.tasks.v1",
    schema_id: "coach.tasks.v1/daily_insight",
    requester_id: "b".repeat(24),
    owner_type: "personal",
    owner_id: "b".repeat(24),
    scope_generation: 0,
    requester_generation: 0,
    conversation_generation: 0,
    status: "claimed",
    lease_generation: 1,
    created_at: "2026-10-29T12:00:00.000Z",
    timeout_at: "2026-10-29T12:15:00.000Z",
    lease_expires_at: "2026-10-29T12:02:00.000Z",
  };
  const context = (result_schema: any) => ({
    task,
    instructions: "Generate.",
    evidence: { timezone: "UTC", observations: [], conversation: [] },
    result_schema,
    allowed_tools: [],
    direct_mutations_forbidden: true,
  });
  for (const ok of [
    current.result_schema,
    legacyDailyInsightContract.result_schema,
  ])
    assert.equal(
      typeof taskContext(task, context(structuredClone(ok)), []),
      "string",
    );
  const wrong: any = structuredClone(current.result_schema);
  wrong.properties.nutrition_decision.anyOf[0].required.pop();
  assert.throws(
    () => taskContext(task, context(wrong), []),
    /CONTEXT_REJECTED/,
  );
});

test("decision/calorie pairing is a repairable SEMANTIC error mirroring the backend refinement", async () => {
  const parse = (value: any) =>
    parseTaskResult(
      "daily_insight",
      JSON.stringify({ ...base, nutrition_decision: value }),
      [],
      current.result_schema,
    );
  for (const bad of [
    { ...decision, new_daily_calories: null },
    { ...decision, decision: "observe" },
    { ...decision, decision: "request_evidence" },
  ])
    assert.throws(
      () => parse(bad),
      (e: any) =>
        e instanceof TaskOutputError &&
        e.category === "SEMANTIC" &&
        /new_daily_calories/.test(e.repairHint),
    );
  assert.equal(
    parse({
      ...decision,
      decision: "request_evidence",
      new_daily_calories: null,
    }).nutrition_decision.decision,
    "request_evidence",
  );
  // The worker's bounded correction repairs the pairing before completion.
  const outputs = [
    { ...base, nutrition_decision: { ...decision, new_daily_calories: null } },
    { ...base, nutrition_decision: decision },
  ];
  const f = await taskFixture({
    capabilities: capabilities(current),
    context: { result_schema: structuredClone(current.result_schema) },
  });
  let calls = 0;
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async () => JSON.stringify(outputs[Math.min(calls++, 1)]),
  });
  try {
    f.enqueue("daily_insight");
    await w.pollOnce();
    assert.equal(calls, 2);
    assert.equal(f.saved.length, 1);
    assert.equal(f.saved[0].result.nutrition_decision.new_daily_calories, 3180);
  } finally {
    await w.stop();
    await f.close();
  }
});
