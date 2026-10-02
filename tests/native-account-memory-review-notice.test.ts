import test from "node:test";
import assert from "node:assert/strict";
import {
  memoryFixture,
  scriptProvider,
  sseText,
  until,
} from "./helpers/native-memory.js";

// Contract follow-up (protected replacement review notice, account-only):
// a commit skips automatic replacement of protected memories with
// content-free `{index, reason:"protected_memory", memory_ids, count}`. The
// host writes nothing, overwrites nothing, never blocks the chat and groups
// ONE compact Needs review notice; normal empty or duplicate extraction stays
// silent.

type Fixture = Awaited<ReturnType<typeof memoryFixture>>;
const MORNING = "Prefers 25-minute morning workouts before work.";
const TUESDAY = "Trains on Tuesdays.";
const HUMAN =
  "I prefer 40-minute evening workouts now and I train on Fridays instead of Tuesdays. Remember that.";
const commits = (f: Fixture) =>
  f.backend.requests.filter(
    (r) => r.method === "POST" && /\/commit$/.test(r.path),
  );
const reviews = (f: Fixture) =>
  f.notices.filter((n) => n.action === "needs-review");
const replacing = (ids: string[]) => ({
  proposals: [
    {
      kind: "preference",
      text: "Prefers 40-minute evening workouts.",
      confidence: 0.9,
      importance: 0.8,
      supersedes: [ids[0]],
    },
    {
      kind: "fact",
      text: "Trains on Fridays instead of Tuesdays.",
      confidence: 0.9,
      importance: 0.8,
      supersedes: [ids[1]],
    },
  ],
});
async function turn(f: Fixture, proposals: () => unknown) {
  scriptProvider(f, {
    proposals,
    reply: () => sseText("Noted, evening sessions it is."),
  });
  const result = await f.turn([{ role: "user", content: HUMAN, timestamp: 1 }]);
  assert.equal(result.stopReason, "stop", "chat is never blocked");
  await until(() => commits(f).length === 1 || undefined);
}

test("replacing protected memories writes nothing and groups one Needs review notice", async () => {
  const f = await memoryFixture();
  try {
    const morning = f.backend.seed({ kind: "preference", text: MORNING });
    const tuesday = f.backend.seed({ kind: "fact", text: TUESDAY });
    const before = JSON.stringify([...f.backend.items.values()]);
    await turn(f, () => replacing([morning.id, tuesday.id]));
    await until(() => reviews(f).length || undefined);
    // Nothing created or overwritten; the protected rows are untouched.
    assert.equal(JSON.stringify([...f.backend.items.values()]), before);
    assert.equal(f.notices.filter((n) => n.action === "remembered").length, 0);
    const [notice] = reviews(f);
    assert.equal(reviews(f).length, 1, "one grouped notice");
    assert.equal(notice.source, "automatic");
    assert.deepEqual(
      notice.items.map((i: any) => [i.id, i.text, i.status]),
      [
        [morning.id, MORNING, "active"],
        [tuesday.id, TUESDAY, "active"],
      ],
    );
    assert.match(notice.note, /2 protected memories/);
    assert.match(notice.note, /Nothing was changed/);
    // Content-free: the rejected replacement text never reaches the notice.
    assert.doesNotMatch(JSON.stringify(notice), /evening|Fridays/);
  } finally {
    await f.close();
  }
});

test("normal empty or duplicate extraction shows no review notice", async () => {
  const f = await memoryFixture();
  try {
    f.backend.seed({ kind: "preference", text: MORNING });
    await turn(f, () => ({
      proposals: [
        {
          kind: "preference",
          text: MORNING,
          confidence: 0.9,
          importance: 0.8,
        },
      ],
    }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(reviews(f), [], "a duplicate skip is not a review");
  } finally {
    await f.close();
  }
});

for (const [name, bad] of [
  ["non-id memory_ids", { memory_ids: ["not-an-id"], count: 1 }],
  ["count below the listed ids", { count: 0 }],
  ["duplicate ids", { duplicate: true }],
  ["missing memory_ids", { memory_ids: undefined }],
] as const)
  test(`a protected skip with ${name} is rejected and announces nothing`, async () => {
    const f = await memoryFixture();
    try {
      const morning = f.backend.seed({ kind: "preference", text: MORNING });
      const tuesday = f.backend.seed({ kind: "fact", text: TUESDAY });
      f.backend.hooks.after = (request, body) => {
        if (!/\/commit$/.test(request.path)) return body;
        const skipped = body.skipped.map((s: any) => {
          const next: any = { ...s, ...bad };
          if ("duplicate" in bad) {
            delete next.duplicate;
            next.memory_ids = [s.memory_ids[0], s.memory_ids[0]];
            next.count = 2;
          }
          if (next.memory_ids === undefined) delete next.memory_ids;
          return next;
        });
        return { ...body, skipped };
      };
      await turn(f, () => replacing([morning.id, tuesday.id]));
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepEqual(reviews(f), []);
    } finally {
      await f.close();
    }
  });
