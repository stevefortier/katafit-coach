import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { Actions } from "../src/chat/actions.js";
import { operatorBackend } from "./operator-tools.test.js";

test("generic action identity and completed/unknown receipts survive restart without SEND reconciliation", async () => {
  const f = await operatorBackend();
  const dir = await mkdtemp(tmpdir() + "/operator-generic-receipts-");
  try {
    const store = new Store(dir);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin: f.origin,
      token: "synthetic-token",
    });
    const actions = new Actions(store);
    actions.save({
      session_id: "synthetic-session",
      idempotency_key: "completed-key",
      tool_name: "studio_operator_future_write",
      status: "completed",
      action_id: "canonical-action",
    } as any);
    actions.save({
      session_id: "synthetic-session",
      idempotency_key: "unknown-key",
      tool_name: "studio_operator_future_write",
      status: "pending",
    } as any);
    const restored = new Actions(store);
    await restored.reconcile();
    assert.deepEqual(
      restored.snapshot().map((a) => a.status),
      ["completed", "unknown"],
    );
    assert.equal(
      (restored.snapshot()[1] as any).tool_name,
      "studio_operator_future_write",
    );
    assert.equal(restored.snapshot()[1].idempotency_key, "unknown-key");
    assert.equal(
      f.calls.some((c) => c.params?.name === "studio_operator_get_action"),
      false,
    );
    assert.equal(
      f.calls.some((c) => c.params?.name === "studio_operator_future_write"),
      false,
    );
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
