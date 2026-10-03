import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeLeaked,
  cycle,
  outcome,
  setup,
  work,
} from "./helpers/autonomy-cycle.js";
import { MEMBER } from "./helpers/autonomy-fake.js";

// C4 crash matrix (work-packages C4): every manager_report is one slot
// occurrence. Lost responses are resolved by receipt GET, an uncommitted
// request by an identical re-PUT, and anything still unknown blocks the work
// as uncertain_write. Restart and credential rotation never duplicate.

test.after(closeLeaked);

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const acted = (slots: string[]) =>
  outcome({
    decisions: [
      {
        subject_id: null,
        decision: "acted",
        action_slots: slots,
        follow_up_ids: [],
      },
    ],
  });
const puts = (env: any, slot: string) =>
  env.fake.calls.filter(
    (c: any) => c.method === "PUT" && c.path.endsWith(`/actions/${slot}`),
  ).length;
const text = (result: any) => JSON.parse(result.content[0].text);

test("lost response after commit: the receipt GET confirms it; one message, certified", async () => {
  const env = await setup();
  try {
    const { result, runtime } = await cycle(env, [
      async ({ call }) => {
        env.fake.dropNextWrite();
        const r = await call("coach_autonomy_report", {
          slot: "r1",
          text: "Private report.",
        });
        assert.equal(text(r).slot, "r1");
        assert.equal(text(r).recovered, true);
        return acted(["r1"]);
      },
    ]);
    assert.equal(runtime.runs[0].calls[0].ok, true);
    assert.equal(env.fake.messages.length, 1);
    assert.equal(puts(env, "r1"), 1);
    assert.equal(result.outcome.result, "completed");
    assert.deepEqual(env.fake.state.reports[0].action_slots, ["r1"]);
  } finally {
    await env.close();
  }
});

test("request lost before commit: receipt 404 leads to one identical re-PUT; one message", async () => {
  const env = await setup();
  try {
    const { result } = await cycle(env, [
      async ({ call }) => {
        env.fake.loseNextWrite();
        const r = await call("coach_autonomy_report", {
          slot: "r1",
          text: "Private report.",
        });
        assert.equal(text(r).slot, "r1");
        return acted(["r1"]);
      },
    ]);
    assert.equal(env.fake.messages.length, 1);
    assert.equal(env.fake.messages[0].text, "Private report.");
    assert.equal(puts(env, "r1"), 2);
    assert.equal(result.outcome.result, "completed");
  } finally {
    await env.close();
  }
});

test("still unknown after the receipt read: no replay, work blocked uncertain_write", async () => {
  const env = await setup();
  try {
    const { result, runtime } = await cycle(env, [
      async ({ call }) => {
        env.fake.dropNextWrite();
        env.fake.state.receiptReadsFail = true;
        const r = await call("coach_autonomy_report", {
          slot: "r1",
          text: "Private report.",
        });
        assert.match(JSON.stringify(r), /UNKNOWN|uncertain/i);
        return acted(["r1"]);
      },
    ]);
    assert.equal(runtime.runs.length, 1, "no correction run after uncertainty");
    assert.equal(puts(env, "r1"), 1);
    assert.equal(env.fake.messages.length, 1);
    assert.equal(result.outcome.result, "blocked");
    assert.equal(result.outcome.blocked_reason, "uncertain_write");
    assert.deepEqual(result.outcome.decisions, []);
    assert.equal(work(env.fake, env.workId).status, "blocked");
  } finally {
    await env.close();
  }
});

test("changed payload on a used slot is a visible conflict, never a second message", async () => {
  const env = await setup();
  try {
    const { result, runtime } = await cycle(env, [
      async ({ call }) => {
        await call("coach_autonomy_report", { slot: "r1", text: "First." });
        const r = await call("coach_autonomy_report", {
          slot: "r1",
          text: "Different.",
        });
        assert.equal(text(r).error, "ACTION_CONFLICT");
        return acted(["r1"]);
      },
    ]);
    assert.ok(runtime.runs[0].calls.every((c) => c.ok));
    assert.equal(env.fake.messages.length, 1);
    assert.equal(env.fake.messages[0].text, "First.");
    assert.equal(result.outcome.result, "completed");
  } finally {
    await env.close();
  }
});

test("crash before complete, restart and credential rotation: prior receipts are known, never duplicated", async () => {
  const env = await setup();
  try {
    const crash = new AbortController();
    await assert.rejects(
      cycle(
        env,
        [
          async ({ call }) => {
            await call("coach_autonomy_report", {
              slot: "r1",
              text: "Private report.",
            });
            crash.abort(new Error("PROCESS_EXIT"));
            throw new Error("PROCESS_EXIT");
          },
        ],
        {},
        { signal: crash.signal },
      ),
    );
    assert.equal(work(env.fake, env.workId).status, "running");
    env.fake.advance(121_000);
    // Restart with a rotated credential on the same account.
    const rotated = env.fake.client("installation-b");
    const { result, runtime } = await cycle(
      env,
      [
        async ({ call, message }) => {
          assert.match(message, /"slot":"r1"/);
          assert.match(message, new RegExp(sha("Private report.")));
          // An identical replay of the same slot stays one occurrence.
          const r = await call("coach_autonomy_report", {
            slot: "r1",
            text: "Private report.",
          });
          assert.equal(text(r).idempotent, true);
          return acted(["r1"]);
        },
      ],
      {},
      { backend: rotated },
    );
    assert.ok(runtime.runs[0].calls.every((c) => c.ok));
    assert.equal(env.fake.messages.length, 1);
    assert.equal(result.outcome.result, "completed");
    assert.equal(work(env.fake, env.workId).status, "completed");
  } finally {
    await env.close();
  }
});

test("a prior receipt can be certified without acting again", async () => {
  const env = await setup();
  try {
    const crash = new AbortController();
    await assert.rejects(
      cycle(
        env,
        [
          async ({ call }) => {
            await call("coach_autonomy_report", { slot: "r1", text: "x" });
            crash.abort(new Error("PROCESS_EXIT"));
            throw new Error("PROCESS_EXIT");
          },
        ],
        {},
        { signal: crash.signal },
      ),
    );
    env.fake.advance(121_000);
    const { result } = await cycle(
      env,
      [async () => acted(["r1"])],
      {},
      {
        backend: env.fake.client("installation-a"),
      },
    );
    assert.equal(result.outcome.result, "completed");
    assert.equal(env.fake.messages.length, 1);
    assert.equal(puts(env, "r1"), 1);
  } finally {
    await env.close();
  }
});

test("lost follow-up create response: one identical re-PUT recovers it; one row, certified", async () => {
  const env = await setup();
  try {
    const { result } = await cycle(env, [
      async ({ call }) => {
        env.fake.dropNextWrite();
        const r = await call("coach_autonomy_follow_up", {
          slot: "f1",
          op: "create",
          subject_id: MEMBER,
          basis: "coach_request",
          summary: "Check recovery next week.",
          due_at: "2026-10-08T07:00:00.000Z",
          next_condition: "A logged session.",
        });
        const id = text(r).follow_up_id;
        assert.match(id, /^[a-f0-9]{24}$/);
        return outcome({
          decisions: [
            {
              subject_id: MEMBER,
              decision: "deferred",
              action_slots: [],
              follow_up_ids: [id],
            },
          ],
        });
      },
    ]);
    assert.equal(env.fake.state.followUps.size, 1);
    assert.equal(result.outcome.result, "completed");
  } finally {
    await env.close();
  }
});
