import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { OperatorChat } from "../src/chat/operator.js";
import { operatorBackend } from "./operator-tools.test.js";
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
test("Clear fences new turns until backend close settles and late model cannot restore history", async () => {
  const entered = deferred(),
    closing = deferred(),
    release = deferred(),
    reply = deferred<string>();
  const f = await operatorBackend(async (name, result) => {
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
    const turn = chat.turn("Discuss selected member", "member-fixture");
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
