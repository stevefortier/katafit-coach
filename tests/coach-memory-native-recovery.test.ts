import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { AccountMemory } from "../src/memory/account.js";
import { startAccountBackend as startBackend } from "./helpers/account-backend.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";
import {
  startProvider,
  isExtraction,
  memoryBackendEnabled,
} from "./helpers/memory-backend.js";

test(
  "native gateway recovers original delivered interaction through real backend without replay",
  { skip: !memoryBackendEnabled, timeout: 60000 },
  async () => {
    const backend = await startBackend();
    const dir = await mkdtemp(tmpdir() + "/memory-native-recovery-");
    let gateway: Awaited<ReturnType<typeof openNativeGateway>> | undefined;
    const provider = await startProvider((body) =>
      isExtraction(body)
        ? JSON.stringify({
            proposals: [
              {
                kind: "preference",
                text: "Operator prefers brief morning reports.",
                confidence: 0.9,
                importance: 0.8,
              },
            ],
          })
        : "New turn reply.",
    );
    try {
      const { db, token } = backend;
      const client = new AccountMemory(
        backend.origin,
        token,
        AbortSignal.timeout(50000),
        [token],
      );
      const capture = await client.capture({
        idempotency_key: "original-delivered",
        human_text: "I prefer brief morning reports.",
        assistant_text: "I will keep reports brief.",
        tool_results: [],
        recalled: [],
      });
      const store = new Store(dir);
      await store.init();
      await store.save({
        ...store.publicConfig(),
        origin: backend.origin,
        token,
        apiKey: "synthetic-model-credential",
        provider: {
          baseUrl: provider.origin + "/v1",
          model: "synthetic-memory",
        },
      });
      gateway = await openNativeGateway(store);
      await gateway.handle({
        kind: "provider",
        body: {
          model: "synthetic-memory",
          messages: [{ role: "user", content: "A new unrelated turn." }],
        },
      });
      const deadline = Date.now() + 15000;
      while ((await client.pending()).captures.length) {
        assert.ok(Date.now() < deadline, "original capture recovery settles");
        await new Promise((r) => setTimeout(r, 50));
      }
      const extractions = provider.bodies.filter(isExtraction);
      assert.equal(extractions.length, 1);
      assert.match(
        JSON.stringify(extractions[0]),
        /I prefer brief morning reports/,
      );
      assert.doesNotMatch(
        JSON.stringify(extractions[0]),
        /A new unrelated turn/,
      );
      assert.equal(
        await db
          .collection("coach_memories")
          .countDocuments({ "provenance.capture_id": capture.capture_id }),
        1,
      );
      assert.equal((await client.pending()).captures.length, 0);
      await gateway.close();
      gateway = await openNativeGateway(store);
      await gateway.handle({
        kind: "provider",
        body: {
          model: "synthetic-memory",
          messages: [{ role: "user", content: "Another new turn." }],
        },
      });
      assert.equal(provider.bodies.filter(isExtraction).length, 1);
      assert.equal(
        await db.collection("studio_operator_actions").countDocuments(),
        0,
      );
      assert.equal(
        await db.collection("external_coach_requests").countDocuments(),
        0,
      );
    } finally {
      await gateway?.close();
      await provider.close();
      await backend.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
