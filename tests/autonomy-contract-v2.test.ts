import test from "node:test";
import assert from "node:assert/strict";
import { AutonomyBackend, AutonomyFailure } from "../src/autonomy/backend.js";
import {
  TOKEN,
  autonomyStub,
  capabilities,
  defaultMandate,
  error,
  MEMBER,
  WORK,
  followUp,
  outcome,
  receipt,
  sha256,
  workItem,
} from "./helpers/autonomy-stub.js";

// CONTRACT v2 + AC1 (work-packages.md §2, §2.9, §2.10) wire behaviour of the
// host adapter. Behavioural: every case drives a real HTTP request/response.
const ACTIVITY = "64b7f0c2a1b2c3d4e5f607c1";
const LEDGER = "64b7f0c2a1b2c3d4e5f607c2";
const COMPLETED = "2026-10-03T06:40:00.000Z";
const open = (origin: string) =>
  new AutonomyBackend(origin, TOKEN, new AbortController().signal, []);
const code = (expected: string, limit?: string) => (e: unknown) =>
  e instanceof AutonomyFailure &&
  e.code === expected &&
  (limit === undefined || e.limit === limit);

const praiseReceipt = (overrides: Record<string, unknown> = {}) => ({
  slot: "praise-1",
  type: "public_praise",
  status: "published",
  comment_id: `${"64b7f0c2a1b2c3d4e5f60701"}:${ACTIVITY}:${COMPLETED}`,
  activity_id: ACTIVITY,
  subject_user_id: MEMBER,
  text_sha256: sha256("Big finish!"),
  committed_at: "2026-10-03T07:01:00.000Z",
  ...overrides,
});
const intentRecord = (overrides: Record<string, unknown> = {}) => ({
  slot: "nudge-1",
  type: "member_message",
  recipient_id: MEMBER,
  purpose: "check_in",
  tone: "warm",
  evidence_refs: [`ev:${LEDGER}`],
  status: "intended",
  created_at: "2026-10-03T07:01:00.000Z",
  ...overrides,
});
const fence = { lease_generation: 1, mandate_revision: 1 };

test("v2 mandate: praise_daily and public_praise are part of the pinned DTO", async () => {
  const stub = await autonomyStub(() => ({
    body: {
      ...defaultMandate({
        delegated_actions: ["follow_up", "public_praise"],
      }),
      capabilities: { ...capabilities, action_types: ["public_praise"] },
    },
  }));
  try {
    const m = await open(stub.origin).mandate();
    assert.equal(m.contact_limits.praise_daily, 10);
    assert.deepEqual(m.delegated_actions, ["follow_up", "public_praise"]);
    const { praise_daily, ...v1 } = m.contact_limits;
    stub.reply = () => ({
      body: { ...defaultMandate({ contact_limits: v1 }), capabilities },
    });
    await assert.rejects(
      () => open(stub.origin).mandate(),
      code("AUTONOMY_RESULT_REJECTED"),
    );
  } finally {
    await stub.close();
  }
});

test("v2 work: conversation kind, attested event refs, unclaimed null timeout and content-free intents are accepted", async () => {
  const conversation = workItem({
    kind: "conversation",
    status: "queued",
    lease_generation: 0,
    lease_expires_at: null,
    timeout_at: null,
    source: {
      conversation: { member_id: MEMBER, from_epoch: 3, to_epoch: 5 },
    },
  });
  const event = workItem({
    source: {
      event_ids: [LEDGER],
      events: [
        {
          ledger_id: LEDGER,
          occurred_at: COMPLETED,
          event_type: "activity.completed",
          subject: { type: "activity", id: ACTIVITY },
        },
      ],
    },
    intents: [
      {
        slot: "nudge-1",
        type: "member_message",
        recipient_id: MEMBER,
        purpose: "check_in",
        status: "composed",
        composition_sha256: sha256("hi"),
      },
    ],
  });
  const stub = await autonomyStub(() => ({
    body: { items: [conversation, event], next_cursor: null, has_more: false },
  }));
  try {
    const page = await open(stub.origin).listWork({ status: "queued" });
    assert.equal(page.items[0].kind, "conversation");
    assert.equal(page.items[0].timeout_at, null);
    assert.equal(page.items[1].intents?.[0].status, "composed");
    // An intent row that carries outbound text is not content-free.
    stub.reply = () => ({
      body: {
        items: [
          workItem({
            intents: [
              {
                slot: "nudge-1",
                type: "member_message",
                recipient_id: MEMBER,
                purpose: "check_in",
                status: "composed",
                composition_sha256: null,
                text: "private",
              },
            ],
          }),
        ],
        next_cursor: null,
        has_more: false,
      },
    });
    await assert.rejects(
      () => open(stub.origin).listWork({}),
      code("AUTONOMY_RESULT_REJECTED"),
    );
  } finally {
    await stub.close();
  }
});

test("v2 complete: coverage pages are sent and an idempotent completion replay is accepted", async () => {
  const withPages = outcome({
    coverage: {
      members_considered: 2,
      members_read: 1,
      partial: true,
      unobserved: ["pages_truncated"],
      pages: [
        { source: "day_events", read: 1, denied: 0, failed: 1, truncated: 0 },
      ],
    },
  });
  const stub = await autonomyStub(() => ({
    body: {
      work: workItem({ status: "completed", lease_expires_at: null }),
      report_id: "64b7f0c2a1b2c3d4e5f60706",
      idempotent: true,
    },
  }));
  try {
    const done = await open(stub.origin).complete(WORK, {
      ...fence,
      outcome: withPages as any,
    });
    assert.equal(done.work.status, "completed");
    assert.deepEqual(stub.calls[0].body.outcome.coverage.pages, [
      { source: "day_events", read: 1, denied: 0, failed: 1, truncated: 0 },
    ]);
  } finally {
    await stub.close();
  }
});

test("public praise: exact occurrence body, local bounds, and only a matching published comment is proof", async () => {
  const stub = await autonomyStub(() => ({
    status: 201,
    body: { receipt: praiseReceipt(), idempotent: false },
  }));
  const praise = {
    ...fence,
    type: "public_praise" as const,
    activity_id: ACTIVITY,
    completed_at: COMPLETED,
    text: "Big finish!",
  };
  try {
    const backend = open(stub.origin);
    const sent = await backend.act(WORK, "praise-1", praise);
    assert.equal(sent.receipt.status, "published");
    assert.deepEqual(stub.calls[0].body, praise);
    for (const bad of [
      { ...praise, text: "x".repeat(101) },
      { ...praise, recipient_id: MEMBER },
      { ...praise, completed_at: undefined },
      { ...praise, activity_id: "nope" },
    ])
      await assert.rejects(
        () => backend.act(WORK, "praise-1", bad as any),
        code("AUTONOMY_INVALID"),
      );
    assert.equal(stub.calls.length, 1);
    stub.reply = () => ({
      body: {
        receipt: praiseReceipt({ status: "already_published" }),
        idempotent: true,
      },
    });
    assert.equal(
      (await backend.act(WORK, "praise-1", praise)).receipt.status,
      "already_published",
    );
    stub.reply = () => ({
      body: {
        receipt: praiseReceipt({ activity_id: "64b7f0c2a1b2c3d4e5f607c9" }),
        idempotent: true,
      },
    });
    await assert.rejects(
      () => backend.act(WORK, "praise-1", praise),
      code("AUTONOMY_OUTCOME_UNKNOWN"),
    );
  } finally {
    await stub.close();
  }
});

test("v2/AC1 backend codes and praise limits map to fixed failures", async () => {
  const cases: [number, string, string?][] = [
    [409, "INTENT_REQUIRED"],
    [409, "COMPOSITION_MISMATCH"],
    [409, "INTENT_CONFLICT"],
    [400, "INTENT_INVALID"],
    [403, "INTENT_EVIDENCE_NOT_AUTHORIZED"],
    [403, "PRAISE_NOT_AUTHORIZED"],
    [409, "PRAISE_SOURCE_CHANGED"],
    [400, "PRAISE_TEXT_REJECTED"],
    [409, "ACTION_LIMITED", "praise_daily"],
    [409, "ACTION_LIMITED", "praise_in_progress"],
  ];
  for (const [status, name, limit] of cases) {
    const stub = await autonomyStub(() =>
      error(status, name, limit ? { limit } : {}),
    );
    try {
      await assert.rejects(
        () =>
          open(stub.origin).act(WORK, "praise-1", {
            ...fence,
            type: "public_praise",
            activity_id: ACTIVITY,
            completed_at: COMPLETED,
            text: "Big finish!",
          }),
        code(name, limit),
      );
    } finally {
      await stub.close();
    }
  }
});

test("AC1 intent: finite handoff only — no text, strict refs, purpose fits type", async () => {
  const stub = await autonomyStub(() => ({
    status: 201,
    body: { intent: intentRecord(), idempotent: false },
  }));
  const intent = {
    type: "member_message" as const,
    recipient_id: MEMBER,
    purpose: "check_in" as const,
    tone: "warm" as const,
    evidence_refs: [`ev:${LEDGER}`],
  };
  try {
    const backend = open(stub.origin);
    const saved = await backend.putIntent(WORK, "nudge-1", {
      ...fence,
      intent,
    });
    assert.equal(saved.intent.status, "intended");
    assert.equal(saved.public_projection, undefined);
    assert.deepEqual(stub.calls[0], {
      ...stub.calls[0],
      method: "PUT",
      path: `/api/coach/autonomy/work/${WORK}/intents/nudge-1`,
      body: { ...fence, intent },
    });
    for (const bad of [
      { ...intent, text: "tell them the plan" },
      { ...intent, note: "x" },
      { ...intent, evidence_refs: [] },
      { ...intent, evidence_refs: Array(9).fill(`ev:${LEDGER}`) },
      { ...intent, evidence_refs: ["memory:secret"] },
      { ...intent, evidence_refs: ["ev:has space"] },
      { ...intent, purpose: "completion_praise" },
      { ...intent, recipient_id: undefined },
      { ...intent, tone: "sarcastic" },
      {
        type: "public_praise",
        purpose: "completion_praise",
        evidence_refs: [`pub:${ACTIVITY}`],
      },
      {
        type: "public_praise",
        recipient_id: MEMBER,
        activity_id: ACTIVITY,
        completed_at: COMPLETED,
        purpose: "completion_praise",
        evidence_refs: [`pub:${ACTIVITY}`],
      },
    ])
      await assert.rejects(
        () =>
          backend.putIntent(WORK, "nudge-1", { ...fence, intent: bad as any }),
        code("AUTONOMY_INVALID"),
      );
    assert.equal(stub.calls.length, 1);
    // A record for another slot or recipient is not this intent.
    stub.reply = () => ({
      body: { intent: intentRecord({ slot: "other" }), idempotent: true },
    });
    await assert.rejects(
      () => backend.putIntent(WORK, "nudge-1", { ...fence, intent }),
      code("AUTONOMY_OUTCOME_UNKNOWN"),
    );
  } finally {
    await stub.close();
  }
});

test("AC1 intent: public praise returns exactly the public projection", async () => {
  const projection = {
    subject_display_name: "Sam",
    activity_type: "run",
    activity_name: "Morning 5k",
    completed_at: COMPLETED,
    personal_record: false,
  };
  const intent = {
    type: "public_praise" as const,
    activity_id: ACTIVITY,
    completed_at: COMPLETED,
    purpose: "completion_praise" as const,
    evidence_refs: [`ev:${LEDGER}`, `pub:${ACTIVITY}`],
  };
  const record = intentRecord({
    slot: "praise-1",
    type: "public_praise",
    recipient_id: undefined,
    activity_id: ACTIVITY,
    completed_at: COMPLETED,
    purpose: "completion_praise",
    tone: undefined,
    evidence_refs: intent.evidence_refs,
  });
  const stub = await autonomyStub(() => ({
    status: 201,
    body: {
      intent: JSON.parse(JSON.stringify(record)),
      idempotent: false,
      public_projection: projection,
    },
  }));
  try {
    const saved = await open(stub.origin).putIntent(WORK, "praise-1", {
      ...fence,
      intent,
    });
    assert.deepEqual(saved.public_projection, projection);
    stub.reply = () => ({
      body: {
        intent: JSON.parse(JSON.stringify(record)),
        idempotent: true,
        public_projection: { ...projection, notes: "private" },
      },
    });
    await assert.rejects(
      () => open(stub.origin).putIntent(WORK, "praise-1", { ...fence, intent }),
      code("AUTONOMY_OUTCOME_UNKNOWN"),
    );
  } finally {
    await stub.close();
  }
});

test("AC1 composition: first write wins and the stored text is what the host must dispatch", async () => {
  const composer = {
    persona_revision: "persona-r3",
    provider_request_sha256: [sha256("request-1")],
  };
  const stub = await autonomyStub(() => ({
    status: 201,
    body: {
      composition: {
        slot: "nudge-1",
        text_sha256: sha256("Hello Sam"),
        stored_at: "2026-10-03T07:02:00.000Z",
      },
      stored: false,
    },
  }));
  try {
    const backend = open(stub.origin);
    const first = await backend.putComposition(WORK, "nudge-1", {
      lease_generation: 1,
      text: "Hello Sam",
      composer,
    });
    assert.equal(first.text, "Hello Sam");
    assert.equal(first.stored, false);
    assert.deepEqual(stub.calls[0].body, {
      lease_generation: 1,
      text: "Hello Sam",
      composer,
    });
    stub.reply = () => ({
      body: {
        composition: {
          slot: "nudge-1",
          text: "Hi Sam, earlier draft",
          text_sha256: sha256("Hi Sam, earlier draft"),
          stored_at: "2026-10-03T07:01:30.000Z",
        },
        stored: true,
      },
    });
    const retry = await backend.putComposition(WORK, "nudge-1", {
      lease_generation: 1,
      text: "Different text",
      composer,
    });
    assert.equal(retry.stored, true);
    assert.equal(retry.text, "Hi Sam, earlier draft");
    // A first-write answer whose digest is not of the sent text proves nothing.
    stub.reply = () => ({
      status: 201,
      body: {
        composition: {
          slot: "nudge-1",
          text_sha256: sha256("other"),
          stored_at: "2026-10-03T07:02:00.000Z",
        },
        stored: false,
      },
    });
    await assert.rejects(
      () =>
        backend.putComposition(WORK, "nudge-1", {
          lease_generation: 1,
          text: "Hello Sam",
          composer,
        }),
      code("AUTONOMY_OUTCOME_UNKNOWN"),
    );
    for (const bad of [
      { lease_generation: 1, text: "", composer },
      { lease_generation: 1, text: "x".repeat(8001), composer },
      {
        lease_generation: 1,
        text: "ok",
        composer: { ...composer, provider_request_sha256: [] },
      },
      { lease_generation: 1, text: "ok", composer, extra: 1 },
    ])
      await assert.rejects(
        () => backend.putComposition(WORK, "nudge-1", bad as any),
        code("AUTONOMY_INVALID"),
      );
  } finally {
    await stub.close();
  }
});

test("AC1 getIntent reads intent, stored composition and receipt for exact recovery", async () => {
  const stub = await autonomyStub(() => ({
    body: {
      intent: intentRecord({ status: "dispatched" }),
      composition: {
        text: "Hello Sam",
        text_sha256: sha256("Hello Sam"),
        stored_at: "2026-10-03T07:02:00.000Z",
      },
      receipt: receipt({ slot: "nudge-1", text_sha256: sha256("Hello Sam") }),
    },
  }));
  try {
    const state = await open(stub.origin).getIntent(WORK, "nudge-1");
    assert.equal(state.composition?.text, "Hello Sam");
    assert.equal(state.receipt?.slot, "nudge-1");
    stub.reply = () => ({
      body: {
        intent: intentRecord(),
        composition: {
          text: "Hello Sam",
          text_sha256: sha256("tampered"),
          stored_at: "2026-10-03T07:02:00.000Z",
        },
        receipt: null,
      },
    });
    await assert.rejects(
      () => open(stub.origin).getIntent(WORK, "nudge-1"),
      code("AUTONOMY_RESULT_REJECTED"),
    );
  } finally {
    await stub.close();
  }
});

test("v2 follow-ups: a member commitment needs the member's verbatim quote", async () => {
  const stub = await autonomyStub(() => ({
    status: 201,
    body: {
      follow_up: followUp({
        evidence: { message_ref: "sealed.ref-1", quote: "I will do mobility" },
      }),
      idempotent: false,
    },
  }));
  const input = {
    ...fence,
    subject_id: MEMBER,
    basis: "member_commitment" as const,
    summary: "Mobility on Thursday.",
    due_at: "2026-10-09T18:00:00.000Z",
    next_condition: "Mobility logged.",
  };
  try {
    const backend = open(stub.origin);
    await assert.rejects(
      () => backend.followUp(WORK, "commitment-1", input),
      code("AUTONOMY_INVALID"),
    );
    await assert.rejects(
      () =>
        backend.followUp(WORK, "commitment-1", {
          ...input,
          evidence: { message_ref: "sealed.ref-1", quote: "short" },
        }),
      code("AUTONOMY_INVALID"),
    );
    const saved = await backend.followUp(WORK, "commitment-1", {
      ...input,
      evidence: { message_ref: "sealed.ref-1", quote: "I will do mobility" },
    });
    assert.equal(saved.follow_up.evidence?.quote, "I will do mobility");
    // A Coach ask is never labelled a trainee commitment and carries no quote.
    stub.reply = () => ({
      status: 201,
      body: {
        follow_up: followUp({ basis: "coach_request", evidence: null }),
        idempotent: false,
      },
    });
    await backend.followUp(WORK, "commitment-1", {
      ...input,
      basis: "coach_request",
    });
    for (const call of [
      () =>
        backend.followUp(WORK, "commitment-1", {
          ...input,
          basis: "coach_request",
          evidence: {
            message_ref: "sealed.ref-1",
            quote: "I will do mobility",
          },
        }),
      // The quote must be bound to a member message or a leased request.
      () =>
        backend.followUp(WORK, "c-2", {
          ...input,
          evidence: { quote: "I will do mobility" } as any,
        }),
    ])
      await assert.rejects(call, code("AUTONOMY_INVALID"));
  } finally {
    await stub.close();
  }
});

test("v2 status carries content-free ingest coverage", async () => {
  const status = {
    mandate: { mode: "observe", paused: false, status: "active", revision: 2 },
    queue: { queued: 1, running: 0, blocked: 0 },
    last_completed_at: null,
    next_due_at: null,
    blocked: [],
    ingest: {
      roster_pass_completed_at: null,
      members_pending_in_pass: 3,
      members_total: 12,
      lagging_members: 1,
    },
  };
  const stub = await autonomyStub(() => ({ body: status }));
  try {
    const read = await open(stub.origin).status();
    assert.equal(read.ingest.members_total, 12);
    stub.reply = () => ({
      body: {
        ...status,
        ingest: { ...status.ingest, member_names: ["Sam"] },
      },
    });
    await assert.rejects(
      () => open(stub.origin).status(),
      code("AUTONOMY_RESULT_REJECTED"),
    );
  } finally {
    await stub.close();
  }
});
