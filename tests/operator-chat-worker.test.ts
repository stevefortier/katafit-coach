import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { fixture } from "./worker.test.js";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("actual worker processing and operator inference overlap with isolated context and independent stop", async () => {
  const backend = await fixture();
  const dir = await mkdtemp(tmpdir() + "/operator-worker-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: backend.origin,
    token: "synthetic-token",
    apiKey: "synthetic-provider-key",
  });
  const workerReady = deferred<void>();
  const operatorReady = deferred<void>();
  const workerReply = deferred<string>();
  const operatorReply = deferred<string>();
  let workerSignal!: AbortSignal;
  let operatorSignal!: AbortSignal;
  const app = await admin(
    store,
    0,
    async (_provider, _system, context, signal) => {
      const parsed = JSON.parse(context);
      if (parsed.scope === "local operator conversation") {
        assert.ok(!context.includes("Authorized running goal"));
        assert.ok(!context.includes("PRIVATE_MEMBER"));
        operatorSignal = signal;
        operatorReady.resolve();
        return operatorReply.promise;
      }
      assert.ok(context.includes("PRIVATE_MEMBER"));
      assert.ok(!context.includes("PRIVATE_OPERATOR"));
      workerSignal = signal;
      workerReady.resolve();
      return workerReply.promise;
    },
  );
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  const call = (path: string, body?: unknown) =>
    fetch(app.origin + path, {
      headers,
      ...(body === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(body) }),
    });
  try {
    backend.enqueue("PRIVATE_MEMBER");
    await call("/api/run", {});
    await workerReady.promise;
    const pending = call("/api/operator/chat", { text: "PRIVATE_OPERATOR" });
    void pending.catch(() => {});
    await operatorReady.promise;
    const status = await (await call("/api/status")).json();
    assert.equal(status.state, "working");
    assert.equal(status.operatorChat, true);
    assert.equal((await call("/api/stop", {})).status, 200);
    assert.equal(workerSignal.aborted, true);
    assert.equal(operatorSignal.aborted, false);
    workerReply.resolve("late worker");
    operatorReply.resolve("operator answer");
    assert.equal((await pending).status, 200);
    assert.equal(backend.publications, 0);
    assert.deepEqual(backend.history, []);
    const history = await (await call("/api/operator/chat")).json();
    assert.equal(history.messages.length, 2);
    assert.ok(!JSON.stringify(history).includes("PRIVATE_MEMBER"));
  } finally {
    workerReply.resolve("cleanup");
    operatorReply.resolve("cleanup");
    await app.close();
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  }
});
