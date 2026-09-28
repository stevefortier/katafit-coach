import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/native.js";
import { NativeConversations } from "../src/sandbox/conversations.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";

const entries: any[] = [
  {
    type: "session",
    version: 3,
    id: "synthetic",
    timestamp: "2026-09-28T12:00:00Z",
    cwd: "/workspace",
  },
  {
    type: "message",
    id: "12345678",
    parentId: null,
    timestamp: "2026-09-28T12:00:01Z",
    message: {
      role: "user",
      content: "Remember the acquired ordinary REST context.",
      timestamp: 1,
    },
  },
  {
    type: "message",
    id: "23456789",
    parentId: "12345678",
    timestamp: "2026-09-28T12:00:02Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Acquired synthetic record retained." }],
      api: "openai-completions",
      provider: "katafit",
      model: "approved-custom-model",
      stopReason: "stop",
      timestamp: 2,
      usage: {
        input: 0,
        output: 0,
        totalTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
      },
    },
  },
];
test("ordinary native history survives credential rotation without MCP requests", async () => {
  const f = await fixture(() => ({
    isError: true,
    content: [{ type: "text", text: "OPERATOR_NOT_AUTHORIZED" }],
  }));
  let gateway: Awaited<ReturnType<typeof openNativeGateway>> | undefined;
  try {
    const history = new NativeConversations(f.store);
    const prepared = await history.prepare();
    gateway = await openNativeGateway(f.store);
    await history.bind(gateway, prepared);
    assert.ok(history.active);
    await history.capture(gateway, {
      entries,
      complete: true,
      imagesOmitted: false,
    });
    const id = history.active!.id;
    await history.finish(gateway);
    await gateway.close();
    gateway = undefined;
    const reopened = new NativeConversations(f.store);
    assert.equal((await reopened.read(id)).status, "authorized");
    const resumed = await reopened.prepare();
    assert.deepEqual(resumed.seed, entries);
    assert.equal(resumed.resume, undefined);
    assert.equal(f.calls.length, 0);
    await f.store.save({
      ...f.store.publicConfig(),
      token: "rotated-installation-token",
    });
    assert.equal((await reopened.read(id)).status, "authorized");
    assert.equal((await reopened.list()).sessions.length, 1);
    assert.deepEqual((await reopened.prepare()).seed, entries);
    assert.equal(f.calls.length, 0);
  } finally {
    await gateway?.close();
    await f.close();
  }
});
