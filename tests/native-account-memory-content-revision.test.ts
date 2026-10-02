import test from "node:test";
import assert from "node:assert/strict";
import {
  memoryFixture,
  scriptProvider,
  sseText,
  until,
} from "./helpers/native-memory.js";
import { AccountMemory } from "../src/memory/account.js";

// Direct user steering (retained semantic coherence): memories acquired in an
// earlier turn stay capture fences, fenced by their semantic content_revision
// when the backend supplies it, so metadata-only edits (importance, pin,
// review date) never freeze automatic learning. Text/kind corrections still
// do; without content_revision the raw revision stays strict.

type Fixture = Awaited<ReturnType<typeof memoryFixture>>;
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const captures = (f: Fixture) =>
  f.backend.requests.filter(
    (r) => r.method === "POST" && r.path === "/api/coach/memory/interactions",
  );
const commits = (f: Fixture) =>
  f.backend.requests.filter(
    (r) => r.method === "POST" && /\/commit$/.test(r.path),
  );
const user = (content: string, timestamp: number) => ({
  role: "user",
  content,
  timestamp,
});
const assistant = (text: string, timestamp: number) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "katafit",
  model: "synthetic-memory-model",
  usage,
  stopReason: "stop",
  timestamp,
});
const VEGETARIAN = "Vegetarian; avoids meat in meal suggestions.";
const owner = (f: Fixture) =>
  new AccountMemory(
    f.backend.origin,
    f.backend.token,
    AbortSignal.timeout(5000),
    [],
  );
const learningOff = (f: Fixture) =>
  f.notices.some((n) => n.action === "learning-off");

async function firstTurn(f: Fixture) {
  const seeded = f.backend.seed({ kind: "preference", text: VEGETARIAN });
  scriptProvider(f, {
    proposals: () => ({ proposals: [] }),
    reply: () => sseText("Try a lentil bowl after training."),
  });
  const first = [user("What vegetarian meal suits after training?", 1)];
  assert.equal((await f.turn(first)).stopReason, "stop");
  await until(() => commits(f).length === 1 || undefined);
  return {
    seeded,
    history: [...first, assistant("Try a lentil bowl after training.", 2)],
  };
}
async function nextTurn(f: Fixture, history: any[], text: string, at: number) {
  scriptProvider(f, {
    proposals: () => ({ proposals: [] }),
    reply: () => sseText("Rest well tonight."),
  });
  const messages = [...history, user(text, at)];
  assert.equal((await f.turn(messages)).stopReason, "stop");
  return [...messages, assistant("Rest well tonight.", at + 1)];
}

test("retained memories are fenced by content_revision, so metadata-only edits never freeze learning (re-observed or not)", async () => {
  const f = await memoryFixture();
  try {
    const { seeded, history } = await firstTurn(f);
    assert.deepEqual(captures(f)[0].body.recalled, [
      { id: seeded.id, revision: 1, content_revision: 1 },
    ]);
    // Importance changes out of band; the next turn does not recall it.
    await owner(f).update(seeded.id, { importance: 0.3 }, 1, "ui:meta-1");
    const second = await nextTurn(
      f,
      history,
      "How long should I rest tonight?",
      3,
    );
    await until(() => commits(f).length === 2 || undefined);
    assert.deepEqual(captures(f)[1].body.recalled, [
      { id: seeded.id, revision: 1, content_revision: 1 },
    ]);
    // Pin and review date change; the next turn's recall re-observes it.
    await owner(f).update(seeded.id, { pinned: true }, 2, "ui:meta-2");
    await owner(f).update(
      seeded.id,
      { review_at: new Date(Date.now() + 86400000 * 30).toISOString() },
      3,
      "ui:meta-3",
    );
    await nextTurn(f, second, "Any tips for sleeping better?", 5);
    await until(() => commits(f).length === 3 || undefined);
    assert.deepEqual(captures(f)[2].body.recalled, [
      { id: seeded.id, revision: 4, content_revision: 1 },
    ]);
    assert.equal(learningOff(f), false);
  } finally {
    await f.close();
  }
});

for (const change of ["text", "kind"] as const)
  test(`a ${change} correction of retained text still stops learning for the chat`, async () => {
    const f = await memoryFixture();
    try {
      const { seeded, history } = await firstTurn(f);
      await owner(f).update(
        seeded.id,
        change === "text"
          ? { text: "Pescatarian; eats fish but no other meat." }
          : { kind: "fact" },
        1,
        "ui:semantic-1",
      );
      await nextTurn(f, history, "How long should I rest tonight?", 3);
      await until(() => learningOff(f) || undefined);
      assert.equal(commits(f).length, 1);
    } finally {
      await f.close();
    }
  });

test("without content_revision from the backend the raw revision stays strict", async () => {
  const f = await memoryFixture();
  try {
    f.backend.hooks.after = (_request, body) =>
      Array.isArray(body?.items)
        ? {
            ...body,
            items: body.items.map(({ content_revision, ...i }: any) => i),
          }
        : body;
    const { seeded, history } = await firstTurn(f);
    assert.deepEqual(captures(f)[0].body.recalled, [
      { id: seeded.id, revision: 1 },
    ]);
    await owner(f).update(seeded.id, { importance: 0.3 }, 1, "ui:meta-1");
    await nextTurn(f, history, "How long should I rest tonight?", 3);
    await until(() => learningOff(f) || undefined);
    assert.equal(commits(f).length, 1);
  } finally {
    await f.close();
  }
});

test("the account client keeps a valid content_revision and rejects an invalid one", async () => {
  const f = await memoryFixture();
  try {
    const seeded = f.backend.seed({ kind: "fact", text: "Owns a rower." });
    const page = await owner(f).list({ status: "active" });
    assert.equal(page.items[0].content_revision, 1);
    f.backend.hooks.after = (_request, body) =>
      Array.isArray(body?.items)
        ? {
            ...body,
            items: body.items.map((i: any) => ({ ...i, content_revision: 0 })),
          }
        : body;
    await assert.rejects(owner(f).list({ status: "active" }), {
      code: "MEMORY_RESULT_REJECTED",
    });
    assert.ok(seeded);
  } finally {
    await f.close();
  }
});
