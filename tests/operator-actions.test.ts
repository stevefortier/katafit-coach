import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Actions } from "../src/chat/actions.js";
import { Store } from "../src/config/store.js";
import { operatorBackend } from "./operator-tools.test.js";

test("durable receipt is monotonic under late ambiguous transport failure", async () => {
  const dir = await mkdtemp(tmpdir() + "/operator-journal-");
  const store = new Store(dir);
  await store.init();
  try {
    const actions = new Actions(store);
    const action = {
      session_id: "session",
      idempotency_key: "key",
      status: "delivered" as const,
      action_id: "action",
      message_id: "message",
    };
    actions.save(action);
    actions.save({ ...action, status: "unknown" });
    assert.equal(new Actions(store).snapshot()[0].status, "delivered");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("receipt retention rotates resolved entries without dropping uncertain actions", async () => {
  const dir = await mkdtemp(tmpdir() + "/operator-retention-");
  const store = new Store(dir);
  await store.init();
  try {
    const actions = new Actions(store);
    actions.save({
      session_id: "uncertain",
      idempotency_key: "pending-key",
      status: "unknown",
    });
    for (let i = 0; i < 45; i++) {
      actions.save({
        session_id: `session-${i}`,
        idempotency_key: `key-${i}`,
        status: "pending",
      });
      actions.save({
        session_id: `session-${i}`,
        idempotency_key: `key-${i}`,
        status: "delivered",
        action_id: `action-${i}`,
        message_id: `message-${i}`,
      });
    }
    const retained = new Actions(store).snapshot();
    assert.equal(retained.length, 20);
    assert.equal(retained[0].session_id, "uncertain");
    assert.equal(retained[0].status, "unknown");
    assert.equal(retained.at(-1)?.message_id, "message-44");
    assert.equal(
      retained.some((a) => a.session_id === "session-0"),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("journal fails closed rather than evicting unresolved receipts", async () => {
  const dir = await mkdtemp(tmpdir() + "/operator-unresolved-");
  const store = new Store(dir);
  await store.init();
  try {
    const actions = new Actions(store);
    for (let i = 0; i < 20; i++)
      actions.save({
        session_id: `session-${i}`,
        idempotency_key: `key-${i}`,
        status: "unknown",
      });
    assert.throws(() =>
      actions.save({
        session_id: "new-session",
        idempotency_key: "new-key",
        status: "pending",
      }),
    );
    assert.deepEqual(new Actions(store).snapshot(), actions.snapshot());
    assert.equal(actions.snapshot().length, 20);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restart reconciles pending stable key without resend; credential replacement hides old receipts", async () => {
  const f = await operatorBackend((name, result) =>
    name === "studio_operator_get_action"
      ? {
          schema_version: 1,
          session_id: "session-fixture",
          action_id: "a",
          message_id: "m",
          status: "delivered",
          idempotent: true,
        }
      : result,
  );
  const dir = await mkdtemp(tmpdir() + "/operator-recovery-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
    apiKey: "synthetic-key",
  });
  try {
    new Actions(store).save({
      session_id: "session-fixture",
      idempotency_key: "original-key",
      status: "pending",
    });
    const restarted = new Actions(store);
    await restarted.reconcile();
    assert.equal(restarted.snapshot()[0].status, "delivered");
    assert.equal(
      f.calls.filter((c) => c.params?.name === "studio_operator_send_message")
        .length,
      0,
    );
    assert.equal(
      f.calls.find((c) => c.params?.name === "studio_operator_get_action")
        .params.arguments.idempotency_key,
      "original-key",
    );
    store.secrets.token = "replacement-fixture";
    assert.deepEqual(restarted.snapshot(), []);
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
