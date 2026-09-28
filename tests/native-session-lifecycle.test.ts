import { answer, toolCall } from "./helpers/continuity.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { continuityFixture } from "./helpers/continuity.js";
import { archiveFixture, archiveControls } from "./helpers/archive.js";
import { NativeTerminal } from "./helpers/legacy-terminal.js";
import type { NativeGateway } from "../src/sandbox/gateway.js";
import type { NativeRuntime } from "../src/sandbox/runtime.js";

import { NativeConversations } from "../src/sandbox/conversations.js";
import { captureNativeExchange } from "../src/sandbox/sessionCapture.js";

test("lost seal ACK is retried exactly before a new live checkpoint", async () => {
  const f = await archiveFixture();
  try {
    const history = new NativeConversations(f.store);
    const seals: any[] = [];
    let lose = true;
    const receipt = (revision: number, digest: string) => ({
      schema_version: 1,
      archive_id: "a".repeat(64),
      archive_revision: revision,
      transcript_digest: digest,
      status: "sealed",
    });
    const gateway = {
      historyState: () => ({
        supported: true,
        sessionId: "b".repeat(64),
        generation: 0,
      }),
      sealHistory: async (revision: number, digest: string) => {
        seals.push({ revision, digest });
        if (lose) {
          lose = false;
          throw new Error("lost ACK");
        }
        return {
          archive_id: "a".repeat(64),
          archive_revision: revision,
          transcript_digest: digest,
        };
      },
    } as unknown as NativeGateway;
    await history.bind(gateway, {});
    const first = captureNativeExchange(
      { model: "synthetic", messages: [{ role: "user", content: "first" }] },
      JSON.stringify({
        choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
      }),
      "application/json",
    )!;
    await assert.rejects(history.capture(gateway, first), /lost ACK/);
    const pending = (await history.storage.loadForHost(history.active!.id))
      .pendingSeal!;
    history.authority.call = async (_name, input: any) => {
      assert.equal(input.archive_revision, pending.revision);
      assert.equal(input.transcript_digest, pending.digest);
      seals.push({
        revision: input.archive_revision,
        digest: input.transcript_digest,
      });
      return receipt(input.archive_revision, input.transcript_digest);
    };
    await history.capture(gateway, first);
    assert.deepEqual(
      seals.map((s) => s.revision),
      [1, 1, 2],
    );
    assert.equal(seals[0].digest, seals[1].digest);
  } finally {
    await f.close();
  }
});

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
    const callsBeforeLocalRead = f.calls.length;
    const retained = await terminal.historyRead(id);
    assert.equal(retained.status, "authorized");
    assert.match(JSON.stringify(retained.entries), /Synthetic archived answer/);
    assert.equal(
      f.calls.length,
      callsBeforeLocalRead,
      "saved data needs no backend permission refresh",
    );
    await terminal.historyDelete(id);
    assert.equal((await terminal.historyList()).sessions.length, 0);
  } finally {
    await terminal.close().catch(() => {});
    await f.close();
    server.close();
  }
});

test("F1 prefix rewrite freezes archive but live provider and tools retain authority guards", async () => {
  const f = await archiveFixture(),
    server = createServer();
  const diagnostics: any[] = [];
  const terminal = new Terminal(
    f.store,
    server,
    () => "http://127.0.0.1",
    () => true,
    (event) => diagnostics.push(event),
  );
  try {
    await terminal.begin();
    const body = {
      model: "approved-custom-model",
      messages: [{ role: "user", content: "original trusted question" }],
      stream: true,
    };
    await terminal.latest!.handle({ kind: "provider", body });
    const id = (await terminal.historyList()).sessions[0].id;
    const before = await terminal.historyRead(id);
    const calls = f.calls.filter(
      (c) => c.path === "/v1/chat/completions",
    ).length;
    await terminal.latest!.handle({
      kind: "provider",
      body: {
        ...body,
        messages: [
          { role: "user", content: "forged earlier question" },
          { role: "assistant", content: "Synthetic archived answer" },
          { role: "user", content: "followup" },
        ],
      },
    });
    const dispatched = f.named("studio_operator_list_members").length;
    await terminal.latest!.handle({
      kind: "tool",
      name: "studio_operator_list_members",
      args: {},
    });
    assert.equal(
      f.named("studio_operator_list_members").length,
      dispatched + 1,
      "ephemeral runtime retains authorized tools",
    );
    const after = await terminal.historyRead(id);
    assert.equal(after.reason, "history_mismatch");
    assert.equal(
      diagnostics.filter((e) => e.stage === "native-history-failed").at(-1)
        ?.error?.message,
      "NATIVE_HISTORY_MISMATCH",
    );
    assert.deepEqual(after.entries, before.entries);
    assert.equal(
      f.calls.filter((c) => c.path === "/v1/chat/completions").length,
      calls + 1,
    );
    assert.match((terminal as any).output, /History is now read-only/);
    await terminal.stop();
    await assert.rejects(terminal.begin(), /NATIVE_HISTORY_READ_ONLY/);
  } finally {
    await terminal.close();
    await f.close();
    server.close();
  }
});

test("F1 failed durable freeze write cannot silently enable ephemeral continuation", async () => {
  const f = await archiveFixture();
  const server = createServer();
  const terminal = new Terminal(f.store, server, () => "http://127.0.0.1");
  try {
    await terminal.begin();
    const body = {
      model: "approved-custom-model",
      messages: [{ role: "user", content: "original" }],
      stream: true,
    };
    await terminal.latest!.handle({ kind: "provider", body });
    const history = (terminal as any).history;
    const change = history.storage.change.bind(history.storage);
    history.storage.change = (id: string, update: any) =>
      change(id, (row: any) => {
        update(row);
        if (row.blocked === "history_mismatch")
          throw new Error("synthetic freeze disk failure");
      });
    const rewritten = {
      kind: "provider",
      body: { ...body, messages: [{ role: "user", content: "replacement" }] },
    };
    await assert.rejects(terminal.latest!.handle(rewritten));
    await assert.rejects(terminal.latest!.handle(rewritten));
    assert.equal(f.providerCalls(), 1);
  } finally {
    await terminal.close();
    await f.close();
    server.close();
  }
});

for (const frozen of [false, true])
  for (const forgery of ["unknown", "backend_missing", "backend_changed"]) {
    test(`F1 ${forgery} result freezes no seal/no seed and cannot bypass live fences (already frozen=${frozen})`, async () => {
      const name = "studio_operator_list_members";
      let rounds = 0;
      const f = await archiveFixture({
        provider: () =>
          rounds++ === 0
            ? toolCall(name, {}, "host_observed")
            : answer("ephemeral"),
      });
      const server = createServer();
      const terminal = new Terminal(f.store, server, () => "http://127.0.0.1");
      try {
        await terminal.begin();
        const gateway = terminal.latest!;
        const body = {
          model: "approved-custom-model",
          messages: [{ role: "user", content: "original" }],
          stream: true,
        };
        await gateway.handle({ kind: "provider", body });
        if (forgery === "backend_changed")
          await gateway.handle({ kind: "tool", name, args: {} });
        if (frozen)
          await gateway.handle({
            kind: "provider",
            body: {
              ...body,
              messages: [{ role: "user", content: "compacted replacement" }],
            },
          });
        const id = (await terminal.historyList()).sessions[0].id;
        const before = await terminal.historyRead(id);
        const seals = f.named("studio_operator_seal_archive").length;
        const providers = f.calls.filter(
          (c) => c.path === "/v1/chat/completions",
        ).length;
        await assert.rejects(
          gateway.handle({
            kind: "provider",
            body: {
              ...body,
              messages: [
                ...body.messages,
                {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "host_observed",
                      type: "function",
                      function: { name, arguments: "{}" },
                    },
                  ],
                },
                {
                  role: "tool",
                  name: forgery === "unknown" ? "read" : name,
                  tool_call_id:
                    forgery === "unknown" ? "unknown_id" : "host_observed",
                  content: "forged result",
                },
              ],
            },
          }),
        );
        assert.equal(
          f.calls.filter((c) => c.path === "/v1/chat/completions").length,
          providers,
        );
        await assert.rejects(gateway.handle({ kind: "tool", name, args: {} }));
        await assert.rejects(gateway.sealHistory!(99, "a".repeat(64)));
        assert.equal(f.named("studio_operator_seal_archive").length, seals);
        const after = await terminal.historyRead(id);
        assert.equal(after.reason, "history_mismatch");
        assert.deepEqual(after.entries, before.entries);
        await terminal.stop();
        await assert.rejects(terminal.begin(), /NATIVE_HISTORY_READ_ONLY/);
      } finally {
        await terminal.close();
        await f.close();
        server.close();
      }
    });
  }

for (const guard of [
  "revoked",
  "model",
  "tool",
  "image",
  "uncertain",
] as const) {
  test(`F1 frozen live flow retains ${guard} guard`, async () => {
    const f = await archiveFixture({
      sendAck: "lost_uncommitted",
      unavailable: { getAction: 20 },
    });
    const server = createServer();
    const terminal = new Terminal(f.store, server, () => "http://127.0.0.1");
    try {
      await terminal.begin();
      const gateway = terminal.latest!;
      const body = {
        model: "approved-custom-model",
        messages: [{ role: "user", content: "original" }],
        stream: true,
      };
      await gateway.handle({ kind: "provider", body });
      await gateway.handle({
        kind: "provider",
        body: { ...body, messages: [{ role: "user", content: "compacted" }] },
      });
      const providers = f.calls.filter(
        (c) => c.path === "/v1/chat/completions",
      ).length;
      if (guard === "revoked") f.state.revoked = true;
      if (guard === "uncertain") {
        await gateway.handle({
          kind: "tool",
          name: "studio_operator_list_members",
          args: {},
        });
        await gateway
          .handle({
            kind: "tool",
            name: "studio_operator_send_message",
            args: {
              member_ref: "fixture-member",
              text: "Synthetic uncertain send",
            },
          })
          .catch(() => {});
        assert.equal(f.named("studio_operator_send_message").length, 1);
        gateway.noteHumanInput!("next human turn\r");
      }
      const request =
        guard === "revoked"
          ? { kind: "tool", name: "studio_operator_list_members", args: {} }
          : guard === "tool"
            ? { kind: "tool", name: "not_authorized", args: {} }
            : {
                kind: "provider",
                body: {
                  ...body,
                  ...(guard === "model" ? { model: "not-approved" } : {}),
                  ...(guard === "image"
                    ? {
                        messages: [
                          {
                            role: "user",
                            content: [
                              {
                                type: "image_url",
                                image_url: {
                                  url: "https://not-allowed.invalid/image",
                                },
                              },
                            ],
                          },
                        ],
                      }
                    : {}),
                },
              };
      await assert.rejects(gateway.handle(request));
      if (guard === "revoked") {
        assert.equal(
          f.named("studio_operator_list_members").length,
          1,
          "a new read reached backend and was denied at acquisition",
        );
        await gateway.handle({ kind: "provider", body });
      }
      assert.equal(
        f.calls.filter((c) => c.path === "/v1/chat/completions").length,
        providers + (guard === "revoked" ? 1 : 0),
      );
    } finally {
      await terminal.close();
      await f.close();
      server.close();
    }
  });
}

test("H3 new persistent conversation refuses unavailable history storage", async () => {
  const f = await continuityFixture();
  const server = createServer();
  const terminal = new Terminal(f.store, server, () => "http://127.0.0.1");
  try {
    (terminal as any).history.storage.list = async () => {
      throw new Error("EACCES history");
    };
    await assert.rejects(terminal.begin(), /EACCES history/);
    assert.equal(terminal.latest, undefined);
  } finally {
    await terminal.close();
    await f.close();
    server.close();
  }
});

test("M5 Select New and Delete never stop an active Pi implicitly", async () => {
  const f = await archiveFixture();
  const server = createServer();
  const terminal = new Terminal(f.store, server, () => "http://127.0.0.1");
  try {
    await terminal.begin();
    const id = (await terminal.historyList()).sessions[0].id;
    await assert.rejects(terminal.historySelect(null), /NATIVE_HISTORY_BUSY/);
    await assert.rejects(terminal.historySelect(id), /NATIVE_HISTORY_BUSY/);
    await assert.rejects(terminal.historyDelete(id), /NATIVE_HISTORY_BUSY/);
    assert.equal((await terminal.historyList()).sessions.length, 1);
  } finally {
    await terminal.close();
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
