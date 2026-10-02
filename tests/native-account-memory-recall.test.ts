import test from "node:test";
import assert from "node:assert/strict";
import {
  memoryFixture,
  scriptProvider,
  sseText,
  systems,
} from "./helpers/native-memory.js";

// Controller F8: recall must work for ordinary questions. The backend keeps
// rows sharing an exact 3+ character token with `query` (no stemming), so the
// host sends bounded topic terms from the whole message, and when nothing is
// relevant it adds a small recent fallback. The model is told the selection is
// bounded, never the complete memory.

type Fixture = Awaited<ReturnType<typeof memoryFixture>>;
const REPORTS = "Prefers brief morning reports.";
const lists = (f: Fixture) =>
  f.backend.requests
    .filter((r) => r.method === "GET" && /^\/api\/coach\/memory\?/.test(r.path))
    .map((r) => new URL(r.path, "http://x").searchParams);
async function ask(f: Fixture, text: string) {
  scriptProvider(f, {
    proposals: () => ({ proposals: [] }),
    reply: () => sseText("Short and early."),
  });
  const result = await f.turn([{ role: "user", content: text, timestamp: 1 }]);
  assert.equal(result.stopReason, "stop");
  return String(systems(f.provider.bodies.at(-1))[0].content);
}
const older = (days: number) =>
  new Date(Date.now() - days * 86400000).toISOString();

test("a natural paraphrase with no shared word still recalls a bounded recent selection", async () => {
  const f = await memoryFixture();
  try {
    f.backend.seed({ kind: "preference", text: REPORTS });
    const system = await ask(f, "What reporting style should we use?");
    assert.ok(system.includes(REPORTS), system);
    assert.match(system, /bounded selection/);
    assert.match(system, /not the complete memory/);
    const fallback = lists(f).filter(
      (p) => !p.has("query") && !p.has("pinned"),
    );
    assert.equal(fallback.length, 1, "one unfiltered recent fallback");
    assert.ok(Number(fallback[0].get("limit")) <= 4);
  } finally {
    await f.close();
  }
});

test("topic terms come from the whole message, bounded, never the raw text", async () => {
  const f = await memoryFixture();
  try {
    // Newer unrelated memories fill any recent fallback.
    for (let i = 0; i < 6; i++)
      f.backend.seed({
        kind: "fact",
        text: `Unrelated synthetic note number ${i}.`,
        updated_at: older(1),
      });
    f.backend.seed({
      kind: "preference",
      text: "Avoids burpees after knee surgery recovery.",
      updated_at: older(90),
    });
    const filler = "Please plan this week carefully. ".repeat(40);
    const system = await ask(f, filler + "No burpees for me, okay?");
    assert.ok(system.includes("Avoids burpees"), "late topic word recalled");
    const query = lists(f)
      .find((p) => p.has("query"))!
      .get("query")!;
    assert.ok(query.length <= 500);
    assert.doesNotMatch(query, /[?,.]/, "terms, not the raw sentence");
    assert.match(query, /\bburpees\b/);
    assert.equal(
      query.split(" ").length,
      new Set(query.split(" ")).size,
      "unique terms",
    );
    // A relevant match exists, so no unfiltered fallback is added.
    assert.equal(
      lists(f).filter((p) => !p.has("query") && !p.has("pinned")).length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("pinned, topic and fallback recall stays within 20 memories", async () => {
  const f = await memoryFixture();
  try {
    for (let i = 0; i < 12; i++)
      f.backend.seed({
        kind: "goal",
        text: `Pinned synthetic goal ${i}.`,
        pinned: true,
      });
    for (let i = 0; i < 30; i++)
      f.backend.seed({ kind: "fact", text: `Squat note ${i}.` });
    const system = await ask(f, "How should my squat sessions progress?");
    const data = /memories=(\[.*\])\n/.exec(system)![1];
    const items = JSON.parse(data.replace(/\\u003c/g, "<"));
    assert.ok(items.length <= 20, String(items.length));
    assert.ok(items.some((i: any) => /Squat note/.test(i.text)));
  } finally {
    await f.close();
  }
});
