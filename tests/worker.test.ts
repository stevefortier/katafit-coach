import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Worker } from "../src/worker/runner.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { LocalMcp } from "../src/mcp/local.js";

test("preview and running worker receive byte-identical saved effective instructions", async () => {
  const f = await fixture();
  const dir = await mkdtemp(tmpdir() + "/coach-parity-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
    apiKey: "synthetic-key",
  });
  const systems: string[] = [];
  let entered!: () => void;
  const workerEntered = new Promise<void>((r) => (entered = r));
  const app = await admin(store, 0, async (_provider, system) => {
    systems.push(system);
    if (systems.length === 2) entered();
    return "Synthetic parity reply, not persona evaluation";
  });
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  const post = (path: string, body: unknown) =>
    fetch(app.origin + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  try {
    const preview = await (
      await post("/api/preview", {
        text: "Preview",
        persona: { name: "UNSAVED" },
      })
    ).json();
    assert.ok(preview.prompt.includes("Use server-authorized context."));
    assert.equal(preview.instructionsStatus, "fetched");
    assert.equal(preview.configuration, "saved");
    assert.equal(preview.prompt.includes("UNSAVED"), false);
    f.enqueue("Worker question");
    assert.equal((await post("/api/run", {})).status, 200);
    await Promise.race([
      workerEntered,
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error("worker timeout")), 2000);
        t.unref();
      }),
    ]);
    assert.deepEqual(systems, [preview.prompt, preview.prompt]);
  } finally {
    await app.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

export async function fixture(
  options: {
    dropReply?: boolean;
    rejectFence?: boolean;
    data?: boolean;
    failureMismatch?: "code" | "generation";
    leaseMs?: number;
    discoveryDelayMs?: number;
  } = {},
) {
  let history: any[] = [];
  let current: any = null;
  let calls: string[] = [];
  let publications = 0;
  let contexts: any[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      res.end(
        "# Kata.fit external Coach agent v1\nUse server-authorized context.",
      );
      return;
    }
    let raw = "";
    for await (const c of req) raw += c;
    const msg = JSON.parse(raw);
    calls.push(msg.params?.name ?? msg.method);
    if (msg.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    let value: any = {};
    const a = msg.params?.arguments;
    if (msg.method === "initialize") value = { protocolVersion: "2025-03-26" };
    else if (msg.method === "tools/list") {
      if (options.discoveryDelayMs)
        await new Promise((resolve) =>
          setTimeout(resolve, options.discoveryDelayMs),
        );
      value = {
        tools: options.data
          ? [
              { name: "coach_get_capabilities" },
              {
                name: "coach_read_media",
                inputSchema: {
                  type: "object",
                  properties: {
                    request_id: { type: "string" },
                    lease_generation: { type: "integer" },
                    media_ref: { type: "string" },
                  },
                  required: ["request_id", "lease_generation"],
                  additionalProperties: false,
                },
              },
            ]
          : [],
      };
    } else {
      switch (msg.params.name) {
        case "coach_get_capabilities":
          value = {
            contract_version: 2,
            allowed_tools: ["coach_read_media"],
            domains: { media: { available: true } },
            limits: {},
          };
          break;
        case "coach_list_requests":
          value = {
            requests:
              current && (!a.statuses || a.statuses.includes(current.status))
                ? [
                    {
                      ...current,
                      ...(a.statuses?.includes("failed") &&
                      options.failureMismatch
                        ? options.failureMismatch === "code"
                          ? { failure_code: "OTHER_FAILURE" }
                          : { lease_generation: current.lease_generation + 1 }
                        : {}),
                    },
                  ]
                : [],
          };
          break;
        case "coach_claim_request":
          if (current && current.status === "queued") {
            current = {
              ...current,
              status: "claimed",
              lease_generation: current.lease_generation + 1,
              lease_expires_at: new Date(
                Date.now() + (options.leaseMs ?? 120000),
              ).toISOString(),
            };
            value = { request: current };
          } else value = { request: null };
          break;
        case "coach_start_request":
          current.status = "working";
          value = { request: current };
          break;
        case "coach_read_context":
          value = {
            request: current,
            conversation: history,
            authorized_member_data: [
              {
                owner: "peer",
                shared_with_audience: true,
                summary: "Authorized running goal",
              },
            ],
          };
          contexts.push(value);
          break;
        case "coach_respond":
          if (current.status !== "completed") {
            publications++;
            history.push(
              { role: "user", text: current.text },
              { role: "assistant", text: a.text },
            );
            current.status = "completed";
            current.reply = { text: a.text };
          }
          value = { request: current };
          break;
        case "coach_fail_request":
          current.failure = a;
          current.failure_code = a.code;
          current.status = "failed";
          value = { request: current };
      }
    }
    if (options.dropReply && msg.params?.name === "coach_respond") {
      req.socket.destroy();
      return;
    }
    if (options.rejectFence && msg.params?.name === "coach_read_context")
      value.request = {
        ...value.request,
        lease_generation: value.request.lease_generation + 1,
      };
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: ["initialize", "tools/list"].includes(msg.method)
          ? value
          : { structuredContent: value },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    origin: `http://127.0.0.1:${(server.address() as any).port}`,
    enqueue(text: string) {
      current = {
        id: String(history.length + 1),
        text,
        requester_id: "member",
        scope: "dojo",
        attachment_count: 0,
        lease_generation: 0,
        status: "queued",
        timeout_at: new Date(Date.now() + 180000).toISOString(),
      };
    },
    get current() {
      return current;
    },
    get history() {
      return history;
    },
    get publications() {
      return publications;
    },
    get calls() {
      return calls;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
test("real wire claim/context/persist/followup and restart deduplicate with canonical context", async () => {
  const f = await fixture();
  const seen: string[] = [];
  try {
    const make = () =>
      new Worker({
        origin: f.origin,
        token: "synthetic-token",
        system: "Coach",
        complete: async (c) => {
          seen.push(c);
          return "Rest and reassess.";
        },
      });
    f.enqueue("Review my training");
    await make().pollOnce();
    assert.equal(f.publications, 1);
    await make().pollOnce();
    assert.equal(f.publications, 1);
    f.enqueue("More detail please");
    await make().pollOnce();
    assert.equal(f.publications, 2);
    assert.ok(seen[1].includes("Rest and reassess."));
    assert.ok(seen[1].includes("Authorized running goal"));
    assert.equal(JSON.parse(seen[1]).request.text, "More detail please");
    assert.equal(f.history.length, 4);
  } finally {
    await f.close();
  }
});

test("main-chat default inference timeout is 100s and explicit shorter modelMs still wins", async () => {
  const f = await fixture();
  const original = AbortSignal.timeout;
  const seen: number[] = [];
  AbortSignal.timeout = ((ms: number) => {
    seen.push(ms);
    return original(ms);
  }) as typeof AbortSignal.timeout;
  try {
    const make = (modelMs?: number) =>
      new Worker({
        origin: f.origin,
        token: "synthetic-token",
        system: "Coach",
        modelMs,
        complete: async () => "Bounded reply",
      });
    f.enqueue("Default budget");
    await make().pollOnce();
    assert.ok(seen.some((ms) => ms > 99000 && ms <= 100000));
    seen.length = 0;
    f.enqueue("Short override");
    await make(1000).pollOnce();
    assert.ok(seen.includes(1000));
    assert.equal(f.publications, 2);
  } finally {
    AbortSignal.timeout = original;
    await f.close();
  }
});

test("main-chat model deadline is clamped below a short lease with publication reserve", async () => {
  const f = await fixture({ leaseMs: 30000 });
  const original = AbortSignal.timeout;
  const seen: number[] = [];
  AbortSignal.timeout = ((ms: number) => {
    seen.push(ms);
    return original(ms);
  }) as typeof AbortSignal.timeout;
  try {
    f.enqueue("Short lease");
    await new Worker({
      origin: f.origin,
      token: "synthetic-token",
      system: "Coach",
      complete: async (_context, _signal, _system, _tools, _ref, budget) => {
        assert.ok(budget);
        assert.ok(budget.deadlineAt! - Date.now() > 17000);
        assert.ok(budget.deadlineAt! - Date.now() < 18000);
        assert.deepEqual(budget.readBudget?.(), { used: 0, limit: 0 });
        return "Bounded reply";
      },
    }).pollOnce();
    assert.ok(seen.some((ms) => ms > 17000 && ms < 18000));
    assert.equal(f.publications, 1);
  } finally {
    AbortSignal.timeout = original;
    await f.close();
  }
});

test("model deadline includes time spent discovering read tools", async () => {
  const f = await fixture({ discoveryDelayMs: 80 });
  const original = AbortSignal.timeout;
  let timeoutStarted = 0;
  let observedDeadline = 0;
  let discoveryElapsed = 0;
  AbortSignal.timeout = ((ms: number) => {
    if (ms === 1000) timeoutStarted = Date.now();
    return original(ms);
  }) as typeof AbortSignal.timeout;
  try {
    f.enqueue("Delayed discovery");
    await new Worker({
      origin: f.origin,
      token: "synthetic-token",
      system: "Coach",
      modelMs: 1000,
      complete: async (_context, _signal, _system, _tools, _ref, budget) => {
        discoveryElapsed = Date.now() - timeoutStarted;
        observedDeadline = budget?.deadlineAt ?? 0;
        return "Bounded reply";
      },
    }).pollOnce();
    assert.equal(f.publications, 1);
    assert.ok(timeoutStarted);
    assert.ok(discoveryElapsed >= 70);
    assert.ok(observedDeadline <= timeoutStarted + 1010);
  } finally {
    AbortSignal.timeout = original;
    await f.close();
  }
});

test("stop fences a non-cooperative late model and settles promptly without publishing", async () => {
  const f = await fixture();
  let enter!: () => void;
  const entered = new Promise<void>((r) => (enter = r));
  let finish!: (s: string) => void;
  const worker = new Worker({
    origin: f.origin,
    token: "synthetic-token",
    system: "Coach",
    complete: async () => {
      enter();
      return new Promise<string>((r) => (finish = r));
    },
  });
  try {
    f.enqueue("Cancel me");
    const pending = worker.pollOnce();
    pending.catch(() => {});
    await entered;
    await Promise.race([
      worker.stop(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("stop did not settle")), 200),
      ),
    ]);
    finish("Late response");
    await pending.catch(() => {});
    assert.equal(f.publications, 0);
  } finally {
    finish?.("Late");
    await worker.stop();
    await f.close();
  }
});

test("context attachments fail closed before inference", async () => {
  const f = await fixture();
  let called = false;
  try {
    f.enqueue("photo");
    f.current.attachment_count = 1;
    const w = new Worker({
      origin: f.origin,
      token: "synthetic-token",
      system: "Coach",
      complete: async () => {
        called = true;
        return "no";
      },
    });
    await assert.rejects(w.pollOnce(), /CONTEXT_REJECTED/);
    assert.equal(called, false);
    assert.equal(f.publications, 0);
  } finally {
    await f.close();
  }
});
test("expired original timeout is never reset by claiming or reconnecting", async () => {
  const f = await fixture();
  try {
    f.enqueue("stale");
    f.current.timeout_at = new Date(0).toISOString();
    const w = new Worker({
      origin: f.origin,
      token: "synthetic-token",
      system: "Coach",
      complete: async () => {
        throw new Error("must not run");
      },
    });
    await assert.rejects(w.pollOnce(), /LEASE_EXPIRED/);
    assert.equal(f.publications, 0);
  } finally {
    await f.close();
  }
});
test("duplicate concurrent poll is one claim and publication", async () => {
  const f = await fixture();
  try {
    f.enqueue("once");
    const w = new Worker({
      origin: f.origin,
      token: "synthetic-token",
      system: "Coach",
      complete: async () => "one",
    });
    await Promise.all([w.pollOnce(), w.pollOnce(), w.pollOnce()]);
    assert.equal(f.publications, 1);
    assert.equal(f.calls.filter((c) => c === "coach_claim_request").length, 1);
  } finally {
    await f.close();
  }
});

test("ambiguous publication is never failed or republished after restart", async () => {
  const f = await fixture({ dropReply: true });
  try {
    f.enqueue("once");
    const make = () =>
      new Worker({
        origin: f.origin,
        token: "synthetic-token",
        system: "Coach",
        complete: async () => "Persisted before disconnect",
      });
    await assert.rejects(make().pollOnce());
    assert.equal(f.publications, 1);
    assert.equal(f.calls.includes("coach_fail_request"), false);
    await make().pollOnce();
    assert.equal(f.publications, 1);
  } finally {
    await f.close();
  }
});
test("mismatched lease generation rejects context before model invocation", async () => {
  const f = await fixture({ rejectFence: true });
  try {
    f.enqueue("stale claim");
    let calls = 0;
    const w = new Worker({
      origin: f.origin,
      token: "synthetic-token",
      system: "Coach",
      complete: async () => {
        calls++;
        return "no";
      },
    });
    await assert.rejects(w.pollOnce(), /CONTEXT_REJECTED/);
    assert.equal(calls, 0);
    assert.equal(f.publications, 0);
  } finally {
    await f.close();
  }
});
test("actual Pi adapter connects authorized context to persisted synthetic-backend reply and followup", async () => {
  const { complete } = await import("../src/runtime/piAdapter.js");
  const f = await fixture();
  const observed: string[] = [];
  const model = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const b = JSON.parse(raw);
    observed.push(JSON.stringify(b.messages.at(-1).content));
    res.setHeader("Content-Type", "text/event-stream");
    res.end(
      "data: " +
        JSON.stringify({
          id: "model",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: "Synthetic Pi coaching feedback",
              },
              finish_reason: null,
            },
          ],
        }) +
        "\n\ndata: " +
        JSON.stringify({
          id: "model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
  try {
    const make = () =>
      new Worker({
        origin: f.origin,
        token: "synthetic-token",
        system: "Coach",
        complete: (context, signal, system) =>
          complete(
            {
              baseUrl: `http://127.0.0.1:${(model.address() as any).port}/v1`,
              model: "synthetic",
              apiKey: "synthetic-key",
            },
            system,
            context,
            signal,
          ),
      });
    f.enqueue("Review my run");
    await make().pollOnce();
    assert.equal(f.history[1].text, "Synthetic Pi coaching feedback");
    f.enqueue("More detail");
    await make().pollOnce();
    assert.ok(observed[1].includes("Synthetic Pi coaching feedback"));
    assert.equal(f.publications, 2);
  } finally {
    model.closeAllConnections();
    await new Promise((r) => model.close(r));
    await f.close();
  }
});

test("worker offers negotiated media only inside claimed request budget", async () => {
  const f = await fixture({ data: true });
  let exposed: any;
  try {
    f.enqueue("original photo");
    f.current.attachment_count = 1;
    const w = new Worker({
      origin: f.origin,
      token: "synthetic-token",
      system: "Coach",
      vision: true,
      complete: async (context, signal, system, tools) => {
        exposed = tools;
        assert.ok(context.includes("Request data capabilities"));
        return "Synthetic authorized image reply";
      },
    });
    await w.pollOnce();
    assert.deepEqual(
      exposed.map((t: any) => t.name),
      ["coach_read_media"],
    );
    assert.equal(f.publications, 1);
    const callCount = f.calls.length;
    await assert.rejects(
      exposed[0].execute("late", { media_ref: "opaque-original" }),
      /READ_UNAVAILABLE/,
    );
    assert.equal(f.calls.length, callCount);
  } finally {
    await f.close();
  }
});
test("request model deadline fences a non-cooperative completion without publication", async () => {
  const f = await fixture();
  let finish: ((text: string) => void) | undefined;
  const worker = new Worker({
    origin: f.origin,
    token: "synthetic-token",
    system: "Coach",
    modelMs: 30,
    complete: async () =>
      new Promise<string>((r) => {
        finish = r;
      }),
  });
  try {
    f.enqueue("Timeout proof");
    await assert.rejects(worker.pollOnce(), /CANCELLED|Timeout|abort/i);
    finish?.("Late ignored response");
    assert.equal(f.publications, 0);
    assert.equal(f.current.status, "failed");
  } finally {
    finish?.("Late");
    await worker.stop();
    await f.close();
  }
});

test("safe worker failure reaches fenced backend and Studio logs survives idle", async () => {
  const { SafeError } = await import("../src/runtime/errors.js");
  const f = await fixture();
  const dir = await mkdtemp(tmpdir() + "/coach-worker-logs-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
    apiKey: "synthetic-provider",
  });
  f.enqueue("PRIVATE question");
  const app = await admin(store, 0, async () => {
    throw new SafeError("PROVIDER_CONTEXT_LIMIT", { status: 400 });
  });
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  try {
    await fetch(app.origin + "/api/run", {
      method: "POST",
      headers,
      body: "{}",
    });
    for (let i = 0; i < 200 && f.current.status !== "failed"; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(f.current.failure.code, "PROVIDER_CONTEXT_LIMIT");
    assert.match(f.current.failure.message, /context window/);
    assert.equal(f.current.failure.lease_generation, 1);
    const logs = await (
      await fetch(app.origin + "/api/logs", { headers })
    ).json();
    assert.ok(
      logs.entries.some(
        (e: any) => e.stage === "context-read" && e.metadata.bytes > 0,
      ),
    );
    const failed = logs.entries.find((e: any) => e.stage === "request-failed");
    assert.equal(failed.code, "PROVIDER_CONTEXT_LIMIT");
    assert.ok(failed.ref);
    assert.ok(!JSON.stringify(logs).includes("PRIVATE"));
    // The default backoff is 10s; test direct idle transition separately below.
    const events: any[] = [];
    const worker = new Worker({
      origin: f.origin,
      token: "synthetic-token",
      system: "Coach",
      complete: async () => {
        throw new SafeError("PROVIDER_AUTH_FAILED");
      },
      onDiagnostic: (e) => events.push(e),
    });
    f.enqueue("Second question");
    await assert.rejects(worker.pollOnce());
    await worker.pollOnce();
    await worker.pollOnce();
    assert.equal(worker.state, "idle");
    assert.equal(worker.lastError?.code, "PROVIDER_AUTH_FAILED");
    assert.equal(events.filter((e) => e.stage === "idle").length, 1);
    await worker.stop();
  } finally {
    await app.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("real Pi provider rejection is correlated through worker backend failure and authenticated logs", async () => {
  const f = await fixture();
  const dir = await mkdtemp(tmpdir() + "/coach-wire-diagnostics-");
  const provider = createServer((req, res) => {
    req.resume();
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          code: "insufficient_quota",
          message: "PRIVATE upstream echoed context",
        },
      }),
    );
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
    apiKey: "synthetic-key",
    provider: {
      baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
      model: "synthetic",
    },
  });
  const app = await admin(store, 0);
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  try {
    f.enqueue("x".repeat(60000));
    await fetch(app.origin + "/api/run", {
      method: "POST",
      headers,
      body: "{}",
    });
    for (let i = 0; i < 200 && f.current.status !== "failed"; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(f.current.failure.code, "PROVIDER_QUOTA_EXCEEDED");
    const data = await (
      await fetch(app.origin + "/api/logs", { headers })
    ).json();
    const failure = data.entries.find((e: any) => e.stage === "request-failed");
    const payload = data.entries.find(
      (e: any) => e.stage === "provider-payload",
    );
    assert.ok(payload, "actual serialized provider payload metadata is logged");
    assert.equal(payload.ref, failure.ref);
    assert.ok(payload.metadata.bytes > 60000);
    assert.equal(payload.metadata.limit, 1048576);
    assert.equal(payload.metadata.totalLimit, 50331648);
    assert.equal(failure.metadata.status, 429);
    assert.ok(!JSON.stringify(data).includes("PRIVATE"));
  } finally {
    await app.close();
    await f.close();
    provider.closeAllConnections();
    await new Promise<void>((r) => provider.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

for (const mismatch of ["code", "generation"] as const) {
  test(`failure readback ${mismatch} mismatch is warning, not confirmed failure`, async () => {
    const f = await fixture({ failureMismatch: mismatch });
    const events: any[] = [];
    const worker = new Worker({
      origin: f.origin,
      token: "synthetic-token",
      system: "Coach",
      complete: async () => {
        throw new Error("MODEL_FAILED");
      },
      onDiagnostic: (e) => events.push(e),
    });
    try {
      f.enqueue("Synthetic failure");
      await assert.rejects(worker.pollOnce(), /MODEL_FAILED/);
      assert.equal(
        events.some((e) => e.stage === "failure-reported"),
        false,
      );
      assert.equal(
        events.find((e) => e.stage === "failure-report-unverified")?.level,
        "warn",
      );
    } finally {
      await worker.stop();
      await f.close();
    }
  });
}

test("claimed Dojo worker sees local tools; personal claim and later turn cannot reuse them", async () => {
  const backend = await fixture();
  const dir = await mkdtemp(tmpdir() + "/coach-mcp-worker-");
  const store = new Store(dir);
  await store.init();
  const local = new LocalMcp(store);
  const peer = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    if (input.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    const result =
      input.method === "tools/list"
        ? {
            tools: [
              {
                name: "change",
                description: "Fixture change",
                inputSchema: {
                  type: "object",
                  properties: {},
                  additionalProperties: false,
                },
              },
            ],
          }
        : { protocolVersion: "2025-03-26" };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
  });
  await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
  try {
    await local.add({
      label: "fixture",
      url: `http://127.0.0.1:${(peer.address() as any).port}/mcp`,
    });
    const seen: string[][] = [];
    const worker = new Worker({
      origin: backend.origin,
      token: "synthetic-token",
      system: "Coach",
      localMcp: local,
      complete: async (_context, _signal, _system, tools) => {
        seen.push(tools.map((tool) => tool.name));
        return "Synthetic reply";
      },
    });
    backend.enqueue("Dojo turn");
    await worker.pollOnce();
    assert.equal(seen[0].length, 1);
    assert.match(seen[0][0], /^local_mcp__/);
    backend.enqueue("Personal turn");
    backend.current.scope = "personal";
    await worker.pollOnce();
    assert.deepEqual(seen[1], []);
    await worker.stop();
  } finally {
    peer.closeAllConnections();
    await new Promise<void>((resolve) => peer.close(() => resolve()));
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  }
});
