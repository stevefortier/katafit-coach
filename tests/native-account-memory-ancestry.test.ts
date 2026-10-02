import test from "node:test";
import assert from "node:assert/strict";
import {
  memoryFixture,
  scriptProvider,
  sseText,
  settle,
  until,
} from "./helpers/native-memory.js";
import { loadExtension } from "./helpers/native-relay.js";
import { toolCall } from "./helpers/continuity.js";
import { sse as selection } from "./helpers/native-member-send.js";
import { AccountMemory } from "../src/memory/account.js";

// Controller blocking finding (retained ancestry): text acquired earlier in a
// runtime stays in Pi's context after a later turn's fresh recall, so every
// capture must depend on all of it, and learning stays off once that cannot
// be proven, until a new runtime.

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

async function twoTurnsThenForget(f: Fixture, forget: "ui" | "coach") {
  const seeded = f.backend.seed({ kind: "preference", text: VEGETARIAN });
  scriptProvider(f, {
    proposals: () => ({ proposals: [] }),
    reply: () => sseText("Try a lentil bowl after training."),
  });
  const first = [user("What vegetarian meal suits after training?", 1)];
  assert.equal((await f.turn(first)).stopReason, "stop");
  await until(() => commits(f).length === 1 || undefined);
  const firstCapture = captures(f)[0];
  assert.deepEqual(firstCapture.body.recalled, [
    { id: seeded.id, revision: 1 },
  ]);
  const history = [...first, assistant("Try a lentil bowl after training.", 2)];
  // Second human turn: its own fresh recall no longer returns the item, but
  // the first turn's text is still in the context Pi sends.
  scriptProvider(f, {
    proposals: () => ({ proposals: [] }),
    reply: () => sseText("Rest well tonight."),
  });
  const second = [...history, user("How long should I rest tonight?", 3)];
  assert.equal((await f.turn(second)).stopReason, "stop");
  await until(() => commits(f).length === 2 || undefined);
  assert.deepEqual(
    captures(f)[1].body.recalled,
    [{ id: seeded.id, revision: 1 }],
    "an item acquired in an earlier turn remains a dependency",
  );
  if (forget === "ui") {
    await new AccountMemory(
      f.backend.origin,
      f.backend.token,
      AbortSignal.timeout(5000),
      [],
    ).forget(seeded.id, 1, "ui:forget-between-turns");
  } else {
    const args = {
      method: "DELETE",
      path: "/api/coach/memory/" + seeded.id,
      body: { expected_revision: 1 },
    };
    f.provider.reply = () => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: selection([{ id: "call_forget", args }]),
    });
    await f.turn([...second, user("Please forget that I'm vegetarian.", 4)]);
    const result = await f.gateway.handle({
      kind: "tool",
      name: "katafit_rest_request",
      args,
      toolCallId: "call_forget",
    });
    assert.equal(JSON.parse(result.content[0].text).status, "forgotten");
  }
  return { seeded, history: [...second, assistant("Rest well tonight.", 5)] };
}

for (const forget of ["ui", "coach"] as const) {
  test(`after a ${forget} Forget, a new human turn cannot resurrect earlier acquired text, while chat keeps working`, async () => {
    const f = await memoryFixture();
    try {
      const { seeded, history } = await twoTurnsThenForget(f, forget);
      const before = captures(f).length;
      // Adversarial: the extractor re-proposes the forgotten text verbatim
      // and the user's new words ground it.
      scriptProvider(f, {
        proposals: () => ({
          proposals: [
            {
              kind: "preference",
              text: VEGETARIAN,
              confidence: 0.9,
              importance: 0.7,
              goal_relevance: null,
              review_after_days: null,
              supersedes: [],
            },
          ],
        }),
        reply: () => sseText("Sure, more vegetarian, meat-free ideas."),
      });
      const third = await f.turn([
        ...history,
        user("Yes, vegetarian, I avoid meat. Any meal suggestions?", 6),
      ]);
      assert.equal(third.stopReason, "stop", "chat keeps working");
      await until(() =>
        f.notices.find(
          (n) =>
            n.action === "learning-off" &&
            /until you start a new chat/.test(n.note),
        ),
      );
      await settle();
      const later = captures(f).slice(before);
      for (const capture of later)
        assert.ok(
          capture.body.recalled.some((r: any) => r.id === seeded.id),
          "any later capture still declares the forgotten revision",
        );
      assert.equal(commits(f).length, 2, "nothing committed after Forget");
      assert.ok(
        ![...f.backend.items.values()].some((i) => i.text === VEGETARIAN),
        "forgotten text was not saved again",
      );
      assert.ok(!f.notices.some((n) => n.action === "remembered"));
      // The next turn is told learning is off; recall still runs.
      scriptProvider(f, { reply: () => sseText("Okay.") });
      await f.turn([
        ...history,
        user("Yes, vegetarian, I avoid meat. Any meal suggestions?", 6),
        assistant("Sure, more vegetarian, meat-free ideas.", 7),
        user("Thanks!", 8),
      ]);
      const system = f.provider.bodies.at(-1).messages[0].content;
      assert.match(system, /Automatic learning: off until the user starts/);
      await settle();
      assert.equal(commits(f).length, 2);
    } finally {
      await f.close();
    }
  });
}

test("account memory read through generic REST joins the runtime ancestry of later captures", async () => {
  const f = await memoryFixture();
  try {
    const seeded = f.backend.seed({
      kind: "fact",
      text: "Owns a rowing machine at home.",
    });
    const path = "/api/coach/memory/" + seeded.id;
    scriptProvider(f, {
      reply: () => toolCall("katafit_rest_request", { method: "GET", path }),
    });
    const first = [user("Check what you know about my equipment.", 1)];
    assert.equal((await f.turn(first)).stopReason, "toolUse");
    const ext = await loadExtension(f.relay);
    const result = await ext.call("katafit_rest_request", {
      method: "GET",
      path,
    });
    assert.match(JSON.stringify(result.content), /rowing machine/);
    scriptProvider(f, {
      proposals: () => ({ proposals: [] }),
      reply: () => sseText("Noted."),
    });
    await f.turn([user("Unrelated: how is the weather for a run?", 2)]);
    await until(() => captures(f).length === 1 || undefined);
    assert.deepEqual(captures(f)[0].body.recalled, [
      { id: seeded.id, revision: 1 },
    ]);
  } finally {
    await f.close();
  }
});

test("more acquired memories than one capture can declare closes learning until a new runtime", async () => {
  const f = await memoryFixture();
  try {
    for (let i = 0; i < 12; i++)
      f.backend.seed({ kind: "fact", text: `Running note number ${i}.` });
    for (let i = 0; i < 12; i++)
      f.backend.seed({ kind: "fact", text: `Cycling note number ${i}.` });
    scriptProvider(f, {
      proposals: () => ({ proposals: [] }),
      reply: () => sseText("Okay."),
    });
    const first = [user("Tell me about my running.", 1)];
    await f.turn(first);
    await until(() => commits(f).length === 1 || undefined);
    assert.equal(captures(f)[0].body.recalled.length, 12);
    await f.turn([...first, assistant("Okay.", 2), user("And my cycling?", 3)]);
    const notice = await until(() =>
      f.notices.find((n) => n.action === "learning-off"),
    );
    assert.match(notice.note, /more saved memories than automatic learning/);
    assert.match(notice.note, /until you start a new chat/);
    await settle();
    assert.equal(captures(f).length, 1, "no undeclarable capture is sent");
    const system = f.provider.bodies.at(-1).messages[0].content;
    assert.match(system, /Cycling note/, "recall itself keeps working");
  } finally {
    await f.close();
  }
});
