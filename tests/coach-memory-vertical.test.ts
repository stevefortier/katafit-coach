import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { Worker } from "../src/worker/runner.js";
import { fixture as workerFixture } from "./worker.test.js";
import { fixture as nativeFixture } from "./helpers/native.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";

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
      memories: store.memories.runtime({ host: backend.origin }),
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
        host: backend.origin,
        subject: { scope: "member", ref: "member-one" },
        kind: "preference",
        text: "Prefers morning workouts.",
        source: { type: "operator_correction", id: "user-supplied" },
      }),
      /MEMORY_AUTHORITY_UNAVAILABLE/,
    );

    const retain = await store.memories.retainWorkerInteraction({
      host: backend.origin,
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
      host: native.store.publicConfig().origin,
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
