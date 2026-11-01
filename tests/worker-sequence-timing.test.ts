import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setImmediate as tick } from "node:timers/promises";
// The compiled shipping Client, Worker, gateway seam and strict diagnostics
// log. Only the backend, provider, Docker/Pi and (where named) the clock are
// synthetic. New-module imports are dynamic so a missing implementation fails
// an assertion rather than the whole file.
import { Client } from "../dist/katafit/client.js";
import { Worker } from "../dist/worker/runner.js";
import { Store } from "../dist/config/store.js";
import { openProfileGateway } from "../dist/sandbox/gateway.js";
import { workerGatewayOptions } from "../dist/runtime/isolatedInvocation.js";
import { HeadlessCycleRuntime } from "../dist/autonomy/headless.js";
import { Diagnostics } from "../dist/diagnostics/log.js";
import { taskFixture } from "./task-fixtures.js";
import { fakeEngine, IMAGE, obedient } from "./helpers/headless-engine.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VALID = '{"text":"Synthetic verified result"}';
const digestOf = (taskId: string, leaseGeneration: number) =>
  parseInt(
    createHash("sha256")
      .update(
        `katafit.coach.worker.task-attempt.v1\0${taskId.toLowerCase()}\0${leaseGeneration}`,
      )
      .digest("hex")
      .slice(0, 12),
    16,
  );
const close = (server: Server) =>
  new Promise<void>((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });
const spans = (events: any[], source = "worker") =>
  events.filter((e) => e.stage === "task-span" && e.source === source);
const nonnegativeInts = (metadata: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(metadata))
    assert.ok(
      Number.isSafeInteger(value) && (value as number) >= 0,
      `${key}=${value}`,
    );
};

/** A deferred fetch whose headers and body chunks the test releases. */
function deferredFetch() {
  const requests: { url: string; init: any }[] = [];
  let respond!: (response: Response) => void;
  let fail!: (error: unknown) => void;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, init: any) => {
    requests.push({ url, init });
    return new Promise<Response>((resolve, reject) => {
      respond = resolve;
      fail = reject;
      init.signal?.addEventListener("abort", () => {
        const reason = init.signal.reason;
        reject(reason);
        try {
          controller?.error(reason);
        } catch {}
      });
    });
  }) as typeof fetch;
  return {
    requests,
    headers(headers: Record<string, string>, status = 200) {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      respond(new Response(body, { status, headers }));
    },
    chunk(text: string) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    end() {
      controller.close();
    },
    fail: (error: unknown) => fail(error),
    restore() {
      globalThis.fetch = original;
    },
  };
}

test("Client reports physical MCP request phases, Server-Timing and X-Request-ID under its poll scope", async () => {
  const wire = deferredFetch();
  const events: any[] = [];
  let now = 1000;
  const scope = {
    ref: randomUUID(),
    origin: 1000,
    clock: () => now,
    attemptDigest: 123456789,
    ordinal: { value: 0 },
  };
  try {
    const client = new (Client as any)(
      "http://backend.invalid",
      "synthetic-backend-token",
      new AbortController().signal,
      (event: any) => events.push(structuredClone(event)),
      scope,
    );
    now = 1010;
    const call = client.call("coach_synthetic_tool", { ok: true }, 30000);
    await tick();
    assert.equal(wire.requests.length, 1);
    const sent = wire.requests[0].init;
    const id = JSON.parse(sent.body).id;
    const requestId = sent.headers["X-Request-ID"];
    assert.match(requestId ?? "", UUID, "physical request id is sent");
    now = 1050;
    wire.headers({
      "content-type": "application/json",
      "x-request-id": requestId,
      "server-timing":
        "total;dur=12.4, auth;dur=1.2, handler;dur=9.6;desc=x, db;dur=3, private-name;dur=1, bad",
    });
    await tick();
    now = 1070;
    const text = JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { structuredContent: { ok: 1 } },
    });
    wire.chunk(text.slice(0, 10));
    await tick();
    now = 1090;
    wire.chunk(text.slice(10));
    wire.end();
    assert.deepEqual(await call, { ok: 1 });
    // A GET (instructions) carries its own request id under the same scope.
    now = 1100;
    const fetched = client
      .withSignal(new AbortController().signal)
      .fetch("/api/agents/coach.md");
    await tick();
    const getId = wire.requests[1].init.headers["X-Request-ID"];
    assert.match(getId ?? "", UUID);
    assert.notEqual(getId, requestId);
    wire.headers({ "content-type": "text/markdown" });
    await tick();
    wire.chunk("# synthetic");
    wire.end();
    await fetched;

    const calls = events.filter((e) => e.stage === "backend-call");
    assert.equal(calls.length, 2);
    const [first, second] = calls;
    assert.equal(first.ref, requestId, "receipt ref is the sent request id");
    assert.equal(first.parentRef, scope.ref);
    assert.equal(second.ref, getId);
    assert.equal(second.parentRef, scope.ref, "withSignal keeps the scope");
    assert.deepEqual(first.metadata, {
      elapsedMs: 80,
      statusCode: 200,
      responseBytes: Buffer.byteLength(text),
      budgetMs: 30000,
      requestBytes: Buffer.byteLength(sent.body),
      headersMs: 40,
      firstByteMs: 60,
      bodyMs: 40,
      decodeMs: 0,
      requestIdEcho: 1,
      callOrdinal: 1,
      sinceScopeMs: 10,
      attemptDigest: 123456789,
      serverTotalMs: 12,
      serverAuthMs: 1,
      serverHandlerMs: 10,
      serverTimingEntries: 4,
    });
    assert.equal(second.metadata.callOrdinal, 2, "ordinal shared by scope");
    assert.equal(second.metadata.sinceScopeMs, 100);
    assert.equal(second.metadata.requestIdEcho, undefined, "no echo, no 0");
    assert.equal(second.metadata.requestBytes, undefined, "GET has no body");
    const all = JSON.stringify(events);
    for (const secret of [
      "synthetic-backend-token",
      "backend.invalid",
      "coach_synthetic_tool",
      "private-name",
      "db",
    ])
      assert.equal(all.includes(secret), false, secret);
  } finally {
    wire.restore();
  }
});

test("Client timing faults and cancellation never change transport outcomes", async () => {
  const scope = (clock: () => number) => ({
    ref: randomUUID(),
    origin: 0,
    clock,
    ordinal: { value: 0 },
  });
  // Cancellation mid-body keeps the existing CANCELLED classification while
  // the receipt still reports the phases observed before the abort.
  {
    const wire = deferredFetch();
    const events: any[] = [];
    let now = 5;
    try {
      const abort = new AbortController();
      const client = new (Client as any)(
        "http://backend.invalid",
        "synthetic-backend-token",
        abort.signal,
        (event: any) => events.push(event),
        scope(() => now),
      );
      const call = client.call("coach_synthetic_tool", {}, 30000);
      await tick();
      now = 25;
      wire.headers({ "content-type": "application/json" });
      await tick();
      now = 30;
      wire.chunk('{"jsonrpc"');
      await tick();
      now = 45;
      abort.abort();
      await assert.rejects(call, { message: "CANCELLED" });
      const [entry] = events;
      assert.equal(entry.backendCall.outcome, "cancelled");
      assert.equal(entry.metadata.headersMs, 20);
      assert.equal(entry.metadata.firstByteMs, 25);
      assert.equal(entry.metadata.bodyMs, undefined, "unknown, never zero");
      assert.equal(entry.metadata.decodeMs, undefined);
    } finally {
      wire.restore();
    }
  }
  // An HTTP failure still records its header phase; a throwing logger and
  // a throwing clock leave both the result and the thrown error unchanged.
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    if (req.url === "/fail") {
      res.writeHead(500, {
        "x-request-id": "ffffffff-ffff-4fff-8fff-ffffffffffff",
      });
      return res.end("{}");
    }
    const id = JSON.parse(raw).id;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    const events: any[] = [];
    const traced = new (Client as any)(
      origin,
      "synthetic-backend-token",
      new AbortController().signal,
      (event: any) => events.push(event),
      scope(() => performance.now()),
    );
    await assert.rejects(traced.fetch("/fail", { x: 1 }, 5000), {
      message: "CONNECTIVITY_ERROR",
    });
    assert.equal(events[0].backendCall.outcome, "http_error");
    assert.equal(events[0].metadata.statusCode, 500);
    assert.equal(typeof events[0].metadata.headersMs, "number");
    assert.equal(events[0].metadata.requestIdEcho, 0, "foreign echo is 0");
    const faulty = new (Client as any)(
      origin,
      "synthetic-backend-token",
      new AbortController().signal,
      (event: any) => {
        events.push(event);
        throw new Error("LOGGER_FAULT");
      },
      scope(() => {
        throw new Error("CLOCK_FAULT");
      }),
    );
    const plain = new Client(
      origin,
      "synthetic-backend-token",
      new AbortController().signal,
    );
    assert.deepEqual(await faulty.rpc("ping"), await plain.rpc("ping"));
    await assert.rejects(faulty.fetch("/fail", { x: 1 }, 5000), {
      message: "CONNECTIVITY_ERROR",
    });
    const faults = events.slice(1);
    assert.equal(faults.length, 2);
    for (const e of faults) {
      assert.equal(
        e.metadata.elapsedMs,
        undefined,
        "unknown clock is not zero",
      );
      assert.equal(e.metadata.headersMs, undefined);
      assert.equal(e.metadata.callOrdinal !== undefined, true);
      assert.match(e.parentRef, UUID);
    }
  } finally {
    await close(server);
  }
});

test("loopback Server-Timing and parentRef persist through the strict diagnostics log", async () => {
  const seen: string[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    seen.push(String(req.headers["x-request-id"]));
    const id = JSON.parse(raw).id;
    res.writeHead(200, {
      "content-type": "application/json",
      "x-request-id": String(req.headers["x-request-id"]).toUpperCase(),
      "server-timing": [
        "total;dur=7.6",
        "auth;dur=99999999999",
        "handler;dur=-1",
        "handler;dur=2.4",
        "Total;dur=1",
        "secret_member_text;dur=5",
        ...Array.from({ length: 40 }, () => "x;dur=1"),
      ].join(", "),
    });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const home = await mkdtemp(tmpdir() + "/sequence-timing-log-");
  try {
    const logs = new Diagnostics(home);
    const parent = randomUUID();
    const client = new (Client as any)(
      `http://127.0.0.1:${(server.address() as any).port}`,
      "synthetic-backend-token",
      new AbortController().signal,
      (event: any) => logs.record(event),
      {
        ref: parent,
        origin: performance.now(),
        clock: () => performance.now(),
        ordinal: { value: 0 },
      },
    );
    await client.rpc("ping");
    logs.record({
      source: "worker",
      stage: "task-span" as any,
      ref: parent,
      parentRef: "not-a-uuid PRIVATE",
      metadata: {
        spanCode: 7,
        spanOutcome: 1,
        spanMs: 12,
        spanStartMs: 3,
        attemptDigest: 5,
        outputAttempt: 2,
        queueMs: 86400001,
        spanUnknownMs: 4,
      },
    } as any);
    logs.record({
      source: "worker",
      stage: "task-span" as any,
      metadata: { spanCode: 21, spanOutcome: 5, requestIdEcho: 2 },
    } as any);
    const entries = new Diagnostics(home).snapshot().entries;
    assert.equal(entries.length, 3);
    const [call, span, bounded] = entries as any[];
    assert.equal(call.ref, seen[0], "ref is the X-Request-ID the backend saw");
    assert.equal(call.parentRef, parent);
    assert.equal(call.metadata.requestIdEcho, 1, "echo match is case-blind");
    assert.equal(call.metadata.serverTotalMs, 8);
    assert.equal(call.metadata.serverAuthMs, undefined, "huge value dropped");
    assert.equal(call.metadata.serverHandlerMs, 2, "first valid handler");
    assert.equal(call.metadata.serverTimingEntries, 29, "bounded part count");
    nonnegativeInts(call.metadata);
    assert.equal(span.stage, "task-span");
    assert.equal(span.parentRef, undefined, "invalid parentRef dropped");
    assert.deepEqual(span.metadata, {
      attemptDigest: 5,
      outputAttempt: 2,
      spanCode: 7,
      spanOutcome: 1,
      spanMs: 12,
      spanStartMs: 3,
    });
    assert.deepEqual(bounded.metadata, {}, "codes are bounded");
    assert.doesNotMatch(
      JSON.stringify(entries),
      /secret_member_text|PRIVATE|synthetic-backend-token/,
    );
  } finally {
    await close(server);
    await rm(home, { recursive: true, force: true });
  }
});

async function providerServer(
  respond: (n: number, res: any) => Promise<void> | void,
) {
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    await respond(++calls, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    server,
    calls: () => calls,
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
  };
}
const jsonCompletion = (res: any) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [
        {
          message: { role: "assistant", content: "SYNTHETIC-PROVIDER-TEXT" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }),
  );
};
async function storeFor(baseUrl: string) {
  const home = await mkdtemp(tmpdir() + "/sequence-timing-store-");
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    provider: { baseUrl, model: "synthetic-model" },
    apiKey: "synthetic-provider-key",
  });
  return { home, store };
}

test("compiled worker gateway reports physical provider phases, host queueing and tool spans", async () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const provider = await providerServer(async (n, res) => {
    await sleep(60);
    if (n === 1) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "coach_synthetic_read", arguments: "{}" } }] } }] })}\n\n`,
      );
      await sleep(40);
      res.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    jsonCompletion(res);
  });
  const { home, store } = await storeFor(provider.baseUrl);
  const events: any[] = [];
  const ref = randomUUID();
  const origin = performance.now();
  const gateway = await openProfileGateway(
    store,
    undefined,
    workerGatewayOptions(store, {
      prompt: "Synthetic persona",
      tools: [
        {
          name: "coach_synthetic_read",
          label: "Synthetic read",
          description: "Synthetic",
          parameters: { type: "object", properties: {} },
          execute: async () => {
            await sleep(30);
            return { content: [{ type: "text", text: "SYNTHETIC-TOOL" }] };
          },
        } as any,
      ],
      ref,
      budget: {
        attribution: { attemptDigest: 77, outputAttempt: 2 },
        trace: { origin, clock: () => performance.now() },
      } as any,
      onDiagnostic: (event) => events.push(structuredClone(event)),
    }),
  );
  try {
    const body = (content: string) => ({
      kind: "provider",
      body: {
        model: "synthetic-model",
        messages: [{ role: "user", content }],
      },
    });
    await gateway.handle(body("Synthetic first"));
    // The tool and the next provider request arrive together; the host
    // serializes them, so the provider request reports its queue wait.
    await Promise.all([
      gateway.handle({
        kind: "tool",
        name: "coach_synthetic_read",
        args: {},
        toolCallId: "call-1",
      }),
      gateway.handle(body("Synthetic second")),
    ]);
  } finally {
    await gateway.close();
    await close(provider.server);
    await rm(home, { recursive: true, force: true });
  }
  const timed = spans(events, "provider");
  assert.deepEqual(
    timed.map((e) => [e.metadata.spanCode, e.metadata.spanOutcome]),
    [
      [19, 1],
      [20, 1],
      [19, 1],
    ],
  );
  for (const e of timed) {
    assert.equal(e.ref, ref);
    assert.equal(e.metadata.attemptDigest, 77);
    assert.equal(e.metadata.outputAttempt, 2);
    assert.equal(e.metadata.profileCode, 3);
    nonnegativeInts(e.metadata);
  }
  const [first, tool, second] = timed.map((e) => e.metadata);
  assert.equal(first.requestOrdinal, 1);
  assert.equal(second.requestOrdinal, 2);
  assert.equal(first.statusCode, 200);
  assert.ok(first.headersMs >= 50, "headers wait for the provider");
  assert.ok(first.firstByteMs >= first.headersMs);
  assert.ok(first.bodyMs >= 30, "streamed body after headers");
  assert.ok(first.providerMs >= first.headersMs + first.bodyMs - 2);
  assert.ok(first.spanMs >= first.providerMs);
  assert.equal(tool.toolOrdinal, 1);
  assert.ok(tool.spanMs >= 25);
  assert.ok(second.queueMs >= 25, "queued behind the serialized tool");
  assert.ok(second.spanStartMs <= tool.spanStartMs + 5);
  // Accounting is unchanged and still one receipt per provider request.
  assert.equal(
    events.filter((e) => e.stage === "provider-accounting").length,
    2,
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /SYNTHETIC-PROVIDER-TEXT|SYNTHETIC-TOOL|synthetic-provider-key|Synthetic (first|second|persona)/,
  );
});

test("native seam spans and headless lifecycle join the Worker poll without changing the call", async () => {
  const module: any = await import("../dist/runtime/isolatedInvocation.js");
  assert.equal(typeof module.nativeSpans, "function", "native seam spans");
  const events: any[] = [];
  const ref = randomUUID();
  let now = 100;
  const budget = {
    attribution: { attemptDigest: 9, outputAttempt: 1 },
    trace: { origin: 40, clock: () => now },
  };
  const timed = module.nativeSpans(
    (event: any) => {
      events.push(structuredClone(event));
      throw new Error("LOGGER_FAULT");
    },
    ref,
    budget,
    new AbortController().signal,
  );
  assert.equal(
    await timed(15, async () => {
      now = 130;
      return "runtime";
    }),
    "runtime",
  );
  await assert.rejects(
    timed(17, async () => {
      now = 150;
      throw new Error("HEADLESS_TIMEOUT");
    }),
    { message: "HEADLESS_TIMEOUT" },
  );
  const container = randomUUID();
  timed.lifecycle({
    source: "worker",
    stage: "headless-lifecycle",
    ref: container,
    metadata: { headlessPhase: 5 },
  });
  assert.deepEqual(
    events.map((e) => [e.stage, e.ref, e.parentRef, e.metadata]),
    [
      [
        "task-span",
        ref,
        undefined,
        {
          attemptDigest: 9,
          outputAttempt: 1,
          spanStartMs: 60,
          spanMs: 30,
          spanCode: 15,
          spanOutcome: 1,
        },
      ],
      [
        "task-span",
        ref,
        undefined,
        {
          attemptDigest: 9,
          outputAttempt: 1,
          spanStartMs: 90,
          spanMs: 20,
          spanCode: 17,
          spanOutcome: 4,
        },
      ],
      [
        "headless-lifecycle",
        container,
        ref,
        {
          headlessPhase: 5,
          attemptDigest: 9,
          outputAttempt: 1,
          spanStartMs: 110,
        },
      ],
    ],
  );
  // Untraced (or unrefed) completions emit nothing and add no lifecycle sink.
  const quiet: any[] = [];
  const untraced = module.nativeSpans(
    (event: any) => quiet.push(event),
    ref,
    { deadlineAt: Date.now() + 1000 },
    new AbortController().signal,
  );
  assert.equal(untraced.lifecycle, undefined);
  assert.equal(await untraced(15, async () => 1), 1);
  assert.equal(
    module.nativeSpans(
      (event: any) => quiet.push(event),
      "not-a-uuid",
      budget,
      new AbortController().signal,
    ).lifecycle,
    undefined,
  );
  assert.deepEqual(quiet, []);
});

/** One compiled Worker over the real gateway/headless seam (model test). */
async function workerRun(options: {
  kind?: string;
  invalidFirst?: boolean;
  fixture?: any;
  onDiagnostic?: (event: any, events: any[]) => void;
  clock?: () => number;
  complete?: any;
}) {
  const backend = await taskFixture(options.fixture ?? {});
  const provider = await providerServer((_, res) => jsonCompletion(res));
  const { home, store } = await storeFor(provider.baseUrl);
  const events: any[] = [];
  let gateway: Awaited<ReturnType<typeof openProfileGateway>>;
  let last = VALID;
  let corrected = !options.invalidFirst;
  const engine = await fakeEngine((command, pi) => {
    if (command.type === "abort")
      return pi.send({ type: "response", id: command.id, success: true });
    if (command.type !== "prompt") return obedient(last)(command, pi);
    pi.send({ type: "response", id: command.id, success: true });
    void (async () => {
      for (const content of ["Synthetic evidence", "Synthetic follow up"])
        await gateway.handle({
          kind: "provider",
          body: {
            model: "synthetic-model",
            messages: [{ role: "user", content }],
          },
        });
      last = corrected ? VALID : "not json at all";
      corrected = true;
      pi.send({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: last }],
          },
        ],
      });
    })().catch(() =>
      pi.send({
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "error", content: [] }],
      }),
    );
  });
  const record = (event: any) => {
    events.push(structuredClone(event));
    options.onDiagnostic?.(event, events);
  };
  const worker = new Worker({
    origin: backend.origin,
    token: "worker-secret",
    system: "Coach",
    onDiagnostic: record,
    ...(options.clock ? { clock: options.clock } : {}),
    complete:
      options.complete ??
      (async (message, signal, prompt, tools, ref, budget) => {
        gateway = await openProfileGateway(
          store,
          signal,
          workerGatewayOptions(store, {
            prompt,
            tools,
            ref,
            budget,
            onDiagnostic: record,
          }),
        );
        try {
          return (
            await new HeadlessCycleRuntime({
              image: IMAGE,
              engine: engine.engine,
            }).run({
              profile: "worker",
              gateway,
              message,
              signal,
              cycleMs: Math.min(30000, budget!.deadlineAt! - Date.now()),
            })
          ).text;
        } finally {
          await gateway.close();
        }
      }),
  } as any);
  return {
    backend,
    worker,
    events,
    provider,
    async close() {
      await Promise.allSettled([worker.stop()]);
      await Promise.allSettled([engine.close(), backend.close()]);
      await close(provider.server);
      await rm(home, { recursive: true, force: true });
    },
  };
}

test(
  "compiled Worker emits the ordered task span sequence and joins every physical call to the poll and attempt",
  { timeout: 60000 },
  async () => {
    const run = await workerRun({ invalidFirst: true });
    try {
      const task = run.backend.enqueue("activity_followup");
      await run.worker.pollOnce();
      assert.equal(run.backend.saved.length, 1);
      assert.equal(run.worker.state, "task-result-stored");
      const digest = digestOf(task.id, task.lease_generation);
      const timing = run.events.filter((e) => e.stage === "task-timing");
      const ref = timing[0].ref;
      const worker = spans(run.events);
      assert.deepEqual(
        worker.map((e) => [
          e.metadata.spanCode,
          e.metadata.outputAttempt ?? 0,
          e.metadata.spanOutcome,
        ]),
        [
          [1, 0, 1], // claim
          [2, 0, 1], // context read
          [3, 0, 1], // local context/capability preparation
          [4, 0, 1], // memory preparation
          [6, 0, 1], // prompt assembly
          [14, 1, 1], // admission wait
          [7, 1, 1], // inference call (native seam)
          [8, 1, 2], // parse rejected -> correction
          [14, 2, 1],
          [7, 2, 1],
          [8, 2, 1],
          [9, 0, 1], // completion + verified receipt (ACK)
        ],
      );
      for (const e of worker) {
        assert.equal(e.ref, ref);
        assert.equal(e.metadata.attemptDigest, digest);
        nonnegativeInts(e.metadata);
        assert.equal(typeof e.metadata.spanMs, "number");
        assert.equal(typeof e.metadata.spanStartMs, "number");
      }
      // Sequential preparation spans start in order on one monotonic clock.
      const starts = worker.slice(0, 5).map((e) => e.metadata.spanStartMs);
      assert.deepEqual(
        starts,
        [...starts].sort((a, b) => a - b),
      );
      for (const [i, e] of worker.slice(0, 4).entries())
        assert.ok(
          e.metadata.spanStartMs + e.metadata.spanMs <=
            worker[i + 1].metadata.spanStartMs + 1,
          "preparation spans do not overlap",
        );
      // Physical backend calls: one shared ordinal, poll parentRef, and the
      // attempt digest on every call after the claim.
      const calls = run.events.filter((e) => e.stage === "backend-call");
      assert.ok(calls.length >= 5);
      assert.deepEqual(
        calls.map((e) => e.metadata.callOrdinal),
        calls.map((_, i) => i + 1),
      );
      assert.equal(new Set(calls.map((e) => e.ref)).size, calls.length);
      for (const e of calls) {
        assert.equal(e.parentRef, ref);
        assert.match(e.ref, UUID);
        assert.notEqual(e.ref, ref);
        assert.equal(typeof e.metadata.headersMs, "number");
      }
      const tool = (name: string) =>
        calls.find((e) => e.backendCall.tool === name)!;
      assert.equal(tool("coach_claim_task").metadata.attemptDigest, undefined);
      for (const name of ["coach_read_task_context", "coach_complete_task"])
        assert.equal(tool(name).metadata.attemptDigest, digest, name);
      // Gateway provider spans: two per output attempt, same poll ref.
      const physical = spans(run.events, "provider");
      assert.deepEqual(
        physical.map((e) => [
          e.metadata.spanCode,
          e.metadata.outputAttempt,
          e.metadata.requestOrdinal,
        ]),
        [
          [19, 1, 1],
          [19, 1, 2],
          [19, 2, 1],
          [19, 2, 2],
        ],
      );
      for (const e of physical) {
        assert.equal(e.ref, ref);
        assert.equal(e.metadata.attemptDigest, digest);
      }
      assert.doesNotMatch(
        JSON.stringify(run.events),
        new RegExp(
          [
            task.id,
            "worker-secret",
            "SYNTHETIC-PROVIDER-TEXT",
            "synthetic-provider-key",
            "Synthetic verified",
          ].join("|"),
        ),
      );
      // Everything persists through the strict installed log schema.
      const home = await mkdtemp(tmpdir() + "/sequence-timing-persist-");
      try {
        const logs = new Diagnostics(home);
        for (const e of [...worker, ...physical, ...calls]) logs.record(e);
        const persisted = new Diagnostics(home).snapshot().entries as any[];
        assert.equal(
          persisted.filter((e) => e.stage === "task-span").length,
          worker.length + physical.length,
        );
        assert.equal(
          persisted.filter((e) => e.parentRef === ref).length,
          calls.length,
        );
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    } finally {
      await run.close();
    }
  },
);

test(
  "compiled Worker outcome is unchanged by throwing loggers and clocks; failures, reports and reconciliation are timed",
  { timeout: 60000 },
  async () => {
    // Throwing logger after capture plus a throwing clock: spans still carry
    // codes, intervals are omitted, and the business outcome is unchanged.
    const faulty = await workerRun({
      onDiagnostic: () => {
        throw new Error("LOGGER_FAULT");
      },
      clock: () => {
        throw new Error("CLOCK_FAULT");
      },
    });
    try {
      faulty.backend.enqueue("activity_followup");
      await faulty.worker.pollOnce();
      assert.equal(faulty.backend.saved.length, 1);
      assert.equal(faulty.worker.state, "task-result-stored");
      const worker = spans(faulty.events);
      // No admission/gateway spans: an unknown origin is never forwarded.
      assert.deepEqual(
        worker.map((e) => [e.metadata.spanCode, e.metadata.spanOutcome]),
        [
          [1, 1],
          [2, 1],
          [3, 1],
          [4, 1],
          [6, 1],
          [7, 1],
          [8, 1],
          [9, 1],
        ],
      );
      assert.deepEqual(spans(faulty.events, "provider"), []);
      for (const e of worker) {
        assert.equal(e.metadata.spanMs, undefined);
        assert.equal(e.metadata.spanStartMs, undefined);
      }
      assert.equal(
        faulty.events.filter((e) => e.stage === "backend-call")[0].metadata
          .sinceScopeMs,
        undefined,
      );
    } finally {
      await faulty.close();
    }
    // Provider failure: the open inference span closes failed and the
    // failure report (fail + receipt read) is its own span.
    const failing = await workerRun({
      complete: async () => {
        throw new Error("PROVIDER_FAILED");
      },
    });
    try {
      failing.backend.enqueue("activity_followup");
      await failing.worker.pollOnce().catch(() => {});
      assert.equal(failing.backend.saved.length, 0);
      const codes = spans(failing.events).map((e) => [
        e.metadata.spanCode,
        e.metadata.spanOutcome,
      ]);
      assert.deepEqual(codes.slice(-3), [
        [14, 1],
        [7, 2],
        [12, 1],
      ]);
      assert.ok(
        failing.backend.calls.some((c: any) => c.name === "coach_fail_task"),
      );
    } finally {
      await failing.close();
    }
    // A lost completion response: the ACK span fails and the receipt
    // reconciliation that settles it is timed under the same poll ref.
    const lost = await workerRun({ fixture: { dropComplete: true } });
    try {
      lost.backend.enqueue("activity_followup");
      await lost.worker.pollOnce();
      assert.equal(lost.backend.saved.length, 1);
      const worker = spans(lost.events);
      const tail = worker
        .slice(-2)
        .map((e) => [e.metadata.spanCode, e.metadata.spanOutcome]);
      assert.deepEqual(tail, [
        [9, 2],
        [10, 1],
      ]);
      assert.equal(new Set(worker.map((e) => e.ref)).size, 1);
      const reads = lost.events.filter(
        (e) =>
          e.stage === "backend-call" &&
          e.backendCall.tool === "coach_read_task_receipt",
      );
      assert.ok(reads.length >= 1);
      for (const e of reads) assert.equal(e.parentRef, worker[0].ref);
    } finally {
      await lost.close();
    }
  },
);

test("deferred memory recovery and retention are timed under the original task poll scope", async () => {
  const f = await taskFixture({ memoryCaptures: true });
  const events: any[] = [];
  const worker = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    onDiagnostic: (event) => events.push(structuredClone(event)),
    complete: async (context) => {
      let origin: unknown;
      try {
        origin = JSON.parse(context).origin;
      } catch {}
      return origin === "task"
        ? JSON.stringify({ proposals: [] })
        : JSON.stringify({
            general_advice: "Synthetic daily encouragement.",
            meal_recommendations: [],
            recovery_recommendations: [],
            workout_directives: [],
          });
    },
  });
  try {
    const task = f.enqueue("daily_insight");
    await worker.pollOnce();
    assert.equal(f.saved.length, 1);
    const origin = events.find(
      (e) => e.stage === "task-timing" && e.metadata.timingCode === 1,
    ).ref;
    // Idle maintenance in a later poll recovers the accepted capture.
    for (let n = 0; n < 3; n++) await worker.pollOnce();
    const capture = f.captures.find((c: any) => c.task_id === task.id);
    assert.equal(capture.status, "committed");
    const digest = digestOf(task.id, task.lease_generation);
    const memory = spans(events).filter((e) =>
      [11, 13].includes(e.metadata.spanCode),
    );
    assert.deepEqual(
      memory.map((e) => [e.metadata.spanCode, e.metadata.spanOutcome]),
      [
        [11, 1],
        [13, 1],
      ],
      "retention nests inside recovery",
    );
    for (const e of memory) {
      assert.equal(e.ref, origin, "original poll ref, not the recovery poll");
      assert.equal(e.metadata.attemptDigest, digest);
      assert.equal(e.metadata.taskKindCode, 1);
      nonnegativeInts(e.metadata);
    }
    const [retain, recover] = memory.map((e) => e.metadata);
    assert.ok(recover.spanStartMs <= retain.spanStartMs);
    assert.ok(recover.spanMs >= retain.spanMs);
    // Extraction inference queues for admission under the same scope; it
    // carries no output attempt (it is not a task output turn).
    const admission = spans(events).filter(
      (e) => e.metadata.spanCode === 14 && e.ref === origin,
    );
    assert.equal(admission.length, 2, "task output + extraction");
    assert.equal(admission[1].metadata.outputAttempt, undefined);
    const resumes = events.filter(
      (e) =>
        e.stage === "backend-call" &&
        e.backendCall.tool === "coach_memory_resume",
    );
    assert.ok(resumes.length >= 1);
    for (const e of resumes) {
      assert.equal(e.parentRef, origin);
      assert.equal(e.metadata.attemptDigest, digest);
    }
    // Every later poll owns a fresh scope: its claim never inherits the
    // earlier task's ref, digest or call ordinals.
    const claims = events.filter(
      (e) =>
        e.stage === "backend-call" && e.backendCall.tool === "coach_claim_task",
    );
    assert.equal(claims.length, 4);
    assert.equal(claims[0].parentRef, origin);
    const later = claims.slice(1).map((e) => e.parentRef);
    assert.equal(new Set([origin, ...later]).size, 4);
    for (const e of claims) {
      assert.match(e.parentRef, /^[0-9a-f-]{36}$/);
      assert.equal(e.metadata.attemptDigest, undefined);
    }
    // Physical call ordinals are contiguous within each scope, never shared.
    const byScope = new Map<string, number[]>();
    for (const e of events)
      if (e.stage === "backend-call" && e.parentRef)
        byScope.set(e.parentRef, [
          ...(byScope.get(e.parentRef) ?? []),
          e.metadata.callOrdinal,
        ]);
    assert.equal(byScope.size, 4);
    for (const ordinals of byScope.values())
      assert.deepEqual(
        [...ordinals].sort((a, b) => a - b),
        ordinals.map((_, n) => n + 1),
      );
  } finally {
    await worker.stop();
    await f.close();
  }
});
