import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/config/store.js";
import { Worker } from "../src/worker/runner.js";
import { fixture as workerFixture } from "./worker.test.js";
import { fixture as nativeFixture } from "./helpers/native.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";

function memoryHost(store: Store) {
  const method = (store as any).memoryAuthority;
  return typeof method === "function"
    ? method.call(store)
    : store.publicConfig().origin;
}

test("memory store recovers an abandoned pid lock instead of deadlocking", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-memory-lock-");
  const store = new Store(dir);
  try {
    await store.init();
    await writeFile(
      join(dir, "memories.lock"),
      JSON.stringify({
        pid: 2147483646,
        created_at: new Date(Date.now() - 60000).toISOString(),
      }),
      { mode: 0o600 },
    );
    const entry = await store.memories.add({
      host: "synthetic-authority",
      subject: { scope: "boss" },
      kind: "preference",
      text: "Prefers lock recovery checks.",
      source: { type: "operator_correction", id: "synthetic-lock" },
    });
    assert.equal(entry.text, "Prefers lock recovery checks.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stale memory writers cannot resurrect a forgotten memory", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-memory-stale-");
  const first = new Store(dir);
  const stale = new Store(dir);
  try {
    await first.init();
    const entry = await first.memories.add({
      host: "synthetic-authority",
      subject: { scope: "boss" },
      kind: "preference",
      text: "Prefers stale writer fencing.",
      source: { type: "operator_correction", id: "synthetic-stale" },
    });
    await stale.init();
    await first.memories.forget(entry.id);
    await assert.rejects(
      stale.memories.update(entry.id, {
        text: "Prefers resurrected stale writes.",
        operator_note: "stale writer",
      }),
      /MEMORY_NOT_FOUND/,
    );
    const restarted = new Store(dir);
    await restarted.init();
    assert.equal(restarted.memories.list({ include_archived: true }).total, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker member memory fails closed without backend durable authority", async () => {
  const backend = await workerFixture();
  const dir = await mkdtemp(tmpdir() + "/coach-memory-worker-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: backend.origin,
    token: "synthetic-token",
    apiKey: "synthetic-provider-key",
  });
  const systems: string[] = [];
  const recallResults: string[] = [];
  const makeWorker = () =>
    new Worker({
      origin: backend.origin,
      token: "synthetic-token",
      system: "Coach",
      memories: store.memories.runtime({ host: memoryHost(store) }),
      complete: async (_context, _signal, system, tools) => {
        systems.push(system);
        const recall = tools.find(
          (tool) => tool.name === "coach_recall_memory",
        );
        if (recall) {
          const result = await recall.execute(
            "synthetic",
            { query: "morning workouts", scopes: ["member"] },
            AbortSignal.timeout(1000),
          );
          recallResults.push(result.content[0].text);
        }
        return "Synthetic response";
      },
    });
  try {
    backend.enqueue("Please remember that I prefer morning workouts.");
    backend.current.requester_id = "member-one";
    await makeWorker().pollOnce();
    assert.equal(
      store.memories.list({ subject_ref: "member-one" }).items.length,
      0,
    );
    assert.doesNotMatch(systems.at(-1) ?? "", /morning workouts/i);
    assert.match(recallResults.at(-1) ?? "", /authority_unavailable/i);
    assert.match(recallResults.at(-1) ?? "", /durable memory authority/i);

    backend.enqueue("What should I do today?");
    backend.current.requester_id = "member-one";
    await makeWorker().pollOnce();
    assert.doesNotMatch(systems.at(-1) ?? "", /morning workouts/i);
    await assert.rejects(
      store.memories.add({
        host: memoryHost(store),
        subject: { scope: "member", ref: "member-one" },
        kind: "preference",
        text: "Prefers morning workouts.",
        source: { type: "operator_correction", id: "user-supplied" },
      }),
      /MEMORY_AUTHORITY_UNAVAILABLE/,
    );

    const retain = await store.memories.retainWorkerInteraction({
      host: memoryHost(store),
      request: {
        id: "stale",
        lease_generation: 1,
        requester_id: "member-one",
        scope: "dojo",
        message: "Please remember that I prefer evening workouts.",
        created_at: new Date().toISOString(),
      },
      assistant: "stale extraction",
    });
    assert.deepEqual(retain, { stored: 0, status: "authority_unavailable" });
    assert.equal(
      store.memories.list({ subject_ref: "member-one" }).items.length,
      0,
    );
  } finally {
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("native Operator provider turns receive current boss memory without restart and can use recall tool", async () => {
  const native = await nativeFixture();
  try {
    await native.store.memories.add({
      host: memoryHost(native.store),
      subject: { scope: "boss" },
      kind: "preference",
      text: "Prefers concise summaries.",
      confidence: 0.9,
      importance: 0.9,
      relevance: 0.9,
      pinned: true,
      source: { type: "operator_correction", id: "synthetic-native" },
    });
    const gateway = await openNativeGateway(native.store);
    try {
      const catalog = await gateway.handle({ kind: "catalog" });
      assert.ok(
        catalog.tools.some((tool: any) => tool.name === "coach_recall_memory"),
      );
      await gateway.handle({
        kind: "provider",
        body: {
          model: "approved-custom-model",
          messages: [{ role: "user", content: "How should you answer me?" }],
        },
      });
      assert.match(
        JSON.stringify(
          native.calls.find((c) => c.path === "/v1/chat/completions")?.body,
        ),
        /concise summaries/i,
      );

      const remembered = await gateway.handle({
        kind: "tool",
        name: "coach_recall_memory",
        args: { query: "summary style", scopes: ["boss"] },
      });
      assert.match(JSON.stringify(remembered), /concise summaries/i);

      const item = native.store.memories.list({ scope: "boss" }).items[0];
      await native.store.memories.update(item.id, {
        text: "Prefers detailed tradeoff notes.",
        importance: 0.95,
        pinned: true,
        operator_note: "Synthetic native correction",
      });
      await gateway.handle({
        kind: "provider",
        body: {
          model: "approved-custom-model",
          messages: [
            { role: "user", content: "How should you answer me now?" },
          ],
        },
      });
      assert.match(
        JSON.stringify(
          native.calls.filter((c) => c.path === "/v1/chat/completions").at(-1)
            ?.body,
        ),
        /detailed tradeoff notes/i,
      );
      assert.doesNotMatch(
        JSON.stringify(
          native.calls.filter((c) => c.path === "/v1/chat/completions").at(-1)
            ?.body,
        ),
        /concise summaries/i,
      );
    } finally {
      await gateway.close();
    }
  } finally {
    await native.close();
  }
});

test("same-origin backend credential rotation hides prior local boss memories", async () => {
  const native = await nativeFixture();
  try {
    await native.store.memories.add({
      host: memoryHost(native.store),
      subject: { scope: "boss" },
      kind: "fact",
      text: "Old owner prefers predecessor-only briefings.",
      importance: 0.95,
      relevance: 0.95,
      source: { type: "operator_correction", id: "synthetic-old-owner" },
    });
    await native.store.save({
      ...native.store.publicConfig(),
      token: "replacement-backend-credential",
    });
    const gateway = await openNativeGateway(native.store);
    try {
      await gateway.handle({
        kind: "provider",
        body: {
          model: "approved-custom-model",
          messages: [{ role: "user", content: "What local memory applies?" }],
        },
      });
      assert.doesNotMatch(
        JSON.stringify(
          native.calls.filter((c) => c.path === "/v1/chat/completions").at(-1)
            ?.body,
        ),
        /predecessor-only briefings/i,
      );
    } finally {
      await gateway.close();
    }
  } finally {
    await native.close();
  }
});

test("forget tears down a native runtime that already saw that memory", async () => {
  const native = await nativeFixture();
  const terminated: string[] = [];
  try {
    const entry = await native.store.memories.add({
      host: memoryHost(native.store),
      subject: { scope: "boss" },
      kind: "preference",
      text: "Prefers runtime teardown after forget.",
      importance: 0.95,
      relevance: 0.95,
      source: { type: "operator_correction", id: "synthetic-forget" },
    });
    const gateway = await openNativeGateway(native.store, undefined, {
      onTerminate: (reason) => terminated.push(reason),
    });
    try {
      await gateway.handle({
        kind: "provider",
        body: {
          model: "approved-custom-model",
          messages: [{ role: "user", content: "Prime memory context." }],
        },
      });
      assert.match(
        JSON.stringify(
          native.calls.filter((c) => c.path === "/v1/chat/completions").at(-1)
            ?.body,
        ),
        /runtime teardown after forget/i,
      );
      await native.store.memories.forget(entry.id);
      await assert.rejects(
        gateway.handle({
          kind: "provider",
          body: {
            model: "approved-custom-model",
            messages: [{ role: "user", content: "Use anything remembered." }],
          },
        }),
        /NATIVE_SESSION_REVOKED/,
      );
      assert.deepEqual(terminated, ["MEMORY_FORGOTTEN"]);
    } finally {
      await gateway.close();
    }
  } finally {
    await native.close();
  }
});
