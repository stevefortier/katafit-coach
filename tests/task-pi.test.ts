import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { complete } from "../src/runtime/piAdapter.js";
import { Worker } from "../src/worker/runner.js";
import { taskFixture } from "./task-fixtures.js";
const results: Record<string, any> = {
  activity_reaction: {
    activity_feedback: { reaction: "flex", reply_worthwhile: false },
    general_advice: "",
  },
  activity_followup: { text: "Keep steady." },
  daily_insight: {
    general_advice: "Recover well.",
    meal_recommendations: [],
    recovery_recommendations: [],
    workout_directives: [],
  },
  media_chat: { text: "Text-only authorized evidence." },
  workout_chat: { text: "Ready to train." },
  exercise_chat: { text: "Keep control." },
  workout_suggestions: {
    recommendations: {
      ["a".repeat(24)]: {
        summary: "Steady load",
        target_weight: 0,
        target_reps: 8,
        target_working_sets: 3,
        intensity: "moderate",
      },
    },
  },
  exercise_suggestions: { summary: "", reply_worthwhile: false, reactions: [] },
};
async function provider(reply: (body: any) => string) {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    bodies.push(body);
    res.setHeader("Content-Type", "text/event-stream");
    res.end(
      "data: " +
        JSON.stringify({
          id: "fixture",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: reply(body) },
              finish_reason: null,
            },
          ],
        }) +
        "\n\ndata: " +
        JSON.stringify({
          id: "fixture",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    bodies,
    config: {
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      model: "synthetic-typed-model",
      apiKey: "synthetic-provider-credential",
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
for (const [kind, result] of Object.entries(results))
  test(`actual Pi + synthetic HTTP typed lifecycle: ${kind}`, async () => {
    const f = await taskFixture();
    const p = await provider(() => JSON.stringify(result));
    const w = new Worker({
      origin: f.origin,
      token: "synthetic-worker-credential",
      system: "Saved standalone persona",
      complete: (context, signal, system, tools) =>
        complete(
          { ...p.config, secrets: ["synthetic-worker-credential"] },
          system,
          context,
          signal,
          tools,
        ),
    });
    try {
      f.enqueue(kind);
      await w.pollOnce();
      assert.deepEqual(f.saved[0].result, result);
      assert.equal(w.state, "task-result-stored");
      assert.equal(p.bodies.length, 1);
      assert.ok(!p.bodies[0].tools?.length);
      const payload = JSON.stringify(p.bodies[0]);
      assert.ok(payload.includes("generation_task"));
      assert.ok(payload.includes("Saved standalone persona"));
      assert.ok(!payload.includes("requester_id"));
      assert.ok(!payload.includes("lease_generation"));
      assert.equal(
        f.calls.filter((c) => c.name === "coach_reconcile_task").length,
        1,
      );
      assert.ok(
        !f.calls.some((c) =>
          [
            "coach_respond",
            "coach_read_context",
            "coach_get_capabilities",
          ].includes(c.name),
        ),
      );
    } finally {
      await w.stop();
      await f.close();
      await p.close();
    }
  });
test("actual Pi typed task cancellation after HTTP headers stops inference without completion", async () => {
  let entered!: () => void;
  const seen = new Promise<void>((r) => (entered = r));
  const server = createServer(async (req, res) => {
    for await (const c of req) {
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(": headers received\n\n");
    entered();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const f = await taskFixture();
  let settled!: () => void;
  const done = new Promise<void>((r) => (settled = r));
  const w = new Worker({
    origin: f.origin,
    token: "synthetic-worker-credential",
    system: "Coach",
    complete: async (context, signal, system, tools) => {
      try {
        return await complete(
          {
            baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
            model: "synthetic-hanging-model",
            apiKey: "synthetic-provider-credential",
          },
          system,
          context,
          signal,
          tools,
        );
      } finally {
        settled();
      }
    },
  });
  try {
    f.enqueue();
    const work = w.pollOnce();
    work.catch(() => {});
    await seen;
    await w.stop();
    await assert.rejects(work);
    await done;
    assert.equal(f.saved.length, 0);
    assert.ok(!f.calls.some((c) => c.name === "coach_complete_task"));
  } finally {
    await w.stop();
    await f.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("actual Pi malformed typed JSON fails rather than fabricating fallback feedback", async () => {
  const f = await taskFixture();
  const p = await provider(
    () =>
      '{"activity_feedback":{"reaction":"muscle","reply_worthwhile":false},"general_advice":""}',
  );
  const w = new Worker({
    origin: f.origin,
    token: "synthetic-worker-credential",
    system: "Coach",
    complete: (context, signal, system, tools) =>
      complete(p.config, system, context, signal, tools),
  });
  try {
    f.enqueue("activity_reaction");
    await assert.rejects(w.pollOnce());
    assert.equal(f.saved.length, 0);
    assert.equal(
      f.calls.find((c) => c.name === "coach_fail_task")?.args.code,
      "TASK_INVALID_OUTPUT",
    );
  } finally {
    await w.stop();
    await f.close();
    await p.close();
  }
});
for (const [category, first] of [
  ["json", "not JSON"],
  ["schema", '{"text":"ok","unexpected":true}'],
  [
    "semantic",
    '{"activity_feedback":{"reaction":"flex","reply_worthwhile":false},"general_advice":"not silent"}',
  ],
] as const)
  test(`actual Pi corrects ${category} typed output with a fresh tool-free request`, async () => {
    const f = await taskFixture();
    const valid =
      category === "semantic"
        ? JSON.stringify(results.activity_reaction)
        : JSON.stringify(results.activity_followup);
    const p = await provider(() => (p.bodies.length === 1 ? first : valid));
    const events: any[] = [];
    const w = new Worker({
      origin: f.origin,
      token: "synthetic-worker-credential",
      system: "Coach",
      onDiagnostic: (event) => events.push(event),
      complete: (context, signal, system, tools) =>
        complete(p.config, system, context, signal, tools),
    });
    try {
      f.enqueue(
        category === "semantic" ? "activity_reaction" : "activity_followup",
      );
      await w.pollOnce();
      assert.equal(p.bodies.length, 2);
      assert.deepEqual(f.saved[0].result, JSON.parse(valid));
      assert.equal(
        f.calls.filter((c) => c.name === "coach_complete_task").length,
        1,
      );
      assert.equal(
        f.calls.filter((c) => c.name === "coach_reconcile_task").length,
        1,
      );
      assert.ok(!p.bodies[1].tools?.length);
      assert.ok(!JSON.stringify(p.bodies[1]).includes(first));
      assert.ok(JSON.stringify(p.bodies[1]).includes("Return only JSON"));
      assert.ok(
        events.some(
          (e) =>
            e.stage === "task-output-correction" &&
            e.error?.code === `TASK_OUTPUT_${category.toUpperCase()}`,
        ),
      );
    } finally {
      await w.stop();
      await f.close();
      await p.close();
    }
  });

test("actual Pi records both rejected candidates and precise reasons locally, never sends them to backend", async () => {
  const f = await taskFixture();
  const raw = "private-invalid-output-do-not-log";
  const p = await provider(() => raw);
  const events: any[] = [];
  const w = new Worker({
    origin: f.origin,
    token: "synthetic-worker-credential",
    system: "Coach",
    onDiagnostic: (e) => events.push(e),
    complete: (context, signal, system, tools) =>
      complete(p.config, system, context, signal, tools),
  });
  try {
    f.enqueue();
    await assert.rejects(w.pollOnce());
    assert.equal(p.bodies.length, 2);
    assert.equal(f.saved.length, 0);
    assert.equal(
      f.calls.filter((c) => c.name === "coach_fail_task")[0].args.code,
      "TASK_INVALID_OUTPUT",
    );
    assert.equal(
      f.calls.filter((c) => c.name === "coach_read_task_receipt").length,
      1,
    );
    const rejections = events.filter(
      (e) => e.stage === "task-output-correction",
    );
    assert.deepEqual(
      rejections.map((e) => e.rejection?.attempt),
      [1, 2],
    );
    assert.ok(
      rejections.every(
        (e) =>
          e.rejection?.text === raw &&
          /Unexpected|JSON|token/i.test(e.rejection.reason),
      ),
    );
    assert.ok(!JSON.stringify(f.calls).includes(raw));
    assert.ok(
      events.some(
        (e) =>
          e.stage === "task-output-correction" &&
          e.error?.code === "TASK_OUTPUT_JSON",
      ),
    );
  } finally {
    await w.stop();
    await f.close();
    await p.close();
  }
});

test("actual Pi skips correction when inference time is insufficient", async () => {
  const f = await taskFixture();
  const p = await provider(() => "not JSON");
  const events: any[] = [];
  const w = new Worker({
    origin: f.origin,
    token: "synthetic-worker-credential",
    system: "Coach",
    modelMs: 1000,
    onDiagnostic: (e) => events.push(e),
    complete: (context, signal, system, tools) =>
      complete(p.config, system, context, signal, tools),
  });
  try {
    f.enqueue();
    await assert.rejects(w.pollOnce());
    assert.equal(p.bodies.length, 1);
    assert.equal(
      f.calls.filter((c) => c.name === "coach_fail_task")[0].args.code,
      "TASK_INVALID_OUTPUT",
    );
    assert.ok(
      events.some(
        (e) =>
          e.stage === "task-output-correction" &&
          e.error?.code === "TASK_OUTPUT_JSON",
      ),
    );
  } finally {
    await w.stop();
    await f.close();
    await p.close();
  }
});

for (const [name, response, expected] of [
  [
    "credential",
    '{"text":"Bearer synthetic-other-credential"}',
    "TASK_OUTPUT_SECURITY",
  ],
  [
    "malformed secret",
    "Bearer synthetic-other-credential {",
    "TASK_OUTPUT_SECURITY",
  ],
  ["oversize", JSON.stringify({ text: "z".repeat(25000) }), "TASK_OUTPUT_SIZE"],
] as const)
  test(`actual Pi fails closed on ${name} without asking provider to repair`, async () => {
    const f = await taskFixture();
    const p = await provider(() => response);
    const events: any[] = [];
    const w = new Worker({
      origin: f.origin,
      token: "synthetic-worker-credential",
      system: "Coach",
      onDiagnostic: (e) => events.push(e),
      complete: (context, signal, system, tools) =>
        complete(p.config, system, context, signal, tools),
    });
    try {
      f.enqueue();
      await assert.rejects(w.pollOnce());
      assert.equal(p.bodies.length, 1);
      assert.equal(f.saved.length, 0);
      assert.equal(
        f.calls.filter((c) => c.name === "coach_fail_task")[0].args.code,
        "TASK_INVALID_OUTPUT",
      );
      assert.ok(
        events.some(
          (e) =>
            e.stage === "task-output-correction" && e.error?.code === expected,
        ),
      );
      assert.ok(!JSON.stringify(events).includes(response));
      assert.ok(!JSON.stringify(f.calls).includes(response));
    } finally {
      await w.stop();
      await f.close();
      await p.close();
    }
  });

test("actual Pi correction never retries a source-revoked completion", async () => {
  let f: Awaited<ReturnType<typeof taskFixture>>;
  f = await taskFixture({
    dropComplete: true,
    reconcileDenial: "TASK_SOURCE_CHANGED",
    onComplete: () => f.deny(task.id),
  });
  const task = f.enqueue();
  const p = await provider(() =>
    p.bodies.length === 1
      ? "not JSON"
      : JSON.stringify(results.activity_followup),
  );
  const w = new Worker({
    origin: f.origin,
    token: "synthetic-worker-credential",
    system: "Coach",
    isolationMs: 0,
    complete: (context, signal, system, tools) =>
      complete(p.config, system, context, signal, tools),
  });
  try {
    await assert.rejects(w.pollOnce(), /DELIVERY_UNVERIFIED/);
    assert.equal(w.incidents.length, 1);
    await w.pollOnce();
    assert.equal(p.bodies.length, 2);
    assert.equal(
      f.calls.filter((c) => c.name === "coach_complete_task").length,
      1,
    );
    assert.equal(f.calls.filter((c) => c.name === "coach_fail_task").length, 0);
  } finally {
    await w.stop();
    await f.close();
    await p.close();
  }
});

test("actual Pi correction reconciles lost completion response without duplicate write", async () => {
  const f = await taskFixture({ dropComplete: true });
  const p = await provider(() =>
    p.bodies.length === 1
      ? "not JSON"
      : JSON.stringify(results.activity_followup),
  );
  const w = new Worker({
    origin: f.origin,
    token: "synthetic-worker-credential",
    system: "Coach",
    complete: (context, signal, system, tools) =>
      complete(p.config, system, context, signal, tools),
  });
  try {
    f.enqueue();
    await w.pollOnce();
    await w.pollOnce();
    assert.equal(w.state, "idle");
    assert.equal(p.bodies.length, 2);
    assert.equal(
      f.calls.filter((c) => c.name === "coach_complete_task").length,
      1,
    );
    assert.equal(f.saved.length, 1);
    assert.deepEqual(f.saved[0].result, results.activity_followup);
  } finally {
    await w.stop();
    await f.close();
    await p.close();
  }
});

test("actual Pi provider response transport is bounded independently of final JSON parser", async () => {
  const p = await provider(() => "x".repeat(3 * 1024 * 1024));
  try {
    await assert.rejects(
      complete(
        p.config,
        "Coach",
        "Synthetic machine task",
        AbortSignal.timeout(2000),
      ),
      /OUTPUT_REJECTED/,
    );
  } finally {
    await p.close();
  }
});
