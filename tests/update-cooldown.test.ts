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
test("immutable comparison is coalesced and rate limits share the ref cooldown", async (t) => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now });
  let calls = 0;
  let limited = true;
  const updates = new Updates("a".repeat(40), null, async (url) => {
    calls++;
    if (!String(url).includes("/compare/"))
      return new Response(JSON.stringify({ object: { sha } }));
    return limited
      ? new Response("", {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(now / 1000 + 3600),
          },
        })
      : new Response(JSON.stringify({ status: "ahead", ahead_by: 1 }));
  });
  await updates.check();
  assert.deepEqual(
    await Promise.all([
      updates.isDescendant(updates.installed!, sha),
      updates.isDescendant(updates.installed!, sha),
    ]),
    [false, false],
  );
  assert.equal(calls, 2);
  assert.equal(updates.latest, null);
  assert.equal(updates.checkError, "RATE_LIMITED");
  for (let minute = 1; minute < 60; minute++) {
    t.mock.timers.setTime(now + minute * 60000);
    await updates.check();
    await updates.isDescendant(updates.installed!, sha);
    assert.equal(calls, 2);
  }
  t.mock.timers.setTime(now + 3600000);
  limited = false;
  await updates.check();
  assert.equal(await updates.isDescendant(updates.installed!, sha), true);
  for (let minute = 61; minute < 75; minute++) {
    t.mock.timers.setTime(now + minute * 60000);
    await updates.check(true);
    assert.equal(await updates.isDescendant(updates.installed!, sha), true);
  }
  assert.equal(calls, 4);
});
test("automatic freshness is fifteen minutes while manual approval can refresh after one", async (t) => {
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
  await updates.check(true);
  for (let minute = 1; minute < 15; minute++) {
    t.mock.timers.setTime(now + minute * 60000);
    await updates.check(true);
    assert.equal(calls, 1);
  }
  assert.throws(() => updates.validate(sha), /CHECK_FIRST/);
  await updates.check();
  assert.equal(calls, 2);
  assert.equal(updates.validate(sha), sha);
  t.mock.timers.setTime(now + 29 * 60000);
  await updates.check(true);
  assert.equal(calls, 3);
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
