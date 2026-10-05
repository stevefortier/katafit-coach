import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "../src/worker/runner.js";
import { taskFixture } from "./task-fixtures.js";
import { fixture } from "./helpers/native.js";
import {
  openNativeGateway,
  nativeProviderEnvelope,
} from "../src/sandbox/gateway.js";
import { compileComposer } from "../src/config/store.js";
import { cycle, outcome, setup } from "./helpers/autonomy-cycle.js";

function assertPolicy(prompt: string) {
  assert.match(
    prompt,
    /effective personal targets.*member.*day.*take precedence.*shared.*baseline/is,
  );
  assert.match(prompt, /numeric disagreement alone.*not.*ambigu/is);
  assert.match(prompt, /correct member.*day.*not.*principal/is);
  assert.match(
    prompt,
    /workout\/activity due_at.*hard expiry.*not.*start.*scheduled/is,
  );
  assert.match(
    prompt,
    /pending workout.*available.*activity feed.*as soon as practical/is,
  );
  assert.match(prompt, /recovery.*safety/is);
  assert.match(prompt, /future unreleased.*completed.*expired/is);
  assert.match(prompt, /not.*autonomy work-item.*commitment.*due_at/is);
  assert.match(prompt, /override.*editable persona/is);
}

// Synthetic storage/provider boundaries: proves delivered instructions and real
// offered reads, not autonomous model semantics or a production publication.
test("daily insight completion receives target/expiry policy with fetched personal data", async () => {
  const f = await taskFixture({
    negotiate: true,
    evidence: {
      timezone: "UTC",
      observations: [{ label: "Strategy", text: "Shared baseline: 3125 kcal" }],
      conversation: [],
    },
    rest: async (c: any) =>
      c.path === "/api/user/targets"
        ? { status: 200, body: { calories: 3475 } }
        : c.path === "/api/activities?scope=today-actions"
          ? {
              status: 200,
              body: {
                activities: [
                  {
                    type: "workout",
                    status: "pending",
                    created_at: "2026-10-05T08:00:00.000Z",
                    due_at: "2026-10-08T00:00:00.000Z",
                  },
                ],
                total: 1,
              },
            }
          : undefined,
  });
  const worker = new Worker({
    origin: f.origin,
    token: "synthetic-worker-credential-0123456789",
    system:
      "Saved persona: ask whenever target numbers differ; treat due_at as a start date.",
    complete: async (context, _signal, system, tools) => {
      assert.match(context, /3125/);
      assertPolicy(system);
      const rest = tools!.find((t) => t.name === "katafit_rest_request")!;
      for (const path of [
        "/api/user/targets",
        "/api/activities?scope=today-actions",
      ]) {
        const result = await rest.execute(
          "synthetic-read-" + path,
          { method: "GET", path },
          new AbortController().signal,
        );
        assert.match(
          JSON.stringify(result),
          path.includes("targets") ? /3475/ : /2026-10-08/,
        );
      }
      return JSON.stringify({
        general_advice: "Synthetic result; not a model semantic evaluation.",
        meal_recommendations: [],
        recovery_recommendations: [],
        workout_directives: [],
      });
    },
  });
  try {
    f.enqueue("daily_insight");
    await worker.pollOnce();
    assert.equal(worker.state, "task-result-stored");
    assert.equal(f.saved.length, 1);
    assert.equal(f.restCalls.length, 2);
  } finally {
    await worker.stop();
    await f.close();
  }
});

test("native Operator catalog and provider envelope carry the same fixed policy", async () => {
  const f = await fixture((name, result, body) => {
    if (name !== "provider") return result;
    assertPolicy(body.messages[0].content);
    return 'data: {"choices":[{"index":0,"delta":{"content":"Synthetic policy transport verified."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  });
  let gateway: Awaited<ReturnType<typeof openNativeGateway>> | undefined;
  try {
    gateway = await openNativeGateway(f.store);
    const catalog: any = await gateway.handle({ kind: "catalog" });
    const wire = JSON.parse(
      nativeProviderEnvelope({
        messages: [
          { role: "system", content: catalog.prompt },
          {
            role: "user",
            content: "Compare shared 3125 with my fetched 3475 target.",
          },
        ],
      }),
    );
    assertPolicy(wire.messages[0].content);
    assert.match(
      wire.messages[0].content,
      /operator is your manager and boss, not a trainee/,
    );
    assert.equal(f.calls.length, 0);
    const response = await gateway.handle({
      kind: "provider",
      body: { ...wire, model: "approved-custom-model" },
    });
    assert.match(
      JSON.stringify(response),
      /Synthetic policy transport verified/,
    );
    assert.equal(
      f.calls.filter((call) => call.path === "/v1/chat/completions").length,
      1,
    );
  } finally {
    await gateway?.close();
    await f.close();
  }
});

test("actual autonomy planner catalog and audience-only composer retain policy", async () => {
  const env = await setup();
  try {
    const { runtime, result } = await cycle(env, [
      async (io) => {
        assertPolicy(io.catalog.prompt);
        return outcome();
      },
    ]);
    assertPolicy(runtime.runs[0].catalog.prompt);
    assert.equal(result.outcome.result, "completed");
    assertPolicy(compileComposer(env.store.publicConfig(), "member"));
    assert.match(
      compileComposer(env.store.publicConfig(), "member"),
      /You have no tools/,
    );
  } finally {
    await env.close();
  }
});
