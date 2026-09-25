import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { OperatorChat } from "../src/chat/operator.js";
import { admin } from "../src/server/admin.js";
import { operatorBackend } from "./operator-tools.test.js";
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
test("Cancel during final session close prevents committing a completed-model answer", async () => {
  const closing = deferred(),
    release = deferred();
  const f = await operatorBackend(async (name, result) => {
    if (name === "tools/list")
      result.tools.push({ name: "studio_operator_list_members" });
    if (name === "studio_operator_open_session") {
      result = {
        ...result,
        mode: "dojo_operator",
        allowed_tools: ["studio_operator_list_members"],
      };
      delete result.member_ref;
    }
    if (name === "studio_operator_close_session") {
      closing.resolve();
      await release.promise;
    }
    return result;
  });
  const dir = await mkdtemp(tmpdir() + "/operator-finalize-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
  });
  const chat = new OperatorChat(store, async () => "Completed-model answer");
  let turn: Promise<any> | undefined;
  try {
    turn = chat.turn("Discuss manager work");
    void turn.catch(() => {});
    await closing.promise;
    assert.deepEqual(
      chat.snapshot().messages,
      [],
      "no answer commits before final cleanup settles",
    );
    const cancel = chat.cancel();
    release.resolve();
    await cancel;
    await assert.rejects(turn, /CANCELLED/);
    assert.deepEqual(chat.snapshot().messages, []);
  } finally {
    release.resolve();
    await turn?.catch(() => {});
    await chat.cancel();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "HTTP disconnect during final close leaves no committed answer",
  { timeout: 5000 },
  async () => {
    const closing = deferred(),
      release = deferred();
    const f = await operatorBackend(async (name, result) => {
      if (name === "tools/list")
        result.tools.push({ name: "studio_operator_list_members" });
      if (name === "studio_operator_open_session") {
        result = {
          ...result,
          mode: "dojo_operator",
          allowed_tools: ["studio_operator_list_members"],
        };
        delete result.member_ref;
      }
      if (name === "studio_operator_close_session") {
        closing.resolve();
        await release.promise;
      }
      return result;
    });
    const dir = await mkdtemp(tmpdir() + "/operator-disconnect-finalize-");
    const store = new Store(dir);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin: f.origin,
      token: "synthetic-token",
    });
    const app = await admin(store, 0, async () => "Completed-model answer");
    const controller = new AbortController();
    const headers = {
      Authorization: "Bearer " + store.secrets.admin,
      Origin: app.origin,
      "Content-Type": "application/json",
    };
    const get = async (path: string) =>
      (await fetch(app.origin + path, { headers })).json();
    try {
      const response = await fetch(app.origin + "/api/operator/chat", {
        method: "POST",
        headers: {
          ...headers,
          Accept: "application/vnd.katafit.operator+json",
        },
        body: JSON.stringify({ text: "Discuss manager work" }),
        signal: controller.signal,
      });
      await response.body!.getReader().read();
      await closing.promise;
      assert.deepEqual((await get("/api/operator/chat")).messages, []);
      controller.abort();
      let cancelled = false;
      for (let i = 0; i < 50 && !cancelled; i++) {
        cancelled = (await get("/api/logs")).entries.some(
          (e: any) => e.code === "CANCELLED",
        );
        if (!cancelled) await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(cancelled, true);
      release.resolve();
      assert.deepEqual((await get("/api/operator/chat")).messages, []);
    } finally {
      controller.abort();
      release.resolve();
      await app.close();
      await f.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("Clear fences new turns until backend close settles and late model cannot restore history", async () => {
  const entered = deferred(),
    closing = deferred(),
    release = deferred(),
    reply = deferred<string>();
  const f = await operatorBackend(async (name, result) => {
    if (name === "tools/list")
      result.tools.push({ name: "studio_operator_list_members" });
    if (name === "studio_operator_open_session")
      result = {
        ...result,
        mode: "dojo_operator",
        allowed_tools: ["studio_operator_list_members"],
      };
    if (name === "studio_operator_open_session") delete result.member_ref;
    if (name === "studio_operator_close_session") {
      closing.resolve();
      await release.promise;
    }
    return result;
  });
  const dir = await mkdtemp(tmpdir() + "/operator-cancel-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
    apiKey: "synthetic-key",
  });
  const chat = new OperatorChat(store, async () => {
    entered.resolve();
    return reply.promise;
  });
  try {
    const turn = chat.turn("Discuss manager work");
    const failed = assert.rejects(turn);
    await entered.promise;
    const clear = chat.clear();
    await closing.promise;
    assert.equal(chat.active, true);
    await assert.rejects(chat.turn("new discussion"));
    release.resolve();
    await clear;
    await failed;
    reply.resolve("late sensitive data");
    await new Promise((r) => setImmediate(r));
    assert.equal(chat.active, false);
    assert.deepEqual(chat.snapshot().messages, []);
  } finally {
    release.resolve();
    reply.resolve("cleanup");
    await chat.cancel();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
