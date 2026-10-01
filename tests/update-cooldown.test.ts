import { test } from "node:test";
import assert from "node:assert/strict";
import { Updates } from "../src/update/updates.js";

const sha = "b".repeat(40);
for (const [headers, seconds] of [
  [{ "retry-after": "1800" }, 1800],
  [{ "retry-after": "Thu, 01 Jan 2026 01:00:00 GMT" }, 3600],
  [{ "x-ratelimit-reset": "1767232800", "retry-after": "1800" }, 7200],
  [{ "retry-after": "-5", "x-ratelimit-reset": "garbage" }, 900],
  [{ "retry-after": "1e5", "x-ratelimit-reset": "Infinity" }, 900],
  [{ "retry-after": "1.5", "x-ratelimit-reset": "1767225599" }, 900],
  [{ "retry-after": "Wed, 31 Dec 2025 23:59:00 GMT" }, 900],
  [{ "retry-after": "99999999999999999999999" }, 900],
  [{ "retry-after": "3000000", "x-ratelimit-reset": "8640000000000" }, 900],
] as const) {
  test(`cooldown headers ${JSON.stringify(headers)}`, async (t) => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    t.mock.timers.enable({ apis: ["Date"], now });
    const updates = new Updates(
      null,
      null,
      async () => new Response("", { status: 429, headers }),
    );
    await updates.check();
    assert.equal(updates.sourceRetryAt, now + seconds * 1000);
  });
}
test("explicit approval expires without idle source discovery and refreshes only on Check", async (t) => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now });
  let calls = 0;
  const updates = new Updates(
    "a".repeat(40),
    async () => {},
    async () => {
      calls++;
      return new Response(JSON.stringify({ object: { sha } }));
    },
  );
  await updates.check();
  assert.equal(updates.validate(sha), sha);
  t.mock.timers.setTime(now + 600001);
  assert.equal(calls, 1);
  assert.throws(() => updates.validate(sha), /CHECK_FIRST/);
  await updates.check();
  assert.equal(calls, 2);
  assert.equal(updates.validate(sha), sha);
});
test("provider cooldown survives repeated manual checks and clears only on success", async (t) => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now });
  let calls = 0;
  const updates = new Updates(null, null, async () => {
    calls++;
    return calls === 1
      ? new Response("", { status: 429, headers: { "retry-after": "1800" } })
      : new Response(JSON.stringify({ object: { sha } }));
  });
  await updates.check();
  assert.equal(updates.snapshot().sourceRetryAt, now + 1800000);
  for (let minute = 1; minute < 30; minute++) {
    t.mock.timers.setTime(now + minute * 60000);
    await Promise.all([updates.check(), updates.check()]);
    assert.equal(calls, 1);
    assert.equal(updates.checkError, "RATE_LIMITED");
  }
  t.mock.timers.setTime(now + 1800000);
  await updates.check();
  assert.equal(calls, 2);
  assert.equal(updates.checkError, null);
  assert.equal(updates.snapshot().sourceRetryAt, null);
});
