import { test } from "node:test";
import assert from "node:assert/strict";
import { Updates } from "../src/update/updates.js";

test("late ref body cannot clear a newer comparison rate limit", async () => {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  let refStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    refStarted = resolve;
  });
  const requests: string[] = [];
  const updates = new Updates(
    "a".repeat(40),
    async () => {},
    async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/compare/"))
        return new Response("", {
          status: 429,
          headers: { "retry-after": "3600" },
        });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
        },
      });
      refStarted();
      return new Response(stream);
    },
  );
  const checking = updates.check();
  await started;
  try {
    await assert.rejects(
      updates.sourceRequest(
        `https://api.github.com/repos/stevefortier/katafit-coach/compare/${"a".repeat(40)}...${"b".repeat(40)}`,
      ),
      /RATE_LIMITED/,
    );
    const deadline = updates.snapshot().sourceRetryAt;
    assert.ok(deadline && deadline > Date.now());
    body.enqueue(
      new TextEncoder().encode(
        JSON.stringify({ object: { sha: "b".repeat(40) } }),
      ),
    );
    body.close();
    await checking;
    assert.equal(updates.snapshot().checkError, "RATE_LIMITED");
    assert.equal(updates.snapshot().latest, null);
    assert.equal(updates.snapshot().sourceRetryAt, deadline);
    await updates.check();
    assert.equal(requests.length, 2, "cooldown prevents another ref request");
    assert.throws(() => updates.validate("b".repeat(40)), /CHECK_FIRST/);
  } finally {
    try {
      body.close();
    } catch {
      // The success path already closed the synthetic stream.
    }
    await checking;
  }
});
