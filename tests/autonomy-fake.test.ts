import test from "node:test";
import assert from "node:assert/strict";
import { AutonomyBackend, AutonomyFailure } from "../src/autonomy/backend.js";
import {
  autonomyFake,
  HUMAN,
  MEMBER,
  OTHER_MEMBER,
} from "./helpers/autonomy-fake.js";

// The in-memory §2 fake establishes wiring for scheduler/runner tests; the
// paired tests (autonomy-*-paired) establish integration with the backend.
const code = (expected: string) => (e: unknown) =>
  e instanceof AutonomyFailure && e.code === expected;

async function setup(mode: "observe" | "message" = "message") {
  const fake = await autonomyFake();
  try {
    return await configure(fake, mode);
  } catch (error) {
    await fake.close();
    throw error;
  }
}

async function configure(
  fake: Awaited<ReturnType<typeof autonomyFake>>,
  mode: "observe" | "message",
) {
  const a = fake.client("installation-a");
  const b = fake.client("installation-b");
  const current = await a.mandate();
  const {
    protocol,
    mandate_id,
    dojo_id,
    chief_id,
    revision,
    status,
    suspended_reason,
    updated_at,
    updated_by,
    capabilities,
    ...fields
  } = current;
  await a.putMandate({
    idempotency_key: "mandate-setup-1",
    expected_revision: 0,
    mandate: {
      ...fields,
      mode,
      timezone: "Europe/Paris",
      delegated_actions: [
        "manager_report",
        "follow_up",
        ...(mode === "message" ? ["member_message" as const] : []),
      ],
    },
  });
  return { fake, a, b };
}

test("fake: two installations race one due item and exactly one claim wins", async () => {
  const { fake, a, b } = await setup();
  try {
    fake.enqueue({ kind: "event", subject_ids: [MEMBER] });
    const [x, y] = await Promise.all([
      a.claim({ lease_seconds: 60 }),
      b.claim({ lease_seconds: 60 }),
    ]);
    assert.equal([x, y].filter(Boolean).length, 1);
    // One item per mandate at a time, even when more are due.
    fake.enqueue({ kind: "event", subject_ids: [OTHER_MEMBER] });
    assert.equal(await (x ? b : a).claim({}), null);
  } finally {
    await fake.close();
  }
});

test("fake: lease expiry fences the stale holder and the next claimant sees committed slots", async () => {
  const { fake, a, b } = await setup();
  try {
    const id = fake.enqueue({ kind: "event", subject_ids: [MEMBER] });
    const first = (await a.claim({ lease_seconds: 30 }))!;
    await a.start(id, first.lease_generation);
    await a.act(id, "praise-1", {
      lease_generation: first.lease_generation,
      mandate_revision: first.mandate_revision,
      type: "member_message",
      recipient_id: MEMBER,
      text: "Strong session.",
    });
    fake.advance(31_000);
    const second = (await b.claim({ lease_seconds: 30 }))!;
    assert.equal(second.id, id);
    assert.equal(second.lease_generation, first.lease_generation + 1);
    assert.deepEqual(
      second.actions.map((r) => r.slot),
      ["praise-1"],
    );
    await assert.rejects(
      () =>
        a.checkpoint(id, {
          lease_generation: first.lease_generation,
          checkpoint: "x",
        }),
      code("LEASE_LOST"),
    );
    // A stale holder replaying the committed slot gets the receipt, not a second message.
    const replay = await a.act(id, "praise-1", {
      lease_generation: first.lease_generation,
      mandate_revision: first.mandate_revision,
      type: "member_message",
      recipient_id: MEMBER,
      text: "Strong session.",
    });
    assert.equal(replay.idempotent, true);
    assert.equal(fake.messages.length, 1);
  } finally {
    await fake.close();
  }
});

test("fake: a committed send whose reply is lost is recovered by identical re-PUT or receipt read, never duplicated", async () => {
  const { fake, a, b } = await setup();
  try {
    const id = fake.enqueue({ kind: "event", subject_ids: [MEMBER] });
    const work = (await a.claim({}))!;
    await a.start(id, work.lease_generation);
    const intent = {
      lease_generation: work.lease_generation,
      mandate_revision: work.mandate_revision,
      type: "member_message" as const,
      recipient_id: MEMBER,
      text: "Checking in on Thursday's plan.",
    };
    fake.dropNextWrite();
    await assert.rejects(
      () => a.act(id, "check-in", intent),
      code("AUTONOMY_OUTCOME_UNKNOWN"),
    );
    const proof = await b.actionReceipt(id, "check-in");
    const again = await a.act(id, "check-in", intent);
    assert.equal(again.idempotent, true);
    assert.equal(again.receipt.message_id, proof.message_id);
    assert.equal(fake.messages.length, 1);
    await assert.rejects(
      () => a.act(id, "check-in", { ...intent, text: "Changed." }),
      code("ACTION_CONFLICT"),
    );
    await assert.rejects(
      () => a.act(id, "check-in", { ...intent, recipient_id: OTHER_MEMBER }),
      code("ACTION_CONFLICT"),
    );
    assert.equal(fake.messages.length, 1);
  } finally {
    await fake.close();
  }
});

test("fake: observe mode only permits manager reports; complete rejects uncertified slots", async () => {
  const { fake, a } = await setup("observe");
  try {
    const id = fake.enqueue({ kind: "event", subject_ids: [MEMBER] });
    const work = (await a.claim({}))!;
    await a.start(id, work.lease_generation);
    const fence = {
      lease_generation: work.lease_generation,
      mandate_revision: work.mandate_revision,
    };
    await assert.rejects(
      () =>
        a.act(id, "praise", {
          ...fence,
          type: "member_message",
          recipient_id: MEMBER,
          text: "Nice.",
        }),
      code("ACTION_UNSUPPORTED"),
    );
    const report = await a.act(id, "report", {
      ...fence,
      type: "manager_report",
      text: "Observed one session.",
    });
    assert.equal(report.receipt.recipient_id, fake.chief);
    const outcome = (slots: string[]) => ({
      result: "completed" as const,
      coverage: {
        members_considered: 1,
        members_read: 1,
        partial: false,
        unobserved: [],
      },
      decisions: [
        {
          subject_id: MEMBER,
          decision: "acted" as const,
          action_slots: slots,
          follow_up_ids: [],
        },
      ],
      uncertainty: [],
      budget: { provider_tokens: 10, tool_calls: 1, elapsed_ms: 5 },
    });
    await assert.rejects(
      () => a.complete(id, { ...fence, outcome: outcome(["praise"]) }),
      code("AUTONOMY_INVALID"),
    );
    const done = await a.complete(id, {
      ...fence,
      outcome: outcome(["report"]),
    });
    assert.equal(done.work.status, "completed");
    assert.equal((await a.reports()).items[0].action_slots[0], "report");
  } finally {
    await fake.close();
  }
});

test("fake: a human session may configure but never claim; a mandate change fences completion", async () => {
  const { fake, a } = await setup();
  try {
    const human = fake.client(HUMAN);
    fake.enqueue({ kind: "event", subject_ids: [MEMBER] });
    await assert.rejects(
      () => human.claim({}),
      code("AUTONOMY_NOT_AUTHORIZED"),
    );
    const work = (await a.claim({}))!;
    await a.start(work.id, work.lease_generation);
    const current = await human.mandate();
    const {
      protocol,
      mandate_id,
      dojo_id,
      chief_id,
      revision,
      status,
      suspended_reason,
      updated_at,
      updated_by,
      capabilities,
      ...fields
    } = current;
    const saved = await human.putMandate({
      idempotency_key: "mandate-human-1",
      expected_revision: revision,
      mandate: { ...fields, paused: true },
    });
    assert.equal(saved.mandate.updated_by, "account_owner_session");
    await assert.rejects(
      () =>
        human.putMandate({
          idempotency_key: "mandate-human-2",
          expected_revision: revision,
          mandate: fields,
        }),
      code("AUTONOMY_CONFLICT"),
    );
    await assert.rejects(
      () =>
        a.complete(work.id, {
          lease_generation: work.lease_generation,
          mandate_revision: work.mandate_revision,
          outcome: {
            result: "completed",
            coverage: {
              members_considered: 0,
              members_read: 0,
              partial: false,
              unobserved: [],
            },
            decisions: [],
            uncertainty: [],
            budget: { provider_tokens: 0, tool_calls: 0, elapsed_ms: 0 },
          },
        }),
      code("AUTONOMY_MANDATE_CHANGED"),
    );
  } finally {
    await fake.close();
  }
});
