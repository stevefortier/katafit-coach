import test from "node:test";
import assert from "node:assert/strict";
import {
  continuityFixture,
  GENERIC,
  answer,
  toolCall,
} from "./helpers/continuity.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";
import { Actions } from "../src/chat/actions.js";

const ROSTER = "studio_operator_list_members";
const SEND = "studio_operator_send_message";
const AUTHORIZE = "studio_operator_authorize_context";
const ADVANCE = "studio_operator_advance_turn";
const provider = (content = "turn") => ({
  kind: "provider",
  body: {
    model: "approved-custom-model",
    messages: [{ role: "user", content }],
  },
});
const tool = (name: string, args: Record<string, unknown> = {}) => ({
  kind: "tool",
  name,
  args,
});
async function open(options: Parameters<typeof continuityFixture>[0] = {}) {
  const f = await continuityFixture(options);
  const terminated: string[] = [];
  let gateway: Awaited<ReturnType<typeof openNativeGateway>>;
  try {
    gateway = await openNativeGateway(f.store, undefined, {
      onTerminate: (reason) => terminated.push(reason),
    });
  } catch (error) {
    await f.close();
    throw error;
  }
  return {
    f,
    gateway,
    terminated,
    async close() {
      await gateway.close();
      await f.close();
    },
  };
}

test("continuity negotiation hides host controls and reserved identity; host session and generation are assigned last", async () => {
  const h = await open();
  try {
    assert.equal(h.f.named("studio_operator_open_session").length, 1);
    assert.equal(
      h.f.named("studio_operator_open_session")[0].args.continuity_version,
      1,
    );
    const catalog = await h.gateway.handle({ kind: "catalog" });
    assert.deepEqual(catalog.tools.map((t: any) => t.name).sort(), [
      ROSTER,
      GENERIC,
      SEND,
    ]);
    assert.doesNotMatch(
      JSON.stringify(catalog.tools),
      /turn_generation|resolved_action_id|continuity_version|session_id|idempotency_key|authorize_context|advance_turn/,
    );
    for (const [name, args] of [
      [ROSTER, { turn_generation: 0 }],
      [GENERIC, { turn_generation: 0 }],
      [GENERIC, { resolved_action_id: "a".repeat(64) }],
      [GENERIC, { continuity_version: 1 }],
      [SEND, { member_ref: "fixture-member", text: "x", turn_generation: 0 }],
    ] as const)
      await assert.rejects(
        h.gateway.handle(tool(name, args as any)),
        /ARGUMENTS_REJECTED/,
      );
    assert.equal(h.f.named(ROSTER).length + h.f.named(GENERIC).length, 0);
    assert.equal(h.f.named(SEND).length, 0);
    await h.gateway.handle(tool(ROSTER));
    await h.gateway.handle(tool(GENERIC, { topic: "t", x_note: "n" }));
    for (const call of [...h.f.named(ROSTER), ...h.f.named(GENERIC)]) {
      assert.equal(call.args.session_id, h.f.state.session_id);
      assert.equal(call.args.turn_generation, 0);
      const keys = Object.keys(call.args);
      assert.deepEqual(keys.slice(-2), ["session_id", "turn_generation"]);
    }
    // A sandbox frame can never request a turn transition.
    await assert.rejects(
      h.gateway.handle({ kind: "turn" }),
      /NATIVE_REQUEST_REJECTED/,
    );
    await assert.rejects(
      h.gateway.handle({ kind: "provider", body: {}, turn: true } as any),
      /NATIVE_REQUEST_REJECTED/,
    );
    assert.equal(h.f.named(ADVANCE).length, 0);
  } finally {
    await h.close();
  }
});

test("more than twelve tool calls succeed only across authenticated human turns; Enter spam arms one bounded transition", async () => {
  const h = await open();
  try {
    await h.gateway.handle(provider("first"));
    for (let i = 0; i < 12; i++) await h.gateway.handle(tool(ROSTER));
    await assert.rejects(
      h.gateway.handle(tool(ROSTER)),
      /TOOL_BUDGET_EXHAUSTED/,
    );
    assert.equal(h.f.named(ROSTER).length, 12);
    // Provider traffic without authenticated human input never mints a turn.
    await h.gateway.handle(provider("model loop"));
    h.gateway.noteHumanInput("typed without enter");
    await h.gateway.handle(provider("model loop"));
    assert.equal(h.f.named(ADVANCE).length, 0);
    await assert.rejects(
      h.gateway.handle(tool(ROSTER)),
      /TOOL_BUDGET_EXHAUSTED/,
    );
    for (let i = 0; i < 5; i++) h.gateway.noteHumanInput("second\r");
    await h.gateway.handle(provider("second"));
    await h.gateway.handle(provider("second continues"));
    assert.equal(h.f.named(ADVANCE).length, 1);
    assert.equal(h.f.state.generation, 1);
    for (let i = 0; i < 12; i++) await h.gateway.handle(tool(ROSTER));
    await assert.rejects(
      h.gateway.handle(tool(ROSTER)),
      /TOOL_BUDGET_EXHAUSTED/,
    );
    assert.equal(h.f.named(ROSTER).length, 24);
    assert.deepEqual(
      h.f.named(ROSTER).map((c) => c.args.turn_generation),
      [...Array(12).fill(0), ...Array(12).fill(1)],
    );
    // Authorization is explicit and content-free: before and after every
    // provider request, never a read replay.
    assert.equal(h.f.named(AUTHORIZE).length, 2 * h.f.providerCalls());
    assert.deepEqual(Object.keys(h.f.named(AUTHORIZE)[0].args), [
      "session_id",
      "turn_generation",
    ]);
    assert.equal(h.f.named("studio_operator_open_session").length, 1);
    assert.deepEqual(h.terminated, []);
  } finally {
    await h.close();
  }
});

test("an expired command renews only through a human turn on the same session and retained proofs", async () => {
  const h = await open({ commandTtlMs: 1000 });
  try {
    await h.gateway.handle(tool(GENERIC, { topic: "retained" }));
    await new Promise((r) => setTimeout(r, 1050));
    await assert.rejects(
      h.gateway.handle(provider("model retry")),
      /CONTINUITY_TURN_REQUIRED/,
    );
    await assert.rejects(h.gateway.handle(tool(ROSTER)), /CANCELLED/);
    assert.equal(h.f.providerCalls(), 0);
    assert.deepEqual(h.terminated, []);
    h.gateway.noteHumanInput("\r");
    await h.gateway.handle(provider("continue with previous evidence"));
    assert.equal(h.f.providerCalls(), 1);
    const [advance] = h.f.named(ADVANCE);
    assert.deepEqual(Object.keys(advance.args).sort(), [
      "idempotency_key",
      "session_id",
      "turn_generation",
    ]);
    assert.equal(advance.args.session_id, h.f.state.session_id);
    assert.equal(advance.args.turn_generation, 0);
    assert.deepEqual(
      h.f.named(AUTHORIZE).map((c) => c.args.turn_generation),
      [1, 1],
    );
    assert.equal(h.f.named("studio_operator_open_session").length, 1);
    assert.equal(h.f.named(GENERIC).length, 1, "no read replay as authority");
    await h.gateway.handle(tool(ROSTER));
  } finally {
    await h.close();
  }
});

test("two intentional sends on separate human turns; one per generation; durable original receipts", async () => {
  const h = await open();
  try {
    h.gateway.noteHumanInput("first\r");
    await h.gateway.handle(provider("first"));
    const first = await h.gateway.handle(
      tool(SEND, { member_ref: "fixture-member", text: "First intentional" }),
    );
    assert.match(JSON.stringify(first), /delivered/);
    await assert.rejects(
      h.gateway.handle(
        tool(SEND, { member_ref: "fixture-member", text: "Unrequested extra" }),
      ),
      /ARGUMENTS_REJECTED/,
    );
    assert.equal(h.f.named(SEND).length, 1);
    h.gateway.noteHumanInput("second\r");
    await h.gateway.handle(provider("second"));
    const firstAction = [...h.f.state.actions.keys()][0];
    assert.equal(
      h.f.named(ADVANCE).at(-1)!.args.resolved_action_id,
      firstAction,
    );
    await h.gateway.handle(
      tool(SEND, { member_ref: "fixture-member", text: "Second intentional" }),
    );
    assert.equal(h.f.named(SEND).length, 2);
    assert.deepEqual(
      h.f.named(SEND).map((c) => c.args.turn_generation),
      [0, 1],
    );
    assert.notEqual(
      h.f.named(SEND)[0].args.idempotency_key,
      h.f.named(SEND)[1].args.idempotency_key,
    );
    assert.deepEqual(h.f.state.messages, [
      { text: "First intentional", generation: 0 },
      { text: "Second intentional", generation: 1 },
    ]);
    const journal = new Actions(h.f.store).snapshot();
    assert.equal(journal.filter((a) => a.status === "delivered").length, 2);
    assert.ok(journal.every((a) => a.session_id === h.f.state.session_id));
  } finally {
    await h.close();
  }
});

test("an uncertain send is never replayed; not_found alone proves nothing until a validated advance fences it", async () => {
  const h = await open({ sendAck: "lost_uncommitted" });
  try {
    await h.gateway.handle(provider("first"));
    const send = tool(SEND, { member_ref: "fixture-member", text: "Maybe" });
    await assert.rejects(h.gateway.handle(send));
    await assert.rejects(h.gateway.handle(send), /DELIVERY_UNVERIFIED/);
    const journal = () => new Actions(h.f.store).snapshot();
    assert.deepEqual(
      journal().map((a) => a.status),
      ["unknown"],
    );
    h.gateway.noteHumanInput("second\r");
    await h.gateway.handle(provider("second"));
    const [advance] = h.f.named(ADVANCE);
    assert.equal(h.f.named(ADVANCE).length, 1);
    assert.equal(Object.hasOwn(advance.args, "resolved_action_id"), false);
    // Only the validated advance proves the old-generation send cannot commit.
    assert.deepEqual(
      journal().map((a) => a.status),
      ["not_found"],
    );
    assert.equal(
      journal()[0].idempotency_key,
      h.f.named(SEND)[0].args.idempotency_key,
    );
    await h.gateway.handle(
      tool(SEND, { member_ref: "fixture-member", text: "Fresh intent" }),
    );
    assert.equal(h.f.named(SEND).length, 2, "original never replayed");
    assert.notEqual(
      h.f.named(SEND)[1].args.idempotency_key,
      h.f.named(SEND)[0].args.idempotency_key,
    );
    assert.deepEqual(h.f.state.messages, [
      { text: "Fresh intent", generation: 1 },
    ]);
    assert.deepEqual(h.terminated, []);
  } finally {
    await h.close();
  }
});

test("an in-flight send landing after the not_found lookup is reconciled as delivered, never replayed", async () => {
  const h = await open({ sendAck: "late_commit" });
  try {
    await assert.rejects(
      h.gateway.handle(
        tool(SEND, { member_ref: "fixture-member", text: "Late" }),
      ),
    );
    h.gateway.noteHumanInput("\r");
    await h.gateway.handle(provider("next"));
    const advances = h.f.named(ADVANCE);
    assert.equal(advances.length, 2);
    assert.equal(Object.hasOwn(advances[0].args, "resolved_action_id"), false);
    const [action] = [...h.f.state.actions.keys()];
    assert.equal(advances[1].args.resolved_action_id, action);
    assert.notEqual(
      advances[1].args.idempotency_key,
      advances[0].args.idempotency_key,
    );
    assert.equal(h.f.named(SEND).length, 1);
    assert.deepEqual(h.f.state.messages, [{ text: "Late", generation: 0 }]);
    assert.deepEqual(
      new Actions(h.f.store).snapshot().map((a) => a.status),
      ["delivered"],
    );
    assert.equal(h.f.state.generation, 1);
  } finally {
    await h.close();
  }
});

test("an in-flight send arriving after the validated advance is fenced and recorded not_found", async () => {
  const h = await open({ sendAck: "late_after_advance" });
  try {
    await assert.rejects(
      h.gateway.handle(
        tool(SEND, { member_ref: "fixture-member", text: "Too late" }),
      ),
    );
    h.gateway.noteHumanInput("\r");
    await h.gateway.handle(provider("next"));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.f.state.generation, 1);
    assert.deepEqual(h.f.state.messages, []);
    assert.deepEqual(
      new Actions(h.f.store).snapshot().map((a) => a.status),
      ["not_found"],
    );
  } finally {
    await h.close();
  }
});

test("a failed receipt lookup keeps the send unknown and mints no transition", async () => {
  const h = await open({
    sendAck: "lost_uncommitted",
    unavailable: { getAction: 5 },
  });
  try {
    await assert.rejects(
      h.gateway.handle(
        tool(SEND, { member_ref: "fixture-member", text: "Maybe" }),
      ),
    );
    h.gateway.noteHumanInput("\r");
    await assert.rejects(
      h.gateway.handle(provider("next")),
      /DELIVERY_UNVERIFIED/,
    );
    assert.equal(h.f.named(ADVANCE).length, 0);
    assert.equal(h.f.providerCalls(), 0);
    assert.deepEqual(
      new Actions(h.f.store).snapshot().map((a) => a.status),
      ["unknown"],
    );
    assert.deepEqual(h.terminated, []);
  } finally {
    await h.close();
  }
});

test("OPERATOR_UNAVAILABLE authorization is retried boundedly and never discloses or terminates", async () => {
  const h = await open({ unavailable: { authorize: 4 } });
  try {
    await assert.rejects(
      h.gateway.handle(provider("unavailable")),
      /OPERATOR_UNAVAILABLE/,
    );
    assert.equal(h.f.providerCalls(), 0);
    assert.equal(h.f.named(AUTHORIZE).length, 3);
    assert.deepEqual(h.terminated, []);
    await h.gateway.handle(provider("recovered"));
    assert.equal(h.f.providerCalls(), 1);
    assert.equal(h.f.named(AUTHORIZE).length, 6);
  } finally {
    await h.close();
  }
});

test("OPERATOR_UNAVAILABLE after an unobserved transition commit reconciles the identical identity", async () => {
  const h = await open({ unavailableAfterAdvanceCommit: 1 });
  try {
    await h.gateway.handle(tool(ROSTER));
    h.gateway.noteHumanInput("\r");
    await h.gateway.handle(provider("next"));
    const advances = h.f.named(ADVANCE);
    assert.equal(advances.length, 2);
    assert.deepEqual(advances[1].args, advances[0].args);
    assert.equal(h.f.state.transitions.length, 1);
    assert.equal(h.f.named(AUTHORIZE)[0].args.turn_generation, 1);
    assert.deepEqual(h.terminated, []);
  } finally {
    await h.close();
  }
});

test("an unavailable transition stays pending, blocks tools and disclosure, and resumes only the identical identity", async () => {
  const h = await open({ unavailable: { advance: 4 } });
  try {
    await h.gateway.handle(tool(ROSTER));
    h.gateway.noteHumanInput("\r");
    await assert.rejects(
      h.gateway.handle(provider("next")),
      /CONTINUITY_TRANSITION_PENDING/,
    );
    await assert.rejects(
      h.gateway.handle(tool(ROSTER)),
      /CONTINUITY_TRANSITION_PENDING/,
    );
    assert.equal(h.f.providerCalls(), 0);
    assert.equal(h.f.named(AUTHORIZE).length, 0);
    // No new human input: the journaled transition itself is resumed.
    await h.gateway.handle(provider("retry"));
    const advances = h.f.named(ADVANCE);
    assert.equal(advances.length, 5);
    assert.ok(
      advances.every(
        (a) => JSON.stringify(a.args) === JSON.stringify(advances[0].args),
      ),
    );
    assert.equal(h.f.state.generation, 1);
    assert.equal(h.f.providerCalls(), 1);
    assert.deepEqual(h.terminated, []);
  } finally {
    await h.close();
  }
});

test("a reconciled transition receipt past its command deadline is renewed before any disclosure", async () => {
  const h = await open({ loseAdvanceAcks: 3, commandTtlMs: 800 });
  try {
    await h.gateway.handle(tool(ROSTER));
    h.gateway.noteHumanInput("\r");
    await assert.rejects(
      h.gateway.handle(provider("next")),
      /CONTINUITY_TRANSITION_PENDING/,
    );
    assert.equal(h.f.state.generation, 1, "committed but unacknowledged");
    await new Promise((r) => setTimeout(r, 850));
    await h.gateway.handle(provider("resume"));
    const advances = h.f.named(ADVANCE);
    assert.equal(advances.length, 5);
    assert.deepEqual(advances[3].args, advances[0].args);
    assert.equal(advances[4].args.turn_generation, 1);
    assert.notEqual(
      advances[4].args.idempotency_key,
      advances[0].args.idempotency_key,
    );
    assert.equal(h.f.state.generation, 2);
    assert.deepEqual(
      h.f.named(AUTHORIZE).map((c) => c.args.turn_generation),
      [2, 2],
    );
    assert.equal(h.f.providerCalls(), 1);
  } finally {
    await h.close();
  }
});

test("a committed send with a lost acknowledgement resolves by original receipt before the next generation", async () => {
  const h = await open({ sendAck: "lost_committed" });
  try {
    h.gateway.noteHumanInput("first\r");
    await h.gateway.handle(provider("first"));
    await assert.rejects(
      h.gateway.handle(
        tool(SEND, { member_ref: "fixture-member", text: "Committed" }),
      ),
    );
    h.gateway.noteHumanInput("second\r");
    await h.gateway.handle(provider("second"));
    const [action] = [...h.f.state.actions.keys()];
    assert.equal(h.f.named(ADVANCE).at(-1)!.args.resolved_action_id, action);
    await h.gateway.handle(
      tool(SEND, { member_ref: "fixture-member", text: "Next turn" }),
    );
    assert.equal(h.f.named(SEND).length, 2);
    assert.equal(h.f.state.messages.length, 2);
    assert.ok(
      new Actions(h.f.store).snapshot().every((a) => a.status === "delivered"),
    );
  } finally {
    await h.close();
  }
});

test("a lost transition acknowledgement retries only the identical transition identity", async () => {
  const h = await open({ loseAdvanceAcks: 1 });
  try {
    await h.gateway.handle(tool(ROSTER));
    h.gateway.noteHumanInput("\r");
    await h.gateway.handle(provider("next"));
    const advances = h.f.named(ADVANCE);
    assert.equal(advances.length, 2);
    assert.deepEqual(advances[1].args, advances[0].args);
    assert.equal(h.f.state.generation, 1);
    assert.equal(h.f.state.transitions.length, 1);
    assert.equal(h.f.named(AUTHORIZE)[0].args.turn_generation, 1);
    assert.deepEqual(h.terminated, []);
  } finally {
    await h.close();
  }
});

test("an unreconciled transition fails closed after a bounded number of identical attempts", async () => {
  const h = await open({ loseAdvanceAcks: 100 });
  try {
    await h.gateway.handle(tool(ROSTER));
    h.gateway.noteHumanInput("\r");
    for (let i = 0; i < 2; i++)
      await assert.rejects(
        h.gateway.handle(provider("next")),
        /CONTINUITY_TRANSITION_PENDING/,
      );
    assert.deepEqual(h.terminated, []);
    await assert.rejects(h.gateway.handle(provider("next")));
    const advances = h.f.named(ADVANCE);
    assert.equal(advances.length, 9);
    assert.ok(
      advances.every(
        (a) => JSON.stringify(a.args) === JSON.stringify(advances[0].args),
      ),
    );
    assert.equal(h.f.providerCalls(), 0);
    assert.deepEqual(h.terminated, ["TRANSITION_UNKNOWN"]);
    await assert.rejects(h.gateway.handle(tool(ROSTER)));
    await assert.rejects(h.gateway.handle({ kind: "catalog" }));
    assert.equal(h.f.named("studio_operator_open_session").length, 1);
  } finally {
    await h.close();
  }
});

test("an observed denial is terminal even if the source is restored", async () => {
  const h = await open();
  try {
    await h.gateway.handle(tool(GENERIC, { topic: "private" }));
    h.f.state.revoked = true;
    await assert.rejects(h.gateway.handle(provider("denied")));
    h.f.state.revoked = false;
    assert.notEqual(h.f.state.status, "active", "backend tombstone persists");
    await assert.rejects(h.gateway.handle(provider("restored")));
    assert.deepEqual(h.terminated, ["AUTHORIZATION_DENIED"]);
    assert.equal(h.f.providerCalls(), 0);
  } finally {
    await h.close();
  }
});

test("revoked retained generic source blocks provider disclosure, terminates, and is never replayed or reopened", async () => {
  const h = await open();
  try {
    const read = await h.gateway.handle(tool(GENERIC, { topic: "private" }));
    assert.match(JSON.stringify(read), /SYNTHETIC GENERIC RETAINED SOURCE/);
    h.f.state.revoked = true;
    await assert.rejects(h.gateway.handle(provider("disclose")));
    assert.equal(h.f.providerCalls(), 0);
    assert.equal(h.terminated.length, 1);
    await assert.rejects(h.gateway.handle(provider("again")));
    h.gateway.noteHumanInput("\r");
    await assert.rejects(h.gateway.handle(provider("after human input")));
    assert.equal(h.f.named(GENERIC).length, 1);
    assert.equal(h.f.named(ADVANCE).length, 0);
    assert.equal(h.f.named("studio_operator_open_session").length, 1);
    // Termination already started disposal; owner close joins it (idempotent).
    await h.gateway.close();
    assert.equal(h.f.named("studio_operator_close_session").length, 1);
    assert.equal(h.f.state.status, "closed");
  } finally {
    await h.close();
  }
});

test("revocation during inference withholds the provider result and terminates", async () => {
  const h = await open({
    provider: (_body, state) => {
      state.revoked = true;
      return answer("derived from revoked context");
    },
  });
  try {
    await h.gateway.handle(tool(GENERIC, { topic: "private" }));
    await assert.rejects(h.gateway.handle(provider("disclose")));
    assert.equal(h.f.providerCalls(), 1);
    assert.equal(h.terminated.length, 1);
  } finally {
    await h.close();
  }
});

test("retained context expiry is terminal and never renewed", async () => {
  const h = await open({ contextTtlMs: 400 });
  try {
    await h.gateway.handle(tool(ROSTER));
    await new Promise((r) => setTimeout(r, 450));
    h.gateway.noteHumanInput("\r");
    await assert.rejects(h.gateway.handle(provider("late")));
    assert.equal(h.f.providerCalls(), 0);
    assert.equal(h.f.named(ADVANCE).length, 0);
    assert.equal(h.terminated.length, 1);
  } finally {
    await h.close();
  }
});

test("an idle runtime is terminated at the absolute retained deadline without any request", async () => {
  const h = await open({ contextTtlMs: 300 });
  try {
    await new Promise((r) => setTimeout(r, 450));
    assert.deepEqual(h.terminated, ["CONTEXT_EXPIRED"]);
    await h.gateway.close();
    assert.equal(h.f.state.status, "closed");
    assert.equal(h.f.named(AUTHORIZE).length + h.f.named(ADVANCE).length, 0);
  } finally {
    await h.close();
  }
});

test("malformed authorization receipt carrying content is a denial", async () => {
  const h = await open({
    authorizeResponse: (value) => ({ ...value, items: ["private"] }),
  });
  try {
    await assert.rejects(h.gateway.handle(provider("x")));
    assert.equal(h.f.providerCalls(), 0);
    assert.equal(h.terminated.length, 1);
  } finally {
    await h.close();
  }
});

test("malformed continuity descriptors fail negotiation and close the opened session", async () => {
  for (const descriptor of [
    (d: any) => ({ ...d, max_tool_calls_per_turn: 99 }),
    (d: any) => ({ ...d, failure_requires: "reset_transcript" }),
    (d: any) => ({ ...d, host_controls: [d.host_controls[0]] }),
    (d: any) => ({ ...d, extra: true }),
  ]) {
    const f = await continuityFixture({ descriptor });
    try {
      await assert.rejects(openNativeGateway(f.store), /CAPABILITIES_REJECTED/);
      assert.equal(f.named("studio_operator_close_session").length, 1);
    } finally {
      await f.close();
    }
  }
});

test("cancellation during a transition cannot create an unknown transition or reach the provider", async () => {
  const h = await open();
  try {
    await h.gateway.handle(tool(ROSTER));
    h.gateway.noteHumanInput("\r");
    const controller = new AbortController();
    const pending = h.gateway.handle(provider("cancelled"), controller.signal);
    controller.abort();
    await assert.rejects(pending, /CANCELLED/);
    assert.equal(h.f.providerCalls(), 0);
    assert.deepEqual(h.terminated, []);
    // The next provider request neither replays nor re-arms the transition.
    // The host-owned transition completed under its own signal, exactly once.
    assert.equal(h.f.named(ADVANCE).length, 1);
    assert.equal(h.f.state.generation, 1);
    await h.gateway.handle(provider("next"));
    assert.equal(h.f.named(ADVANCE).length, 1);
    assert.equal(h.f.state.transitions.length, 1);
    assert.equal(h.f.providerCalls(), 1);
  } finally {
    await h.close();
  }
});

test("the generation cap stops renewal without rolling over", async () => {
  const h = await open({ maxTurns: 2 });
  try {
    await h.gateway.handle(tool(ROSTER));
    h.gateway.noteHumanInput("\r");
    await h.gateway.handle(provider("one"));
    await h.gateway.handle(tool(ROSTER));
    h.gateway.noteHumanInput("\r");
    await h.gateway.handle(provider("capped"));
    assert.equal(h.f.named(ADVANCE).length, 1);
    assert.equal(h.f.state.generation, 1);
  } finally {
    await h.close();
  }
});

test("an expired command at the generation cap is terminal instead of stranding retained context", async () => {
  const h = await open({ maxTurns: 2, commandTtlMs: 800 });
  try {
    await h.gateway.handle(tool(ROSTER));
    h.gateway.noteHumanInput("\r");
    await h.gateway.handle(provider("one"));
    await h.gateway.handle(tool(ROSTER));
    await new Promise((r) => setTimeout(r, 850));
    h.gateway.noteHumanInput("\r");
    await assert.rejects(h.gateway.handle(provider("exhausted")));
    assert.deepEqual(h.terminated, ["TURNS_EXHAUSTED"]);
    assert.equal(h.f.named(ADVANCE).length, 1);
    assert.equal(h.f.providerCalls(), 1);
  } finally {
    await h.close();
  }
});

test("an armed turn on an unused, unexpired generation does not burn a transition", async () => {
  const h = await open();
  try {
    h.gateway.noteHumanInput("\r");
    await h.gateway.handle(provider("fresh"));
    assert.equal(h.f.named(ADVANCE).length, 0);
    await h.gateway.handle(tool(ROSTER));
    await h.gateway.handle(provider("same turn"));
    assert.equal(h.f.named(ADVANCE).length, 0, "latch was consumed");
  } finally {
    await h.close();
  }
});

test("a legacy backend without advertised continuity is unchanged and human input cannot renew it", async () => {
  const f = await continuityFixture({ continuity: false });
  const gateway = await openNativeGateway(f.store);
  try {
    assert.equal(
      f.named("studio_operator_open_session")[0].args.continuity_version,
      undefined,
    );
    await assert.rejects(
      gateway.handle(tool(GENERIC, { topic: "x" })),
      /SOURCE_AUTHORIZATION_UNSUPPORTED/,
    );
    gateway.noteHumanInput("\r");
    await gateway.handle(provider("x"));
    assert.equal(f.named(ADVANCE).length + f.named(AUTHORIZE).length, 0);
  } finally {
    await gateway.close();
    await f.close();
  }
});
