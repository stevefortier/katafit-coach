import test from "node:test";
import assert from "node:assert/strict";
import {
  extractionSystem,
  parseProposals,
  ExtractionRejected,
} from "../src/memory/extract.js";
import {
  memoryFixture,
  scriptProvider,
  sseText,
  until,
  settle,
} from "./helpers/native-memory.js";
import { AccountMemory } from "../src/memory/account.js";

// D1 (parent product decision): capture coherence fences cover every
// acquired memory, but persisted ancestry is only what a proposal cites in
// the optional account-only `based_on` (plus explicit supersedes).

const A = "a".repeat(24);
const B = "b".repeat(24);
const base = { kind: "fact", text: "Owns a kettlebell.", confidence: 0.9 };
const parse = (proposal: object, origin?: "account_turn" | "operator_turn") =>
  parseProposals(
    JSON.stringify({ proposals: [{ ...base, importance: 0.5, ...proposal }] }),
    { secrets: [], recalled: [A, B], origin },
  );

test("account proposals accept a cited subset of recalled ids and keep it", () => {
  const [p] = parse({ based_on: [A] }, "account_turn");
  assert.deepEqual(p.based_on, [A]);
  const [plain] = parse({}, "account_turn");
  assert.equal("based_on" in plain, false, "absent stays absent");
});

for (const [name, based_on] of [
  ["a not-recalled id", ["c".repeat(24)]],
  ["a duplicate id", [A, A]],
  ["an invalid id", ["not-an-id"]],
  ["more than 20 ids", Array.from({ length: 21 }, () => A)],
  ["a non-array", A],
] as const)
  test(`account proposals citing ${name} discard the whole output`, () => {
    assert.throws(
      () => parse({ based_on }, "account_turn"),
      ExtractionRejected,
    );
  });

test("legacy origins keep the unchanged schema without based_on", () => {
  assert.throws(
    () => parse({ based_on: [A] }, "operator_turn"),
    ExtractionRejected,
  );
  assert.doesNotMatch(extractionSystem("p", "operator_turn"), /based_on/);
  const account = extractionSystem("p", "account_turn");
  assert.match(account, /based_on/);
  assert.match(account, /only/i);
});

const commits = (f: Awaited<ReturnType<typeof memoryFixture>>) =>
  f.backend.requests.filter(
    (r) => r.method === "POST" && /\/commit$/.test(r.path),
  );

test("native commit sends only genuine citations; Forget of a cited goal does not cascade to an unrelated allergy or an independent observation", async () => {
  const f = await memoryFixture();
  try {
    const allergy = f.backend.seed({
      kind: "fact",
      text: "Allergic to peanuts.",
      pinned: true,
    });
    const goal = f.backend.seed({
      kind: "goal",
      text: "Training for a spring half marathon.",
      pinned: true,
    });
    const DERIVED = "Wants long runs on Sundays for the half marathon.";
    const INDEPENDENT = "Owns a treadmill at home.";
    scriptProvider(f, {
      proposals: () => ({
        proposals: [
          {
            kind: "preference",
            text: DERIVED,
            confidence: 0.9,
            importance: 0.7,
            based_on: [goal.id],
          },
          { kind: "fact", text: INDEPENDENT, confidence: 0.9, importance: 0.5 },
        ],
      }),
      reply: () => sseText("Sunday long runs it is; your treadmill helps."),
    });
    await f.turn([
      {
        role: "user",
        content:
          "For my half marathon I want long runs on Sundays. I own a treadmill at home.",
        timestamp: 1,
      },
    ]);
    await until(() => commits(f).length === 1 || undefined);
    const capture = f.backend.requests.find(
      (r) => r.method === "POST" && r.path === "/api/coach/memory/interactions",
    )!;
    assert.deepEqual(
      capture.body.recalled.map((r: any) => r.id).sort(),
      [allergy.id, goal.id].sort(),
      "all acquired memories remain capture fences",
    );
    const [derived, independent] = commits(f)[0].body.proposals;
    assert.deepEqual(derived.based_on, [goal.id]);
    assert.equal("based_on" in independent, false);
    await until(
      () =>
        [...f.backend.items.values()].some((i) => i.text === INDEPENDENT) ||
        undefined,
    );
    const client = new AccountMemory(
      f.backend.origin,
      f.backend.token,
      AbortSignal.timeout(5000),
      [],
    );
    await client.forget(goal.id, goal.revision, "ui:forget-goal-0001");
    const texts = [...f.backend.items.values()].map((i) => i.text);
    assert.ok(texts.includes("Allergic to peanuts."), "unrelated allergy kept");
    assert.ok(texts.includes(INDEPENDENT), "independent observation kept");
    assert.ok(!texts.includes(DERIVED), "true cited descendant forgotten");
  } finally {
    await f.close();
  }
});

test("native extraction citing a memory that was not recalled commits nothing", async () => {
  const f = await memoryFixture();
  try {
    f.backend.seed({
      kind: "fact",
      text: "Allergic to peanuts.",
      pinned: true,
    });
    scriptProvider(f, {
      proposals: () => ({
        proposals: [
          {
            kind: "fact",
            text: "Owns a treadmill at home.",
            confidence: 0.9,
            importance: 0.5,
            based_on: ["c".repeat(24)],
          },
        ],
      }),
      reply: () => sseText("Nice."),
    });
    await f.turn([
      { role: "user", content: "I own a treadmill at home.", timestamp: 1 },
    ]);
    await settle(800);
    assert.ok(
      ![...f.backend.items.values()].some((i) => /treadmill/.test(i.text)),
    );
    for (const c of commits(f)) assert.deepEqual(c.body.proposals, []);
  } finally {
    await f.close();
  }
});
