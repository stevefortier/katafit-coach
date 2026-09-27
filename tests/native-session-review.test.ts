import { Actions } from "../src/chat/actions.js";
import test from "node:test";
import assert from "node:assert/strict";
import { archiveFixture } from "./helpers/archive.js";
import { NativeConversations } from "../src/sandbox/conversations.js";
import { captureNativeExchange } from "../src/sandbox/sessionCapture.js";
import type { NativeGateway } from "../src/sandbox/gateway.js";

const sessionId = "b".repeat(64);
const identity = (revision: number, digest: string) => ({
  archive_id: "a".repeat(64),
  archive_revision: revision,
  transcript_digest: digest,
});
const capture = () =>
  captureNativeExchange(
    { model: "synthetic", messages: [{ role: "user", content: "original" }] },
    JSON.stringify({
      choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
    }),
    "application/json",
  )!;
async function setup() {
  const f = await archiveFixture();
  const history = new NativeConversations(f.store);
  const gateway = {
    historyState: () => ({ supported: true, sessionId, generation: 0 }),
    sealHistory: async (r: number, d: string) => identity(r, d),
  } as unknown as NativeGateway;
  history.authority.call = async (_name, input: any) => ({
    schema_version: 1,
    ...identity(input.archive_revision, input.transcript_digest),
    status: "sealed",
  });
  history.authority.authorize = async () => {};
  await history.bind(gateway, {});
  return { f, history, gateway, id: history.active!.id };
}

test("L6 updater root rollback then revision reuse cannot resume a different compiled persona", async () => {
  const { readFile, writeFile } = await import("node:fs/promises");
  const { Store } = await import("../src/config/store.js");
  const f = await archiveFixture();
  try {
    const path = f.store.dir + "/config.json";
    const before = await readFile(path);
    await f.store.save({
      ...f.store.publicConfig(),
      persona: { ...f.store.publicConfig().persona, name: "Snapshot persona" },
    });
    const history = new NativeConversations(f.store);
    const gateway = {
      historyState: () => ({ supported: true, sessionId, generation: 0 }),
      sealHistory: async (r: number, d: string) => identity(r, d),
    } as unknown as NativeGateway;
    await history.bind(gateway, {});
    const id = history.active!.id;
    await history.capture(gateway, capture());
    await history.finish();
    const snapshot = (await history.storage.loadForHost(id)).snapshot;
    // Exactly the supervisor's root-file restoration class, not a Store API rollback.
    await writeFile(path, before);
    const restored = new Store(f.store.dir);
    await restored.init();
    assert.equal(
      restored.publicConfig().revision,
      snapshot.personaRevision - 1,
    );
    await restored.save({
      ...restored.publicConfig(),
      persona: {
        ...restored.publicConfig().persona,
        name: "Different reused persona",
      },
    });
    assert.equal(restored.publicConfig().revision, snapshot.personaRevision);
    const restarted = new NativeConversations(restored);
    restarted.authority.authorize = async () => {};
    assert.equal((await restarted.read(id)).reason, "settings_changed");
    await assert.rejects(restarted.prepare(), /NATIVE_HISTORY_READ_ONLY/);
  } finally {
    await f.close();
  }
});

for (const field of ["model", "prompt", "skills"] as const) {
  test(`L6 reused revisions with changed ${field} content stay read-only`, async () => {
    const { f, history, gateway, id } = await setup();
    try {
      // Simulate root settings rollback/reuse: the frozen snapshot belongs to
      // another content version at the very same current revision numbers.
      await history.storage.change(id, (row) => {
        if (field === "skills") row.snapshot.skills[0].body += " changed";
        else row.snapshot[field] += " changed";
      });
      await history.capture(gateway, capture());
      await history.finish();
      const original = history.authority.call;
      history.authority.call = async (name, args: any) =>
        name === "studio_operator_close_session"
          ? { schema_version: 1, session_id: args.session_id, status: "closed" }
          : original(name, args);
      assert.equal((await history.read(id)).reason, "settings_changed");
      await assert.rejects(history.prepare(), /NATIVE_HISTORY_READ_ONLY/);
    } finally {
      await f.close();
    }
  });
}

test("M1 read recovering an in-flight seal does not discard provider result", async () => {
  const { f, history, gateway, id } = await setup();
  try {
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => (started = r)),
      gate = new Promise<void>((r) => (release = r));
    gateway.sealHistory = async (r, d) => {
      started();
      await gate;
      return identity(r, d);
    };
    const pending = history.capture(gateway, capture());
    await entered;
    assert.equal((await history.read(id)).status, "authorized");
    release();
    await pending;
  } finally {
    await f.close();
  }
});

test("M2 recovered successor first seal retires predecessor resume journal", async () => {
  const { f, history, gateway, id } = await setup();
  try {
    await history.capture(gateway, capture());
    await history.storage.change(id, (row) => {
      row.resume = {
        ...row.archive!,
        idempotency_key: "12345678-1234-1234-1234-123456789abc",
      };
      row.pendingSeal = {
        entries: row.entries,
        digest: row.archive!.transcript_digest,
        revision: 1,
        sessionId: "c".repeat(64),
        generation: 0,
      };
      row.execution!.sessionId = "c".repeat(64);
    });
    await history.read(id);
    assert.equal((await history.storage.loadForHost(id)).resume, undefined);
  } finally {
    await f.close();
  }
});

test("M4 unrelated unknown generic receipt does not block this predecessor resume", async () => {
  const { f, history, gateway } = await setup();
  try {
    await history.capture(gateway, capture());
    await history.finish();
    new Actions(f.store).recorder()({
      session_id: "d".repeat(64),
      idempotency_key: "synthetic-unrelated",
      tool_name: "synthetic_action",
      status: "unknown",
    });
    const original = history.authority.call;
    history.authority.call = async (name, args: any) =>
      name === "studio_operator_close_session"
        ? { schema_version: 1, session_id: args.session_id, status: "closed" }
        : original(name, args);
    assert.ok((await history.prepare()).resume);
  } finally {
    await f.close();
  }
});

test("M4 prior-turn delivery is not the predecessor current delivered action", async () => {
  const { f, history, gateway } = await setup();
  try {
    gateway.historyState = () =>
      ({ supported: true, sessionId, generation: 1 }) as any;
    await history.capture(gateway, capture());
    await history.finish();
    new Actions(f.store).recorder()({
      session_id: sessionId,
      idempotency_key: "old-turn",
      status: "delivered",
      action_id: "e".repeat(64),
      message_id: "f".repeat(64),
      turn_generation: 0,
    } as any);
    const original = history.authority.call;
    history.authority.call = async (name, args: any) =>
      name === "studio_operator_close_session"
        ? { schema_version: 1, session_id: args.session_id, status: "closed" }
        : original(name, args);
    assert.equal(
      (await history.prepare()).resume?.resolved_action_id,
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("L3 deletion reconciles the first lost seal ACK before backend deletion", async () => {
  const { f, history, gateway, id } = await setup();
  try {
    gateway.sealHistory = async () => {
      throw new Error("lost ACK");
    };
    await assert.rejects(history.capture(gateway, capture()));
    await history.finish();
    const deleted: string[] = [];
    history.authority.delete = async (id) => {
      deleted.push(id);
    };
    await history.delete(id);
    assert.deepEqual(deleted, ["a".repeat(64)]);
  } finally {
    await f.close();
  }
});

test("M3 prepare durably records definite revocation", async () => {
  const { f, history, gateway, id } = await setup();
  try {
    await history.capture(gateway, capture());
    await history.finish();
    history.authority.authorize = async () => {
      throw Object.assign(new Error("denied"), { contextRevoked: true });
    };
    await assert.rejects(history.prepare());
    assert.equal(
      (await history.storage.loadForHost(id)).blocked,
      "authority_revoked",
    );
  } finally {
    await f.close();
  }
});
