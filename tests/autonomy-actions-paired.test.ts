import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { AutonomyBackend, AutonomyFailure } from "../src/autonomy/backend.js";
import { settleAction, settleFollowUp } from "../src/autonomy/actions.js";
import { autonomyRunner } from "../src/autonomy/runner.js";
import { lossyProxy, pairedSkip } from "./helpers/account-backend.js";
import { startAutonomyBackend } from "./helpers/autonomy-backend.js";
import {
  outcome,
  ScriptedRuntime,
  type Script,
} from "./helpers/autonomy-cycle.js";

// C4 paired gate: the client's settle-then-prove action path and the real
// runner against the REAL coach.autonomy.v1 routes (B4) on a disposable Mongo
// replica set. Lost responses, lost requests, crash before complete and
// credential rotation across two installations of the same chief account
// never produce a second coach_chats message.

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const ALL = ["member_message", "manager_report", "follow_up"];
const clock = (minutes: number) =>
  new Date(Date.now() + minutes * 60000).toISOString().slice(11, 16);
const AWAY = () => ({ start: clock(120), end: clock(180) });
const text = (r: any) => JSON.parse(r.content[0].text);

test(
  "autonomy actions paired with the actual backend routes and Mongo",
  { skip: pairedSkip, timeout: 600000 },
  async (t) => {
    const b = await startAutonomyBackend();
    t.after(() => b.close());
    const proxy = await lossyProxy(b.origin);
    t.after(() => proxy.close());
    const signal = new AbortController().signal;
    const client = (origin: string, token: string) =>
      new AutonomyBackend(origin, token, signal, [token]);

    await t.test(
      "member_message: lost request, lost response, rotation and changed payload stay one message per slot",
      async () => {
        const mandate = await b.saveMandate({
          mode: "message",
          timezone: "UTC",
          quiet_hours: AWAY(),
          delegated_actions: ALL,
        });
        const [tokenA, tokenB] = [await b.bearer(), await b.bearer()];
        const a = client(proxy.origin, tokenA);
        await b.enqueue(mandate.mandate_id);
        const claimed = await a.claimCycle({ lease_seconds: 120 });
        assert.ok(claimed?.capability, "capability negotiated");
        assert.ok(claimed.capability.actions.includes("member_message"));
        const work = await a.start(
          claimed.work.id,
          claimed.work.lease_generation,
        );
        // Dispatch-path isolation: compositions seeded at the storage boundary
        // (the full B11 intent route is paired in autonomy-compose-paired).
        const compose = (slot: string, body: string, recipient = b.member) =>
          b.db.collection("coach_autonomy_intents").insertOne({
            _id: sha(JSON.stringify([String(work.id), slot])),
            work_id: new b.ObjectId(work.id),
            mandate_id: new b.ObjectId(work.mandate_id),
            slot,
            type: "member_message",
            recipient_id: String(recipient),
            purpose: "check_in",
            evidence_refs: [],
            composition: {
              text: body,
              text_sha256: sha(body),
              stored_at: new Date(),
            },
            created_at: new Date(),
          });
        const fence = {
          lease_generation: work.lease_generation,
          mandate_revision: work.mandate_revision,
        };
        const nudge = "Synthetic check-in: how did the long run feel?";
        await compose("nudge", nudge);
        proxy.state.loseNext = true;
        const lost = await settleAction(a, work.id, "nudge", {
          ...fence,
          type: "member_message",
          recipient_id: String(b.member),
          text: nudge,
        });
        assert.equal(lost.recovered, true);
        assert.equal(lost.receipt.text_sha256, sha(nudge));

        const other = "Synthetic check-in: rest day tomorrow?";
        await compose("other", other, b.other);
        proxy.state.dropNext = true;
        const dropped = await settleAction(a, work.id, "other", {
          ...fence,
          type: "member_message",
          recipient_id: String(b.other),
          text: other,
        });
        assert.equal(dropped.recovered, true);
        assert.equal(dropped.idempotent, true, "proved by the receipt GET");
        const wire = (slot: string) =>
          proxy.state.requests
            .filter((r: any) => r.path.endsWith(`/actions/${slot}`))
            .map((r: any) => r.method);
        assert.deepEqual(
          wire("nudge"),
          ["PUT", "GET", "PUT"],
          "404, then one identical re-PUT",
        );
        assert.deepEqual(
          wire("other"),
          ["PUT", "GET"],
          "committed: the receipt proves it, no re-send",
        );

        // Crash; a second installation of the same chief takes over.
        await b.expire(work.id);
        const rotated = client(b.origin, tokenB);
        const again = await rotated.claimCycle({ lease_seconds: 120 });
        assert.equal(again?.work.id, work.id);
        assert.deepEqual(
          again!.work.actions.map((r) => r.slot).sort(),
          ["nudge", "other"],
          "prior receipts travel with the work item",
        );
        const taken = await rotated.start(
          again!.work.id,
          again!.work.lease_generation,
        );
        const replay = await settleAction(rotated, taken.id, "nudge", {
          lease_generation: taken.lease_generation,
          mandate_revision: taken.mandate_revision,
          type: "member_message",
          recipient_id: String(b.member),
          text: nudge,
        });
        assert.equal(replay.idempotent, true);
        assert.deepEqual(replay.receipt, lost.receipt);
        await assert.rejects(
          settleAction(rotated, taken.id, "nudge", {
            lease_generation: taken.lease_generation,
            mandate_revision: taken.mandate_revision,
            type: "member_message",
            recipient_id: String(b.member),
            text: "Synthetic different text.",
          }),
          (e: any) =>
            e instanceof AutonomyFailure && e.code === "ACTION_CONFLICT",
        );
        const toMember = await b.chat(b.member);
        assert.equal(toMember.length, 1);
        assert.equal(toMember[0].text, nudge);
        assert.equal(toMember[0].source, "external_agent");
        assert.equal((await b.chat(b.other)).length, 1);
        assert.equal(
          await b.db
            .collection("coach_member_message_receipts")
            .countDocuments(),
          2,
        );
        const follow = await settleFollowUp(rotated, taken.id, "f1", {
          lease_generation: taken.lease_generation,
          mandate_revision: taken.mandate_revision,
          subject_id: String(b.member),
          basis: "coach_request",
          summary: "Synthetic: check recovery next week.",
          due_at: new Date(Date.now() + 7 * 86400000).toISOString(),
          next_condition: "A logged session.",
        });
        assert.equal(follow.recovered, false);
        await rotated.complete(taken.id, {
          lease_generation: taken.lease_generation,
          mandate_revision: taken.mandate_revision,
          outcome: JSON.parse(
            outcome({
              decisions: [
                {
                  subject_id: String(b.member),
                  decision: "acted",
                  action_slots: ["nudge"],
                  follow_up_ids: [follow.follow_up.id],
                },
                {
                  subject_id: String(b.other),
                  decision: "acted",
                  action_slots: ["other"],
                  follow_up_ids: [],
                },
              ],
              coverage: {
                members_considered: 2,
                members_read: 2,
                partial: false,
                unobserved: [],
              },
            }),
          ),
        });
      },
    );

    await t.test(
      "real runner: manager report lost response, crash before complete, rotated installation certifies the prior receipt once",
      async () => {
        const mandate = await b.saveMandate({
          mode: "observe",
          timezone: "UTC",
          delegated_actions: ["manager_report", "follow_up"],
        });
        const [tokenA, tokenB] = [await b.bearer(), await b.bearer()];
        const dir = await mkdtemp(tmpdir() + "/autonomy-paired-");
        t.after(() => rm(dir, { recursive: true, force: true }));
        const store = new Store(dir);
        await store.init();
        await store.save({
          ...store.publicConfig(),
          origin: b.origin,
          provider: { baseUrl: b.origin + "/v1", model: "synthetic-model" },
          token: tokenA,
          apiKey: "synthetic-provider-credential",
        });
        const before = (await b.chat(b.chief)).length;
        const report = "Synthetic private report: one member trained twice.";
        await b.enqueue(mandate.mandate_id);
        const run = async (
          backend: AutonomyBackend,
          script: Script,
          abort?: AbortController,
        ) => {
          const claimed = await backend.claimCycle({ lease_seconds: 120 });
          assert.ok(claimed);
          const work = await backend.start(
            claimed.work.id,
            claimed.work.lease_generation,
          );
          const runtime = new ScriptedRuntime([script]);
          const result = await autonomyRunner({ store, runtime })({
            work,
            mandate: await backend.mandate(),
            backend,
            signal: abort?.signal ?? signal,
            capability: claimed.capability,
          });
          if (runtime.errors.length) throw runtime.errors[0];
          return { result, runtime, work };
        };
        const crash = new AbortController();
        let workId = "";
        await assert.rejects(
          run(
            client(proxy.origin, tokenA),
            async ({ call }) => {
              proxy.state.dropNext = true;
              const r = await call("coach_autonomy_report", {
                slot: "r1",
                text: report,
              });
              assert.equal(text(r).recovered, true);
              crash.abort(new Error("PROCESS_EXIT"));
              throw new Error("PROCESS_EXIT");
            },
            crash,
          ),
        );
        const [stuck] = await b.db
          .collection("coach_autonomy_work")
          .find({ status: "running" })
          .toArray();
        workId = String(stuck._id);
        await b.expire(workId);
        const { result, runtime } = await run(
          client(b.origin, tokenB),
          async ({ message, call }) => {
            assert.match(message, /"slot":"r1"/);
            assert.match(message, new RegExp(sha(report)));
            const r = await call("coach_autonomy_report", {
              slot: "r1",
              text: report,
            });
            assert.equal(text(r).idempotent, true);
            return outcome({
              decisions: [
                {
                  subject_id: null,
                  decision: "acted",
                  action_slots: ["r1"],
                  follow_up_ids: [],
                },
              ],
            });
          },
        );
        assert.ok(runtime.runs[0].calls.every((c) => c.ok));
        assert.equal(result.outcome.result, "completed");
        const toChief = (await b.chat(b.chief)).slice(before);
        assert.equal(toChief.length, 1);
        assert.equal(toChief[0].text, report);
        const done = await b.db
          .collection("coach_autonomy_work")
          .findOne({ _id: new b.ObjectId(workId) });
        assert.equal(done.status, "completed");
        assert.equal(done.actions.length, 1);
      },
    );

    await t.test(
      "real runner: conversation work reads the member conversation over REST (B7); a pending question shows its request status",
      async () => {
        const mandate = await b.saveMandate({
          mode: "observe",
          timezone: "UTC",
          delegated_actions: ["manager_report", "follow_up"],
        });
        const token = await b.bearer();
        const dir = await mkdtemp(tmpdir() + "/autonomy-paired-");
        t.after(() => rm(dir, { recursive: true, force: true }));
        const store = new Store(dir);
        await store.init();
        await store.save({
          ...store.publicConfig(),
          origin: b.origin,
          provider: { baseUrl: b.origin + "/v1", model: "synthetic-model" },
          token,
          apiKey: "synthetic-provider-credential",
        });
        const request = (
          await b.db.collection("external_coach_requests").insertOne({
            user_id: b.member,
            requester_id: b.member,
            owner_type: "dojo",
            owner_id: b.dojo,
            requester_generation: 0,
            status: "working",
            created_at: new Date(Date.now() - 120000),
          })
        ).insertedId;
        await b
          .backendModule("./core/coachChatStore")
          .appendCoachChatMessages(b.db, b.member, [
            {
              _id: new b.ObjectId(),
              role: "user",
              text: "Synthetic question: should I deload next week?",
              created_at: new Date(Date.now() - 60000),
              external_request_id: String(request),
            },
          ]);
        await b.enqueue(mandate.mandate_id, {
          kind: "conversation",
          source: {
            conversation: {
              member_id: String(b.member),
              from_epoch: 0,
              to_epoch: 1,
            },
          },
        });
        const backend = client(b.origin, token);
        const claimed = await backend.claimCycle({ lease_seconds: 120 });
        assert.ok(claimed);
        const work = await backend.start(
          claimed.work.id,
          claimed.work.lease_generation,
        );
        let read: any;
        const runtime = new ScriptedRuntime([
          async ({ message, call }) => {
            const path = message.match(
              /GET (\/api\/coach\/member-conversations\/[^\s.]+)/,
            )?.[1];
            assert.ok(path, "reader hint for this member");
            const r = await call("katafit_rest_get", { path });
            read = r.content[0].text;
            return outcome({
              decisions: [
                {
                  subject_id: String(b.member),
                  decision: "no_action",
                  action_slots: [],
                  follow_up_ids: [],
                },
              ],
            });
          },
        ]);
        const result = await autonomyRunner({ store, runtime })({
          work,
          mandate: await backend.mandate(),
          backend,
          signal,
          capability: claimed.capability,
        });
        if (runtime.errors.length) throw runtime.errors[0];
        assert.ok(runtime.runs[0].calls.every((c) => c.ok));
        assert.match(runtime.runs[0].catalog.prompt, /request worker/i);
        assert.match(read, /should I deload next week/);
        assert.match(read, /"request_status":"working"/);
        assert.match(read, /retained_main_coach_conversation/);
        assert.equal(result.outcome.result, "completed");
      },
    );

    await t.test(
      "public_praise (B8): lost response recovered by receipt, different activity on the slot is a conflict, same occurrence never published twice",
      async () => {
        const mandate = await b.saveMandate({
          mode: "message",
          timezone: "UTC",
          quiet_hours: AWAY(),
          delegated_actions: [...ALL, "public_praise"],
        });
        await b.db.collection("users").updateOne(
          { _id: b.member },
          {
            $set: {
              display_name: "Synthetic Member",
              privacy_settings: { workout: ["dojo"] },
            },
          },
        );
        const completed = new Date("2026-10-02T09:30:00.000Z");
        const activity = async () => {
          const doc = {
            _id: new b.ObjectId(),
            user_id: b.member,
            type: "workout",
            name: "Synthetic leg day",
            status: "completed",
            completed_at: completed,
            is_template: false,
            data: { exercises: [] },
          };
          await b.db.collection("activities").insertOne(doc);
          return doc;
        };
        const [actA, actB] = [await activity(), await activity()];
        const refs = [actA, actB].map((act) => ({
          ledger_id: String(new b.ObjectId()),
          occurred_at: new Date().toISOString(),
          event_type: "workout.completed",
          subject: { type: "workout", id: String(act._id) },
        }));
        await b.enqueue(mandate.mandate_id, {
          source: { event_ids: refs.map((r) => r.ledger_id), events: refs },
        });
        const token = await b.bearer();
        const backend = client(proxy.origin, token);
        const claimed = await backend.claimCycle({ lease_seconds: 120 });
        assert.ok(claimed);
        const work = await backend.start(
          claimed.work.id,
          claimed.work.lease_generation,
        );
        const words = "Synthetic Member closed out leg day. Strong work.";
        // Dispatch-path isolation (B11 + C11: autonomy-compose-paired).
        const compose = (slot: string, act: any) =>
          b.db.collection("coach_autonomy_intents").insertOne({
            _id: sha(JSON.stringify([work.id, slot])),
            work_id: new b.ObjectId(work.id),
            mandate_id: new b.ObjectId(mandate.mandate_id),
            slot,
            type: "public_praise",
            activity_id: String(act._id),
            completed_at: completed.toISOString(),
            purpose: "completion_praise",
            evidence_refs: [],
            composition: {
              text: words,
              text_sha256: sha(words),
              stored_at: new Date(),
            },
            created_at: new Date(),
          });
        await compose("p1", actA);
        await compose("p2", actA);
        const praise = (act: any) => ({
          lease_generation: work.lease_generation,
          mandate_revision: work.mandate_revision,
          type: "public_praise" as const,
          activity_id: String(act._id),
          completed_at: completed.toISOString(),
          text: words,
        });
        const before = b.fanout.length;
        const chatBefore = (await b.chat(b.member)).length;
        proxy.state.requests.length = 0;
        proxy.state.dropNext = true;
        const first = await settleAction(backend, work.id, "p1", praise(actA));
        assert.equal(first.recovered, true);
        assert.equal(first.receipt.status, "published");
        assert.equal(first.receipt.activity_id, String(actA._id));
        assert.deepEqual(
          proxy.state.requests.map((r: any) => r.method),
          ["PUT", "GET"],
        );

        proxy.state.loseNext = true;
        await assert.rejects(
          settleAction(backend, work.id, "p1", praise(actB)),
          (e: any) => e.code === "ACTION_CONFLICT",
        );

        const again = await settleAction(backend, work.id, "p2", praise(actA));
        assert.equal(again.receipt.status, "already_published");
        assert.equal(again.receipt.comment_id, first.receipt.comment_id);

        const comments = await b.db
          .collection("dojo_coach_comments")
          .find({})
          .toArray();
        assert.equal(comments.length, 1);
        assert.equal(comments[0].text, words);
        assert.equal(comments[0].provenance.source, "external_agent");
        assert.equal(
          (await b.chat(b.member)).length,
          chatBefore,
          "never a private message",
        );
        assert.equal(
          b.fanout.slice(before).filter((f: any) => f[0] === "broadcastToUsers")
            .length,
          1,
          "one toast",
        );
      },
    );
  },
);
