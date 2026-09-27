import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { Client } from "../src/katafit/client.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";
import {
  startBackend,
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
      const { db, ObjectId, service } = backend;
      const chief = new ObjectId(),
        dojo = new ObjectId();
      await db.collection("users").insertOne({
        _id: chief,
        display_name: "Synthetic chief",
        timezone: "UTC",
      });
      await db.collection("dojos").insertOne({
        _id: dojo,
        chief_id: chief,
        external_coach_agent: { enabled: true },
      });
      await db.collection("dojo_members").insertOne({
        user_id: chief,
        dojo_id: dojo,
        role: "chief",
        joined_at: new Date(0),
      });
      const token = (
        await service.createCredential(String(chief), {
          scopes: [...service.DEFAULT_SCOPES, "history:read", "userdata:read"],
        })
      ).token;
      const client = new Client(
        backend.origin,
        token,
        new AbortController().signal,
      );
      await client.connect();
      const opened = await client.call("studio_operator_open_session", {
        mode: "dojo_operator",
        idempotency_key: "original",
        continuity_version: 1,
      });
      const capture = await client.call("studio_operator_record_interaction", {
        session_id: opened.session_id,
        turn_generation: 0,
        idempotency_key: "original-delivered",
        human_text: "I prefer brief morning reports.",
        assistant_text: "I will keep reports brief.",
      });
      await client.call("studio_operator_close_session", {
        session_id: opened.session_id,
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
      assert.equal(
        (await client.call("studio_memory_pending", {})).captures.length,
        0,
      );
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
