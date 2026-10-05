import test from "node:test";
import assert from "node:assert/strict";
import { setup, cycle, outcome, work } from "./helpers/autonomy-cycle.js";
import { openProfileGateway } from "../src/sandbox/gateway.js";

// Candidate-specific adaptation of the 11 external budget0712 controls.
// Imports resolve this worktree; synthetic usage only, no production state.
// Block every non-loopback fetch before any fixture starts. No production state.
const originalFetch = globalThis.fetch;
let synthetic: { body: string; type: string } | undefined;
let intercepted = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    "non-loopback network forbidden",
  );
  if (url.pathname.endsWith("/chat/completions") && synthetic) {
    intercepted++;
    return new Response(synthetic.body, {
      headers: { "content-type": synthetic.type },
    });
  }
  return originalFetch(input, init);
};
test.after(() => {
  globalThis.fetch = originalFetch;
});
const body = {
  model: "synthetic-model",
  messages: [{ role: "user", content: "synthetic evidence" }],
};

for (const total of [65400, 68342, 84206, 69874, 60000]) {
  for (const requestAgain of [false, true]) {
    test(`runner total=${total}, next-request=${requestAgain}`, async () => {
      const env = await setup({ budgets: { provider_tokens: 60000 } });
      synthetic = {
        body: JSON.stringify({
          choices: [{ message: { role: "assistant", content: "synthetic" } }],
          usage: { total_tokens: total },
        }),
        type: "application/json",
      };
      const before = intercepted;
      try {
        const { result } = await cycle(env, [
          async ({ provider, call }) => {
            await provider(body);
            // Provider exhaustion is not a global tool gate either.
            const report = await call("coach_autonomy_report", {
              slot: "synthetic-slot",
              text: "Synthetic report",
            });
            assert.ok(!report.error);
            if (requestAgain)
              await assert.rejects(provider(body), /NATIVE_REQUEST_REJECTED/);
            return outcome();
          },
        ]);
        assert.equal(intercepted - before, 1, "no rejected request sent");
        assert.equal(result.outcome.budget.provider_tokens, total);
        assert.equal(result.outcome.budget.tool_calls, 1);
        assert.equal(
          result.outcome.result,
          requestAgain ? "blocked" : "completed",
        );
        assert.equal(
          result.outcome.blocked_reason,
          requestAgain ? "budget_exhausted" : undefined,
        );
        if (requestAgain)
          assert.ok(
            result.outcome.uncertainty.includes(
              "budget_exhausted:provider_tokens",
            ),
          );
        const canonical = work(env.fake, env.workId);
        assert.equal(canonical.status, result.outcome.result);
        assert.equal(
          env.fake.state.reports.at(-1)?.result,
          result.outcome.result,
        );
        console.log(
          JSON.stringify({
            total,
            requestAgain,
            result: result.outcome.result,
            canonical: canonical.status,
          }),
        );
      } finally {
        synthetic = undefined;
        await env.close();
      }
    });
  }
}

test("gateway reported totals vs fallback wire bytes; SSE takes last safe total", async () => {
  const config = {
    revision: 1,
    origin: "http://127.0.0.1",
    provider: { model: "synthetic-model", baseUrl: "http://127.0.0.1/v1" },
  };
  const store: any = {
    publicConfig: () => config,
    secrets: {},
    skills: { runtime: () => ({ skills: [] }) },
  };
  const gateway = await openProfileGateway(store, undefined, {
    profile: "worker",
    prompt: "synthetic",
    budgets: { tool_calls: 1, provider_tokens: 60000, images_per_cycle: 0 },
  });
  const charge = Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 4);
  try {
    const samples = [
      {
        body: JSON.stringify({ usage: { total_tokens: 100 } }),
        type: "application/json",
        expected: 100,
      },
      {
        body: 'data: {"usage":{"total_tokens":7}}\ndata: {"usage":{"total_tokens":13}}\ndata: [DONE]\n',
        type: "text/event-stream",
        expected: 13,
      },
      {
        body: JSON.stringify({
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }),
        type: "application/json",
        expected: charge,
      },
      {
        body: 'data: {"choices":[]}\ndata: [DONE]\n',
        type: "text/event-stream",
        expected: charge,
      },
    ];
    let expected = 0;
    for (const sample of samples) {
      synthetic = sample;
      await gateway.handle({ kind: "provider", body });
      expected += sample.expected;
      assert.equal(gateway.usage().provider_tokens, expected);
    }
    assert.equal(gateway.usage().provider_requests, 4);
    console.log(
      JSON.stringify({
        parserSamples: samples.length,
        fallbackWireCharge: charge,
        accumulatedCharge: expected,
      }),
    );
  } finally {
    synthetic = undefined;
    await gateway.close();
  }
});
