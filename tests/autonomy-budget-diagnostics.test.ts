import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  openProfileGateway,
  type ProfileGatewayOptions,
} from "../src/sandbox/gateway.js";
import { Diagnostics, type LogInput } from "../src/diagnostics/log.js";
import type { Store } from "../src/config/store.js";
import { AutonomyHost } from "../src/autonomy/host.js";
import { Admission } from "../src/runtime/admission.js";
import {
  setup,
  outcome,
  ScriptedRuntime,
  closeLeaked,
  cycle,
  restServer,
  composerScript,
} from "./helpers/autonomy-cycle.js";
import { MEMBER } from "./helpers/autonomy-fake.js";

test.after(closeLeaked);

const body = {
  model: "synthetic-model",
  messages: [{ role: "user", content: "PRIVATE-WIRE-SENTINEL" }],
};
const wireBytes = Buffer.byteLength(JSON.stringify(body));
const estimate = Math.ceil(wireBytes / 4);
const store = {
  publicConfig: () => ({
    revision: 1,
    origin: "http://127.0.0.1",
    provider: { model: "synthetic-model", baseUrl: "http://127.0.0.1/v1" },
  }),
  secrets: {},
  skills: { runtime: () => ({ skills: [] }) },
} as unknown as Store;

async function fixture(
  run: (
    gateway: Awaited<ReturnType<typeof openProfileGateway>>,
    logs: Diagnostics,
  ) => Promise<void>,
  options: Pick<
    ProfileGatewayOptions,
    "onExhausted" | "onDiagnostic" | "budgets"
  > = {},
) {
  const dir = await mkdtemp(tmpdir() + "/budget0803-diagnostics-");
  const logs = new Diagnostics(dir);
  const gateway = await openProfileGateway(store, undefined, {
    profile: "worker",
    prompt: "PRIVATE-PROMPT-SENTINEL",
    budgets: { tool_calls: 1, provider_tokens: 60000, images_per_cycle: 0 },
    onDiagnostic: (event) => logs.record(event),
    ...options,
  });
  const original = globalThis.fetch;
  try {
    await run(gateway, logs);
  } finally {
    globalThis.fetch = original;
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function accounting(logs: Diagnostics) {
  const entries = logs
    .snapshot()
    .entries.filter(
      (e) => e.stage === ("provider-accounting" as LogInput["stage"]),
    );
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry).sort(), [
      "level",
      "metadata",
      "source",
      "stage",
      "time",
    ]);
    assert.ok(
      Object.values(entry.metadata).every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(entry),
      /PRIVATE-|synthetic-model|127\.0\.0\.1/,
    );
  }
  return entries.map((e) => e.metadata);
}

test("SSE detail-only usage survives later chunks without usage", async () => {
  await fixture(async (gateway, logs) => {
    globalThis.fetch = async () =>
      new Response(
        'data: {"usage":{"prompt_tokens":9,"completion_tokens":2}}\ndata: {"choices":[]}\ndata: [DONE]\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    await gateway.handle({ kind: "provider", body });
    const [m] = accounting(logs);
    assert.equal(m.chargeSource, 2);
    assert.equal(m.chargedTokens, estimate);
    assert.equal(m.inputTokens, 9);
    assert.equal(m.outputTokens, 2);
  });
});

test("JSON accounting persists one numeric-only receipt with reported usage", async () => {
  await fixture(async (gateway, logs) => {
    let dispatches = 0;
    globalThis.fetch = async () => {
      dispatches++;
      return Response.json({
        choices: [{ message: { content: "PRIVATE-OUTPUT-SENTINEL" } }],
        usage: {
          total_tokens: 40,
          prompt_tokens: 30,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 20 },
        },
      });
    };
    const result = await gateway.handle({ kind: "provider", body });
    assert.ok(result.body.includes("PRIVATE-OUTPUT-SENTINEL"));
    assert.equal(dispatches, 1);
    assert.equal(gateway.usage().provider_tokens, 40);
    assert.deepEqual(accounting(logs), [
      {
        profileCode: 3,
        requestOrdinal: 1,
        wireBytes,
        chargeSource: 1,
        inputTokens: 30,
        outputTokens: 10,
        cachedTokens: 20,
        chargedTokens: 40,
        cumulativeTokens: 40,
        tokenBudget: 60000,
        remainingTokens: 59960,
      },
    ]);
  });
});

for (const again of [false, true]) {
  test(
    `installed AutonomyHost persists planner usage and final summary; next=${again}`,
    { timeout: 10000 },
    async () => {
      const env = await setup({ budgets: { provider_tokens: 60000 } });
      const logs = new Diagnostics(env.store.dir);
      const planner = new ScriptedRuntime([
        async (io) => {
          await io.provider(body);
          if (again)
            await assert.rejects(io.provider(body), /NATIVE_REQUEST_REJECTED/);
          return outcome();
        },
      ]);
      const host = new AutonomyHost({
        store: env.store,
        admission: new Admission(),
        onDiagnostic: (event) => logs.record(event),
        runtimes: async () => ({ planner, composer: new ScriptedRuntime([]) }),
      });
      const original = globalThis.fetch;
      let dispatches = 0;
      globalThis.fetch = async (input, init) => {
        const url = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
        if (url.pathname.endsWith("/chat/completions")) {
          dispatches++;
          return Response.json({
            usage: {
              total_tokens: 65400,
              prompt_tokens: 65000,
              completion_tokens: 400,
            },
          });
        }
        return original(input, init);
      };
      try {
        await host.start();
        const deadline = Date.now() + 4000;
        while (!host.snapshot().lastOutcome && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 10));
        assert.equal(
          host.snapshot().lastOutcome,
          again ? "blocked" : "completed",
        );
        await host.stop();
        assert.deepEqual(planner.errors, []);
        assert.equal(dispatches, 1);
        const canonical = env.fake.state.work.get(env.workId);
        assert.equal(canonical.status, again ? "blocked" : "completed");
        assert.equal(env.fake.state.reports.at(-1)?.result, canonical.status);
        const completion = await env.backend.completionReceipt(
          env.workId,
          canonical.lease_generation,
        );
        assert.equal(completion.state, "committed");
        assert.equal(completion.receipt?.result, canonical.status);
        const receipt = accounting(logs);
        assert.equal(
          receipt.length,
          1,
          "real caller forwards gateway accounting",
        );
        assert.equal(receipt[0].profileCode, 1);
        const summaries = logs
          .snapshot()
          .entries.filter(
            (e) => e.stage === ("autonomy-usage" as LogInput["stage"]),
          );
        assert.equal(
          summaries.length,
          1,
          "canonical final usage reaches installed logger",
        );
        assert.deepEqual(summaries[0].metadata, {
          plannerTokens: 65400,
          composerTokens: 0,
          cumulativeTokens: 65400,
          tokenBudget: 60000,
          remainingTokens: 0,
          calls: 0,
          elapsedMs: summaries[0].metadata.elapsedMs,
          exhaustedProviderTokens: again ? 1 : 0,
          exhaustedToolCalls: 0,
          exhaustedImages: 0,
          exhaustedRestReads: 0,
          exhaustedCycleSeconds: 0,
        });
        const disk = new Diagnostics(env.store.dir).snapshot().entries;
        assert.deepEqual(
          disk,
          logs.snapshot().entries,
          "numeric fields survive real persisted log reload",
        );
        const raw = await readFile(
          env.store.dir + "/diagnostics.jsonl",
          "utf8",
        );
        assert.doesNotMatch(
          raw,
          /PRIVATE-|synthetic-model|127\.0\.0\.1|65400.*content/,
        );
        assert.equal(
          disk.filter(
            (e) => e.stage === ("provider-budget-refused" as LogInput["stage"]),
          ).length,
          again ? 1 : 0,
        );
        console.log(
          JSON.stringify({
            realCaller: "AutonomyHost->runner->gateway->Diagnostics->reload",
            next: again,
            dispatches,
            total: summaries[0].metadata.cumulativeTokens,
          }),
        );
      } finally {
        await host.stop();
        globalThis.fetch = original;
        await env.close();
      }
    },
  );
}

test("runner forwards composer accounting without weakening isolated catalog", async () => {
  const env = await setup({
    mode: "message",
    kind: "conversation",
    delegated: ["member_message", "manager_report", "follow_up"],
  });
  const logs = new Diagnostics(env.store.dir);
  const path = `/api/coach/member-conversations/${MEMBER}`;
  restServer(env.fake, {
    [`GET ${path}`]: {
      status: 200,
      body: {
        schema_version: 1,
        member_id: MEMBER,
        coverage: "retained_main_coach_conversation",
        conversation_epoch: 1,
        items: [
          {
            message_ref: "synthetic-ref",
            role: "user",
            text: "Should I rest after the meet?",
            created_at: "2026-10-03T06:00:00.000Z",
            source: "member",
          },
        ],
        has_more: false,
        next_cursor: null,
      },
    },
  });
  env.fake.state.requireComposition = true;
  env.fake.state.provider = (request) => ({
    content:
      request.messages[0].content === "PRIVATE-WIRE-SENTINEL"
        ? "Manager-private synthetic result."
        : "A lighter week can help recovery.",
    tokens: 777,
  });
  const composer = new ScriptedRuntime([
    composerScript("A lighter week can help recovery."),
  ]);
  try {
    const { result } = await cycle(
      env,
      [
        async (io) => {
          await io.provider(body);
          const read = await io.call("katafit_rest_get", { path });
          assert.ok(!read.error);
          const sent = await io.call("coach_autonomy_intend", {
            slot: "m1",
            intent: {
              type: "member_message",
              recipient_id: MEMBER,
              purpose: "answer_question",
              tone: "warm",
              evidence_refs: ["msg:synthetic-ref"],
            },
          });
          assert.equal(
            JSON.parse(sent.content[0].text).status,
            "delivered",
            sent.content[0].text,
          );
          return outcome({
            decisions: [
              {
                subject_id: MEMBER,
                decision: "acted",
                action_slots: ["m1"],
                follow_up_ids: [],
              },
            ],
          });
        },
      ],
      {
        compose: { runtime: composer },
        onDiagnostic: (event: LogInput) => logs.record(event),
      },
    );
    assert.equal(result.outcome.result, "completed");
    assert.equal(result.outcome.budget.provider_tokens, 1554);
    assert.deepEqual(composer.runs[0].catalog.tools, []);
    assert.deepEqual(composer.runs[0].catalog.skills, []);
    assert.deepEqual(
      accounting(logs).map((m) => [
        m.profileCode,
        m.requestOrdinal,
        m.chargedTokens,
        m.tokenBudget,
      ]),
      [
        [1, 1, 777, 60000],
        [2, 1, 777, 59223],
      ],
    );
    const summary = logs
      .snapshot()
      .entries.find((e) => e.stage === ("autonomy-usage" as LogInput["stage"]));
    assert.equal(summary?.metadata.composerTokens, 777);
    assert.equal(summary?.metadata.plannerTokens, 777);
  } finally {
    await env.close();
  }
});

test("SSE keeps last safe total and matching supplied details, not chunk sums", async () => {
  await fixture(async (gateway, logs) => {
    const response =
      'data: {"usage":{"total_tokens":7,"prompt_tokens":5}}\n' +
      'data: {"usage":{"total_tokens":13,"input_tokens":10,"output_tokens":3,"input_tokens_details":{"cached_tokens":0}}}\n' +
      'data: {"usage":{"total_tokens":1.5,"prompt_tokens":999}}\ndata: [DONE]\n';
    globalThis.fetch = async () =>
      new Response(response, {
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    const result = await gateway.handle({ kind: "provider", body });
    assert.equal(result.body, response);
    assert.equal(gateway.usage().provider_tokens, 13);
    assert.deepEqual(accounting(logs), [
      {
        profileCode: 3,
        requestOrdinal: 1,
        wireBytes,
        chargeSource: 1,
        inputTokens: 10,
        outputTokens: 3,
        cachedTokens: 0,
        chargedTokens: 13,
        cumulativeTokens: 13,
        tokenBudget: 60000,
        remainingTokens: 59987,
      },
    ]);
  });
});

test("fallback retains valid supplied detail fields without inferring a total", async () => {
  await fixture(async (gateway, logs) => {
    const samples = [
      Response.json({ usage: { prompt_tokens: 100, completion_tokens: 10 } }),
      new Response('data: {"choices":[]}\ndata: [DONE]\n', {
        headers: { "content-type": "text/event-stream" },
      }),
      Response.json({
        usage: {
          total_tokens: 1.5,
          prompt_tokens: -1,
          completion_tokens: "10",
          prompt_tokens_details: { cached_tokens: 1.5 },
        },
      }),
      Response.json({
        usage: {
          total_tokens: Number.MAX_SAFE_INTEGER + 1,
          input_tokens: Number.MAX_SAFE_INTEGER + 1,
          output_tokens: null,
          input_tokens_details: { cached_tokens: "private-value" },
        },
      }),
    ];
    for (const sample of samples) {
      globalThis.fetch = async () => sample;
      await gateway.handle({ kind: "provider", body });
    }
    const records = accounting(logs);
    assert.equal(records.length, 4);
    records.forEach((m, index) => {
      assert.equal(m.chargeSource, 2);
      assert.equal(m.chargedTokens, estimate);
      assert.equal(m.cumulativeTokens, estimate * (index + 1));
      assert.equal(m.requestOrdinal, index + 1);
      assert.equal(m.remainingTokens, 60000 - estimate * (index + 1));
      if (index)
        for (const key of ["inputTokens", "outputTokens", "cachedTokens"])
          assert.ok(!(key in m));
    });
    assert.equal(records[0].inputTokens, 100);
    assert.equal(records[0].outputTokens, 10);
    assert.ok(!("cachedTokens" in records[0]));
    assert.equal(gateway.usage().provider_tokens, estimate * 4);
  });
});

test("malformed SSE scan preserves prior total; malformed JSON falls back", async () => {
  await fixture(async (gateway, logs) => {
    globalThis.fetch = async () =>
      new Response(
        'data: {"usage":{"total_tokens":7}}\ndata: not-json\ndata: {"usage":{"total_tokens":900}}\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    await gateway.handle({ kind: "provider", body });
    globalThis.fetch = async () => new Response("not-json");
    await gateway.handle({ kind: "provider", body });
    assert.deepEqual(
      accounting(logs).map((m) => [m.chargedTokens, m.chargeSource]),
      [
        [7, 1],
        [estimate, 2],
      ],
    );
    assert.equal(gateway.usage().provider_tokens, 7 + estimate);
  });
});

for (const failure of ["dispatch", "nonOK", "drain", "oversize"] as const) {
  test(`${failure} failure charges conservative outgoing wire once`, async () => {
    await fixture(async (gateway, logs) => {
      let dispatches = 0;
      globalThis.fetch = async () => {
        dispatches++;
        if (failure === "dispatch") throw new Error("PRIVATE-NETWORK-ERROR");
        if (failure === "nonOK")
          return Response.json(
            {
              error: { message: "PRIVATE-ERROR-BODY" },
              usage: { total_tokens: 999 },
            },
            { status: 503 },
          );
        if (failure === "oversize")
          return new Response(new Uint8Array(2 * 1024 * 1024 + 1));
        let n = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (n++) controller.error(new Error("PRIVATE-DRAIN-ERROR"));
              else
                controller.enqueue(
                  Buffer.from('data: {"usage":{"total_tokens":999}}\n'),
                );
            },
          }),
        );
      };
      await assert.rejects(
        gateway.handle({ kind: "provider", body }),
        failure === "oversize"
          ? /NATIVE_RESPONSE_TOO_LARGE/
          : /NATIVE_PROVIDER_/,
      );
      assert.equal(dispatches, 1);
      assert.equal(gateway.usage().provider_tokens, estimate);
      assert.deepEqual(accounting(logs), [
        {
          profileCode: 3,
          requestOrdinal: 1,
          wireBytes,
          chargeSource: 2,
          chargedTokens: estimate,
          cumulativeTokens: estimate,
          tokenBudget: 60000,
          remainingTokens: 60000 - estimate,
        },
      ]);
    });
  });
}

test("threshold refusal is separate, sends nothing and preserves exhaustion callback once", async () => {
  const exhausted: string[] = [];
  await fixture(
    async (gateway, logs) => {
      let dispatches = 0;
      globalThis.fetch = async () => {
        dispatches++;
        return Response.json({ usage: { total_tokens: 65400 } });
      };
      await gateway.handle({ kind: "provider", body });
      assert.deepEqual(
        exhausted,
        [],
        "overshoot itself is still not exhaustion",
      );
      for (let n = 0; n < 2; n++)
        await assert.rejects(
          gateway.handle({ kind: "provider", body }),
          /NATIVE_REQUEST_REJECTED/,
        );
      assert.equal(dispatches, 1);
      assert.equal(accounting(logs).length, 1);
      assert.deepEqual(exhausted, ["provider_tokens"]);
      const refused = logs
        .snapshot()
        .entries.filter(
          (e) => e.stage === ("provider-budget-refused" as LogInput["stage"]),
        );
      assert.equal(refused.length, 2);
      refused.forEach((e) =>
        assert.deepEqual(e.metadata, {
          profileCode: 3,
          cumulativeTokens: 65400,
          tokenBudget: 60000,
          remainingTokens: 0,
          requestOrdinal: 2,
        }),
      );
      assert.equal(gateway.usage().provider_requests, 1);
    },
    { onExhausted: (reason) => exhausted.push(reason) },
  );
});

test("legacy negative reported charge stays unchanged; diagnostic counters are bounded", async () => {
  await fixture(async (gateway, logs) => {
    globalThis.fetch = async () =>
      Response.json({
        usage: {
          total_tokens: -1,
          prompt_tokens: -1,
          completion_tokens: -1,
          prompt_tokens_details: { cached_tokens: -1 },
        },
      });
    await gateway.handle({ kind: "provider", body });
    assert.equal(gateway.usage().provider_tokens, -1);
    const [m] = accounting(logs);
    assert.equal(m.chargedTokens, 0);
    assert.equal(m.cumulativeTokens, 0);
    assert.equal(m.accountingClamped, 1);
    assert.equal(m.chargeSource, 1);
    for (const key of ["inputTokens", "outputTokens", "cachedTokens"])
      assert.ok(!(key in m));
  });
});

test("telemetry saturates unsafe cumulative counts without changing accounting", async () => {
  await fixture(
    async (gateway, logs) => {
      globalThis.fetch = async () =>
        Response.json({ usage: { total_tokens: Number.MAX_SAFE_INTEGER } });
      await gateway.handle({ kind: "provider", body });
      await gateway.handle({ kind: "provider", body });
      assert.equal(
        gateway.usage().provider_tokens,
        Number.MAX_SAFE_INTEGER * 2,
      );
      const [first, second] = accounting(logs);
      assert.equal(first.chargedTokens, Number.MAX_SAFE_INTEGER);
      assert.equal(second.cumulativeTokens, Number.MAX_SAFE_INTEGER);
      assert.equal(second.tokenBudget, Number.MAX_SAFE_INTEGER);
      assert.equal(second.remainingTokens, Number.MAX_SAFE_INTEGER);
      assert.equal(second.accountingClamped, 1);
    },
    {
      budgets: {
        provider_tokens: Number.MAX_VALUE,
        tool_calls: 1,
        images_per_cycle: 0,
      },
    },
  );
});

test("logger exceptions cannot swallow cancellation or alter conservative charge", async () => {
  await fixture(
    async (gateway) => {
      const abort = new AbortController();
      globalThis.fetch = async () => {
        abort.abort();
        throw new Error("PRIVATE-CANCELLED-ERROR");
      };
      await assert.rejects(
        gateway.handle({ kind: "provider", body }, abort.signal),
        /NATIVE_CANCELLED/,
      );
      assert.equal(gateway.usage().provider_tokens, estimate);
    },
    {
      onDiagnostic: () => {
        throw new Error("synthetic logger unavailable");
      },
    },
  );
});

test("installation runtime context exposes existing logger to isolated worker", async () => {
  const env = await setup();
  const logs = new Diagnostics(env.store.dir);
  const logger = (event: LogInput) => logs.record(event);
  const host = new AutonomyHost({
    store: env.store,
    admission: new Admission(),
    onDiagnostic: logger,
  });
  try {
    const context = await host.runtimeContext();
    assert.equal((context as { onDiagnostic?: unknown }).onDiagnostic, logger);
  } finally {
    await host.stop();
    await env.close();
  }
});
