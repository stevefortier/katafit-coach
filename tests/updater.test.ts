import { test } from "node:test";
import assert from "node:assert/strict";
import { Updates } from "../src/update/updates.js";

test("failed checks clear approval and rate-limit guidance; apply accepts only recently shown SHA and serializes", async () => {
  let finish!: () => void;
  let calls = 0;
  const sha = "b".repeat(40);
  const updates = new Updates(
    "a".repeat(40),
    async () =>
      new Promise<void>((r) => {
        finish = r;
      }),
    async () => {
      calls++;
      return calls === 1
        ? new Response(JSON.stringify({ object: { sha } }))
        : new Response("{}", { status: 403 });
    },
  );
  await assert.rejects(updates.apply(sha), /CHECK_FIRST/);
  await updates.check();
  await assert.rejects(updates.apply("main"), /TARGET_REJECTED/);
  const applying = updates.apply(sha);
  assert.equal(updates.snapshot().applying, true);
  await assert.rejects(updates.apply(sha), /UPDATE_IN_PROGRESS/);
  finish();
  await applying;
  updates.checkedAt = Date.now() - 61000;
  await updates.check();
  assert.equal(updates.snapshot().latest, null);
  assert.match(updates.snapshot().guidance, /rate limit/);
  await assert.rejects(updates.apply(sha), /CHECK_FIRST/);
});

test("oversized source responses are cancelled before buffering their body", async () => {
  let cancelled = false,
    pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (++pulls > 10) controller.close();
      else controller.enqueue(new Uint8Array(60000));
    },
    cancel() {
      cancelled = true;
    },
  });
  const updates = new Updates(null, null, async () => new Response(stream));
  await updates.check();
  assert.equal(cancelled, true);
  assert.equal(updates.snapshot().latest, null);
});

test("source check pins the fixed main SHA and throttles concurrent checks", async () => {
  let calls = 0;
  const sha = "a".repeat(40);
  const updates = new Updates(null, null, async (url) => {
    calls++;
    assert.equal(
      url,
      "https://api.github.com/repos/stevefortier/katafit-coach/git/ref/heads/main",
    );
    return new Response(JSON.stringify({ object: { sha } }), { status: 200 });
  });
  const results = await Promise.all([updates.check(), updates.check()]);
  assert.equal(results[0].latest, sha);
  assert.equal(results[1].latest, sha);
  assert.equal(calls, 1);
  await updates.check();
  assert.equal(calls, 1);
  assert.equal(updates.snapshot().installed, null);
  assert.match(updates.snapshot().guidance, /managed/);
});
