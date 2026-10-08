import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { Worker } from "../src/worker/runner.js";
import { complete } from "../src/runtime/piAdapter.js";
import {
  verifyTaskFailure,
  verifyTaskResolution,
} from "../src/katafit/tasks.js";
import { taskFixture } from "./task-fixtures.js";

// Real clocks, a real MCP transport fixture and the real Pi adapter over HTTP.
// Only the backend plane and the provider endpoint are synthetic.

const failCall = (f: any) =>
  f.calls.find((c: any) => c.name === "coach_fail_task");

async function provider(status: number, body: unknown) {
  const server: Server = createServer(async (req, res) => {
    for await (const _ of req);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const piWorker = (origin: string, baseUrl: string, extra: any = {}) =>
  new Worker({
    origin,
    token: "worker-secret",
    system: "Coach",
    complete: (context, signal, system, tools, _ref, budget) =>
      complete(
        {
          baseUrl,
          model: "synthetic-model",
          apiKey: "synthetic-provider-credential",
          secrets: ["worker-secret"],
        },
        system,
        context,
        signal,
        tools,
        budget,
      ),
    ...extra,
  });

test("own inference timer expiry is reported as the model deadline with measured timing", async () => {
  const f = await taskFixture({ failureDetails: true });
  let finish: ((text: string) => void) | undefined;
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    modelMs: 40,
    complete: async () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  });
  try {
    f.enqueue("activity_followup");
    const started = Date.now();
    await assert.rejects(w.pollOnce());
    const call = failCall(f);
    assert.equal(call.args.code, "TASK_PROVIDER_FAILED");
    assert.equal(call.args.detail_code, "PROVIDER_MODEL_DEADLINE");
    assert.equal(call.args.timing.budget_ms, 40);
    assert.ok(
      call.args.timing.elapsed_ms >= 35,
      `${call.args.timing.elapsed_ms}`,
    );
    assert.ok(call.args.timing.elapsed_ms <= Date.now() - started);
    assert.equal(w.lastError?.code, "PROVIDER_TIMEOUT");
    assert.equal(w.state, "task-failure-reported");
    finish!('{"text":"late"}');
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(
      f.calls.filter((c) => c.name === "coach_complete_task").length,
      0,
    );
  } finally {
    finish?.('{"text":"late"}');
    await w.stop();
    await f.close();
  }
});

test("a fast memory-tool transport denial is a tool abort, keeps its original cause and is not a timeout", async () => {
  const f = await taskFixture({
    failureDetails: true,
    memory: true,
    memorySearchFailure: true,
  });
  let toolError: unknown;
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async (_context, signal, _system, tools) => {
      const search = tools!.find((t) => t.name === "coach_memory_search")!;
      assert.ok(search, "memory search is offered for the task lease");
      await search
        .execute("call-1", { query: "recent shoulder work" } as any)
        .catch((error: unknown) => {
          toolError = error;
        });
      return new Promise<string>((_resolve, reject) => {
        if (signal.aborted) return reject(new Error("CANCELLED"));
        signal.addEventListener("abort", () => reject(new Error("CANCELLED")), {
          once: true,
        });
      });
    },
  });
  try {
    f.enqueue("activity_followup");
    await assert.rejects(w.pollOnce());
    assert.ok(toolError, "the real transport denied the search");
    const call = failCall(f);
    assert.equal(call.args.code, "TASK_PROVIDER_FAILED");
    assert.equal(call.args.detail_code, "PROVIDER_TOOL_ABORTED");
    assert.ok(call.args.timing.elapsed_ms < call.args.timing.budget_ms - 1000);
    assert.notEqual(w.lastError?.code, "PROVIDER_TIMEOUT");
    assert.equal(w.lastError?.code, "CREDENTIAL_REJECTED");
  } finally {
    await w.stop();
    await f.close();
  }
});

for (const [status, body, detail, local] of [
  [
    504,
    { error: { message: "gateway" } },
    "PROVIDER_UPSTREAM_TIMEOUT",
    "PROVIDER_TIMEOUT",
  ],
  [
    408,
    { error: { message: "slow" } },
    "PROVIDER_UPSTREAM_TIMEOUT",
    "PROVIDER_TIMEOUT",
  ],
  [
    429,
    { error: { code: "rate_limit_exceeded" } },
    "PROVIDER_RATE_LIMITED",
    "PROVIDER_RATE_LIMITED",
  ],
  [
    500,
    { error: { message: "boom" } },
    "PROVIDER_UNKNOWN",
    "PROVIDER_UNAVAILABLE",
  ],
] as const) {
  test(`real Pi HTTP ${status} is attributed ${detail}, distinct from the worker timer`, async () => {
    const f = await taskFixture({ failureDetails: true });
    const p = await provider(status, body);
    const w = piWorker(f.origin, p.baseUrl);
    try {
      f.enqueue("activity_followup");
      await assert.rejects(w.pollOnce());
      const call = failCall(f);
      assert.equal(call.args.code, "TASK_PROVIDER_FAILED");
      assert.equal(call.args.detail_code, detail);
      assert.ok(call.args.timing.elapsed_ms < 10000);
      assert.equal(w.lastError?.code, local);
      assert.equal(w.lastError?.metadata.status, status);
      assert.doesNotMatch(
        JSON.stringify(call.args),
        /gateway|slow|boom|rate_limit/,
      );
    } finally {
      await w.stop();
      await p.close();
      await f.close();
    }
  });
}

test("a refused provider connection is attributed as a connection failure", async () => {
  const f = await taskFixture({ failureDetails: true });
  const p = await provider(200, {});
  const baseUrl = p.baseUrl;
  await p.close();
  const w = piWorker(f.origin, baseUrl);
  try {
    f.enqueue("activity_followup");
    await assert.rejects(w.pollOnce());
    assert.equal(failCall(f).args.detail_code, "PROVIDER_CONNECTION_FAILED");
    assert.equal(w.lastError?.code, "PROVIDER_CONNECTION_FAILED");
  } finally {
    await w.stop();
    await f.close();
  }
});

test("an older backend without the capability receives exactly the legacy failure", async () => {
  const f = await taskFixture();
  const p = await provider(504, {});
  const w = piWorker(f.origin, p.baseUrl);
  try {
    f.enqueue("activity_followup");
    await assert.rejects(w.pollOnce());
    const call = failCall(f);
    assert.deepEqual(Object.keys(call.args).sort(), [
      "code",
      "lease_generation",
      "protocol",
      "task_id",
    ]);
    assert.equal(call.args.code, "TASK_PROVIDER_FAILED");
    assert.equal(w.state, "task-failure-reported");
  } finally {
    await w.stop();
    await p.close();
    await f.close();
  }
});

test("an ambiguous completion never becomes a failure write even when details are negotiated", async () => {
  const f = await taskFixture({ failureDetails: true });
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
    f.enqueue("activity_followup");
    await w.pollOnce().catch(() => {});
    assert.ok(!f.calls.some((c) => c.name === "coach_fail_task"));
  } finally {
    globalThis.fetch = fetchOriginal;
    await w.stop();
    await f.close();
  }
});

test("receipt verification accepts only code-matched provider subtypes", () => {
  const task = { id: "a".repeat(24), status: "claimed", lease_generation: 2 };
  const receipt = {
    task: { ...task, status: "failed" },
    status: "failed",
    result_sha256: null,
    completed_at: null,
    consumed_at: null,
    failure_code: "TASK_PROVIDER_FAILED",
    failure_detail_code: "PROVIDER_UPSTREAM_TIMEOUT",
  };
  assert.doesNotThrow(() =>
    verifyTaskFailure(
      task,
      receipt,
      "TASK_PROVIDER_FAILED",
      "PROVIDER_UPSTREAM_TIMEOUT",
    ),
  );
  assert.throws(
    () =>
      verifyTaskFailure(
        task,
        receipt,
        "TASK_INVALID_OUTPUT",
        "PROVIDER_UPSTREAM_TIMEOUT",
      ),
    /DELIVERY_UNVERIFIED/,
  );
  assert.equal(
    verifyTaskResolution(
      task,
      { ...receipt, resolution: "observed" },
      "b".repeat(64),
    ),
    "failed",
  );
  assert.throws(
    () =>
      verifyTaskResolution(
        task,
        {
          ...receipt,
          failure_code: "TASK_INVALID_OUTPUT",
          resolution: "observed",
        },
        "b".repeat(64),
      ),
    /DELIVERY_UNVERIFIED/,
  );
  assert.throws(
    () =>
      verifyTaskResolution(
        task,
        {
          ...receipt,
          failure_detail_code: "TASK_OUTPUT_JSON",
          resolution: "observed",
        },
        "b".repeat(64),
      ),
    /DELIVERY_UNVERIFIED/,
  );
});
