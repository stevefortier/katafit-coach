import test from "node:test";
import assert from "node:assert/strict";
import {
  closeLeaked,
  cycle,
  outcome,
  setup,
  work,
} from "./helpers/autonomy-cycle.js";

// C4 digest: the host states verified facts (content-free reports since the
// previous digest, coverage and unknowns); the planner only words them into
// one private manager report. An empty window follows mandate suppression.

test.after(closeLeaked);

const DATE = { digest_local_date: "2026-10-03" };
const report = (over: Record<string, unknown>) => ({
  id: Math.random().toString(16).slice(2).padEnd(24, "0").slice(0, 24),
  work_id: "a".repeat(24),
  kind: "reconcile",
  result: "completed",
  coverage: {
    members_considered: 2,
    members_read: 2,
    partial: false,
    unobserved: [],
  },
  counts: { acted: 1, no_action: 1, deferred: 0, escalated: 0 },
  action_slots: ["s1"],
  created_at: "2026-10-03T08:00:00.000Z",
  ...over,
});
const acted = (slot: string) =>
  outcome({
    decisions: [
      {
        subject_id: null,
        decision: "acted",
        action_slots: [slot],
        follow_up_ids: [],
      },
    ],
    coverage: {
      members_considered: 0,
      members_read: 0,
      partial: false,
      unobserved: [],
    },
  });

test("empty window with suppress_empty: no planner run, no message, completed", async () => {
  const env = await setup({
    kind: "digest",
    subjects: [],
    source: DATE,
    digest: { suppress_empty: true },
  });
  try {
    // Only an earlier digest: nothing happened since.
    env.fake.state.reports.push(report({ kind: "digest", action_slots: [] }));
    const { result, runtime } = await cycle(env, []);
    assert.equal(runtime.runs.length, 0);
    assert.equal(env.fake.messages.length, 0);
    assert.equal(result.outcome.result, "completed");
    assert.match(result.outcome.uncertainty.join(" "), /digest_empty/);
    assert.equal(work(env.fake, env.workId).status, "completed");
  } finally {
    await env.close();
  }
});

test("digest facts: window since the last digest, coverage and unknowns stated; one private report", async () => {
  const env = await setup({
    kind: "digest",
    subjects: [],
    source: DATE,
    digest: { suppress_empty: true },
  });
  try {
    // Newest first, as the backend pages them.
    env.fake.state.reports.push(
      report({}),
      report({
        result: "blocked",
        coverage: {
          members_considered: 3,
          members_read: 1,
          partial: true,
          unobserved: ["images"],
        },
        counts: { acted: 0, no_action: 0, deferred: 0, escalated: 0 },
        action_slots: [],
      }),
      report({
        kind: "digest",
        action_slots: [],
        counts: { acted: 9, no_action: 0, deferred: 0, escalated: 0 },
      }),
      report({ kind: "event" }),
    );
    const { result, runtime } = await cycle(env, [
      async ({ call, message, catalog }) => {
        const facts = JSON.parse(
          /<host_digest>(.*)<\/host_digest>/s.exec(message)![1],
        );
        assert.equal(facts.local_date, "2026-10-03");
        assert.equal(facts.cycles, 2, "only reports since the last digest");
        assert.deepEqual(facts.results, {
          completed: 1,
          deferred: 0,
          blocked: 1,
          failed: 0,
        });
        assert.equal(facts.actions_confirmed, 1);
        assert.equal(facts.partial_cycles, 1);
        assert.deepEqual(facts.unobserved, ["images"]);
        assert.equal(facts.window_complete, true);
        assert.ok(
          catalog.tools.some((t: any) => t.name === "coach_autonomy_report"),
        );
        await call("coach_autonomy_report", {
          slot: "digest-2026-10-03",
          text: "Daily digest: 2 cycles, 1 action, 1 partial (images unobserved).",
        });
        return acted("digest-2026-10-03");
      },
    ]);
    assert.equal(runtime.runs.length, 1);
    assert.equal(env.fake.messages.length, 1);
    assert.equal(env.fake.messages[0].recipient_id, env.fake.chief);
    assert.equal(result.outcome.result, "completed");
  } finally {
    await env.close();
  }
});

test("an empty window is still reported when suppression is off", async () => {
  const env = await setup({
    kind: "digest",
    subjects: [],
    source: DATE,
    digest: { suppress_empty: false },
  });
  try {
    const { runtime } = await cycle(env, [
      async ({ call, message }) => {
        const facts = JSON.parse(
          /<host_digest>(.*)<\/host_digest>/s.exec(message)![1],
        );
        assert.equal(facts.cycles, 0);
        await call("coach_autonomy_report", {
          slot: "digest-2026-10-03",
          text: "Quiet day: no cycles ran.",
        });
        return acted("digest-2026-10-03");
      },
    ]);
    assert.equal(runtime.runs.length, 1);
    assert.equal(env.fake.messages.length, 1);
  } finally {
    await env.close();
  }
});

test("a digest that cannot read its reports says so instead of inventing a quiet day", async () => {
  const env = await setup({
    kind: "digest",
    subjects: [],
    source: DATE,
    digest: { suppress_empty: true },
  });
  try {
    env.fake.state.reportsFail = true;
    const { result, runtime } = await cycle(env, [
      async ({ call, message }) => {
        const facts = JSON.parse(
          /<host_digest>(.*)<\/host_digest>/s.exec(message)![1],
        );
        assert.equal(facts.window_complete, false);
        assert.match(facts.unknowns.join(" "), /reports unavailable/);
        await call("coach_autonomy_report", {
          slot: "digest-2026-10-03",
          text: "Digest incomplete: cycle reports were unavailable.",
        });
        return acted("digest-2026-10-03");
      },
    ]);
    assert.equal(runtime.runs.length, 1);
    assert.equal(result.outcome.coverage.partial, true);
  } finally {
    await env.close();
  }
});
