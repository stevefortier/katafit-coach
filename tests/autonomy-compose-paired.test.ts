import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { compileComposer, Store } from "../src/config/store.js";
import { AutonomyBackend } from "../src/autonomy/backend.js";
import { autonomyRunner } from "../src/autonomy/runner.js";
import { INTEND_TOOL } from "../src/autonomy/tools.js";
import {
  closeServer,
  lossyProxy,
  pairedSkip,
} from "./helpers/account-backend.js";
import { startAutonomyBackend } from "./helpers/autonomy-backend.js";
import {
  composerScript,
  outcome,
  ScriptedRuntime,
  type Script,
} from "./helpers/autonomy-cycle.js";

// [AC1] C11 paired gate: the real runner's planner intent, isolated composer,
// stored composition and exact dispatch against the REAL B11 intents and
// compositions routes (and B4/B8 dispatch) on a disposable Mongo replica set.

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const ALL = ["manager_report", "follow_up", "member_message", "public_praise"];
const clock = (minutes: number) =>
  new Date(Date.now() + minutes * 60000).toISOString().slice(11, 16);
const AWAY = () => ({ start: clock(120), end: clock(180) });
const parse = (r: any) => JSON.parse(r.content[0].text);
// Several member messages to the same synthetic member in one suite.
const LIMITS = {
  member_daily: 5,
  member_cooldown_minutes: 0,
  dojo_daily: 200,
  praise_daily: 10,
};

/** A synthetic OpenAI-compatible provider: the composer's only upstream. */
async function syntheticProvider() {
  const bodies: string[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    bodies.push(raw);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    origin: `http://127.0.0.1:${(server.address() as any).port}`,
    bodies,
    close: () => closeServer(server),
  };
}

test(
  "C11 planner/composer split paired with the actual B11 routes and Mongo",
  { skip: pairedSkip, timeout: 600000 },
  async (t) => {
    const b = await startAutonomyBackend();
    t.after(() => b.close());
    const proxy = await lossyProxy(b.origin);
    t.after(() => proxy.close());
    const provider = await syntheticProvider();
    t.after(() => provider.close());

    const storeFor = async (token: string) => {
      const dir = await mkdtemp(tmpdir() + "/autonomy-compose-paired-");
      t.after(() => rm(dir, { recursive: true, force: true }));
      const store = new Store(dir);
      await store.init();
      await store.save({
        ...store.publicConfig(),
        origin: proxy.origin,
        provider: {
          baseUrl: provider.origin + "/v1",
          model: "synthetic-model",
        },
        token,
        apiKey: "synthetic-provider-credential",
      });
      return store;
    };
    // A member question with proven Dojo scope (a Dojo-owned request).
    const question = async (text: string) => {
      const request = (
        await b.db.collection("external_coach_requests").insertOne({
          user_id: b.member,
          requester_id: b.member,
          owner_type: "dojo",
          owner_id: b.dojo,
          requester_generation: 0,
          status: "completed",
          created_at: new Date(Date.now() - 120000),
        })
      ).insertedId;
      await b
        .backendModule("./core/coachChatStore")
        .appendCoachChatMessages(b.db, b.member, [
          {
            _id: new b.ObjectId(),
            role: "user",
            text,
            created_at: new Date(Date.now() - 60000),
            external_request_id: String(request),
          },
        ]);
    };
    const conversationWork = async (mandateId: string) =>
      b.enqueue(mandateId, {
        kind: "conversation",
        source: {
          conversation: {
            member_id: String(b.member),
            from_epoch: 0,
            to_epoch: 1,
          },
        },
      });
    const claim = async (token: string) => {
      const backend = new AutonomyBackend(
        proxy.origin,
        token,
        new AbortController().signal,
        [token],
      );
      const claimed = await backend.claimCycle({ lease_seconds: 120 });
      assert.ok(claimed?.capability, "capability negotiated");
      const work = await backend.start(
        claimed.work.id,
        claimed.work.lease_generation,
      );
      return { backend, claimed, work };
    };
    /** Reads the member conversation; returns the member's newest message_ref. */
    const readRef = async (io: any) => {
      const path = io.message.match(
        /GET (\/api\/coach\/member-conversations\/\S+)/,
      )?.[1];
      assert.ok(path, "reader hint for this member");
      const r = await io.call("katafit_rest_get", { path });
      assert.ok(!r.error, JSON.stringify(r));
      const items = JSON.parse(r.content[0].text).items.filter(
        (i: any) => i.role === "user",
      );
      return items[items.length - 1].message_ref as string;
    };
    const memberIntent = (ref: string) => ({
      type: "member_message",
      recipient_id: String(b.member),
      purpose: "answer_question",
      tone: "warm",
      evidence_refs: [`msg:${ref}`],
    });
    const acted = (slots: string[], subject = String(b.member)) =>
      outcome({
        coverage: {
          members_considered: 1,
          members_read: 1,
          partial: false,
          unobserved: [],
        },
        decisions: [
          {
            subject_id: subject,
            decision: "acted",
            action_slots: slots,
            follow_up_ids: [],
          },
        ],
      } as any);
    /** Wraps the real client to act right after the composition is stored. */
    const afterComposition = (backend: AutonomyBackend, hook: () => void) =>
      new Proxy(backend, {
        get(target, key) {
          if (key === "putComposition")
            return async (...args: any[]) => {
              const out = await (target.putComposition as any)(...args);
              hook();
              return out;
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const intentRow = (workId: string, slot: string) =>
      b.db
        .collection("coach_autonomy_intents")
        .findOne({ work_id: new b.ObjectId(workId), slot });
    const memberChat = async () =>
      (await b.chat(b.member)).filter((m: any) => m.role !== "user");

    await t.test(
      "member_message: real B11 verifies the msg ref; the stored composition is the exact delivered row and its text is erased",
      async () => {
        const mandate = await b.saveMandate({
          mode: "message",
          timezone: "UTC",
          quiet_hours: AWAY(),
          delegated_actions: ALL,
          contact_limits: LIMITS,
        });
        await question("Synthetic question: should I deload after the meet?");
        await conversationWork(mandate.mandate_id);
        const token = await b.bearer();
        const store = await storeFor(token);
        const { backend, claimed, work } = await claim(token);
        assert.ok(claimed.capability!.actions.includes("member_message"));
        const composed =
          "Great question. A lighter week after the meet is a smart call.";
        const captured: string[] = [];
        const composer = new ScriptedRuntime(
          [composerScript(composed)],
          "composer-",
        );
        const before = (await memberChat()).length;
        const runtime = new ScriptedRuntime([
          async (io) => {
            const ref = await readRef(io);
            const r = parse(
              await io.call(INTEND_TOOL, {
                slot: "m1",
                intent: memberIntent(ref),
              }),
            );
            assert.deepEqual(r, {
              slot: "m1",
              status: "delivered",
              idempotent: false,
            });
            return acted(["m1"]);
          },
        ]);
        const result = await autonomyRunner({
          store,
          runtime,
          compose: {
            runtime: composer,
            onProviderRequest: (w) => captured.push(w),
          },
        })({
          work,
          mandate: await backend.mandate(),
          backend,
          signal: new AbortController().signal,
          capability: claimed.capability,
        });
        if (runtime.errors.length) throw runtime.errors[0];
        assert.equal(result.outcome.result, "completed");
        assert.equal(composer.runs.length, 1);
        assert.deepEqual(composer.runs[0].catalog.tools, []);
        assert.ok(!composer.runs[0].message.includes("Prioritise"));
        const delivered = (await memberChat()).slice(before);
        assert.equal(delivered.length, 1);
        assert.equal(delivered[0].text, composed);
        const row = await intentRow(work.id, "m1");
        assert.equal(row.status, "dispatched");
        assert.equal(row.composition.text, undefined, "AC1 retention erase");
        assert.equal(row.composition.text_sha256, sha(composed));
        assert.equal(
          row.composition.persona_revision,
          sha(compileComposer(store.publicConfig(), "member")),
        );
        assert.equal(captured.length, 1);
        assert.deepEqual(row.composition.provider_request_sha256, [
          sha(captured[0]),
        ]);
        const done = await b.db
          .collection("coach_autonomy_work")
          .findOne({ _id: new b.ObjectId(work.id) });
        assert.equal(done.status, "completed");
        assert.deepEqual(
          done.intents.map((i: any) => [i.slot, i.status]),
          [["m1", "dispatched"]],
        );
      },
    );

    await t.test(
      "a refused ref (another member's message) writes no intent; a crash after the composition is stored is dispatched by a rotated installation with no recompose",
      async () => {
        const mandate = await b.saveMandate({
          mode: "message",
          timezone: "UTC",
          quiet_hours: AWAY(),
          delegated_actions: ALL,
          contact_limits: LIMITS,
        });
        await question("Synthetic question: is a 5k on Sunday too much?");
        await conversationWork(mandate.mandate_id);
        const [tokenA, tokenB] = [await b.bearer(), await b.bearer()];
        const first = await claim(tokenA);
        const stored = "Stored before the crash: an easy 5k on Sunday is fine.";
        let firstRef = "";
        const crash = new AbortController();
        const before = (await memberChat()).length;
        await assert.rejects(
          autonomyRunner({
            store: await storeFor(tokenA),
            runtime: new ScriptedRuntime([
              async (io) => {
                const ref = await readRef(io);
                const other = parse(
                  await io.call(INTEND_TOOL, {
                    slot: "x1",
                    intent: {
                      ...memberIntent(ref),
                      recipient_id: String(b.other),
                    },
                  }),
                );
                assert.equal(other.error, "INTENT_EVIDENCE_NOT_AUTHORIZED");
                firstRef = ref;
                await io.call(INTEND_TOOL, {
                  slot: "m1",
                  intent: memberIntent(ref),
                });
                return acted(["m1"]);
              },
            ]),
            compose: {
              runtime: new ScriptedRuntime(
                [composerScript(stored)],
                "composer-",
              ),
            },
          })({
            work: first.work,
            mandate: await first.backend.mandate(),
            backend: afterComposition(first.backend, () =>
              crash.abort(new Error("host crashed")),
            ),
            signal: crash.signal,
            capability: first.claimed.capability,
          }),
        );
        assert.equal(await intentRow(first.work.id, "x1"), null);
        assert.equal((await intentRow(first.work.id, "m1")).status, "composed");
        assert.equal((await memberChat()).length, before, "not yet sent");

        await b.expire(first.work.id);
        const second = await claim(tokenB);
        assert.equal(second.work.id, first.work.id);
        assert.deepEqual(
          second.work.intents?.map((i) => [i.slot, i.status]),
          [["m1", "composed"]],
        );
        const never = new ScriptedRuntime([], "composer-");
        const runtime = new ScriptedRuntime([
          async (io) => {
            const sent = (await memberChat()).slice(before);
            assert.deepEqual(
              sent.map((m: any) => m.text),
              [stored],
              "dispatched at cycle start, before the planner ran",
            );
            const ref = await readRef(io);
            const r = parse(
              await io.call(INTEND_TOOL, {
                slot: "m1",
                intent: memberIntent(ref),
              }),
            );
            // The planner is told m1 is already dispatched. Real msg refs are
            // bound to the conversation epoch, which the recovered delivery
            // advanced, so a re-selected intent is a different digest: the
            // backend refuses it and nothing is sent twice (seam, handoff C11).
            assert.match(io.message, /"slot":"m1"/);
            assert.match(io.message, /"status":"dispatched"/);
            assert.notEqual(ref, firstRef, "epoch-bound ref");
            assert.equal(r.error, "INTENT_CONFLICT");
            return acted(["m1"]);
          },
        ]);
        const result = await autonomyRunner({
          store: await storeFor(tokenB),
          runtime,
          compose: { runtime: never },
        })({
          work: second.work,
          mandate: await second.backend.mandate(),
          backend: second.backend,
          signal: new AbortController().signal,
          capability: second.claimed.capability,
        });
        if (runtime.errors.length) throw runtime.errors[0];
        assert.equal(never.runs.length, 0);
        assert.equal(result.outcome.result, "completed");
        assert.deepEqual(
          (await memberChat()).slice(before).map((m: any) => m.text),
          [stored],
        );
        assert.equal(
          (await intentRow(first.work.id, "m1")).status,
          "dispatched",
        );
      },
    );

    await t.test(
      "a lost dispatch request is resolved by the receipt GET and one identical PUT of the stored text",
      async () => {
        const mandate = await b.saveMandate({
          mode: "message",
          timezone: "UTC",
          quiet_hours: AWAY(),
          delegated_actions: ALL,
          contact_limits: LIMITS,
        });
        await question("Synthetic question: protein after late sessions?");
        await conversationWork(mandate.mandate_id);
        const token = await b.bearer();
        const { backend, claimed, work } = await claim(token);
        const composed =
          "Yes, a protein snack after late sessions helps recovery.";
        const before = (await memberChat()).length;
        const runtime = new ScriptedRuntime([
          async (io) => {
            const ref = await readRef(io);
            proxy.state.requests.length = 0;
            const r = parse(
              await io.call(INTEND_TOOL, {
                slot: "m1",
                intent: memberIntent(ref),
              }),
            );
            assert.equal(r.status, "delivered");
            assert.equal(r.recovered, true);
            return acted(["m1"]);
          },
        ]);
        const result = await autonomyRunner({
          store: await storeFor(token),
          runtime,
          compose: {
            runtime: new ScriptedRuntime(
              [composerScript(composed)],
              "composer-",
            ),
          },
        })({
          work,
          mandate: await backend.mandate(),
          backend: afterComposition(
            backend,
            () => (proxy.state.loseNext = true),
          ),
          signal: new AbortController().signal,
          capability: claimed.capability,
        });
        if (runtime.errors.length) throw runtime.errors[0];
        assert.equal(result.outcome.result, "completed");
        const slotWire = proxy.state.requests
          .filter((r: any) =>
            /\/work\/[0-9a-f]+\/(intents|actions)\/m1/.test(r.path),
          )
          .map(
            (r: any) => `${r.method} ${r.path.split("/").slice(-2).join("/")}`,
          );
        assert.deepEqual(slotWire, [
          "PUT intents/m1",
          "PUT m1/composition",
          "PUT actions/m1",
          "GET actions/m1",
          "PUT actions/m1",
        ]);
        assert.deepEqual(
          (await memberChat()).slice(before).map((m: any) => m.text),
          [composed],
        );
      },
    );

    await t.test(
      "public_praise: the public composer sees the B11 projection only; the stored text is the one published comment",
      async () => {
        const mandate = await b.saveMandate({
          mode: "message",
          timezone: "UTC",
          quiet_hours: AWAY(),
          delegated_actions: ALL,
          contact_limits: LIMITS,
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
        const act = {
          _id: new b.ObjectId(),
          user_id: b.member,
          type: "workout",
          name: "Synthetic leg day",
          status: "completed",
          completed_at: completed,
          is_template: false,
          notes: "PRIVATE-ACTIVITY-NOTE-MARKER",
          data: { exercises: [] },
        };
        await b.db.collection("activities").insertOne(act);
        const ledger = new b.ObjectId();
        await b.db.collection("user_activity_events").insertOne({
          _id: ledger,
          owner_user_id: b.member,
          event_type: "workout.completed",
          created_at: new Date(),
        });
        const event = {
          ledger_id: String(ledger),
          occurred_at: new Date().toISOString(),
          event_type: "workout.completed",
          subject: { type: "workout", id: String(act._id) },
        };
        await b.enqueue(mandate.mandate_id, {
          source: { event_ids: [event.ledger_id], events: [event] },
        });
        const token = await b.bearer();
        const { backend, claimed, work } = await claim(token);
        const words = "Strong finish on leg day. Well done!";
        const composer = new ScriptedRuntime(
          [composerScript(words)],
          "composer-",
        );
        const commentsBefore = await b.db
          .collection("dojo_coach_comments")
          .countDocuments();
        const runtime = new ScriptedRuntime([
          async (io) => {
            const r = parse(
              await io.call(INTEND_TOOL, {
                slot: "p1",
                intent: {
                  type: "public_praise",
                  activity_id: String(act._id),
                  completed_at: completed.toISOString(),
                  purpose: "completion_praise",
                  tone: "celebratory",
                  evidence_refs: [`ev:${ledger}`, `pub:${act._id}`],
                },
              }),
            );
            assert.equal(r.status, "published", JSON.stringify(r));
            return acted(["p1"]);
          },
        ]);
        const result = await autonomyRunner({
          store: await storeFor(token),
          runtime,
          compose: { runtime: composer },
        })({
          work,
          mandate: await backend.mandate(),
          backend,
          signal: new AbortController().signal,
          capability: claimed.capability,
        });
        if (runtime.errors.length) throw runtime.errors[0];
        assert.equal(result.outcome.result, "completed");
        const message = composer.runs[0].message;
        assert.match(message, /Synthetic Member/);
        assert.match(message, /Synthetic leg day/);
        assert.ok(!message.includes("PRIVATE-ACTIVITY-NOTE-MARKER"));
        assert.ok(!message.includes("Synthetic question"));
        const comments = await b.db
          .collection("dojo_coach_comments")
          .find({})
          .sort({ _id: -1 })
          .toArray();
        assert.equal(comments.length, commentsBefore + 1);
        assert.equal(comments[0].text, words);
        const row = await intentRow(work.id, "p1");
        assert.equal(row.status, "dispatched");
        assert.equal(row.composition.text, undefined);
      },
    );
  },
);
