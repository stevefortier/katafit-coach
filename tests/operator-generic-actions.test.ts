import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { Actions } from "../src/chat/actions.js";

test("retired generic Operator receipts survive restart without legacy reconciliation", async () => {
  const dir = await mkdtemp(tmpdir() + "/operator-generic-receipts-");
  try {
    const store = new Store(dir);
    await store.init();
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
    assert.equal("reconcile" in restored, false);
    assert.deepEqual(
      restored.snapshot().map((a) => a.status),
      ["completed", "pending"],
    );
    assert.equal(
      restored.snapshot()[1].tool_name,
      "studio_operator_future_write",
    );
    assert.equal(restored.snapshot()[1].idempotency_key, "unknown-key");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
