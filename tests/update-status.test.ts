import { test } from "node:test";
import assert from "node:assert/strict";
import { Updates } from "../src/update/updates.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/config/store.js";
import { AutoUpdateSetting } from "../src/update/auto.js";
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

test("manual rate limit replaces the earlier armed source timer", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-manual-cooldown-"));
  const store = new Store(home);
  await store.init();
  const timers: { delay: number; timer: ReturnType<typeof setTimeout> }[] = [];
  const owner = await supervise(store, 0, undefined, {
    request: async () =>
      new Response("", { status: 429, headers: { "retry-after": "3600" } }),
    autoTimer: ((_fn: () => void, delay: number) => {
      const timer = setTimeout(() => {}, 2 ** 30);
      timers.push({ delay, timer });
      return timer;
    }) as typeof setTimeout,
  });
  try {
    const old = owner.updates.snapshot().autoSchedule!.nextAttemptAt!;
    await owner.updates.check();
    const state = owner.updates.snapshot();
    assert.ok(state.autoSchedule!.nextAttemptAt! > old);
    assert.equal(state.autoSchedule!.nextAttemptAt, state.sourceRetryAt);
    assert.equal(state.autoSchedule!.reason, "check-failed");
    assert.equal(timers.length, 2);
    assert.ok(timers[1].delay <= 3600000 && timers[1].delay > 3599000);
    await owner.updates.check();
    assert.equal(timers.length, 2);
  } finally {
    await owner.close();
    timers.forEach(({ timer }) => clearTimeout(timer));
    await rm(home, { recursive: true, force: true });
  }
});

test("stable scheduler publishes actual deadline through runtime IPC and API", async (t) => {
  const realNow = Date.now;
  let elapsed = 0;
  t.mock.method(Date, "now", () => realNow() + elapsed);
  const home = await mkdtemp(join(tmpdir(), "coach-schedule-status-"));
  const store = new Store(home);
  await store.init();
  await new AutoUpdateSetting(home).write(true);
  let callback!: () => void;
  let delay = 0;
  let respond!: (response: Response) => void;
  const owner = await supervise(store, 0, undefined, {
    request: () =>
      new Promise<Response>((resolve) => {
        respond = resolve;
      }),
    autoTimer: ((fn: () => void, ms: number) => {
      const timer = setTimeout(() => {}, 2 ** 30);
      callback = () => {
        clearTimeout(timer);
        fn();
      };
      delay = ms;
      return timer;
    }) as typeof setTimeout,
  });
  const read = async () =>
    (
      await fetch(owner.origin + "/api/update", {
        headers: { Authorization: "Bearer " + store.secrets.admin },
      })
    ).json();
  const wait = async (predicate: () => Promise<boolean>) => {
    const end = Date.now() + 5000;
    while (!(await predicate())) {
      assert.ok(Date.now() < end, "state reached API");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  };
  try {
    assert.equal(delay, 900000);
    const initial = owner.updates.snapshot().autoSchedule;
    assert.equal(initial?.reason, "poll");
    assert.ok(initial!.nextAttemptAt! > Date.now());
    await wait(
      async () =>
        (await read()).autoSchedule?.nextAttemptAt === initial!.nextAttemptAt,
    );
    callback();
    await wait(async () => (await read()).checking === true);
    assert.equal(owner.updates.snapshot().autoSchedule?.nextAttemptAt, null);
    respond(new Response("", { status: 429 }));
    await wait(
      async () => (await read()).autoSchedule?.reason === "check-failed",
    );
    assert.equal(delay, 900000);
    const failed = await read();
    assert.ok(Math.abs(failed.serverNow - Date.now()) < 2000);
    assert.equal(failed.checkError, "RATE_LIMITED");
    assert.ok(
      Math.abs(failed.autoSchedule.nextAttemptAt - Date.now() - delay) < 2000,
    );
    // The deadline is NOT checkedAt + backoff and manual checks do not reset it.
    const deadline = failed.autoSchedule.nextAttemptAt;
    assert.ok(
      deadline > failed.checkedAt + delay,
      "backoff starts after the response, not the request",
    );
    await new AutoUpdateSetting(home).write(false);
    const disabled = await read();
    assert.equal(disabled.auto.enabled, false);
    assert.equal(
      disabled.autoSchedule.nextAttemptAt,
      deadline,
      "consent does not cancel the timer",
    );
    await new AutoUpdateSetting(home).write(true);
    elapsed += 900001; // Cooldown expires; manual success leaves the armed timer intact.
    const manual = owner.updates.check();
    respond(
      new Response(
        JSON.stringify({ object: { sha: owner.updates.installed } }),
      ),
    );
    await manual;
    assert.equal(
      owner.updates.snapshot().autoSchedule?.nextAttemptAt,
      deadline,
    );
    assert.equal(owner.updates.snapshot().checkError, null);
    assert.equal(
      owner.updates.snapshot().autoSchedule?.reason,
      "check-failed",
      "successful manual check does not rearm the existing backoff timer",
    );
    callback();
    await wait(async () => (await read()).autoSchedule?.reason === "poll");
    assert.equal(delay, 900000);
  } finally {
    await owner.close();
    await rm(home, { recursive: true, force: true });
  }
});

for (const reason of ["readiness", "recovery"] as const) {
  test(`stable scheduler reports ${reason} deadline without claiming a source request`, async (t) => {
    const realNow = Date.now;
    let elapsed = 0;
    t.mock.method(Date, "now", () => realNow() + elapsed);
    const home = await mkdtemp(join(tmpdir(), "coach-schedule-reason-"));
    const store = new Store(home);
    await store.init();
    await new AutoUpdateSetting(home).write(true);
    const sha = "b".repeat(40);
    if (reason === "recovery")
      await writeFile(
        join(home, "update-resume.json"),
        JSON.stringify({ sha, pending: true }),
        { mode: 0o600 },
      );
    let callback!: () => void;
    let delay = 0;
    let requests = 0;
    const owner = await supervise(store, 0, undefined, {
      request: async (url) => {
        requests++;
        return new Response(
          JSON.stringify(
            String(url).includes("/compare/")
              ? { status: "ahead", ahead_by: 1 }
              : { object: { sha } },
          ),
        );
      },
      prepare: async () => {
        throw new Error("EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED");
      },
      autoTimer: ((fn: () => void, ms: number) => {
        const timer = setTimeout(() => {}, 2 ** 30);
        callback = () => {
          clearTimeout(timer);
          fn();
        };
        delay = ms;
        return timer;
      }) as typeof setTimeout,
    });
    try {
      assert.equal(delay, reason === "recovery" ? 1 : 900000);
      callback();
      const end = Date.now() + 10000;
      while (
        owner.updates.snapshot().autoSchedule?.reason !== reason ||
        delay === 1
      ) {
        assert.ok(Date.now() < end, "scheduler completed cycle");
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      const schedule = owner.updates.snapshot().autoSchedule!;
      assert.equal(owner.updates.snapshot().checking, false);
      assert.ok(Math.abs(schedule.nextAttemptAt! - Date.now() - delay) < 2000);
      if (reason === "recovery") {
        assert.equal(delay, 10000);
        assert.equal(requests, 0, "recovery precedes source checks");
      } else {
        assert.ok(delay <= 60000 && delay >= 58000);
        assert.equal(
          owner.updates.snapshot().autoOutcome?.reason,
          "ARTIFACT_NOT_READY",
        );
        assert.equal(requests, 2, "one ref plus one comparison");
        for (let minute = 1; minute < 15; minute++) {
          elapsed += 60000;
          await owner.auto.tick();
          assert.equal(
            requests,
            2,
            "local readiness retries reuse remote evidence",
          );
        }
        elapsed += 60000;
        await owner.auto.tick();
        assert.equal(
          requests,
          3,
          "new ref after fifteen minutes; immutable ancestry reused",
        );
        assert.equal(await new AutoUpdateSetting(home).failedTarget(), null);
      }
    } finally {
      await owner.close();
      await rm(home, { recursive: true, force: true });
    }
  });
}
