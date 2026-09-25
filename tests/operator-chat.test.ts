import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  stat,
  readFile,
  writeFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, request } from "node:http";
import { Store, compileOperator } from "../src/config/store.js";
import { Actions } from "../src/chat/actions.js";
import { admin } from "../src/server/admin.js";
import { effectivePrompt, operatorPolicy } from "../src/runtime/prompt.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const policy =
  "# Kata.fit external Coach agent v1\n## Member worker\nAnswer the trainee's training goal only.\n## Chief-manager operator sessions and human Studio\nThe operator is the Coach's manager, not a trainee.\n## Another worker section\nNever share this worker-only instruction.";
test("operator instructions reject a missing or empty chief-manager contract", () => {
  assert.throws(
    () =>
      operatorPolicy(
        "# Kata.fit external Coach agent v1\n## Required worker loop\nDo work",
      ),
    /CONTRACT_UNSUPPORTED/,
  );
  assert.throws(
    () =>
      operatorPolicy(
        "# Kata.fit external Coach agent v1\n## Chief-manager operator sessions and human Studio\n\n## Connect",
      ),
    /CONTRACT_UNSUPPORTED/,
  );
});
async function fixture(infer: Parameters<typeof admin>[2]) {
  const dir = await mkdtemp(tmpdir() + "/operator-chat-");
  const paths: string[] = [];
  const backend = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/agents/coach/mcp") {
      let raw = "";
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result:
            body.method === "initialize"
              ? { protocolVersion: "2025-03-26" }
              : { tools: [] },
        }),
      );
      return;
    }
    paths.push(req.url!);
    res.end(policy);
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(backend.address() as any).port}`,
    token: "synthetic-token",
    apiKey: "synthetic-provider-key",
  });
  let app = await admin(store, 0, infer);
  const headers = () => ({
    Authorization: "Bearer " + store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  });
  const call = (path: string, body?: unknown) =>
    fetch(app.origin + path, {
      headers: headers(),
      ...(body === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(body) }),
    });
  return {
    dir,
    store,
    paths,
    call,
    headers,
    get origin() {
      return app.origin;
    },
    async restart() {
      await app.close();
      app = await admin(store, 0, infer);
    },
    async close() {
      await app.close();
      backend.closeAllConnections();
      await new Promise<void>((r) => backend.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("overlapping historical reconciliation never becomes a failed read's current action", async () => {
  const reconciling = deferred<void>(),
    releaseReconcile = deferred<void>(),
    inferEntered = deferred<void>(),
    releaseInfer = deferred<void>();
  const original = Actions.prototype.reconcile;
  const f = await fixture(async () => {
    inferEntered.resolve();
    await releaseInfer.promise;
    throw new Error("READ_UNAVAILABLE");
  });
  const old = {
    session_id: "historical-session",
    idempotency_key: "historical-action",
    status: "pending" as const,
  };
  try {
    new Actions(f.store).save(old);
    await f.restart();
    Actions.prototype.reconcile = async function () {
      reconciling.resolve();
      await releaseReconcile.promise;
      this.save({ ...old, status: "unknown" });
    };
    const get = f.call("/api/operator/chat");
    await reconciling.promise;
    const post = f.call("/api/operator/chat", {
      text: "Read current evidence",
    });
    await inferEntered.promise;
    releaseReconcile.resolve();
    await get;
    releaseInfer.resolve();
    const result = await (await post).json();
    assert.equal(result.error, "READ_UNAVAILABLE");
    assert.equal(result.actions[0].status, "unknown");
    assert.deepEqual(result.turnActions, []);
  } finally {
    releaseReconcile.resolve();
    releaseInfer.resolve();
    Actions.prototype.reconcile = original;
    await f.close();
  }
});

test("failed read turn separates historical uncertain writes from this turn's receipts", async () => {
  const f = await fixture(async () => {
    throw new Error("READ_UNAVAILABLE");
  });
  try {
    new Actions(f.store).save({
      session_id: "old-session",
      idempotency_key: "old-write",
      status: "unknown",
    });
    await f.restart();
    const response = await f.call("/api/operator/chat", {
      text: "Compare Alex and Morgan",
    });
    const result = await response.json();
    assert.equal(result.error, "READ_UNAVAILABLE");
    assert.equal(result.actions[0].status, "unknown");
    assert.deepEqual(result.turnActions, []);
    assert.doesNotMatch(result.hint, /receipts/);
  } finally {
    await f.close();
  }
});

test("Operator inference diagnostics correlate with its Studio request", async () => {
  const f = await fixture(async (provider) => {
    provider.onDiagnostic?.({
      source: "provider",
      stage: "provider-payload",
      metadata: { turn: 1 },
      texts: [{ role: "tool", text: "Private synthetic member evidence" }],
      calls: [
        {
          name: "studio_operator_read_member_coach_feed",
          argumentKeys: ["member_ref"],
          arguments: '{"member_ref":"sensitive-member-ref"}',
        },
      ],
    });
    return "Synthetic answer";
  });
  try {
    await (
      await f.call("/api/operator/chat", { text: "Discuss coaching" })
    ).json();
    const logs = await (await f.call("/api/logs")).json();
    const events = logs.entries.filter(
      (e: any) => e.stage === "provider-payload",
    );
    assert.equal(
      events.length,
      1,
      "Operator must wire diagnostics, not just Worker",
    );
    assert.ok(events[0].ref);
    const stages = logs.entries
      .filter((e: any) => e.ref === events[0].ref)
      .map((e: any) => e.stage);
    assert.ok(stages.includes("connecting"));
    assert.ok(stages.includes("reads-ready"));
    assert.ok(stages.includes("inference"));
    const persisted = await readFile(f.dir + "/diagnostics.jsonl", "utf8");
    assert.doesNotMatch(
      persisted,
      /Private synthetic member evidence|sensitive-member-ref/,
    );
  } finally {
    await f.close();
  }
});

test(
  "streaming Operator disconnect still cancels inference and cannot publish a late answer",
  { timeout: 5000 },
  async () => {
    const entered = deferred<void>();
    const aborted = deferred<void>();
    const release = deferred<string>();
    const f = await fixture(async (_p, _s, _c, signal) => {
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve();
      return release.promise;
    });
    const controller = new AbortController();
    try {
      const response = await fetch(f.origin + "/api/operator/chat", {
        method: "POST",
        headers: {
          ...f.headers(),
          Accept: "application/vnd.katafit.operator+json",
        },
        body: JSON.stringify({ text: "Compare Alex and Morgan" }),
        signal: controller.signal,
      });
      await response.body!.getReader().read();
      await entered.promise;
      controller.abort();
      await aborted.promise;
      release.resolve("Late private answer");
      const snapshot = await (await f.call("/api/operator/chat")).json();
      assert.deepEqual(snapshot.messages, []);
      assert.equal(
        (await (await f.call("/api/status")).json()).operatorChat,
        false,
      );
    } finally {
      controller.abort();
      release.resolve("cleanup");
      await f.close();
    }
  },
);

test(
  "recurring Operator heartbeats survive a real idle-timeout HTTP proxy",
  { timeout: 30000 },
  async () => {
    let aborted = false;
    const f = await fixture(async (_p, _s, _c, signal) => {
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true },
      );
      await new Promise((r) => setTimeout(r, 22000));
      return "Verified delayed answer";
    });
    let chunks = 0;
    let timedOut = false;
    const proxy = createServer((req, res) => {
      const upstream = request(
        f.origin + req.url,
        {
          method: req.method,
          headers: { ...req.headers, host: new URL(f.origin).host },
        },
        (response) => {
          res.writeHead(response.statusCode!, response.headers);
          response.on("data", () => {
            chunks++;
          });
          response.pipe(res);
        },
      );
      upstream.setTimeout(12000, () => {
        timedOut = true;
        upstream.destroy();
        res.destroy();
      });
      upstream.on("error", () => res.destroy());
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    });
    try {
      await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
      const response = await fetch(
        `http://127.0.0.1:${(proxy.address() as any).port}/api/operator/chat`,
        {
          method: "POST",
          headers: {
            ...f.headers(),
            Accept: "application/vnd.katafit.operator+json",
          },
          body: JSON.stringify({ text: "Compare Alex and Morgan" }),
          signal: AbortSignal.timeout(28000),
        },
      );
      assert.equal((await response.json()).text, "Verified delayed answer");
      assert.ok(
        chunks >= 4,
        "initial byte, recurring heartbeats, and terminal result",
      );
      assert.equal(timedOut, false);
      assert.equal(aborted, false);
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((r) => proxy.close(() => r()));
      await f.close();
    }
  },
);

test("streaming Operator request receives bytes before inference completes and preserves terminal errors", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const f = await fixture(async () => {
    entered.resolve();
    await release.promise;
    throw new Error("PROVIDER_TIMEOUT");
  });
  try {
    const responsePromise = fetch(f.origin + "/api/operator/chat", {
      method: "POST",
      headers: {
        ...f.headers(),
        Accept: "application/vnd.katafit.operator+json",
      },
      body: JSON.stringify({
        text: "Tell me what you think about Alex vs Morgan",
      }),
      signal: AbortSignal.timeout(2000),
    });
    await entered.promise;
    const response = await responsePromise;
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.equal(Buffer.from(first.value!).toString().trim(), "");
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    release.resolve();
    let text = Buffer.from(first.value!).toString();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      text += Buffer.from(next.value).toString();
    }
    assert.equal(JSON.parse(text).error, "PROVIDER_TIMEOUT");
    assert.deepEqual(JSON.parse(text).actions, []);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("default Discussion photo request never borrows a member command session or invents visible images", async () => {
  const calls: any[] = [];
  const f = await fixture(
    async (_provider, _system, context, _signal, tools = []) => {
      calls.push({
        context: JSON.parse(context),
        tools: tools.map((t) => t.name),
      });
      return "I cannot fetch or show dojo check-in photos in Discussion until a dojo read-only backend session and image cards are available.";
    },
  );
  try {
    const response = await f.call("/api/operator/chat", {
      text: "Show me the latest check-in pictures of everyone in my dojo",
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.text, /cannot fetch or show/);
    assert.deepEqual(calls[0].tools, []);
    assert.match(calls[0].context.authority, /Operator session is unavailable/);
    assert.deepEqual(f.paths, ["/api/agents/coach.md"]);
    assert.deepEqual(body.images, []);
  } finally {
    await f.close();
  }
});

test("operator HTTP chat supplies explicit multi-turn local context and shared saved prompt, without remote mutations", async () => {
  const calls: any[] = [];
  const f = await fixture(
    async (provider, system, context, signal, tools = []) => {
      calls.push({ provider, system, context: JSON.parse(context), tools });
      return "Synthetic answer " + calls.length;
    },
  );
  try {
    assert.equal((await f.call("/api/operator/chat")).status, 200);
    const first = await f.call("/api/operator/chat", {
      text: "Discuss my coaching style",
    });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).text, "Synthetic answer 1");
    assert.equal(
      (await f.call("/api/operator/chat", { text: "Be more specific" })).status,
      200,
    );
    assert.deepEqual(calls[1].context.messages, [
      { role: "user", text: "Discuss my coaching style" },
      { role: "assistant", text: "Synthetic answer 1" },
      { role: "user", text: "Be more specific" },
    ]);
    assert.match(calls[0].system, /operator is your manager, not a trainee/);
    assert.match(calls[0].system, /Member data.*lower-trust/);
    assert.doesNotMatch(
      calls[0].system,
      /Only explicitly supplied request-scoped read tools are available\. No mutations/,
    );
    assert.match(calls[0].system, /backend-advertised session capabilities/i);
    assert.match(calls[0].system, /dojo.*trainees.*authorized/i);
    assert.match(
      calls[0].system,
      /do not demand (?:a|the) manager'?s training goal/i,
    );
    assert.doesNotMatch(
      calls[0].system,
      /Answer the trainee's training goal only/,
    );
    assert.doesNotMatch(
      calls[0].system,
      /Never share this worker-only instruction/,
    );
    assert.match(calls[0].system, /The operator is the Coach's manager/);
    assert.ok(
      calls[0].system.includes(
        effectivePrompt(
          compileOperator(
            f.store.publicConfig(),
            Object.values(f.store.secrets),
          ),
          "## Chief-manager operator sessions and human Studio\nThe operator is the Coach's manager, not a trainee.\n",
          Object.values(f.store.secrets),
        ),
      ),
    );
    assert.deepEqual(calls[0].tools, []);
    assert.match(calls[0].context.scope, /local operator/);
    assert.match(calls[0].context.authority, /no claimed request/);
    assert.match(calls[0].context.authority, /Operator session is unavailable/);
    assert.match(calls[0].system, /Settings/);
    assert.deepEqual(f.paths, ["/api/agents/coach.md", "/api/agents/coach.md"]);
    assert.equal(
      (await (await f.call("/api/operator/chat")).json()).messages.length,
      4,
    );
  } finally {
    await f.close();
  }
});

test("operator lifecycle independently guards turns, permits worker stop, fences cancel and clear late completions", async () => {
  let entered = deferred<void>();
  let reply = deferred<string>();
  const f = await fixture(async () => {
    entered.resolve();
    return reply.promise;
  });
  try {
    const pending = f.call("/api/operator/chat", { text: "first" });
    void pending.catch(() => {});
    await entered.promise;
    assert.equal(
      (await (await f.call("/api/status")).json()).operatorChat,
      true,
    );
    assert.equal(
      (await f.call("/api/operator/chat", { text: "overlap" })).status,
      409,
    );
    for (const path of [
      "/api/config",
      "/api/rollback",
      "/api/update/apply",
      "/api/update/check",
    ])
      assert.equal((await f.call(path, f.store.publicConfig())).status, 409);
    assert.equal((await f.call("/api/stop", {})).status, 200);
    assert.equal((await f.call("/api/operator/cancel", {})).status, 200);
    assert.equal((await pending).status, 400);
    const old = reply;
    entered = deferred<void>();
    reply = deferred<string>();
    const next = f.call("/api/operator/chat", { text: "second" });
    await entered.promise;
    old.resolve("stale reply");
    assert.equal(
      (await (await f.call("/api/status")).json()).operatorChat,
      true,
    );
    assert.equal((await f.call("/api/operator/clear", {})).status, 200);
    reply.resolve("late after clear");
    assert.equal((await next).status, 400);
    assert.deepEqual(
      (await (await f.call("/api/operator/chat")).json()).messages,
      [],
    );
    assert.equal(
      (await (await f.call("/api/status")).json()).operatorChat,
      false,
    );
  } finally {
    reply.resolve("cleanup");
    await f.close();
  }
});

test("operator validates input and secrets at every boundary including credential rotation", async () => {
  let output = "answer";
  let count = 0;
  const f = await fixture(async () => {
    count++;
    return output;
  });
  try {
    for (const body of [
      null,
      [],
      {},
      { text: "" },
      { text: " " },
      { text: 42 },
      { text: "x".repeat(8001) },
      { text: "hi", extra: true },
    ])
      assert.equal((await f.call("/api/operator/chat", body)).status, 400);
    assert.equal(count, 0);
    assert.equal(
      (await f.call("/api/operator/chat", { text: f.store.secrets.token }))
        .status,
      400,
    );
    assert.equal(count, 0);
    output = f.store.secrets.apiKey;
    assert.equal(
      (await f.call("/api/operator/chat", { text: "safe" })).status,
      400,
    );
    assert.deepEqual(
      (await (await f.call("/api/operator/chat")).json()).messages,
      [],
    );
    output = "potential-future-key";
    assert.equal(
      (await f.call("/api/operator/chat", { text: "safe" })).status,
      200,
    );
    assert.equal(
      (
        await f.call("/api/config", {
          ...f.store.publicConfig(),
          apiKey: output,
        })
      ).status,
      400,
    );
    assert.notEqual(f.store.secrets.apiKey, output);
    await f.call("/api/operator/clear", {});
    assert.equal(
      (
        await f.call("/api/config", {
          ...f.store.publicConfig(),
          apiKey: output,
        })
      ).status,
      200,
    );
    output = "";
    assert.equal(
      (await f.call("/api/operator/chat", { text: "safe" })).status,
      400,
    );
    output = "x".repeat(32001);
    assert.equal(
      (await f.call("/api/operator/chat", { text: "safe" })).status,
      400,
    );
    assert.deepEqual(
      (await (await f.call("/api/operator/chat")).json()).messages,
      [],
    );
  } finally {
    await f.close();
  }
});

test("operator failures remain safe and failed persistence never acknowledges a reply", async () => {
  let fail = true;
  const f = await fixture(async () => {
    if (fail) throw new Error("upstream PRIVATE_BODY");
    return "answer";
  });
  try {
    const rejected = await f.call("/api/operator/chat", { text: "safe" });
    assert.equal(rejected.status, 400);
    assert.ok(!(await rejected.text()).includes("PRIVATE_BODY"));
    fail = false;
    await writeFile(f.dir + "/target", "untouched");
    await symlink(f.dir + "/target", f.dir + "/operator-chat.json");
    assert.equal(
      (await f.call("/api/operator/chat", { text: "safe" })).status,
      400,
    );
    assert.deepEqual(
      (await (await f.call("/api/operator/chat")).json()).messages,
      [],
    );
    assert.equal(await readFile(f.dir + "/target", "utf8"), "untouched");
    await rm(f.dir + "/operator-chat.json");
    await f.call("/api/config", {
      ...f.store.publicConfig(),
      origin: f.origin,
    });
    const failed = await (
      await f.call("/api/operator/chat", { text: "safe" })
    ).json();
    assert.equal(failed.error, "BACKEND_INSTRUCTIONS_UNAVAILABLE");
  } finally {
    await f.close();
  }
});

test("operator HTTP rejects unauthenticated, cross-origin and malformed requests", async () => {
  const f = await fixture(async () => "answer");
  try {
    for (const path of [
      "/api/operator/chat",
      "/api/operator/cancel",
      "/api/operator/clear",
    ]) {
      assert.equal((await fetch(f.origin + path)).status, 401);
      assert.equal(
        (
          await fetch(f.origin + path, {
            method: "POST",
            headers: { ...f.headers(), Origin: "https://evil.test" },
            body: "{}",
          })
        ).status,
        403,
      );
      const { Origin, ...headers } = f.headers();
      assert.equal(
        (await fetch(f.origin + path, { method: "POST", headers, body: "{}" }))
          .status,
        403,
      );
    }
    assert.equal(
      (
        await fetch(f.origin + "/api/operator/chat", {
          method: "POST",
          headers: f.headers(),
          body: "{",
        })
      ).status,
      400,
    );
    assert.equal(
      (await f.call("/api/operator/chat")).headers.get("cache-control"),
      "no-store",
    );
  } finally {
    await f.close();
  }
});

test("shutdown fences noncooperative operator completion across restart", async () => {
  const entered = deferred<void>();
  const reply = deferred<string>();
  const f = await fixture(async () => {
    entered.resolve();
    return reply.promise;
  });
  try {
    const pending = f.call("/api/operator/chat", { text: "before shutdown" });
    void pending.catch(() => {});
    await entered.promise;
    await f.restart();
    reply.resolve("late shutdown reply");
    await pending.catch(() => {});
    assert.deepEqual(
      (await (await f.call("/api/operator/chat")).json()).messages,
      [],
    );
  } finally {
    reply.resolve("cleanup");
    await f.close();
  }
});

test("history is revalidated after out-of-band credential replacement", async () => {
  let text = "future-credential";
  const f = await fixture(async () => text);
  try {
    await f.call("/api/operator/chat", { text: "hello" });
    f.store.secrets.token = text;
    assert.equal((await f.call("/api/operator/chat")).status, 400);
    assert.equal(
      (await f.call("/api/operator/chat", { text: "next" })).status,
      400,
    );
    await f.restart();
    assert.equal((await f.call("/api/operator/chat")).status, 400);
    assert.equal((await f.call("/api/operator/clear", {})).status, 200);
    assert.deepEqual(
      (await (await f.call("/api/operator/chat")).json()).messages,
      [],
    );
  } finally {
    await f.close();
  }
});

test("private bounded successful history survives restart and clear is durable", async () => {
  const f = await fixture(async () => "answer");
  try {
    await f.call("/api/operator/chat", { text: "remember this" });
    await f.restart();
    assert.equal(
      (await (await f.call("/api/operator/chat")).json()).messages[0]?.text,
      "remember this",
    );
    assert.equal(
      (await stat(f.dir + "/operator-chat.json")).mode & 0o777,
      0o600,
    );
    for (let i = 0; i < 25; i++)
      assert.equal(
        (await f.call("/api/operator/chat", { text: "turn " + i })).status,
        200,
      );
    assert.equal(
      (await (await f.call("/api/operator/chat")).json()).messages.length,
      40,
    );
    assert.ok((await stat(f.dir + "/operator-chat.json")).size <= 131072);
    await f.call("/api/operator/clear", {});
    await f.restart();
    assert.deepEqual(
      (await (await f.call("/api/operator/chat")).json()).messages,
      [],
    );
  } finally {
    await f.close();
  }
});
