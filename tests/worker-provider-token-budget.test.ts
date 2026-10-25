import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { openProfileGateway } from "../src/sandbox/gateway.js";
import * as workerInvocation from "../src/runtime/isolatedInvocation.js";
import { closeServer } from "./helpers/account-backend.js";

// Synthetic reported usage exercises real gateway accounting, not paid inference.
test("worker token policy admits continuation above 200k and stops at 500k independently per generation", async () => {
  const budget = (workerInvocation as any).WORKER_PROVIDER_TOKENS;
  assert.equal(budget, 500000);
  const home = await mkdtemp(tmpdir() + "/worker-provider-budget-");
  let calls = 0;
  const provider = createServer(async (req, res) => {
    for await (const _chunk of req) {
    }
    calls++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content: "Synthetic result" },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 249999,
          completion_tokens: 1,
          total_tokens: 250000,
        },
      }),
    );
  });
  const gateways: Awaited<ReturnType<typeof openProfileGateway>>[] = [];
  try {
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    const store = new Store(home);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      provider: {
        baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
        model: "synthetic-model",
      },
      apiKey: "synth...ey",
    });
    const open = async (worker: boolean) => {
      const gateway = await openProfileGateway(store, undefined, {
        profile: "worker",
        prompt: "Synthetic persona",
        ...(worker
          ? {
              budgets: {
                tool_calls: 64,
                provider_tokens: budget,
                images_per_cycle: 0,
              },
            }
          : {}),
      });
      gateways.push(gateway);
      return gateway;
    };
    const request = {
      kind: "provider",
      body: {
        model: "synthetic-model",
        messages: [{ role: "user", content: "Synthetic question" }],
        stream: false,
      },
    };
    const first = await open(true);
    await first.handle(request);
    await first.handle(request);
    assert.equal(
      calls,
      2,
      "a continuation after 250k tokens must reach the provider",
    );
    await assert.rejects(first.handle(request));
    assert.equal(
      calls,
      2,
      "500k exhaustion must refuse before provider dispatch",
    );
    const next = await open(true);
    await next.handle(request);
    assert.equal(calls, 3, "a new generation has its own fresh budget");
    const unchangedDefault = await open(false);
    await unchangedDefault.handle(request);
    await assert.rejects(unchangedDefault.handle(request));
    assert.equal(
      calls,
      4,
      "the generic 200k gateway default remains unchanged",
    );
  } finally {
    for (const gateway of gateways) await gateway.close();
    await closeServer(provider);
    await rm(home, { recursive: true, force: true });
  }
});
