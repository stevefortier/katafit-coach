import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { archiveFixture, archiveControls } from "./helpers/archive.js";
import { NativeTerminal } from "../src/server/terminal.js";
import type { NativeGateway } from "../src/sandbox/gateway.js";
import type { NativeRuntime } from "../src/sandbox/runtime.js";

class Terminal extends NativeTerminal {
  latest?: NativeGateway;
  protected async resolveImage() {
    return "sha256:" + "a".repeat(64);
  }
  protected createRuntime() {
    return {
      start: async (gateway: NativeGateway) => {
        this.latest = gateway;
      },
      attach: async () => {},
      stop: async () => {},
    } as unknown as NativeRuntime;
  }
  begin() {
    return (this as any).start();
  }
}
test("real host gateway seals structured history, Stop and service restart preserve authorized text and resume fresh execution without replay", async () => {
  const f = await archiveFixture();
  const server = createServer();
  let terminal = new Terminal(f.store, server, () => "http://127.0.0.1");
  try {
    await terminal.begin();
    await terminal.latest!.handle({
      kind: "provider",
      body: {
        model: "approved-custom-model",
        messages: [{ role: "user", content: "Synthetic first question" }],
        stream: true,
      },
    });
    assert.equal(typeof terminal.historyList, "function");
    const rows = await terminal.historyList();
    assert.equal(rows.sessions.length, 1);
    const id = rows.sessions[0].id;
    const before = await terminal.historyRead(id);
    assert.equal(before.status, "authorized");
    assert.match(JSON.stringify(before.entries), /Synthetic archived answer/);
    assert.ok(!JSON.stringify(before).includes("synthetic-backend-credential"));
    await terminal.stop();
    await terminal.close();
    terminal = new Terminal(f.store, server, () => "http://127.0.0.1");
    const reopened = await terminal.historyRead(id);
    assert.match(JSON.stringify(reopened.entries), /Synthetic first question/);
    const callsBefore = f.calls.filter(
      (c) => c.path === "/v1/chat/completions",
    ).length;
    await terminal.begin();
    assert.equal(
      f.calls.filter((c) => c.path === "/v1/chat/completions").length,
      callsBefore,
    );
    const catalog = await terminal.latest!.handle({ kind: "catalog" });
    assert.ok(catalog.history.entries.length >= 3);
    assert.equal(
      catalog.tools.some((t: any) => archiveControls.includes(t.name)),
      false,
    );
    assert.equal(f.named("studio_operator_resume_archive").length, 1);
    await terminal.stop();
    f.revoke();
    const denied = await terminal.historyRead(id);
    assert.equal(denied.status, "locked");
    assert.equal(denied.entries, undefined);
    assert.equal(JSON.stringify(denied).includes("Synthetic"), false);
    await terminal.historyDelete(id);
    assert.equal((await terminal.historyList()).sessions.length, 0);
  } finally {
    await terminal.close().catch(() => {});
    await f.close();
    server.close();
  }
});

test("a first provider failure still leaves a sealed read-only user turn, never an automatic retry on restart", async () => {
  const f = await archiveFixture({
    provider: (_body, _state, res) => {
      res.statusCode = 400;
      return "synthetic provider refusal";
    },
  });
  const server = createServer();
  const terminal = new Terminal(f.store, server, () => "http://127.0.0.1");
  try {
    await terminal.begin();
    await assert.rejects(
      terminal.latest!.handle({
        kind: "provider",
        body: {
          model: "approved-custom-model",
          messages: [
            { role: "user", content: "Synthetic failed first prompt" },
          ],
          stream: true,
        },
      }),
    );
    const id = (await terminal.historyList()).sessions[0].id;
    const view = await terminal.historyRead(id);
    assert.equal(view.status, "authorized");
    assert.match(JSON.stringify(view.entries), /Synthetic failed first prompt/);
    assert.equal(view.reason, "interrupted_turn");
  } finally {
    await terminal.close().catch(() => {});
    await f.close();
    server.close();
  }
});
test("expired resume budget preserves currently authorized history with explicit read-only fallback", async () => {
  const f = await archiveFixture();
  const server = createServer();
  const terminal = new Terminal(f.store, server, () => "http://127.0.0.1");
  try {
    await terminal.begin();
    await terminal.latest!.handle({
      kind: "provider",
      body: {
        model: "approved-custom-model",
        messages: [{ role: "user", content: "Synthetic budget history" }],
        stream: true,
      },
    });
    const id = (await terminal.historyList()).sessions[0].id;
    await terminal.stop();
    f.refuseResume("OPERATOR_BUDGET_EXHAUSTED");
    await assert.rejects(terminal.begin());
    const view = await terminal.historyRead(id);
    assert.equal(view.status, "authorized");
    assert.equal(view.reason, "resume_unavailable");
    assert.match(JSON.stringify(view.entries), /Synthetic budget history/);
  } finally {
    await terminal.close().catch(() => {});
    await f.close();
    server.close();
  }
});
test("selected older conversation remains the default after a controller restart", async () => {
  const { NativeConversations } = await import(
    "../src/sandbox/conversations.js"
  );
  const f = await archiveFixture();
  try {
    const history = new NativeConversations(f.store);
    const snapshot = {
      personaRevision: 1,
      skillsRevision: 1,
      model: "synthetic",
      prompt: "Synthetic",
      skills: [],
    };
    const first = await history.storage.create(snapshot);
    await history.storage.create(snapshot);
    await history.select(first.id);
    assert.equal(
      (await new NativeConversations(f.store).list()).selected,
      first.id,
    );
  } finally {
    await f.close();
  }
});
test("failed backend Delete keeps a content-free retry tombstone across restart", async () => {
  const { NativeConversations } = await import(
    "../src/sandbox/conversations.js"
  );
  const f = await archiveFixture();
  const server = createServer();
  const terminal = new Terminal(f.store, server, () => "http://127.0.0.1");
  try {
    await terminal.begin();
    await terminal.latest!.handle({
      kind: "provider",
      body: {
        model: "approved-custom-model",
        messages: [{ role: "user", content: "Synthetic delete history" }],
        stream: true,
      },
    });
    const id = (await terminal.historyList()).sessions[0].id;
    await terminal.close();
    const history = new NativeConversations(f.store);
    history.authority.delete = async () => {
      throw new Error("unavailable");
    };
    await history.delete(id);
    assert.equal([...f.archives.values()][0].deleted, false);
    const restarted = new NativeConversations(f.store);
    assert.equal((await restarted.list()).sessions.length, 0);
    assert.equal([...f.archives.values()][0].deleted, true);
  } finally {
    await terminal.close().catch(() => {});
    await f.close();
    server.close();
  }
});
