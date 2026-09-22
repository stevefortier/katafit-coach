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
import { createServer } from "node:http";
import { Store, compile } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { effectivePrompt } from "../src/runtime/prompt.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const policy = "# Kata.fit external Coach agent v1\nSynthetic policy";
async function fixture(infer: Parameters<typeof admin>[2]) {
  const dir = await mkdtemp(tmpdir() + "/operator-chat-");
  const paths: string[] = [];
  const backend = createServer((req, res) => {
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
    assert.ok(
      calls[0].system.includes(
        effectivePrompt(
          compile(f.store.publicConfig(), Object.values(f.store.secrets)),
          policy,
          Object.values(f.store.secrets),
        ),
      ),
    );
    assert.deepEqual(calls[0].tools, []);
    assert.match(calls[0].context.scope, /local operator/);
    assert.match(calls[0].context.authority, /no claimed request/);
    assert.match(calls[0].context.authority, /Settings/);
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
