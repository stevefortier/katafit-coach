import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "../src/worker/runner.js";
import { compile, stockPersona } from "../src/config/store.js";
import { taskFixture } from "./task-fixtures.js";

// C8 (work-packages §2.7): the request worker offers coach_record_commitment
// only when the backend advertises it, records only a verbatim quote of the
// member's own message under the active request lease, and a commitment
// failure never affects the reply (coach_respond).

const TOKEN = "synthetic-worker-credential-0123456789";
const MESSAGE =
  "Thanks coach! I will do my mobility routine every morning this week.";
const QUOTE = "I will do my mobility routine every morning this week";
const ARGS = {
  slot: "mobility-week",
  quote: QUOTE,
  due_at: "2026-10-10T08:00:00.000Z",
  timezone: "Europe/Paris",
  next_condition: "Ask how the morning mobility went.",
};
const recorded = (a: any) => ({
  recorded: true,
  follow_up_id: "f".repeat(24),
  idempotent: false,
  echo: a.slot,
});

async function run(
  options: any,
  script: (tools: any[]) => Promise<unknown>,
  extra: any = {},
) {
  const f = await taskFixture({
    main: true,
    requestMessage: MESSAGE,
    ...options,
  });
  const seen: any = {};
  const w = new Worker({
    origin: f.origin,
    token: TOKEN,
    system: "Saved Coach persona",
    complete: async (_c: string, _s: any, system: string, tools: any[]) => {
      seen.system = system;
      seen.names = tools.map((t) => t.name);
      seen.tools = tools;
      seen.result = await script(tools);
      return "Synthetic reply.";
    },
    ...extra,
  });
  try {
    await w.pollOnce().catch((e: Error) => (seen.error = e.message));
  } finally {
    await w.stop();
    await f.close();
  }
  const responded = f.calls.filter((c: any) => c.name === "coach_respond");
  return { f, seen, responded };
}
async function record(tools: any[], args: any) {
  const tool = tools.find((t) => t.name === "coach_record_commitment");
  assert.ok(tool, "coach_record_commitment offered");
  try {
    const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
    const out = await tool.execute(
      "c1",
      prepared,
      new AbortController().signal,
    );
    return { ok: true, value: JSON.parse(out.content[0].text) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

test("the tool is absent when the backend does not advertise it", async () => {
  const { seen, responded } = await run({}, async () => null);
  assert.ok(!seen.names.includes("coach_record_commitment"));
  assert.equal(responded.length, 1);
});

test("an explicit quoted commitment is recorded under the active lease with the quote passed through", async () => {
  const { f, seen, responded } = await run({ commitment: recorded }, (tools) =>
    record(tools, ARGS),
  );
  assert.deepEqual(seen.result, {
    ok: true,
    value: {
      recorded: true,
      follow_up_id: "f".repeat(24),
      idempotent: false,
    },
  });
  assert.deepEqual(f.commitments, [
    { request_id: "main", lease_generation: 1, ...ARGS },
  ]);
  assert.equal(responded.length, 1);
  assert.match(seen.system, /coach_record_commitment/);
  assert.match(seen.system, /explicit/i);
});

test("the model cannot choose the fence: request and lease come from the active claim", async () => {
  const { f, seen } = await run({ commitment: recorded }, (tools) =>
    record(tools, { ...ARGS, request_id: "a".repeat(24), lease_generation: 9 }),
  );
  assert.equal(seen.result.ok, false);
  assert.deepEqual(f.commitments, []);
});

test("the fence closes when inference ends: a call during publication records nothing", async () => {
  let tools: any[] = [];
  let late: any;
  const { f, responded } = await run(
    {
      commitment: recorded,
      beforeRespond: async () => {
        late = await record(tools, ARGS);
      },
    },
    async (offered) => {
      tools = offered;
    },
  );
  assert.equal(responded.length, 1);
  assert.equal(late.ok, true);
  assert.equal(late.value.recorded, false);
  assert.equal(late.value.error, "LEASE_LOST");
  assert.deepEqual(f.commitments, []);
});

for (const code of [
  "COMMITMENT_EVIDENCE_MISMATCH",
  "LEASE_LOST",
  "COMMITMENT_SLOT_CONFLICT",
  "COMMITMENT_UNAVAILABLE",
])
  test(`backend ${code} is visible as non-recorded and the reply still publishes`, async () => {
    const { seen, responded } = await run(
      { commitment: () => ({ error: code }) },
      (tools) => record(tools, ARGS),
    );
    assert.deepEqual(seen.result.value, { recorded: false, error: code });
    assert.equal(responded.length, 1);
    assert.equal(seen.error, undefined);
  });

test("no mandate is passed through as non-recorded", async () => {
  const { seen, responded } = await run(
    { commitment: () => ({ recorded: false, reason: "no_mandate" }) },
    (tools) => record(tools, ARGS),
  );
  assert.deepEqual(seen.result.value, {
    recorded: false,
    reason: "no_mandate",
  });
  assert.equal(responded.length, 1);
});

test("an inferred missed plan item is never recorded: the quote must be the member's own words", async () => {
  const { f, seen, responded } = await run({ commitment: recorded }, (tools) =>
    record(tools, {
      ...ARGS,
      slot: "missed-legs",
      quote: "skipped leg day twice this week",
    }),
  );
  assert.equal(seen.result.value.recorded, false);
  assert.equal(seen.result.value.error, "COMMITMENT_EVIDENCE_MISMATCH");
  assert.deepEqual(f.commitments, [], "no backend call");
  assert.equal(responded.length, 1);
});

test("a lost response is settled by one identical retry; never a different payload", async () => {
  let n = 0;
  const { f, seen, responded } = await run(
    {
      commitment: (a: any) =>
        ++n === 1 ? "drop" : { ...recorded(a), idempotent: true },
    },
    (tools) => record(tools, ARGS),
  );
  assert.equal(seen.result.value.recorded, true);
  assert.equal(seen.result.value.idempotent, true);
  assert.equal(f.commitments.length, 2);
  assert.deepEqual(f.commitments[0], f.commitments[1]);
  assert.equal(responded.length, 1);
});

test("compile() authorizes only explicit quoted commitments and keeps the no-mutations rule", () => {
  const prompt = compile({ revision: 1, persona: stockPersona() } as any);
  assert.match(prompt, /No mutations/);
  assert.match(prompt, /coach_record_commitment/);
  assert.match(prompt, /verbatim/);
  assert.match(prompt, /never infer/i);
});
