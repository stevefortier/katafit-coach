import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/config/store.js";
import { AutonomyBackend, AutonomyFailure } from "../src/autonomy/backend.js";

import { autonomyRunner } from "../src/autonomy/runner.js";
import { closeServer, pairedSkip } from "./helpers/account-backend.js";
import { startAutonomyBackend } from "./helpers/autonomy-backend.js";
import {
  composerScript,
  outcome,
  ScriptedRuntime,
  type Io,
} from "./helpers/autonomy-cycle.js";
import { INTEND_TOOL } from "../src/autonomy/tools.js";
import {
  HeadlessCycleRuntime,
  HeadlessFailure,
  type HeadlessRun,
} from "../src/autonomy/headless.js";
import { CleanupRegistry } from "../src/autonomy/cleanup.js";
import { fakeEngine, obedient, IMAGE } from "./helpers/headless-engine.js";

const gate = { skip: pairedSkip, timeout: 60000 };
const question = "I will do mobility on Thursday";
const storedText = "A gentle mobility session sounds good.";
const parse = (r: any) => JSON.parse(r.content[0].text);
async function scene(t: TestContext) {
  const b = await startAutonomyBackend();
  let dir: string | undefined;
  const provider = createServer(async (req, res) => {
    for await (const _ of req) {
      /* consume the synthetic provider request */
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { total_tokens: 10 },
      }),
    );
  });
  t.after(async () => {
    t.mock.timers.reset();
    t.mock.restoreAll();
    try {
      await closeServer(provider);
    } finally {
      try {
        await b.close();
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true });
      }
    }
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const token = await b.bearer();
  const controller = new AbortController();
  const backend = new AutonomyBackend(b.origin, token, controller.signal, [
    token,
  ]);
  const defaults = await backend.mandate();
  const clock = (min: number) =>
    new Date(Date.now() + min * 60000).toISOString().slice(11, 16);
  await b.saveMandate({
    mode: "message",
    timezone: "UTC",
    budgets: { ...defaults.budgets, cycle_seconds: 120 },
    delegated_actions: [
      "manager_report",
      "follow_up",
      "member_message",
      "public_praise",
    ],
    quiet_hours: { start: clock(120), end: clock(180) },
    contact_limits: {
      member_daily: 5,
      member_cooldown_minutes: 0,
      dojo_daily: 200,
      praise_daily: 10,
    },
    digest: {
      enabled: false,
      local_time: "18:00",
      weekdays: [0],
      suppress_empty: true,
    },
  });
  const mandate = await backend.mandate();
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
        text: question,
        created_at: new Date(Date.now() - 60000),
        external_request_id: String(request),
      },
    ]);
  const queued = await b.enqueue(mandate.mandate_id!, {
    kind: "conversation",
    source: {
      conversation: { member_id: String(b.member), from_epoch: 0, to_epoch: 1 },
    },
  });
  dir = await mkdtemp(join(tmpdir(), "deadline0258-review-"));
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: b.origin,
    token,
    apiKey: "synthetic-key",
    provider: {
      baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
      model: "synthetic-model",
    },
  });
  const claim = async () => {
    const claimed = await backend.claimCycle({ lease_seconds: 120 });
    assert.ok(claimed?.capability);
    const work = await backend.start(
      claimed.work.id,
      claimed.work.lease_generation,
    );
    return { claimed, work };
  };
  const readRef = async (io: Io) => {
    const path = io.message.match(
      /GET (\/api\/coach\/member-conversations\/[^\s.]+)/,
    )?.[1];
    assert.ok(path);
    const reply = parse(await io.call("katafit_rest_get", { path }));
    return reply.items.filter((i: any) => i.role === "user").at(-1)
      .message_ref as string;
  };
  const intent = (ref: string) => ({
    type: "member_message",
    recipient_id: String(b.member),
    purpose: "answer_question",
    tone: "warm",
    evidence_refs: [`msg:${ref}`],
  });
  const rows = () =>
    b.db.collection("coach_autonomy_work").findOne({ _id: queued._id });
  const messages = async () =>
    (await b.chat(b.member)).filter((m: any) => m.role !== "user");
  return {
    b,
    backend,
    controller,
    store,
    mandate,
    queued,
    claim,
    readRef,
    intent,
    rows,
    messages,
  };
}

for (const boundary of ["follow-up read", "follow-up setup"])
  test(
    `F1: ${boundary} exhaustion retains genuinely recovered action, follow-up and recovery warnings in canonical report`,
    gate,
    async (t) => {
      const s = await scene(t);
      const first = await s.claim();
      const crash = new AbortController();
      let followUpId = "";
      const seed = new ScriptedRuntime([
        async (io) => {
          const ref = await s.readRef(io);
          const fu = await s.backend.followUp(first.work.id, "mobility", {
            lease_generation: first.work.lease_generation,
            mandate_revision: first.work.mandate_revision,
            subject_id: String(s.b.member),
            basis: "member_commitment",
            summary: "Mobility commitment",
            due_at: new Date(Date.now() + 86400000).toISOString(),
            next_condition: "Mobility completed",
            evidence: { message_ref: ref, quote: question },
          });
          followUpId = fu.follow_up.id;
          await io.call(INTEND_TOOL, { slot: "m1", intent: s.intent(ref) });
          return outcome();
        },
      ]);
      const put = s.backend.putComposition.bind(s.backend);
      t.mock.method(
        s.backend,
        "putComposition",
        async (...args: Parameters<typeof put>) => {
          const r = await put(...args);
          crash.abort(new Error("synthetic crash after storage"));
          return r;
        },
      );
      await assert.rejects(
        autonomyRunner({
          store: s.store,
          runtime: seed,
          compose: {
            runtime: new ScriptedRuntime([composerScript(storedText)]),
          },
        })({
          work: first.work,
          mandate: s.mandate,
          backend: s.backend,
          capability: first.claimed.capability,
          signal: crash.signal,
        }),
      );
      assert.deepEqual(seed.errors, []);
      assert.ok(followUpId);
      assert.equal((await s.messages()).length, 0);
      t.mock.restoreAll();
      await s.b.expire(first.work.id);
      const second = await s.claim();
      assert.equal(second.work.id, first.work.id);
      assert.equal(second.work.intents?.[0].status, "composed");
      assert.ok(second.work.follow_ups.includes(followUpId));
      const origin = Date.parse(second.work.timeout_at!) - 120000;
      t.mock.timers.enable({ apis: ["Date"], now: origin + 45000 });
      const act = s.backend.act.bind(s.backend);
      t.mock.method(
        s.backend,
        "act",
        async (...args: Parameters<typeof act>) => {
          t.mock.timers.setTime(origin + 49000);
          return act(...args);
        },
      );
      if (boundary === "follow-up read")
        t.mock.method(s.backend, "listFollowUps", async () => {
          t.mock.timers.setTime(origin + 66000);
          throw new Error("synthetic follow-up read unavailable");
        });
      else {
        const list = s.backend.listFollowUps.bind(s.backend);
        t.mock.method(
          s.backend,
          "listFollowUps",
          async (...args: Parameters<typeof list>) => {
            const page = await list(...args);
            t.mock.timers.setTime(origin + 66000);
            return page;
          },
        );
      }
      const never = new ScriptedRuntime([]);
      const result = await autonomyRunner({
        store: s.store,
        runtime: never,
        compose: { runtime: new ScriptedRuntime([]) },
      })({
        work: second.work,
        mandate: s.mandate,
        backend: s.backend,
        capability: second.claimed.capability,
        signal: s.controller.signal,
      });
      const receipt = await s.backend.completionReceipt(
        second.work.id,
        second.work.lease_generation,
      );
      const report = await s.b.db
        .collection("coach_autonomy_reports")
        .findOne({ _id: new s.b.ObjectId(result.report_id) });
      const action = await s.backend.actionReceipt(second.work.id, "m1");
      t.diagnostic(
        JSON.stringify({
          finding: "F1",
          confirmed: action.slot,
          followUpId,
          uncertainty: report.uncertainty,
          receipt: receipt.state,
          messages: (await s.messages()).length,
        }),
      );
      assert.equal(receipt.state, "committed");
      assert.equal(result.outcome.blocked_reason, "budget_exhausted");
      assert.deepEqual(
        result.outcome.decisions,
        [],
        "no planner decision invented",
      );
      assert.deepEqual(report.counts, {
        acted: 0,
        no_action: 0,
        deferred: 0,
        escalated: 0,
      });
      assert.deepEqual(report.action_slots, []);
      assert.deepEqual(report.follow_up_ids, []);
      assert.match(
        report.uncertainty.join("\n"),
        /uncertified confirmed:.*slot m1/,
        "canonical report must disclose confirmed recovered send",
      );
      assert.ok(
        report.uncertainty.some((note: string) =>
          note.includes(`follow-up ${followUpId}`),
        ),
        "confirmed follow-up remains disclosed",
      );
      if (boundary === "follow-up read")
        assert.ok(
          report.uncertainty.includes("open follow-ups unavailable"),
          "recovery/setup notes preserved",
        );
      assert.equal(action.status, "delivered");
      assert.equal((await s.messages()).length, 1);
      assert.equal((await s.messages())[0].text, storedText);
      assert.equal(never.runs.length, 0);
      assert.equal(
        await s.backend.claimCycle(),
        null,
        "blocked identity never replayed",
      );
    },
  );

test(
  "F2: nested composer cleanup and bounded post-inference writes cannot consume canonical settlement",
  gate,
  async (t) => {
    const s = await scene(t);
    const { work, claimed } = await s.claim();
    const origin = Date.parse(work.timeout_at!) - 120000;
    t.mock.timers.enable({ apis: ["Date"], now: origin });
    const stages: { stage: string; at: number }[] = [];
    const at = (stage: string, ms: number) => {
      t.mock.timers.setTime(origin + ms);
      stages.push({ stage, at: ms });
    };
    let outputReady!: () => void;
    const ready = new Promise<void>((r) => {
      outputReady = r;
    });
    let releaseCleanup!: () => void;
    const released = new Promise<void>((r) => {
      releaseCleanup = r;
    });
    t.after(() => releaseCleanup());
    let teardown = false;
    const obey = obedient(storedText);
    const fake = await fakeEngine((command, pi) => {
      if (command.type === "get_last_assistant_text") {
        at("composer_output", 64000);
        teardown = true;
      }
      obey(command, pi);
    });
    t.after(() => fake.close());
    const cleanup = await CleanupRegistry.open(s.store.dir, "a".repeat(32));
    const exec = fake.engine.exec;
    const native = new HeadlessCycleRuntime({
      image: IMAGE,
      cleanup,
      engine: {
        ...fake.engine,
        exec: async (...args: Parameters<typeof exec>) => {
          if (teardown && args[1].includes("version")) {
            outputReady();
            await released;
            at("cleanup_version", 73000);
          }
          const result = await exec(...args);
          if (teardown && args[1].includes("rm")) at("cleanup_remove", 91000);
          return result;
        },
      },
    });
    // Delay only this owned runtime's real Docker probe, not production engines.
    const probe = (native as any).probe;
    const inspect = probe.inspect.bind(probe);
    t.mock.method(probe, "inspect", async (reference: string) => {
      const result = await inspect(reference);
      if (teardown) at("cleanup_inspect", 77000);
      return result;
    });
    const put = s.backend.putComposition.bind(s.backend);
    t.mock.method(
      s.backend,
      "putComposition",
      async (...args: Parameters<typeof put>) => {
        at("composition_store", Date.now() - origin + 14000);
        return put(...args);
      },
    );
    const act = s.backend.act.bind(s.backend);
    t.mock.method(s.backend, "act", async (...args: Parameters<typeof act>) => {
      at("action_dispatch", Date.now() - origin + 14000);
      return act(...args);
    });
    const complete = s.backend.complete.bind(s.backend);
    t.mock.method(
      s.backend,
      "complete",
      async (...args: Parameters<typeof complete>) => {
        at("completion_processing", Date.now() - origin + 2000);
        return complete(...args);
      },
    );
    const script = new ScriptedRuntime([
      async (io) => {
        const ref = await s.readRef(io);
        await io.call(INTEND_TOOL, {
          slot: "late-nested",
          intent: s.intent(ref),
        });
        return outcome();
      },
    ]);
    let pending: Promise<unknown> | undefined;
    const planner = {
      async run(run: HeadlessRun) {
        pending = script.run(run);
        pending.catch(() => {});
        await ready;
        at("planner_timeout", run.deadlineAt! - origin);
        queueMicrotask(releaseCleanup);
        throw new HeadlessFailure("HEADLESS_TIMEOUT");
      },
    };
    const composer = {
      async run(run: HeadlessRun) {
        // Real profile gateway/provider attestation, then the actual headless RPC
        // and owned teardown against a synthetic Docker/Pi peer.
        await new ScriptedRuntime([composerScript(storedText)]).run(run);
        return native.run(run);
      },
    };
    let result:
      | Awaited<ReturnType<ReturnType<typeof autonomyRunner>>>
      | undefined;
    let error: any;
    try {
      result = await autonomyRunner({
        store: s.store,
        runtime: planner,
        compose: { runtime: composer },
      })({
        work,
        mandate: s.mandate,
        backend: s.backend,
        signal: s.controller.signal,
        capability: claimed.capability,
      });
    } catch (e) {
      error = e;
    } finally {
      releaseCleanup();
      await pending;
    }
    const exact = await s.backend.completionReceipt(
      work.id,
      work.lease_generation,
    );
    const row = await s.rows();
    t.diagnostic(
      JSON.stringify({
        finding: "F2",
        stages,
        error: error?.code,
        receipt: exact.state,
        status: row.status,
        messages: (await s.messages()).length,
        creates: fake.creates().length,
        removes: fake.removes().length,
      }),
    );
    assert.deepEqual(script.errors, []);
    assert.equal(fake.creates().length, 1);
    assert.equal(fake.removes().length, 1);
    assert.equal(cleanup.pending, 0);
    assert.equal(fake.daemon.containers.size, 0);
    assert.equal(
      error,
      undefined,
      "bounded nested pipeline must settle rather than lose completion with LEASE_LOST",
    );
    assert.equal(exact.state, "committed");
    assert.equal(exact.receipt?.report_id, result!.report_id);
    assert.equal(result!.outcome.blocked_reason, "budget_exhausted");
    assert.equal(row.status, "blocked");
    assert.deepEqual(result!.outcome.decisions, []);
    assert.equal(
      (await s.messages()).length,
      0,
      "insufficient pipeline time must not dispatch the selected action",
    );
    assert.ok(
      !stages.some((stage) =>
        ["composition_store", "action_dispatch"].includes(stage.stage),
      ),
    );
    assert.ok(Date.parse(exact.receipt!.committed_at) < origin + 120000);
    assert.equal(await s.backend.claimCycle(), null);
  },
);

for (const committed of [true, false])
  test(
    `F2: late lost action response ${committed ? "settles exact committed receipt" : "retains unknown without late retry"}`,
    gate,
    async (t) => {
      const s = await scene(t);
      const { work, claimed } = await s.claim();
      const origin = Date.parse(work.timeout_at!) - 120000;
      t.mock.timers.enable({ apis: ["Date"], now: origin });
      const act = s.backend.act.bind(s.backend);
      let attempts = 0;
      t.mock.method(
        s.backend,
        "act",
        async (...args: Parameters<typeof act>) => {
          attempts++;
          t.mock.timers.setTime(origin + 64000);
          if (committed) await act(...args);
          throw new AutonomyFailure("AUTONOMY_OUTCOME_UNKNOWN");
        },
      );
      const get = s.backend.actionReceipt.bind(s.backend);
      let receiptReads = 0;
      t.mock.method(
        s.backend,
        "actionReceipt",
        async (...args: Parameters<typeof get>) => {
          receiptReads++;
          t.mock.timers.setTime(origin + 66000);
          return get(...args);
        },
      );
      const planner = new ScriptedRuntime([
        async (io) => {
          const ref = await s.readRef(io);
          await io.call(INTEND_TOOL, { slot: "lost", intent: s.intent(ref) });
          throw new HeadlessFailure("HEADLESS_TIMEOUT");
        },
      ]);
      const result = await autonomyRunner({
        store: s.store,
        runtime: planner,
        compose: { runtime: new ScriptedRuntime([composerScript(storedText)]) },
      })({
        work,
        mandate: s.mandate,
        backend: s.backend,
        capability: claimed.capability,
        signal: s.controller.signal,
      });
      const exact = await s.backend.completionReceipt(
        work.id,
        work.lease_generation,
      );
      const row = await s.rows();
      t.diagnostic(
        JSON.stringify({
          finding: "F2",
          committed,
          attempts,
          receiptReads,
          receipt: exact.state,
          messages: (await s.messages()).length,
          blocked: result.outcome.blocked_reason,
        }),
      );
      assert.deepEqual(planner.errors, []);
      assert.equal(
        attempts,
        1,
        "no identical dispatch retry when a full request no longer fits",
      );
      assert.equal(
        receiptReads,
        1,
        "already-dispatched mutation is not abandoned at inference cutoff",
      );
      assert.equal(exact.state, "committed");
      assert.equal(exact.receipt?.report_id, result.report_id);
      assert.equal(
        result.outcome.blocked_reason,
        committed ? "budget_exhausted" : "uncertain_write",
      );
      assert.equal(row.status, "blocked");
      assert.deepEqual(result.outcome.decisions, []);
      assert.equal((await s.messages()).length, committed ? 1 : 0);

      if (committed) {
        assert.ok(
          result.outcome.uncertainty.some((note) =>
            note.includes("uncertified confirmed: slot lost"),
          ),
        );
        assert.equal(row.actions.length, 1);
      } else {
        assert.ok(result.outcome.uncertainty.includes("uncertain_write"));
        assert.equal(row.actions.length, 0);
      }
      assert.equal(await s.backend.claimCycle(), null);
    },
  );

test(
  "F2: insufficient postprocessing budget does not launch a nested composer",
  gate,
  async (t) => {
    const s = await scene(t);
    const { work, claimed } = await s.claim();
    const origin = Date.parse(work.timeout_at!) - 120000;
    t.mock.timers.enable({ apis: ["Date"], now: origin + 40000 });
    const planner = new ScriptedRuntime([
      async (io) => {
        const ref = await s.readRef(io);
        const reply = await io.call(INTEND_TOOL, {
          slot: "short",
          intent: s.intent(ref),
        });
        assert.equal(parse(reply).error, "COMPOSER_UNAVAILABLE");
        return outcome();
      },
    ]);
    const compose = new ScriptedRuntime([]);
    const result = await autonomyRunner({
      store: s.store,
      runtime: planner,
      compose: { runtime: compose },
    })({
      work,
      mandate: s.mandate,
      backend: s.backend,
      capability: claimed.capability,
      signal: s.controller.signal,
    });
    assert.deepEqual(planner.errors, []);
    assert.equal(compose.runs.length, 0);
    assert.equal(result.outcome.blocked_reason, "budget_exhausted");
    assert.equal(
      (await s.backend.completionReceipt(work.id, work.lease_generation)).state,
      "committed",
    );
    assert.equal((await s.messages()).length, 0);
    assert.equal((await s.rows()).actions.length, 0);
    assert.equal(await s.backend.claimCycle(), null);
  },
);

test(
  "F2: lost composition ACKs preserve storage without action promotion or later replay",
  gate,
  async (t) => {
    const s = await scene(t);
    const { work, claimed } = await s.claim();
    const origin = Date.parse(work.timeout_at!) - 120000;
    t.mock.timers.enable({ apis: ["Date"], now: origin + 30000 });
    const put = s.backend.putComposition.bind(s.backend);
    let attempts = 0;
    t.mock.method(
      s.backend,
      "putComposition",
      async (...args: Parameters<typeof put>) => {
        attempts++;
        const stored = await put(...args);
        assert.equal(stored.text, storedText);
        // Both the first lost ACK and its single identical retry take 14s,
        // within the existing 15s request bound. Neither promotes an action.
        t.mock.timers.setTime(Date.now() + 14000);
        throw new AutonomyFailure("AUTONOMY_OUTCOME_UNKNOWN");
      },
    );
    const composer = {
      async run(run: HeadlessRun) {
        const result = await new ScriptedRuntime([
          composerScript(storedText),
        ]).run(run);
        t.mock.timers.setTime(origin + 34000);
        return result;
      },
    };
    const planner = new ScriptedRuntime([
      async (io) => {
        const ref = await s.readRef(io);
        const reply = parse(
          await io.call(INTEND_TOOL, {
            slot: "stored-unknown",
            intent: s.intent(ref),
          }),
        );
        assert.equal(reply.error, "AUTONOMY_OUTCOME_UNKNOWN");
        t.mock.timers.setTime(origin + 65000);
        throw new HeadlessFailure("HEADLESS_TIMEOUT");
      },
    ]);
    const result = await autonomyRunner({
      store: s.store,
      runtime: planner,
      compose: { runtime: composer },
    })({
      work,
      mandate: s.mandate,
      backend: s.backend,
      capability: claimed.capability,
      signal: s.controller.signal,
    });
    assert.deepEqual(planner.errors, []);
    assert.equal(
      attempts,
      2,
      "one identical retry, never repeated after terminal completion",
    );
    assert.equal(
      (await s.backend.getIntent(work.id, "stored-unknown")).composition?.text,
      storedText,
    );
    assert.equal((await s.rows()).intents[0].status, "composed");
    assert.equal((await s.rows()).actions.length, 0);
    assert.equal((await s.messages()).length, 0);
    assert.equal(result.outcome.blocked_reason, "uncertain_write");
    assert.ok(result.outcome.uncertainty.includes("uncertain_write"));
    assert.equal(
      (await s.backend.completionReceipt(work.id, work.lease_generation)).state,
      "committed",
    );
    assert.equal(await s.backend.claimCycle(), null);
  },
);

test(
  "F2: crossing initial dispatch admission is budget-unavailable, not an unknown write",
  gate,
  async (t) => {
    const s = await scene(t);
    const first = await s.claim();
    const base = Date.parse(first.work.timeout_at) - 120_000;
    let crossed = false;
    let checks = 0;
    let attempts = 0;
    const put = s.backend.putComposition.bind(s.backend);
    t.mock.method(
      s.backend,
      "putComposition",
      async (...args: Parameters<typeof put>) => {
        const result = await put(...args);
        crossed = true;
        return result;
      },
    );
    const act = s.backend.act.bind(s.backend);
    t.mock.method(s.backend, "act", (...args: Parameters<typeof act>) => {
      attempts++;
      return act(...args);
    });
    const runtime = new ScriptedRuntime([
      async (io) => {
        const ref = await s.readRef(io);
        await io.call(INTEND_TOOL, { slot: "m1", intent: s.intent(ref) });
        return outcome();
      },
    ]);
    const result = await autonomyRunner({
      store: s.store,
      runtime,
      now: () => (!crossed ? base : base + (++checks === 1 ? 49_999 : 50_001)),
      compose: { runtime: new ScriptedRuntime([composerScript(storedText)]) },
    })({
      work: first.work,
      mandate: s.mandate,
      backend: s.backend,
      capability: first.claimed.capability,
      signal: s.controller.signal,
    });
    assert.equal(crossed, true);
    assert.ok(checks >= 2);
    assert.equal(attempts, 0);
    assert.equal((await s.messages()).length, 0);
    assert.equal(result.outcome.blocked_reason, "budget_exhausted");
    const receipt = await s.backend.completionReceipt(
      first.work.id,
      first.work.lease_generation,
    );
    assert.equal(receipt.state, "committed");
    const row = await s.rows();
    const report = await s.b.db
      .collection("coach_autonomy_reports")
      .findOne({ _id: new s.b.ObjectId(result.report_id) });
    assert.equal(row.status, "blocked");
    assert.equal(report.blocked_reason, "budget_exhausted");
  },
);
