import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { complete } from "../src/runtime/piAdapter.js";
import { Worker } from "../src/worker/runner.js";
import { closeServer, pairedSkip } from "./helpers/account-backend.js";
import { startTaskBackend } from "./helpers/task-backend.js";

// The real backend task plane on a disposable replica set, the real Worker and
// the real Pi adapter. Only the provider endpoint is synthetic: it answers an
// HTTP status and never produces model text.
async function statusProvider(status: number) {
  const server: Server = createServer(async (req, res) => {
    for await (const _ of req);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "synthetic upstream" } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    close: () => closeServer(server),
  };
}

test(
  "paired: provider subtypes and model timing persist on the real backend task row",
  { skip: pairedSkip, timeout: 600000 },
  async (t) => {
    const b = await startTaskBackend();
    t.after(() => b.close());
    const run = async (
      status: number | null,
      options: { modelMs?: number } = {},
    ) => {
      await b.reset();
      await b.checkIn();
      const token = await b.credential(false);
      const p = await statusProvider(status ?? 200);
      const w = new Worker({
        origin: b.origin,
        token,
        system: "Synthetic Coach persona",
        ...(options.modelMs ? { modelMs: options.modelMs } : {}),
        complete:
          status === null
            ? // Inference that never answers: only the worker's own timer ends it.
              (_context, signal) =>
                new Promise<string>((_resolve, reject) =>
                  signal.addEventListener(
                    "abort",
                    () => reject(new Error("CANCELLED")),
                    { once: true },
                  ),
                )
            : (context, signal, system, tools, _ref, budget) =>
                complete(
                  {
                    baseUrl: p.baseUrl,
                    model: "synthetic-model",
                    apiKey: "synthetic-provider-credential",
                    secrets: [token],
                  },
                  system,
                  context,
                  signal,
                  tools,
                  budget,
                ),
      });
      try {
        await assert.rejects(w.pollOnce());
        return { state: w.state, lastError: w.lastError, row: await b.task() };
      } finally {
        await w.stop();
        await p.close();
      }
    };

    await t.test("upstream HTTP 504", async () => {
      const { state, lastError, row } = await run(504);
      assert.equal(state, "task-failure-reported");
      assert.equal(lastError?.code, "PROVIDER_TIMEOUT");
      assert.equal(row.status, "failed");
      assert.equal(row.failure_code, "TASK_PROVIDER_FAILED");
      assert.equal(row.failure_detail_code, "PROVIDER_UPSTREAM_TIMEOUT");
      assert.ok(Number.isInteger(row.failure_timing.elapsed_ms));
      assert.ok(row.failure_timing.elapsed_ms < row.failure_timing.budget_ms);
      assert.ok(row.failure_timing.budget_ms > 0);
    });

    await t.test("own model deadline", async () => {
      const { state, lastError, row } = await run(null, { modelMs: 60 });
      assert.equal(state, "task-failure-reported");
      assert.equal(lastError?.code, "PROVIDER_TIMEOUT");
      assert.equal(row.failure_detail_code, "PROVIDER_MODEL_DEADLINE");
      assert.equal(row.failure_timing.budget_ms, 60);
      assert.ok(row.failure_timing.elapsed_ms >= 55);
    });

    await t.test("rate limited", async () => {
      const { row } = await run(429);
      assert.equal(row.failure_detail_code, "PROVIDER_RATE_LIMITED");
      assert.doesNotMatch(JSON.stringify(row), /synthetic upstream/);
    });
  },
);
