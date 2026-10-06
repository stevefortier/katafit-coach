import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import type { Store } from "../src/config/store.js";
import { InvocationCapability } from "../src/capability/invocation.js";
import { Diagnostics, type LogInput } from "../src/diagnostics/log.js";
import {
  openProfileGateway,
  nativeProviderAdmission,
  type ProfileGatewayOptions,
} from "../src/sandbox/gateway.js";
import { NativeFailure } from "../src/sandbox/failures.js";
import { closeServer } from "./helpers/account-backend.js";
import { AutonomyHost } from "../src/autonomy/host.js";
import { Admission } from "../src/runtime/admission.js";
import { restRequest } from "../src/katafit/restGet.js";
import { SafeError } from "../src/runtime/errors.js";
import {
  setup,
  outcome,
  ScriptedRuntime,
  restServer,
  closeLeaked,
} from "./helpers/autonomy-cycle.js";

test.after(closeLeaked);

const model = "synthetic-model";
const privateJson = JSON.stringify({
  marker: "PRIVATE-RESULT-雪".repeat(1000),
});
const requestBody = {
  model,
  messages: [{ role: "user", content: "PRIVATE-SEED" }],
};
const call = (path: string, id = "PRIVATE-CALL-ID") => ({
  kind: "tool",
  name: "katafit_rest_request",
  toolCallId: id,
  args: { method: "GET", path },
});
function selection(requests: ReturnType<typeof call>[]) {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: requests.map((r, index) => ({ index, id: r.toolCallId, type: "function", function: { name: r.name, arguments: JSON.stringify(r.args) } })) }, finish_reason: "tool_calls" }], usage: { total_tokens: 7 } })}\n\ndata: [DONE]\n\n`;
}
async function fixture(
  run: (f: {
    gateway: Awaited<ReturnType<typeof openProfileGateway>>;
    logs: Diagnostics;
    dir: string;
    reads: string[];
    wires: string[];
    select: (requests: ReturnType<typeof call>[]) => void;
    respond: (
      path: string,
      status: number,
      body: string | Buffer,
      type?: string,
    ) => void;
    providerResponse: (body: string) => void;
    observations: unknown[];
  }) => Promise<void>,
  sink?: (event: LogInput) => void,
  options: Partial<ProfileGatewayOptions> = {},
  acquisitionSink?: () => void,
  diagnosticThrows = false,
) {
  const dir = await mkdtemp(tmpdir() + "/cost1335-");
  const logs = new Diagnostics(dir);
  const reads: string[] = [],
    wires: string[] = [];
  const observations: unknown[] = [];
  const routes = new Map<
    string,
    { status: number; body: string | Buffer; type: string }
  >();
  let response = selection([]);
  const server = createServer(async (req, res) => {
    if (req.url === "/v1/chat/completions") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      wires.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(response);
    } else {
      reads.push(req.url!);
      const route = routes.get(req.url!) ?? {
        status: 200,
        body: privateJson,
        type: "application/json",
      };
      res.writeHead(route.status, { "content-type": route.type });
      res.end(route.body);
    }
  });
  let gateway: Awaited<ReturnType<typeof openProfileGateway>> | undefined;
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    const store = {
      publicConfig: () => ({
        revision: 1,
        origin,
        provider: { model, baseUrl: origin + "/v1", vision: true },
      }),
      secrets: { token: "synthetic-token", apiKey: "synthetic-key" },
      skills: { runtime: () => ({ skills: [] }) },
    } as unknown as Store;
    const acquisition = new InvocationCapability({
      plane: "autonomy",
      origin,
      token: "synthetic-token",
      secrets: ["synthetic-token", "synthetic-key"],
      vision: true,
      actions: [],
      current: () => true,
      maxReads: 8,
      maxImages: 2,
      onRead: (_path, result) => {
        observations.push(result);
        acquisitionSink?.();
      },
    });
    gateway = await openProfileGateway(store, undefined, {
      profile: "planner",
      prompt: "PRIVATE-PROMPT",
      tools: acquisition.tools(),
      autonomy: {
        intend: async () => ({}),
        report: async () => ({}),
        followUp: async () => ({}),
      } as any,
      budgets: { tool_calls: 8, provider_tokens: 60000, images_per_cycle: 2 },
      onDiagnostic:
        sink ??
        ((e) => {
          logs.record(e);
          if (diagnosticThrows) throw new Error("PRIVATE-DIAGNOSTIC-SINK");
        }),
      ...options,
    });
    await run({
      gateway,
      logs,
      dir,
      reads,
      wires,
      observations,
      select: (requests) => {
        response = selection(requests);
      },
      respond: (path, status, body, type = "application/json") =>
        routes.set(path, { status, body, type }),
      providerResponse: (body) => {
        response = body;
      },
    });
  } finally {
    await gateway?.close();
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
}
for (const legacy of [false, true])
  for (const [status, outcomeCode] of [
    [200, 1],
    [401, 2],
    [403, 2],
    [404, 3],
    [503, 4],
  ])
    test(`attested ${legacy ? "legacy" : "modern"} HTTP ${status} survives storage, cache and provider continuation`, async () => {
      const controls: unknown[] = [];
      for (const enabled of [false, true])
        await fixture(
          async ({
            gateway,
            logs,
            dir,
            respond,
            reads,
            wires,
            select,
            observations,
          }) => {
            const modern = call("/api/coach/memory?query=PRIVATE-OUTCOME");
            const chosen = legacy
              ? {
                  ...modern,
                  name: "katafit_rest_get",
                  args: { path: modern.args.path },
                }
              : modern;
            respond(modern.args.path, status, privateJson);
            select([modern]);
            await gateway.handle({ kind: "provider", body: requestBody });
            const fresh = await gateway.handle(chosen);
            const repeat = await gateway.handle(chosen);
            const next = { ...modern, toolCallId: "PRIVATE-NEXT-OUTCOME" };
            const continuation = {
              model,
              messages: [
                ...requestBody.messages,
                {
                  role: "tool",
                  tool_call_id: modern.toolCallId,
                  content: fresh.content[0].text,
                },
              ],
            };
            select([next]);
            await gateway.handle({ kind: "provider", body: continuation });
            const retained = await gateway.handle(
              legacy ? { ...chosen, toolCallId: next.toolCallId } : next,
            );
            assert.deepEqual(
              reads,
              [modern.args.path],
              "cache never redispatches",
            );
            assert.equal(
              observations.length,
              1,
              "coverage remains acquisition-only",
            );
            if (status === 200) {
              assert.deepEqual(fresh, {
                content: [{ type: "text", text: privateJson }],
                details: {},
              });
              assert.deepEqual(retained, fresh);
            } else {
              const error =
                status === 401 || status === 403
                  ? "REST_READ_DENIED"
                  : status === 404
                    ? "REST_READ_MISSING"
                    : "REST_READ_UNAVAILABLE";
              assert.deepEqual(JSON.parse(fresh.content[0].text), {
                error,
                status,
                note: "This fact is unavailable to this invocation. State that plainly; do not invent it.",
              });
              assert.deepEqual(JSON.parse(retained.content[0].text), {
                error,
                status,
                note: "This exact read already failed in this invocation and was not repeated. Use a documented path from GET /api/docs/coach (domain index) or state the fact as unavailable.",
              });
            }
            if (!legacy) assert.deepEqual(repeat, fresh);
            assert.deepEqual(wires, [
              JSON.stringify(requestBody),
              JSON.stringify(continuation),
            ]);
            controls.push({
              fresh,
              repeat,
              retained,
              wires: [...wires],
              reads: [...reads],
            });
            if (!enabled) return;
            const events = new Diagnostics(dir)
              .snapshot()
              .entries.filter((e) => e.stage === "acquisition-result");
            assert.equal(events.length, 3);
            assert.deepEqual(
              events.map((e) => [
                e.metadata.outcomeCode,
                e.metadata.statusCode,
                e.metadata.cacheCode,
              ]),
              [
                [outcomeCode, status, 3],
                [outcomeCode, status, legacy ? 2 : 1],
                [outcomeCode, status, 2],
              ],
            );
            const accounting = logs
              .snapshot()
              .entries.filter((e) => e.stage === "provider-accounting");
            assert.ok(events.every((e) => e.ref === accounting[1].ref));
            assert.equal(accounting[1].metadata.emissionOrdinal, 2);
            assert.equal(
              accounting[1].metadata.toolHistoryTextBytes,
              Buffer.byteLength(fresh.content[0].text),
            );
            assert.deepEqual(
              new Diagnostics(dir).snapshot().entries,
              logs.snapshot().entries,
            );
            assert.doesNotMatch(
              await readFile(dir + "/diagnostics.jsonl", "utf8"),
              /PRIVATE-|synthetic-|\/api\/|127\.0\.0\.1/,
            );
          },
          enabled ? undefined : () => {},
        );
      assert.deepEqual(
        controls[0],
        controls[1],
        "telemetry must preserve result/provider bytes",
      );
    });

for (const legacy of [false, true])
  for (const [control, outcomeCode, errorCode] of [
    ["timeout", 5, "BACKEND_TIMEOUT"],
    ["connectivity", 6, "CONNECTIVITY_ERROR"],
    ["cancelled", 7, "CANCELLED"],
    ["other", 8, "REST_READ_UNAVAILABLE"],
  ] as const)
    test(`attested ${legacy ? "legacy" : "modern"} transport ${control} is finite and preserves sink/cancellation/cache semantics`, async () => {
      const outputs: unknown[] = [];
      for (const throwing of [false, true]) {
        await fixture(
          async ({ gateway, logs, dir, select, reads, wires }) => {
            const modern = call("/api/coach/memory?query=PRIVATE-TRANSPORT");
            const chosen = legacy
              ? {
                  ...modern,
                  name: "katafit_rest_get",
                  args: { path: modern.args.path },
                }
              : modern;
            select([modern]);
            await gateway.handle({ kind: "provider", body: requestBody });
            const controller = new AbortController();
            const deadline = new AbortController();
            const originalFetch = globalThis.fetch;
            const originalTimeout = AbortSignal.timeout;
            let dispatches = 0;
            let result: any;
            try {
              AbortSignal.timeout = (ms) =>
                ms === 8000 ? deadline.signal : originalTimeout(ms);
              globalThis.fetch = async (url, init) => {
                if (new URL(String(url)).pathname !== "/api/coach/memory")
                  return originalFetch(url, init);
                dispatches++;
                assert.equal(init?.method, "GET");
                if (control === "timeout") {
                  deadline.abort(
                    new DOMException("PRIVATE-TIMEOUT", "TimeoutError"),
                  );
                  throw deadline.signal.reason;
                }
                if (control === "connectivity")
                  throw new TypeError("PRIVATE-NETWORK");
                if (control === "cancelled") {
                  controller.abort();
                  throw controller.signal.reason;
                }
                throw new Error("PRIVATE-UNCLASSIFIED");
              };
              if (control === "cancelled") {
                await assert.rejects(
                  gateway.handle(chosen, controller.signal),
                  (e: any) =>
                    e instanceof NativeFailure && e.code === "NATIVE_CANCELLED",
                );
              } else {
                result = await gateway.handle(chosen);
                assert.deepEqual(JSON.parse(result.content[0].text), {
                  error: errorCode,
                  note: "This read did not complete. Report the fact as unavailable; do not invent it.",
                });
                const repeated = await gateway.handle(chosen);
                if (!legacy) assert.deepEqual(repeated, result);
                const next = {
                  ...modern,
                  toolCallId: "PRIVATE-TRANSPORT-NEXT",
                };
                select([next]);
                const body = {
                  model,
                  messages: [{ role: "tool", content: result.content[0].text }],
                };
                await gateway.handle({ kind: "provider", body });
                const cached = await gateway.handle(
                  legacy ? { ...chosen, toolCallId: next.toolCallId } : next,
                );
                assert.deepEqual(JSON.parse(cached.content[0].text), {
                  error: errorCode,
                  note: "This exact read already failed in this invocation and was not repeated. Use a documented path from GET /api/docs/coach (domain index) or state the fact as unavailable.",
                });
                assert.equal(wires[1], JSON.stringify(body));
              }
            } finally {
              globalThis.fetch = originalFetch;
              AbortSignal.timeout = originalTimeout;
            }
            assert.equal(dispatches, 1);
            assert.deepEqual(
              reads,
              [],
              "deterministic seam replaces only actual REST dispatch",
            );
            const events = new Diagnostics(dir)
              .snapshot()
              .entries.filter((e) => e.stage === "acquisition-result");
            assert.equal(events.length, control === "cancelled" ? 1 : 3);
            assert.ok(
              events.every(
                (e) =>
                  e.metadata.outcomeCode === outcomeCode &&
                  !("statusCode" in e.metadata),
              ),
            );
            assert.deepEqual(
              events.map((e) => e.metadata.cacheCode),
              control === "cancelled" ? [3] : [3, legacy ? 2 : 1, 2],
            );
            assert.deepEqual(
              new Diagnostics(dir).snapshot().entries,
              logs.snapshot().entries,
            );
            if (control !== "cancelled") {
              const accounting = logs
                .snapshot()
                .entries.filter((e) => e.stage === "provider-accounting")
                .at(-1)!;
              assert.equal(accounting.ref, events[0].ref);
              assert.equal(accounting.metadata.emissionOrdinal, 2);
            }
            assert.doesNotMatch(
              await readFile(dir + "/diagnostics.jsonl", "utf8"),
              /PRIVATE-|synthetic-|\/api\/|127\.0\.0\.1/,
            );
            outputs.push({ result, wires: [...wires], dispatches });
          },
          undefined,
          {},
          throwing
            ? () => {
                throw new Error("PRIVATE-ACQUISITION-SINK");
              }
            : undefined,
          throwing,
        );
      }
      assert.deepEqual(outputs[0], outputs[1]);
    });

test("throwing actual acquisition callback cannot turn successful HTTP into failed/cache replacement", async () => {
  await fixture(
    async ({ gateway, reads, select, observations }) => {
      const chosen = call("/api/docs/coach");
      select([chosen]);
      await gateway.handle({ kind: "provider", body: requestBody });
      const result = await gateway.handle(chosen);
      assert.deepEqual(result, {
        content: [{ type: "text", text: privateJson }],
        details: {},
      });
      assert.deepEqual(
        await gateway.handle({
          kind: "tool",
          name: "katafit_rest_get",
          args: { path: chosen.args.path },
        }),
        result,
      );
      assert.equal(reads.length, 1);
      assert.equal(observations.length, 1);
    },
    undefined,
    {},
    () => {
      throw new Error("PRIVATE-ACQUISITION-SINK");
    },
  );
});

test("throwing acquisition callback preserves original transport cancellation identity", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const transportError = new SafeError("CANCELLED");
  const acquisition = new InvocationCapability({
    plane: "autonomy",
    origin: "http://127.0.0.1",
    token: "synthetic-token",
    secrets: [],
    vision: true,
    actions: [],
    current: () => true,
    onRead: () => {
      throw new Error("PRIVATE-SINK");
    },
  });
  try {
    globalThis.fetch = async () => {
      throw transportError;
    };
    await assert.rejects(
      acquisition
        .tools()[0]
        .execute(
          "private",
          { method: "GET", path: "/api/docs/coach" },
          controller.signal,
        ),
      (e) => e === transportError,
    );
    await assert.rejects(
      restRequest(
        "http://127.0.0.1",
        "synthetic-token",
        { method: "GET", path: "/api/docs/coach" },
        controller.signal,
        [],
      ),
      (e) => e === transportError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("acquisition status and outcome domains persist only finite protocol codes", async () => {
  const dir = await mkdtemp(tmpdir() + "/memory0851-domains-");
  try {
    const logs = new Diagnostics(dir);
    for (let outcomeCode = 0; outcomeCode <= 8; outcomeCode++)
      for (let cacheCode = 0; cacheCode <= 4; cacheCode++) {
        const metadata = { outcomeCode, cacheCode, statusCode: 503 };
        logs.record({
          source: "provider",
          stage: "acquisition-result",
          metadata,
        });
        assert.deepEqual(logs.snapshot().entries.at(-1)!.metadata, metadata);
      }
    for (const metadata of [
      { outcomeCode: 9, cacheCode: 5, statusCode: 600 },
      { outcomeCode: "1", cacheCode: "3", statusCode: 99 },
      { outcomeCode: 1.5, cacheCode: NaN, statusCode: "503" },
      {
        arbitraryNumeric: 503,
        query: "PRIVATE-QUERY",
        errorMessage: "PRIVATE-ERROR",
        memberId: "PRIVATE-MEMBER",
        accountId: "PRIVATE-ACCOUNT",
      },
    ]) {
      logs.record({
        source: "provider",
        stage: "acquisition-result",
        metadata,
      });
      assert.deepEqual(logs.snapshot().entries.at(-1)!.metadata, {});
    }
    assert.deepEqual(
      new Diagnostics(dir).snapshot().entries,
      logs.snapshot().entries,
    );
    assert.doesNotMatch(
      await readFile(dir + "/diagnostics.jsonl", "utf8"),
      /PRIVATE-|arbitraryNumeric|memberId|accountId/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const [status, body, outcomeCode] of [
  [200, '{"error":"REST_READ_DENIED","outcomeCode":2}', 1],
  [200, "PRIVATE-INVALID-JSON", 8],
  [302, privateJson, 8],
  [400, privateJson, 8],
  [204, "", 1],
] as const)
  test(`HTTP ${status} content/protocol control never guesses outcome from text`, async () => {
    await fixture(async ({ gateway, logs, select, respond, reads }) => {
      const chosen = call("/api/coach/memory");
      respond(chosen.args.path, status, body);
      select([chosen]);
      await gateway.handle({ kind: "provider", body: requestBody });
      const result = await gateway.handle(chosen);
      assert.equal(receipts(logs)[0].metadata.outcomeCode, outcomeCode);
      assert.equal(receipts(logs)[0].metadata.statusCode, status);
      assert.equal(receipts(logs)[0].metadata.cacheCode, 3);
      if (status === 200 && outcomeCode === 1)
        assert.equal(result.content[0].text, body);
      if (status === 200 && outcomeCode === 8)
        assert.match(result.content[0].text, /REST_READ_UNAVAILABLE/);
      if (status === 302)
        assert.match(result.content[0].text, /REST_REDIRECT_REJECTED/);
      if (status === 204)
        assert.equal(result.content[0].text, '{"status":204}');
      assert.equal(reads.length, 1);
    });
  });

test("read-budget refusal is non-dispatched, cached failure and never an HTTP denial", async () => {
  await fixture(
    async ({ gateway, logs, reads }) => {
      for (let n = 0; n < 9; n++)
        await gateway.handle({
          kind: "tool",
          name: "katafit_rest_get",
          args: { path: `/api/coach/memory?query=PRIVATE-${n}` },
        });
      // Invocation has maxReads=8; gateway has a separate, unchanged larger quota.
      const event = receipts(logs).at(-1)!;
      assert.equal(event.metadata.outcomeCode, 8);
      assert.equal(event.metadata.cacheCode, 4);
      assert.ok(!("statusCode" in event.metadata));
      assert.equal(reads.length, 8);
      await gateway.handle({
        kind: "tool",
        name: "katafit_rest_get",
        args: { path: "/api/coach/memory?query=PRIVATE-8" },
      });
      assert.equal(receipts(logs).at(-1)!.metadata.cacheCode, 2);
      assert.equal(reads.length, 8);
    },
    undefined,
    {
      budgets: { tool_calls: 12, provider_tokens: 60000, images_per_cycle: 2 },
    },
  );
});

function receipts(logs: Diagnostics) {
  return logs
    .snapshot()
    .entries.filter(
      (e) => e.stage === ("acquisition-result" as LogInput["stage"]),
    );
}

test("modern JSON acquisition and provider continuation persist correlated numeric receipts with exact wire/result parity", async () => {
  const captured: { result: unknown; wires: string[] }[] = [];
  for (const enabled of [false, true]) {
    await fixture(
      async ({ gateway, logs, dir, reads, wires, select }) => {
        const chosen = call("/api/docs/coach?domain=PRIVATE-QUERY");
        select([chosen]);
        await gateway.handle({ kind: "provider", body: requestBody });
        const result = await gateway.handle(chosen);
        assert.deepEqual(result, {
          content: [{ type: "text", text: privateJson }],
          details: {},
        });
        const continuation = {
          model,
          messages: [
            ...requestBody.messages,
            {
              role: "tool",
              tool_call_id: chosen.toolCallId,
              content: privateJson,
            },
          ],
        };
        select([]);
        await gateway.handle({ kind: "provider", body: continuation });
        assert.deepEqual(wires, [
          JSON.stringify(requestBody),
          JSON.stringify(continuation),
        ]);
        assert.deepEqual(reads, [chosen.args.path]);
        assert.equal(gateway.usage().tool_calls, 1);
        captured.push({ result, wires: [...wires] });
        if (!enabled) return;
        const [receipt] = receipts(logs);
        assert.ok(receipt, "missing validated acquisition-result receipt");
        assert.match(receipt.ref!, /^[a-f0-9-]{36}$/);
        assert.deepEqual(receipt.metadata, {
          profileCode: 1,
          requestOrdinal: 1,
          emissionOrdinal: 1,
          toolCode: 1,
          sourceCode: 1,
          cacheCode: 3,
          outcomeCode: 1,
          statusCode: 200,
          resultTextBytes: Buffer.byteLength(privateJson),
          resultImageParts: 0,
        });
        const accounting = logs
          .snapshot()
          .entries.filter((e) => e.stage === "provider-accounting");
        assert.equal(accounting.length, 2);
        assert.ok(accounting.every((e) => e.ref === receipt.ref));
        assert.deepEqual(
          accounting.map((e) => [
            e.metadata.emissionOrdinal,
            e.metadata.toolHistoryMessages,
            e.metadata.toolHistoryTextBytes,
            e.metadata.toolHistoryImageParts,
          ]),
          [
            [0, 0, 0, 0],
            [1, 1, Buffer.byteLength(privateJson), 0],
          ],
        );
        assert.deepEqual(
          new Diagnostics(dir).snapshot().entries,
          logs.snapshot().entries,
        );
        assert.doesNotMatch(
          await readFile(dir + "/diagnostics.jsonl", "utf8"),
          /PRIVATE-|synthetic-|127\.0\.0\.1|\/api\//,
        );
      },
      enabled ? undefined : () => {},
    );
  }
  assert.deepEqual(
    captured[0],
    captured[1],
    "diagnostics must not change model-facing data or provider bytes",
  );
});

test("persisted sanitizer admits only finite codes and nonnegative safe counters, never hostile metadata", async () => {
  const dir = await mkdtemp(tmpdir() + "/cost1335-sanitizer-");
  try {
    const logs = new Diagnostics(dir);
    const ref = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const fields = {
      emissionOrdinal: 1,
      toolCode: 1,
      sourceCode: 5,
      cacheCode: 1,
      outcomeCode: 0,
      resultTextBytes: 30,
      resultImageParts: 1,
      toolHistoryMessages: 2,
      toolHistoryTextBytes: 90,
      toolHistoryImageParts: 1,
    };
    logs.record({
      source: "provider",
      stage: "acquisition-result",
      ref,
      metadata: {
        ...fields,
        path: "/api/PRIVATE-PATH",
        query: "PRIVATE-QUERY",
        credential: "PRIVATE-SECRET",
        result: "PRIVATE-RESULT",
        "PRIVATE-ARBITRARY": 1,
      },
    });
    logs.record({
      source: "provider",
      stage: "acquisition-result",
      ref: "PRIVATE-REF",
      metadata: {
        emissionOrdinal: -1,
        resultTextBytes: Number.MAX_SAFE_INTEGER + 1,
        resultImageParts: 1.5,
        toolHistoryMessages: NaN,
        toolHistoryTextBytes: Infinity,
        toolHistoryImageParts: "PRIVATE-STRING",
        toolCode: 99,
        sourceCode: 99,
        cacheCode: 99,
        outcomeCode: 99,
      },
    });
    const disk = new Diagnostics(dir).snapshot().entries;
    assert.deepEqual(disk, logs.snapshot().entries);
    assert.equal(disk[0].stage, "acquisition-result");
    assert.equal(disk[0].ref, ref);
    assert.deepEqual(disk[0].metadata, fields);
    assert.deepEqual(
      disk[1].metadata,
      {},
      "out-of-domain codes must not survive real sanitizer",
    );
    assert.ok(!("ref" in disk[1]));
    for (const key of Object.keys(fields))
      for (const invalid of [
        -1,
        0.25,
        Number.MAX_SAFE_INTEGER + 1,
        NaN,
        Infinity,
        "PRIVATE-NUMBER",
        { nested: "PRIVATE-CONTENT" },
      ]) {
        logs.record({
          source: "provider",
          stage: "acquisition-result",
          metadata: { [key]: invalid },
        });
        assert.deepEqual(logs.snapshot().entries.at(-1)!.metadata, {});
      }
    const maxima = {
      emissionOrdinal: Number.MAX_SAFE_INTEGER,
      resultTextBytes: Number.MAX_SAFE_INTEGER,
      resultImageParts: Number.MAX_SAFE_INTEGER,
      toolHistoryMessages: Number.MAX_SAFE_INTEGER,
      toolHistoryTextBytes: Number.MAX_SAFE_INTEGER,
      toolHistoryImageParts: Number.MAX_SAFE_INTEGER,
    };
    logs.record({
      source: "provider",
      stage: "acquisition-result",
      metadata: maxima,
      preview: "PRIVATE-PREVIEW",
      texts: [{ role: "tool", text: "PRIVATE-TEXT" }],
      calls: [
        {
          name: "PRIVATE-TOOL",
          argumentKeys: ["PRIVATE-KEY"],
          arguments: "PRIVATE-ARGS",
        },
      ],
      receipt: { name: "PRIVATE-TOOL", outcome: "ok", media: false },
    });
    assert.deepEqual(logs.snapshot().entries.at(-1)!.metadata, maxima);
    logs.record({
      source: "provider",
      stage: "PRIVATE-STAGE" as LogInput["stage"],
      ref: "PRIVATE-REF",
      metadata: { "PRIVATE-KEY": 1 },
    });
    assert.equal(logs.snapshot().entries.at(-1)!.stage, "operation-failed");
    assert.deepEqual(
      new Diagnostics(dir).snapshot().entries,
      logs.snapshot().entries,
    );
    assert.doesNotMatch(
      await readFile(dir + "/diagnostics.jsonl", "utf8"),
      /PRIVATE-|\/api\//,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("modern occurrence, legacy and invocation-cache returns count emissions without new acquisitions", async () => {
  await fixture(
    async ({ gateway, logs, reads, wires, select, observations }) => {
      const docs = call("/api/docs/coach", "PRIVATE-DOC-CALL");
      const feed = call("/api/friends/feed/dojo?limit=20", "PRIVATE-FEED-CALL");
      select([docs, feed]);
      await gateway.handle({ kind: "provider", body: requestBody });
      const results = [
        await gateway.handle(docs),
        await gateway.handle(docs),
        await gateway.handle(feed),
      ];
      const legacy = {
        kind: "tool",
        name: "katafit_rest_get",
        args: { path: docs.args.path },
        toolCallId: "PRIVATE-LEGACY-CALL",
      };
      results.push(await gateway.handle(legacy), await gateway.handle(legacy));
      assert.ok(results.every((r) => r.content[0].text === privateJson));
      assert.deepEqual(reads, [docs.args.path, feed.args.path]);
      assert.equal(observations.length, 2);
      assert.equal(gateway.usage().tool_calls, 4);
      const continuation = {
        model,
        messages: results.map((r) => ({
          role: "tool",
          content: r.content[0].text,
        })),
      };
      const next = call(docs.args.path, "PRIVATE-NEXT-CALL");
      select([next]);
      await gateway.handle({ kind: "provider", body: continuation });
      assert.deepEqual(await gateway.handle(next), results[0]);
      assert.equal(reads.length, 2);
      assert.equal(observations.length, 2);
      assert.equal(gateway.usage().tool_calls, 5);
      const events = receipts(logs);
      assert.deepEqual(
        events.map((e) => [
          e.metadata.emissionOrdinal,
          e.metadata.requestOrdinal,
          e.metadata.toolCode,
          e.metadata.sourceCode,
          e.metadata.cacheCode,
        ]),
        [
          [1, 1, 1, 1, 3],
          [2, 1, 1, 1, 1],
          [3, 1, 1, 2, 3],
          [4, 1, 2, 1, 2],
          [5, 1, 2, 1, 2],
          [6, 2, 1, 1, 2],
        ],
      );
      assert.ok(
        events.every(
          (e) =>
            e.ref === events[0].ref &&
            e.metadata.resultTextBytes === Buffer.byteLength(privateJson) &&
            e.metadata.outcomeCode === 1 &&
            e.metadata.statusCode === 200,
        ),
      );
      const last = logs
        .snapshot()
        .entries.filter((e) => e.stage === "provider-accounting")
        .at(-1)!;
      assert.equal(last.ref, events[0].ref);
      assert.equal(last.metadata.emissionOrdinal, 5);
      assert.equal(last.metadata.toolHistoryMessages, 5);
      assert.equal(
        last.metadata.toolHistoryTextBytes,
        5 * Buffer.byteLength(privateJson),
      );
      assert.equal(wires[1], JSON.stringify(continuation));
    },
  );
});

for (const [path, source] of [
  ["/api/docs/coach?domain=PRIVATE-DOMAIN", 1],
  ["/api/friends/feed/dojo?query=PRIVATE-QUERY", 2],
  ["/api/friends/activity/aaaaaaaaaaaaaaaaaaaaaaaa", 2],
  ["/api/activities/aaaaaaaaaaaaaaaaaaaaaaaa", 2],
  [
    "/api/coach/member-conversations/aaaaaaaaaaaaaaaaaaaaaaaa?cursor=PRIVATE-CURSOR",
    3,
  ],
  ["/api/coach/memory?query=PRIVATE-MEMORY", 4],
  ["/api/coach/memory/aaaaaaaaaaaaaaaaaaaaaaaa", 4],
  ["/api/media/aaaaaaaaaaaaaaaaaaaaaaaa/files/bbbbbbbbbbbbbbbbbbbbbbbb", 5],
  ["/api/PRIVATE-UNKNOWN?query=PRIVATE-QUERY", 0],
  ["/api/coach/member-conversations/PRIVATE-MALFORMED", 0],
  ["/api/%64ocs/coach", 0],
  ["/api/docs/coach?bad=%00", 0],
] as const) {
  test(`finite source class ${source} for synthetic route control ${path.split("?")[0]}`, async () => {
    await fixture(async ({ gateway, logs, select, reads, dir }) => {
      const chosen = call(path);
      select([chosen]);
      await gateway.handle({ kind: "provider", body: requestBody });
      const result = await gateway.handle(chosen);
      const [event] = receipts(logs);
      assert.equal(event.metadata.sourceCode, source);
      assert.equal(event.metadata.toolCode, 1);
      assert.equal(event.metadata.outcomeCode, path.includes("%00") ? 0 : 1);
      if (path.includes("%00")) {
        assert.equal(reads.length, 0);
        assert.match(result.content[0].text, /ARGUMENTS_REJECTED/);
      } else assert.deepEqual(reads, [path]);
      assert.doesNotMatch(
        await readFile(dir + "/diagnostics.jsonl", "utf8"),
        /PRIVATE-|aaaaaaaaaaaaaaaaaaaaaaaa|bbbbbbbbbbbbbbbbbbbbbbbb|\/api\//,
      );
    });
  });
}

for (const status of [403, 500]) {
  test(`returned HTTP ${status} denial/error is attested and identical under throwing sink`, async () => {
    const controls: unknown[] = [];
    for (const throwing of [false, true]) {
      const attempts: LogInput[] = [];
      await fixture(
        async ({ gateway, select, respond, reads, observations }) => {
          const chosen = call("/api/friends/feed/dojo");
          respond(chosen.args.path, status, "PRIVATE-UPSTREAM-ERROR");
          select([chosen]);
          await gateway.handle({ kind: "provider", body: requestBody });
          const result = await gateway.handle(chosen);
          assert.deepEqual(await gateway.handle(chosen), result);
          assert.match(
            result.content[0].text,
            status === 403 ? /REST_READ_DENIED/ : /REST_READ_UNAVAILABLE/,
          );
          const returned = attempts.filter(
            (e) => e.stage === "acquisition-result",
          );
          assert.equal(returned.length, 2);
          assert.ok(
            returned.every(
              (e) =>
                e.metadata?.outcomeCode === (status === 403 ? 2 : 4) &&
                e.metadata?.statusCode === status &&
                e.metadata?.resultTextBytes ===
                  Buffer.byteLength(result.content[0].text),
            ),
          );
          controls.push({
            result,
            reads,
            observations,
            usage: gateway.usage().tool_calls,
          });
        },
        (e) => {
          attempts.push(e);
          if (throwing) throw new Error("PRIVATE-SINK-ERROR");
        },
      );
    }
    assert.deepEqual(controls[0], controls[1]);
  });
}

test("synthetic image return and original tool history preserve image compaction and exact wire", async () => {
  const png = await sharp({
    create: { width: 3, height: 2, channels: 3, background: "#224466" },
  })
    .png()
    .toBuffer();
  const controls: unknown[] = [];
  for (const throwing of [false, true]) {
    const attempts: LogInput[] = [];
    await fixture(
      async ({ gateway, select, respond, reads, wires }) => {
        const chosen = call(
          "/api/media/aaaaaaaaaaaaaaaaaaaaaaaa/files/bbbbbbbbbbbbbbbbbbbbbbbb",
        );
        respond(chosen.args.path, 200, png, "image/png");
        select([chosen]);
        await gateway.handle({ kind: "provider", body: requestBody });
        const result = await gateway.handle(chosen);
        const image = result.content.find((p: any) => p.type === "image");
        assert.ok(image);
        assert.equal(
          (await sharp(Buffer.from(image.data, "base64")).metadata()).width,
          3,
        );
        const text = result.content
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join("");
        const [event] = attempts.filter(
          (e) => e.stage === "acquisition-result",
        );
        assert.equal(event.metadata?.sourceCode, 5);
        assert.equal(event.metadata?.resultImageParts, 1);
        assert.equal(event.metadata?.resultTextBytes, Buffer.byteLength(text));
        const body = {
          model,
          messages: [
            { role: "system", content: "PRIVATE-SKILL-UNATTRIBUTED" },
            ...Array.from({ length: 6 }, () => ({
              role: "tool",
              content: [
                { type: "text", text: "雪" },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:${image.mimeType};base64,${image.data}`,
                  },
                },
              ],
            })),
            {
              role: "user",
              content: [{ type: "text", text: "PRIVATE-LOCAL-HISTORY" }],
            },
          ],
        };
        const original = JSON.stringify(body);
        const expectedWire = nativeProviderAdmission(body).wire;
        assert.notEqual(
          expectedWire,
          original,
          "control must exercise existing compaction",
        );
        select([]);
        await gateway.handle({ kind: "provider", body });
        const last = attempts
          .filter((e) => e.stage === "provider-accounting")
          .at(-1)!;
        assert.equal(last.ref, event.ref);
        assert.equal(
          last.metadata?.toolHistoryImageParts,
          6,
          "original envelope, not compacted five-image wire",
        );
        assert.equal(last.metadata?.toolHistoryMessages, 6);
        assert.equal(last.metadata?.toolHistoryTextBytes, 18);
        assert.equal(wires[1], expectedWire);
        assert.equal(JSON.stringify(body), original);
        assert.equal(reads.length, 1);
        await assert.rejects(
          gateway.handle({
            kind: "provider",
            body: {
              model,
              messages: [
                {
                  role: "tool",
                  content: [
                    {
                      type: "image_url",
                      image_url: { url: "PRIVATE-INVALID-IMAGE" },
                    },
                  ],
                },
              ],
            },
          }),
          (error: unknown) => {
            assert.ok(error instanceof NativeFailure);
            assert.equal(error.code, "NATIVE_IMAGE_REJECTED");
            assert.equal(error.message, "MEDIA_REJECTED");
            return true;
          },
        );
        assert.equal(
          wires.length,
          2,
          "invalid image admission sends/charges nothing extra",
        );
        assert.equal(
          attempts.filter((e) => e.stage === "provider-accounting").length,
          2,
        );
        controls.push({ result, wires, used: gateway.usage().tool_calls });
      },
      (e) => {
        attempts.push(e);
        if (throwing) throw new Error("PRIVATE-SINK-ERROR");
      },
    );
  }
  assert.deepEqual(controls[0], controls[1]);
});

test("gateway UUID separates lifetimes when profile and ordinals reset", async () => {
  const refs: string[] = [];
  for (let n = 0; n < 2; n++)
    await fixture(async ({ gateway, logs }) => {
      await gateway.handle({
        kind: "tool",
        name: "katafit_rest_get",
        args: { path: "/api/docs/coach" },
      });
      const [event] = receipts(logs);
      assert.equal(event.metadata.emissionOrdinal, 1);
      assert.equal(event.metadata.requestOrdinal, 0);
      refs.push(event.ref!);
    });
  assert.notEqual(refs[0], refs[1]);
});

for (const mode of ["failed", "uncertain", "cancelled"] as const) {
  test(`throwing diagnostics preserve ${mode} callback failure without a returned-result receipt`, async () => {
    const controls: unknown[] = [];
    for (const throwing of [false, true]) {
      let executions = 0;
      const events: LogInput[] = [];
      const abort = new AbortController();
      await fixture(
        async ({ gateway, select, reads }) => {
          const chosen = {
            ...call("/api/docs/coach"),
            name: "PRIVATE-UNKNOWN-TOOL",
            args: {},
          };
          select([chosen as ReturnType<typeof call>]);
          await gateway.handle({ kind: "provider", body: requestBody });
          let failure: any;
          try {
            await gateway.handle(chosen, abort.signal);
          } catch (error) {
            failure = error;
          }
          assert.equal(
            failure.code,
            mode === "uncertain"
              ? "NATIVE_DELIVERY_UNVERIFIED"
              : mode === "cancelled"
                ? "NATIVE_CANCELLED"
                : "NATIVE_TOOL_FAILED",
          );
          assert.equal(
            events.filter((e) => e.stage === "acquisition-result").length,
            0,
          );
          assert.equal(executions, 1);
          assert.equal(reads.length, 0);
          controls.push({
            code: failure.code,
            used: gateway.usage().tool_calls,
          });
        },
        (e) => {
          events.push(e);
          if (throwing) throw new Error("PRIVATE-SINK-ERROR");
        },
        {
          tools: [
            {
              name: "PRIVATE-UNKNOWN-TOOL",
              label: "synthetic",
              description: "synthetic",
              parameters: {
                type: "object",
                additionalProperties: false,
              } as any,
              execute: async () => {
                executions++;
                if (mode === "uncertain")
                  throw new NativeFailure("NATIVE_DELIVERY_UNVERIFIED");
                if (mode === "cancelled") abort.abort();
                throw new Error("PRIVATE-CALLBACK-ERROR");
              },
            },
          ],
        },
      );
    }
    assert.deepEqual(controls[0], controls[1]);
  });
}

test("unknown host tool and non-GET refusal are other with no extra mutation dispatch", async () => {
  await fixture(async ({ gateway, logs, select, reads }) => {
    const chosen = {
      ...call("/api/activities/aaaaaaaaaaaaaaaaaaaaaaaa"),
      args: {
        method: "POST",
        path: "/api/activities/aaaaaaaaaaaaaaaaaaaaaaaa",
        body: { marker: "PRIVATE-MUTATION" },
      },
    };
    select([chosen]);
    await gateway.handle({ kind: "provider", body: requestBody });
    assert.match(
      (await gateway.handle(chosen)).content[0].text,
      /ACTION_UNSUPPORTED/,
    );
    assert.equal(reads.length, 0);
    assert.equal(receipts(logs)[0].metadata.sourceCode, 0);
  });
  await fixture(
    async ({ gateway, logs, select, reads }) => {
      const chosen = {
        ...call("unused"),
        name: "PRIVATE-UNKNOWN-TOOL",
        args: {},
      };
      select([chosen as ReturnType<typeof call>]);
      await gateway.handle({ kind: "provider", body: requestBody });
      assert.deepEqual(await gateway.handle(chosen), {
        content: [{ type: "text", text: "PRIVATE-HOST-RESULT" }],
        details: {},
      });
      const [event] = receipts(logs);
      assert.equal(event.metadata.sourceCode, 0);
      assert.equal(event.metadata.toolCode, 0);
      assert.equal(
        event.metadata.outcomeCode,
        0,
        "text alone is never attested success",
      );
      assert.equal(event.metadata.cacheCode, 0);
      assert.equal(reads.length, 0);
      assert.doesNotMatch(JSON.stringify(event), /PRIVATE-/);
      await assert.rejects(
        gateway.handle({
          kind: "tool",
          name: "katafit_rest_get",
          args: { path: "/api/docs/coach?bad=%00" },
        }),
        /NATIVE_REQUEST_REJECTED/,
      );
      assert.equal(receipts(logs).length, 1);
    },
    undefined,
    {
      tools: [
        {
          name: "PRIVATE-UNKNOWN-TOOL",
          label: "synthetic",
          description: "synthetic",
          parameters: { type: "object", additionalProperties: false } as any,
          execute: async () => ({
            content: [{ type: "text", text: "PRIVATE-HOST-RESULT" }],
            details: {},
          }),
        },
      ],
    },
  );
});

test("throwing sink preserves reported overshoot and unchanged next-request 60000 refusal", async () => {
  const exhausted: string[] = [];
  const events: LogInput[] = [];
  await fixture(
    async ({ gateway, providerResponse, wires }) => {
      providerResponse(
        `data: ${JSON.stringify({ choices: [], usage: { total_tokens: 65400, prompt_tokens: 65000, completion_tokens: 400 } })}\n\ndata: [DONE]\n\n`,
      );
      await gateway.handle({ kind: "provider", body: requestBody });
      assert.equal(gateway.usage().provider_tokens, 65400);
      assert.deepEqual(exhausted, []);
      await assert.rejects(
        gateway.handle({ kind: "provider", body: requestBody }),
        /NATIVE_REQUEST_REJECTED/,
      );
      await assert.rejects(
        gateway.handle({ kind: "provider", body: requestBody }),
        /NATIVE_REQUEST_REJECTED/,
      );
      assert.deepEqual(exhausted, ["provider_tokens"]);
      assert.equal(wires.length, 1);
      const charged = events.filter((e) => e.stage === "provider-accounting");
      const refused = events.filter(
        (e) => e.stage === "provider-budget-refused",
      );
      assert.equal(charged.length, 1);
      assert.equal(charged[0].metadata?.chargedTokens, 65400);
      assert.equal(refused.length, 2);
      assert.ok(
        refused.every(
          (e) =>
            e.ref === charged[0].ref &&
            e.metadata?.requestOrdinal === 2 &&
            e.metadata?.tokenBudget === 60000,
        ),
      );
    },
    (event) => {
      events.push(event);
      throw new Error("PRIVATE-SINK-ERROR");
    },
    { onExhausted: (reason) => exhausted.push(reason) },
  );
});

test("actual AutonomyHost forwards modern acquisition and provider receipts through runner into persisted logger", async () => {
  const env = await setup();
  const logs = new Diagnostics(env.store.dir);
  const chosen = call("/api/docs/coach", "t1");
  restServer(env.fake, {
    "GET /api/docs/coach": { status: 200, body: JSON.parse(privateJson) },
  });
  const planner = new ScriptedRuntime([
    async (io) => {
      await io.provider(requestBody);
      const result = await io.call(chosen.name, chosen.args);
      assert.equal(result.content[0].text, privateJson);
      await io.provider({
        model,
        messages: [{ role: "tool", content: result.content[0].text }],
      });
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
  let providers = 0;
  let acquisitions = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    assert.equal(url.hostname, "127.0.0.1");
    if (url.pathname.endsWith("/chat/completions")) {
      providers++;
      return new Response(selection(providers === 1 ? [chosen] : []), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (url.pathname === chosen.args.path) acquisitions++;
    return original(input, init);
  };
  try {
    await host.start();
    const deadline = Date.now() + 4000;
    while (!host.snapshot().lastOutcome && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    await host.stop();
    assert.deepEqual(planner.errors, []);
    assert.equal(host.snapshot().lastOutcome, "completed");
    assert.equal(env.fake.state.work.get(env.workId).status, "completed");
    assert.equal(providers, 2);
    assert.equal(acquisitions, 1);
    const [event] = receipts(logs);
    assert.equal(receipts(logs).length, 1);
    assert.equal(event.metadata.sourceCode, 1);
    assert.equal(event.metadata.outcomeCode, 1);
    assert.equal(event.metadata.statusCode, 200);
    assert.equal(event.metadata.cacheCode, 3);
    assert.equal(
      event.metadata.resultTextBytes,
      Buffer.byteLength(privateJson),
    );
    const accounting = logs
      .snapshot()
      .entries.filter((e) => e.stage === "provider-accounting");
    assert.equal(accounting.length, 2);
    assert.ok(accounting.every((e) => e.ref === event.ref));
    assert.equal(
      accounting[1].metadata.toolHistoryTextBytes,
      Buffer.byteLength(privateJson),
    );
    assert.deepEqual(
      new Diagnostics(env.store.dir).snapshot().entries,
      logs.snapshot().entries,
    );
    assert.doesNotMatch(
      await readFile(env.store.dir + "/diagnostics.jsonl", "utf8"),
      /PRIVATE-|synthetic-token|synthetic-key|\/api\/docs/,
    );
  } finally {
    await host.stop();
    globalThis.fetch = original;
    await env.close();
  }
});
