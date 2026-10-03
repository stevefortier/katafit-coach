import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compileComposer } from "../src/config/store.js";
import { INTEND_TOOL, REPORT_TOOL } from "../src/autonomy/tools.js";
import {
  BLOCKED_REASONS_710D,
  MEMBER,
  OTHER_MEMBER,
} from "./helpers/autonomy-fake.js";
import {
  closeLeaked,
  composerScript,
  cycle,
  outcome,
  restServer,
  ScriptedRuntime,
  SECRET_INSTRUCTION,
  setup,
  type Io,
} from "./helpers/autonomy-cycle.js";

// [AC1] C11 (contracts §21, work-packages §2.10): the planner selects a finite
// intent; an isolated, tool-less composer drafts the words from host-projected
// audience evidence only; the stored composition is the only dispatchable text.

after(closeLeaked);

const ALL = ["manager_report", "follow_up", "member_message", "public_praise"];
const MEMORY_MARK = "MEMORY-PRIVATE-MARKER-91c2";
const REPORT_MARK = "REPORT-PRIVATE-MARKER-4d1e";
const SUMMARY_MARK = "PLANNER-SUMMARY-MARKER-zx1";
const CONDITION_MARK = "NEXT-CONDITION-MARKER-zx2";
const QUESTION = "Should I deload next week after the meet?";
const conversationPath = `/api/coach/member-conversations/${MEMBER}`;
const otherConversationPath = `/api/coach/member-conversations/${OTHER_MEMBER}`;
const ACT_MEMBER = "64b7f0c2a1b2c3d4e5f60a01";
const ACT_OTHER = "64b7f0c2a1b2c3d4e5f60a02";
const LEDGER = "64b7f0c2a1b2c3d4e5f60b01";
const UNKNOWN_LEDGER = "64b7f0c2a1b2c3d4e5f60b09";
const COMPLETED_AT = "2026-10-03T06:30:00.000Z";

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const parse = (result: any) => JSON.parse(result.content[0].text);
const read = (io: Io, path: string) =>
  io.call("katafit_rest_get", { path }).then((r) => {
    assert.ok(!r.error, `read ${path}: ${JSON.stringify(r)}`);
    return r;
  });

async function composeEnv(o: Parameters<typeof setup>[0] = {}) {
  const env = await setup({ mode: "message", delegated: ALL, ...o });
  env.fake.state.supported.push("public_praise");
  env.fake.state.requireComposition = true;
  restServer(env.fake, {
    [`GET ${conversationPath}`]: {
      status: 200,
      body: {
        schema_version: 1,
        member_id: MEMBER,
        coverage: "retained_main_coach_conversation",
        conversation_epoch: 5,
        items: [
          {
            message_ref: "opaque-ref-1",
            role: "user",
            text: QUESTION,
            created_at: "2026-10-03T06:00:00.000Z",
            source: "member",
          },
        ],
        has_more: false,
        next_cursor: null,
      },
    },
    [`GET ${otherConversationPath}`]: {
      status: 200,
      body: {
        schema_version: 1,
        member_id: OTHER_MEMBER,
        coverage: "retained_main_coach_conversation",
        conversation_epoch: 2,
        items: [
          {
            message_ref: "opaque-ref-other",
            role: "user",
            text: "Peer-only words that the member must never see.",
            created_at: "2026-10-03T06:00:00.000Z",
            source: "member",
          },
        ],
        has_more: false,
        next_cursor: null,
      },
    },
    [`GET /api/activities/${ACT_MEMBER}`]: {
      status: 200,
      body: {
        _id: ACT_MEMBER,
        user_id: MEMBER,
        type: "workout",
        name: "Leg day",
        status: "completed",
        completed_at: COMPLETED_AT,
        notes: "ACTIVITY-NOTE-MARKER-p9 private note",
      },
    },
    [`GET /api/activities/${ACT_OTHER}`]: {
      status: 200,
      body: {
        _id: ACT_OTHER,
        user_id: OTHER_MEMBER,
        type: "workout",
        name: "Peer run",
        status: "completed",
        completed_at: COMPLETED_AT,
      },
    },
    "GET /api/coach/memory": {
      status: 200,
      body: {
        items: [
          {
            text: `Mika plans to leave the Falcons team after the cup final. ${MEMORY_MARK}`,
          },
        ],
      },
    },
  });
  return env;
}

function seedFollowUp(
  env: Awaited<ReturnType<typeof setup>>,
  subject: string,
  over: Record<string, unknown> = {},
) {
  const id =
    (subject === MEMBER
      ? "64b7f0c2a1b2c3d4e5f60c0"
      : "64b7f0c2a1b2c3d4e5f60c1") + "1";
  env.fake.state.followUps.set(id, {
    id,
    subject_id: subject,
    status: "open",
    basis: "member_commitment",
    summary: `Check the 5k. ${SUMMARY_MARK}`,
    due_at: "2026-10-04T08:00:00.000Z",
    timezone: "Europe/Paris",
    next_condition: `If missed, escalate. ${CONDITION_MARK}`,
    last_evidence_at: null,
    source: { slot: "seed" },
    evidence: {
      message_ref: "opaque-ref-0",
      quote: "I will run 5k on Saturday",
    },
    closure_reason: null,
    revision: 1,
    created_at: "2026-10-02T08:00:00.000Z",
    updated_at: "2026-10-02T08:00:00.000Z",
    ...over,
  });
  return id;
}

const message = (over: Record<string, unknown> = {}) => ({
  type: "member_message",
  recipient_id: MEMBER,
  purpose: "answer_question",
  tone: "warm",
  evidence_refs: ["msg:opaque-ref-1"],
  ...over,
});
const acted = (slots: string[], over: Record<string, unknown> = {}) =>
  outcome({
    decisions: [
      {
        subject_id: MEMBER,
        decision: "acted",
        action_slots: slots,
        follow_up_ids: [],
      },
    ],
    ...over,
  } as any);
const writes = (env: { fake: any }, pattern: RegExp) =>
  env.fake.calls.filter((c: any) => c.method !== "GET" && pattern.test(c.path));
const composerOptions = (
  composer: ScriptedRuntime,
  captured: string[] = [],
) => ({
  compose: {
    runtime: composer,
    onProviderRequest: (w: string) => captured.push(w),
  },
});

test("C11 member_message: planner intent, isolated tool-less composer, stored composition, exact dispatch", async () => {
  const env = await composeEnv({ kind: "conversation" });
  const captured: string[] = [];
  const composed = "Good question! A lighter week after the meet sounds smart.";
  // Only the composer reaches the provider here (the planner is scripted).
  env.fake.state.provider = () => ({ content: composed, tokens: 777 });
  const composer = new ScriptedRuntime([composerScript(composed)], "composer-");
  try {
    const { runtime, result } = await cycle(
      env,
      [
        async (io) => {
          const intend = io.catalog.tools.find(
            (t: any) => t.name === INTEND_TOOL,
          );
          assert.ok(intend, "intend offered with a composer");
          const fields = Object.keys(
            intend.parameters.properties.intent.properties,
          );
          for (const banned of ["text", "message", "body", "content", "draft"])
            assert.ok(
              !fields.includes(banned),
              `no ${banned} field on intents`,
            );
          await read(
            io,
            `${conversationPath}?view=main_conversation&order=oldest`,
          );
          await read(io, "/api/coach/memory?query=mika");
          await io.call(REPORT_TOOL, {
            slot: "r1",
            text: `Private note. ${REPORT_MARK}`,
          });
          const r = parse(
            await io.call(INTEND_TOOL, { slot: "m1", intent: message() }),
          );
          assert.deepEqual(r, {
            slot: "m1",
            status: "delivered",
            idempotent: false,
          });
          return acted(["r1", "m1"]);
        },
      ],
      composerOptions(composer, captured),
    );
    assert.equal(result.outcome.result, "completed");
    // The composer ran once, separately, with no tools and the composer prompt.
    assert.equal(composer.runs.length, 1);
    const run = composer.runs[0];
    assert.equal(run.profile, "composer");
    assert.deepEqual(run.catalog.tools, []);
    assert.deepEqual(run.catalog.skills, []);
    assert.equal(
      run.catalog.prompt,
      compileComposer(env.store.publicConfig(), "member"),
    );
    assert.notEqual(run.catalog.prompt, runtime.runs[0].catalog.prompt);
    // Approved projections only: the member's own question, purpose and tone.
    assert.ok(run.message.includes(QUESTION));
    assert.match(run.message, /answer_question/);
    assert.match(run.message, /warm/);
    for (const forbidden of [
      SECRET_INSTRUCTION,
      MEMORY_MARK,
      REPORT_MARK,
      "Falcons",
      "opaque-ref-1",
      "Prioritise recovery",
    ]) {
      assert.ok(!run.message.includes(forbidden), `message has ${forbidden}`);
      assert.ok(
        !run.catalog.prompt.includes(forbidden),
        `prompt has ${forbidden}`,
      );
      for (const wire of captured)
        assert.ok(!wire.includes(forbidden), `wire has ${forbidden}`);
    }
    assert.equal(captured.length, 1);
    assert.ok(captured[0].includes(QUESTION));
    // Exactly the stored composition went out, once; its text is erased.
    assert.deepEqual(
      env.fake.messages
        .filter((m) => m.recipient_id !== env.fake.chief)
        .map((m) => [m.recipient_id, m.text]),
      [[MEMBER, composed]],
    );
    const row = env.fake.state.intents.get(`${env.workId}:m1`);
    assert.equal(row.status, "dispatched");
    assert.equal(row.composition.text, undefined);
    assert.equal(row.composition.text_sha256, sha256(composed));
    assert.equal(
      row.composition.composer.persona_revision,
      sha256(run.catalog.prompt),
    );
    assert.deepEqual(row.composition.composer.provider_request_sha256, [
      sha256(captured[0]),
    ]);
    // Composer tokens count toward the cycle budget.
    assert.equal(result.outcome.budget.provider_tokens, 777);
  } finally {
    await env.close();
  }
});

test("C11 refs: unacquired refs and refs about anyone but the recipient are refused before any backend write", async () => {
  const env = await composeEnv({
    kind: "event",
    source: {
      events: [
        {
          ledger_id: LEDGER,
          occurred_at: COMPLETED_AT,
          event_type: "workout.completed",
          subject: { type: "activity", id: ACT_MEMBER },
        },
      ],
    },
  });
  const otherFollowUp = seedFollowUp(env, OTHER_MEMBER);
  const composer = new ScriptedRuntime([], "composer-");
  try {
    await cycle(
      env,
      [
        async (io) => {
          await read(
            io,
            `${conversationPath}?view=main_conversation&order=oldest`,
          );
          await read(
            io,
            `${otherConversationPath}?view=main_conversation&order=oldest`,
          );
          await read(io, `/api/activities/${ACT_OTHER}`);
          const refused = async (intent: any) => {
            const r = parse(await io.call(INTEND_TOOL, { slot: "m1", intent }));
            assert.equal(
              r.error,
              "INTENT_EVIDENCE_NOT_AUTHORIZED",
              JSON.stringify(intent),
            );
          };
          await refused(message({ evidence_refs: ["msg:never-read-ref"] }));
          await refused(message({ evidence_refs: ["msg:opaque-ref-other"] }));
          await refused(message({ recipient_id: OTHER_MEMBER }));
          await refused(message({ evidence_refs: [`act:${ACT_OTHER}`] }));
          await refused(message({ evidence_refs: [`act:${ACT_MEMBER}`] }));
          await refused(message({ evidence_refs: [`fu:${otherFollowUp}`] }));
          await refused(message({ evidence_refs: [`ev:${UNKNOWN_LEDGER}`] }));
          await refused(
            message({ evidence_refs: [`rcpt:${"a".repeat(24)}/nope`] }),
          );
          await refused({
            type: "public_praise",
            activity_id: ACT_MEMBER,
            completed_at: COMPLETED_AT,
            purpose: "completion_praise",
            evidence_refs: [`ev:${LEDGER}`, "msg:opaque-ref-1"],
          });
          return outcome();
        },
      ],
      composerOptions(composer),
    );
    assert.deepEqual(writes(env, /\/intents\//), []);
    assert.equal(composer.runs.length, 0);
    assert.equal(env.fake.messages.length, 0);
  } finally {
    await env.close();
  }
});

test("C11 fu: projection is basis, due_at, status and the member's own quote; never summary or next_condition", async () => {
  const env = await composeEnv({ kind: "follow_up" });
  const followUp = seedFollowUp(env, MEMBER);
  const composer = new ScriptedRuntime(
    [composerScript("How did the Saturday 5k go?")],
    "composer-",
  );
  try {
    const { runtime } = await cycle(
      env,
      [
        async (io) => {
          const r = parse(
            await io.call(INTEND_TOOL, {
              slot: "m1",
              intent: message({
                purpose: "follow_up_reminder",
                evidence_refs: [`fu:${followUp}`],
              }),
            }),
          );
          assert.equal(r.status, "delivered");
          return acted(["m1"]);
        },
      ],
      composerOptions(composer),
    );
    // The planner may see its own follow-up prose; the composer never does.
    assert.ok(runtime.runs[0].message.includes(followUp));
    const sent = composer.runs[0].message;
    assert.ok(sent.includes("I will run 5k on Saturday"));
    assert.match(sent, /member_commitment/);
    assert.ok(sent.includes("2026-10-04T08:00:00.000Z"));
    assert.ok(!sent.includes(SUMMARY_MARK));
    assert.ok(!sent.includes(CONDITION_MARK));
    assert.ok(!sent.includes(followUp));
  } finally {
    await env.close();
  }
});

test("C11 composition_rejected: private literals or invalid output are never stored or sent; the work is blocked for the manager", async () => {
  for (const [leak, advertised] of [
    [`Keep going! ${SECRET_INSTRUCTION}`, false],
    ["Heard Mika plans to leave the Falcons team after all.", false],
    ["x".repeat(8001), true],
    ["   ", true],
  ] as const) {
    const env = await composeEnv({ kind: "conversation" });
    if (advertised) env.fake.state.blockedReasons = [...BLOCKED_REASONS_710D];
    const composer = new ScriptedRuntime([composerScript(leak)], "composer-");
    try {
      const { result } = await cycle(
        env,
        [
          async (io) => {
            await read(
              io,
              `${conversationPath}?view=main_conversation&order=oldest`,
            );
            await read(io, "/api/coach/memory?query=mika");
            const r = parse(
              await io.call(INTEND_TOOL, { slot: "m1", intent: message() }),
            );
            assert.equal(r.error, "COMPOSITION_REJECTED");
            return outcome();
          },
        ],
        composerOptions(composer),
      );
      assert.deepEqual(writes(env, /\/composition$/), [], leak.slice(0, 40));
      assert.deepEqual(writes(env, /\/actions\//), []);
      assert.equal(env.fake.messages.length, 0);
      assert.equal(result.outcome.result, "blocked");
      // contracts §21.4 composition_rejected once the backend advertises it
      // (710d4513); an older backend cannot carry it, so the manager decides.
      assert.equal(
        result.outcome.blocked_reason,
        advertised ? "composition_rejected" : "manager_decision_needed",
      );
      assert.equal(env.fake.state.work.get(env.workId).status, "blocked");
      assert.ok(
        result.outcome.uncertainty.some((u) =>
          /composition_rejected:m1/.test(u),
        ),
        JSON.stringify(result.outcome.uncertainty),
      );
    } finally {
      await env.close();
    }
  }
});

test("C11 recovery: a crash before the composition is stored recomposes on the next claim", async () => {
  const env = await composeEnv({ kind: "conversation" });
  const crash = new AbortController();
  const composer = new ScriptedRuntime(
    [
      async (io) => {
        await composerScript("unused")(io);
        crash.abort(new Error("host crashed"));
        throw new Error("PROCESS_EXIT");
      },
      composerScript("A lighter week after the meet sounds right."),
    ],
    "composer-",
  );
  const planner = async (io: Io) => {
    await read(io, `${conversationPath}?view=main_conversation&order=oldest`);
    const r = parse(
      await io.call(INTEND_TOOL, { slot: "m1", intent: message() }),
    );
    assert.equal(r.status, "delivered");
    return acted(["m1"]);
  };
  try {
    await assert.rejects(
      cycle(env, [planner], composerOptions(composer), {
        signal: crash.signal,
      }),
    );
    assert.equal(
      env.fake.state.intents.get(`${env.workId}:m1`).status,
      "intended",
    );
    assert.deepEqual(writes(env, /\/composition$/), []);
    env.fake.advance(130_000);
    const { runtime, result } = await cycle(
      env,
      [planner],
      composerOptions(composer),
    );
    assert.match(
      runtime.runs[0].message,
      /"slot":"m1"/,
      "pending intent listed",
    );
    assert.equal(result.outcome.result, "completed");
    assert.equal(composer.runs.length, 2);
    assert.deepEqual(
      env.fake.messages.map((m) => m.text),
      ["A lighter week after the meet sounds right."],
    );
  } finally {
    await env.close();
  }
});

test("C11 recovery: a crash after the composition is stored dispatches the stored text with no composer re-run", async () => {
  const env = await composeEnv({ kind: "conversation" });
  const crash = new AbortController();
  env.fake.state.afterWrite = (_method, path) => {
    if (path.endsWith("/composition")) crash.abort(new Error("host crashed"));
  };
  const stored = "Stored before the crash: deload sounds right.";
  try {
    await assert.rejects(
      cycle(
        env,
        [
          async (io) => {
            await read(
              io,
              `${conversationPath}?view=main_conversation&order=oldest`,
            );
            await io.call(INTEND_TOOL, { slot: "m1", intent: message() });
            return outcome();
          },
        ],
        composerOptions(
          new ScriptedRuntime([composerScript(stored)], "composer-"),
        ),
        { signal: crash.signal },
      ),
    );
    env.fake.state.afterWrite = undefined;
    assert.deepEqual(writes(env, /\/actions\//), []);
    assert.equal(
      env.fake.state.intents.get(`${env.workId}:m1`).status,
      "composed",
    );
    env.fake.advance(130_000);
    const never = new ScriptedRuntime([], "composer-");
    const { runtime, result } = await cycle(
      env,
      [
        async (io) => {
          await read(
            io,
            `${conversationPath}?view=main_conversation&order=oldest`,
          );
          // The stored composition was dispatched at cycle start, before
          // the planner chose anything (contracts §21.4 step 5).
          assert.deepEqual(
            env.fake.messages
              .filter((m) => m.recipient_id !== env.fake.chief)
              .map((m) => m.text),
            [stored],
          );
          assert.match(io.message, /"slot":"m1"/);
          // Re-selecting the same intent is idempotent: no second composition.
          const r = parse(
            await io.call(INTEND_TOOL, { slot: "m1", intent: message() }),
          );
          assert.deepEqual(r, {
            slot: "m1",
            status: "delivered",
            idempotent: true,
          });
          return acted(["m1"]);
        },
      ],
      composerOptions(never),
    );
    assert.equal(never.runs.length, 0);
    assert.match(runtime.runs[0].message, /Already committed/);
    assert.equal(result.outcome.result, "completed");
    assert.deepEqual(
      env.fake.messages.map((m) => m.text),
      [stored],
    );
  } finally {
    await env.close();
  }
});

test("C11 first write wins: a composition stored by another holder is the text dispatched", async () => {
  const env = await composeEnv({ kind: "conversation" });
  const earlier = "Earlier holder's stored composition.";
  const composer = new ScriptedRuntime(
    [
      async (io) => {
        const row = env.fake.state.intents.get(`${env.workId}:m1`);
        row.composition = {
          text: earlier,
          text_sha256: sha256(earlier),
          stored_at: new Date(env.fake.now()).toISOString(),
        };
        row.status = "composed";
        return composerScript("This draft loses the race.")(io);
      },
    ],
    "composer-",
  );
  try {
    await cycle(
      env,
      [
        async (io) => {
          await read(
            io,
            `${conversationPath}?view=main_conversation&order=oldest`,
          );
          const r = parse(
            await io.call(INTEND_TOOL, { slot: "m1", intent: message() }),
          );
          assert.equal(r.status, "delivered");
          return acted(["m1"]);
        },
      ],
      composerOptions(composer),
    );
    assert.deepEqual(
      env.fake.messages.map((m) => m.text),
      [earlier],
    );
  } finally {
    await env.close();
  }
});

test("C11 lost dispatch: receipt GET (or an identical PUT) settles it; one message; no memory or source read between acquisition and dispatch", async () => {
  for (const fault of ["drop", "lose"] as const) {
    const env = await composeEnv({ kind: "conversation" });
    env.fake.state.afterWrite = (_method, path) => {
      if (!path.endsWith("/composition")) return;
      if (fault === "drop") env.fake.dropNextWrite();
      else env.fake.loseNextWrite();
    };
    const text = "Deload sounds right after the meet.";
    try {
      await cycle(
        env,
        [
          async (io) => {
            await read(
              io,
              `${conversationPath}?view=main_conversation&order=oldest`,
            );
            await read(io, "/api/coach/memory?query=mika");
            const r = parse(
              await io.call(INTEND_TOOL, { slot: "m1", intent: message() }),
            );
            assert.equal(r.status, "delivered");
            assert.equal(r.recovered, true);
            return acted(["m1"]);
          },
        ],
        composerOptions(
          new ScriptedRuntime([composerScript(text)], "composer-"),
        ),
      );
      assert.deepEqual(
        env.fake.messages.map((m) => m.text),
        [text],
        fault,
      );
      const puts = writes(env, /\/actions\/m1$/);
      assert.equal(puts.length, fault === "drop" ? 1 : 2);
      assert.ok(puts.every((c: any) => c.body === puts[0].body));
      // Between the intent and the first dispatch only the composition is written.
      const calls = env.fake.calls.map(
        (c) => `${c.method} ${c.path.split("?")[0]}`,
      );
      const from = calls.findIndex((c) => /PUT .*\/intents\/m1$/.test(c));
      const to = calls.findIndex((c) => /PUT .*\/actions\/m1$/.test(c));
      assert.ok(from >= 0 && to > from);
      assert.deepEqual(calls.slice(from + 1, to), [
        `PUT /api/coach/autonomy/work/${env.workId}/intents/m1/composition`,
      ]);
    } finally {
      await env.close();
    }
  }
});

test("C11 public_praise: the composer gets the backend public projection only and the praise sanitizer applies", async () => {
  const source = {
    events: [
      {
        ledger_id: LEDGER,
        occurred_at: COMPLETED_AT,
        event_type: "workout.completed",
        subject: { type: "activity", id: ACT_MEMBER },
      },
    ],
  };
  const praise = (over: Record<string, unknown> = {}) => ({
    type: "public_praise",
    activity_id: ACT_MEMBER,
    completed_at: COMPLETED_AT,
    purpose: "completion_praise",
    tone: "celebratory",
    evidence_refs: [`ev:${LEDGER}`, `pub:${ACT_MEMBER}`],
    ...over,
  });
  const env = await composeEnv({ kind: "event", source });
  const composer = new ScriptedRuntime(
    [
      composerScript("Visit https://example.test for more"),
      composerScript("Strong finish on leg day, Mika!"),
    ],
    "composer-",
  );
  try {
    const { result } = await cycle(
      env,
      [
        async (io) => {
          await read(
            io,
            `${conversationPath}?view=main_conversation&order=oldest`,
          );
          await read(io, `/api/activities/${ACT_MEMBER}`);
          const unattested = parse(
            await io.call(INTEND_TOOL, {
              slot: "p0",
              intent: praise({
                activity_id: ACT_OTHER,
                evidence_refs: [`ev:${LEDGER}`],
              }),
            }),
          );
          assert.equal(unattested.error, "PRAISE_NOT_AUTHORIZED");
          const rejected = parse(
            await io.call(INTEND_TOOL, { slot: "p1", intent: praise() }),
          );
          assert.equal(rejected.error, "COMPOSITION_REJECTED");
          const r = parse(
            await io.call(INTEND_TOOL, { slot: "p2", intent: praise() }),
          );
          assert.equal(r.status, "published");
          return acted(["p2"]);
        },
      ],
      composerOptions(composer),
    );
    assert.deepEqual(writes(env, /\/intents\/p0$/), []);
    assert.equal(composer.runs.length, 2);
    const run = composer.runs[1];
    assert.equal(
      run.catalog.prompt,
      compileComposer(env.store.publicConfig(), "public"),
    );
    assert.ok(run.message.includes("Mika"));
    assert.ok(run.message.includes("Leg day"));
    assert.match(run.message, /completion_praise/);
    for (const forbidden of [
      QUESTION,
      "ACTIVITY-NOTE-MARKER-p9",
      SECRET_INSTRUCTION,
    ])
      assert.ok(!run.message.includes(forbidden), forbidden);
    assert.deepEqual(
      [...env.fake.state.comments.values()].map((c: any) => c.text),
      ["Strong finish on leg day, Mika!"],
    );
    // The rejected praise was blocked; the published one still counts.
    assert.equal(result.outcome.result, "blocked");
  } finally {
    await env.close();
  }
});

test("C11 act: an activity the planner read for the recipient projects allowlisted fields only", async () => {
  const env = await composeEnv({ kind: "reconcile" });
  const composer = new ScriptedRuntime(
    [composerScript("Nice work on leg day.")],
    "composer-",
  );
  try {
    await cycle(
      env,
      [
        async (io) => {
          await read(io, `/api/activities/${ACT_MEMBER}`);
          const r = parse(
            await io.call(INTEND_TOOL, {
              slot: "m1",
              intent: message({
                purpose: "progress_praise",
                evidence_refs: [`act:${ACT_MEMBER}`],
              }),
            }),
          );
          assert.equal(r.status, "delivered");
          return acted(["m1"]);
        },
      ],
      composerOptions(composer),
    );
    const sent = composer.runs[0].message;
    assert.ok(sent.includes("Leg day"));
    assert.ok(sent.includes(COMPLETED_AT));
    assert.ok(!sent.includes("ACTIVITY-NOTE-MARKER-p9"));
    assert.ok(!sent.includes(ACT_MEMBER));
  } finally {
    await env.close();
  }
});

test("C11 isolation: the composer never shares the planner's runtime (one fresh container per composer run)", async () => {
  const env = await composeEnv({ kind: "conversation" });
  try {
    const { autonomyRunner } = await import("../src/autonomy/runner.js");
    const shared = new ScriptedRuntime([]);
    assert.throws(
      () =>
        autonomyRunner({
          store: env.store,
          runtime: shared,
          compose: { runtime: shared },
        }),
      /COMPOSER_RUNTIME_SHARED/,
    );
    assert.equal(shared.runs.length, 0);
  } finally {
    await env.close();
  }
});
