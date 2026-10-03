import test from "node:test";
import assert from "node:assert/strict";
import { AutonomyBackend, AutonomyFailure } from "../src/autonomy/backend.js";
import type { CycleOutcome, MandateView } from "../src/autonomy/types.js";
import { pairedSkip } from "./helpers/account-backend.js";
import { startAutonomyBackend } from "./helpers/autonomy-backend.js";

// C2/B6 paired gate: the client's AutonomyBackend transport and validators
// against the REAL coach.autonomy.v1 routes (B1/B2/B5) on a disposable Mongo
// replica set: mandate CAS and idempotent replay, one claim across two
// installations, lease loss fencing the stale holder, pause, credential
// revoke, and the B5 status/reports read models.

const clock = (minutes: number) =>
  new Date(Date.now() + minutes * 60000).toISOString().slice(11, 16);
const AWAY = () => ({ start: clock(120), end: clock(180) });

const rejects = async (fn: () => Promise<unknown>, code: string) =>
  assert.rejects(fn, (e: unknown) => {
    assert.ok(e instanceof AutonomyFailure, String(e));
    assert.equal(e.code, code);
    return true;
  });

const fields = (view: MandateView) => {
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
    ...rest
  } = view as any;
  return rest;
};

test(
  "autonomy backend client paired with the actual backend routes and Mongo",
  { skip: pairedSkip, timeout: 600000 },
  async (t) => {
    const b = await startAutonomyBackend();
    t.after(() => b.close());
    const signal = new AbortController().signal;
    const client = (token: string) =>
      new AutonomyBackend(b.origin, token, signal, [token]);
    const done = (subject: unknown): CycleOutcome => ({
      result: "completed",
      coverage: {
        members_considered: 1,
        members_read: 1,
        partial: false,
        unobserved: [],
      },
      decisions: [
        {
          subject_id: String(subject),
          decision: "no_action",
          action_slots: [],
          follow_up_ids: [],
        },
      ],
      uncertainty: [],
      budget: { provider_tokens: 0, tool_calls: 0, elapsed_ms: 0 },
    });

    const tokenA = await b.bearer();
    const tokenB = await b.bearer();
    const [a, bb] = [client(tokenA), client(tokenB)];

    await t.test(
      "mandate: a Coach bearer reads the capability view and CAS-updates it; same key+body replays, a changed body or stale revision is refused",
      async () => {
        await b.saveMandate({
          mode: "message",
          timezone: "UTC",
          quiet_hours: AWAY(),
          delegated_actions: ["member_message", "manager_report", "follow_up"],
        });
        const view = await a.mandate();
        assert.equal(view.mode, "message");
        assert.ok(view.capabilities.action_types.includes("member_message"));
        assert.ok(
          view.capabilities.blocked_reasons?.includes("composition_rejected"),
        );
        const put = {
          idempotency_key: "paired-mandate-0001",
          expected_revision: view.revision,
          mandate: {
            ...fields(view),
            digest: {
              ...view.digest,
              suppress_empty: !view.digest.suppress_empty,
            },
          },
        };
        const first = await a.putMandate(put);
        assert.equal(first.idempotent, false);
        assert.equal(first.mandate.revision, view.revision + 1);
        assert.equal(first.mandate.updated_by, "external_coach");
        assert.equal(
          first.mandate.digest.suppress_empty,
          !view.digest.suppress_empty,
        );
        // A lost response is safely retried by replaying the same key + body,
        // even from the other installation of the same account.
        const replay = await bb.putMandate(put);
        assert.equal(replay.idempotent, true);
        assert.equal(replay.mandate.revision, first.mandate.revision);
        await rejects(
          () =>
            a.putMandate({
              ...put,
              mandate: { ...put.mandate, paused: !put.mandate.paused },
            }),
          "AUTONOMY_IDEMPOTENCY_CONFLICT",
        );
        await rejects(
          () =>
            a.putMandate({ ...put, idempotency_key: "paired-mandate-0002" }),
          "AUTONOMY_CONFLICT",
        );
        assert.equal((await bb.mandate()).revision, first.mandate.revision);
      },
    );

    let completedWork = "";
    await t.test(
      "claims: two installations race for one due item, exactly one wins; an expired lease fences the stale holder out of checkpoint and complete",
      async () => {
        const view = await a.mandate();
        await b.enqueue(view.mandate_id);
        const raced = await Promise.all([a.claimCycle(), bb.claimCycle()]);
        const winners = raced.filter((c) => c !== null);
        assert.equal(winners.length, 1, "exactly one claim succeeds");
        const [first, second] = raced[0] ? [a, bb] : [bb, a];
        const claimed = winners[0]!;
        assert.ok(claimed.capability, "capability negotiated");
        const work = await first.start(
          claimed.work.id,
          claimed.work.lease_generation,
        );
        assert.equal(work.status, "running");
        await first.checkpoint(work.id, {
          lease_generation: work.lease_generation,
          checkpoint: "synthetic-progress",
        });
        // One cycle per mandate: a live lease blocks every other claim.
        assert.equal(await second.claimCycle(), null);

        // The holder crashes; its lease lapses and the other installation
        // takes the work over under a higher generation.
        await b.expire(work.id);
        const taken = await second.claimCycle();
        assert.equal(taken?.work.id, work.id);
        assert.ok(taken!.work.lease_generation > work.lease_generation);
        await second.start(taken!.work.id, taken!.work.lease_generation);
        await rejects(
          () =>
            first.checkpoint(work.id, {
              lease_generation: work.lease_generation,
              checkpoint: "stale",
            }),
          "LEASE_LOST",
        );
        await rejects(
          () =>
            first.complete(work.id, {
              lease_generation: work.lease_generation,
              mandate_revision: view.revision,
              outcome: done(b.member),
            }),
          "LEASE_LOST",
        );
        const finished = await second.complete(work.id, {
          lease_generation: taken!.work.lease_generation,
          mandate_revision: view.revision,
          outcome: done(b.member),
        });
        assert.equal(finished.work.status, "completed");
        assert.match(finished.report_id, /^[0-9a-f]{24}$/);
        completedWork = work.id;
      },
    );

    await t.test(
      "B5 read models: status and paginated reports validate through the client and reflect the completed cycle",
      async () => {
        const view = await a.mandate();
        // A second completed cycle so the report list needs a page break.
        await b.enqueue(view.mandate_id);
        const claimed = (await a.claimCycle())!;
        await a.start(claimed.work.id, claimed.work.lease_generation);
        await a.complete(claimed.work.id, {
          lease_generation: claimed.work.lease_generation,
          mandate_revision: view.revision,
          outcome: done(b.member),
        });

        const status = await bb.status();
        assert.equal(status.mandate.mode, "message");
        assert.equal(status.mandate.revision, view.revision);
        assert.equal(status.queue.running, 0);
        assert.equal(status.queue.queued, 0);
        assert.notEqual(status.last_completed_at, null);
        assert.deepEqual(status.blocked, []);

        const page1 = await bb.reports({ limit: 1 });
        assert.equal(page1.items.length, 1);
        assert.equal(page1.has_more, true);
        assert.equal(page1.items[0].work_id, claimed.work.id);
        const page2 = await bb.reports({
          limit: 1,
          cursor: page1.next_cursor!,
        });
        assert.equal(page2.items[0].work_id, completedWork);
        assert.equal(page2.items[0].result, "completed");
        assert.deepEqual(page2.items[0].coverage, done(b.member).coverage);
      },
    );

    await t.test(
      "pause stops admission without a claim; a revoked installation credential fails as expired auth while the other keeps working",
      async () => {
        const view = await a.mandate();
        await b.saveMandate({ paused: true });
        await b.enqueue(view.mandate_id);
        await rejects(() => a.claimCycle(), "AUTONOMY_DISABLED");
        assert.equal((await a.status()).queue.queued, 1);
        await b.saveMandate({ paused: false });

        await b.db
          .collection("external_coach_credentials")
          .updateMany(
            { token_hash: { $exists: true } },
            { $set: { revoked_at: new Date() } },
          );
        const tokenC = await b.bearer();
        await rejects(() => a.mandate(), "AUTONOMY_AUTH_EXPIRED");
        await rejects(() => bb.claimCycle(), "AUTONOMY_AUTH_EXPIRED");
        const c = client(tokenC);
        const claimed = await c.claimCycle();
        assert.ok(claimed, "a live installation still claims");
      },
    );
  },
);
