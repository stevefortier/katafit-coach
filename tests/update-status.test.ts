import { test } from "node:test";
import assert from "node:assert/strict";
import { Updates } from "../src/update/updates.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/config/store.js";
import { supervise } from "./helpers/legacy-supervisor.js";

test("source check reports in-flight state and retains error until real success", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1700000000000 });
  let respond!: (response: Response) => void;
  const updates = new Updates(
    "a".repeat(40),
    async () => {},
    () =>
      new Promise((resolve) => {
        respond = resolve;
      }),
  );
  const first = updates.check();
  assert.equal(updates.snapshot().checking, true);
  respond(new Response("", { status: 429 }));
  assert.equal((await first).checking, false);
  assert.equal(updates.snapshot().checkError, "RATE_LIMITED");
  await updates.check(); // A throttled call is not success.
  assert.equal(updates.snapshot().checkError, "RATE_LIMITED");
  t.mock.timers.tick(900001);
  const next = updates.check();
  assert.equal(updates.snapshot().checking, true);
  assert.equal(updates.snapshot().checkError, "RATE_LIMITED");
  respond(new Response(JSON.stringify({ object: { sha: "a".repeat(40) } })));
  await next;
  assert.equal(updates.snapshot().checking, false);
  assert.equal(updates.snapshot().checkError, null);
});

test("403 requires rate-limit evidence; network and HTTP errors are visible", async () => {
  for (const [response, expected] of [
    [new Response("", { status: 403 }), "FORBIDDEN"],
    [
      new Response("", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      }),
      "RATE_LIMITED",
    ],
    [
      new Response("", { status: 403, headers: { "retry-after": "60" } }),
      "RATE_LIMITED",
    ],
    [new Response("", { status: 503 }), "UNAVAILABLE"],
    [null, "UNAVAILABLE"],
  ] as const) {
    const updates = new Updates(null, null, async () => {
      if (!response) throw new Error("private network detail");
      return response;
    });
    await updates.check();
    assert.equal(updates.snapshot().checkError, expected);
    assert.equal(updates.snapshot().checking, false);
    assert.equal(updates.snapshot().latest, null);
    assert.doesNotMatch(updates.guidance, /private network detail/);
  }
});
