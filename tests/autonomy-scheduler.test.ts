import test from "node:test";
import assert from "node:assert/strict";
import { AutonomyScheduler } from "../src/autonomy/scheduler.js";
import { Admission } from "../src/runtime/admission.js";
import type { WorkItem } from "../src/autonomy/types.js";
import {
  autonomyFake,
  MEMBER,
  type AutonomyFake,
} from "./helpers/autonomy-fake.js";

// C2 behaviour (work-packages §4 C2): ticks read state before any inference,
// claims are single-flight and fenced by the backend, admission is shared
// with the request Worker, and stop/pause never release a lease locally.

async function setup(mode: "observe" | "off" = "observe") {
  const fake = await autonomyFake();
  try {
    const owner = fake.client("installation-a");
    const {
      capabilities,
      protocol,
      mandate_id,
      dojo_id,
      chief_id,
      revision,
      status,
      suspended_reason,
      updated_at,
      updated_by,
      ...fields
    } = await owner.mandate();
    await owner.putMandate({
      idempotency_key: "scheduler-setup",
      expected_revision: 0,
      mandate: {
        ...fields,
        mode,
        timezone: "Europe/Paris",
        delegated_actions: ["manager_report", "follow_up"],
      },
    });
    return fake;
  } catch (error) {
    await fake.close();
    throw error;
  }
}

/** A runner that records cycles and counts provider (inference) calls. */
function recorder(
  behaviour: (cycle: {
    work: WorkItem;
    signal: AbortSignal;
  }) => Promise<void> = async () => {},
) {
  const cycles: WorkItem[] = [];
  const counter = { provider: 0 };
  const run = async (cycle: { work: WorkItem; signal: AbortSignal }) => {
    cycles.push(cycle.work);
    counter.provider += 1;
    await behaviour(cycle);
  };
  return { cycles, counter, run };
}

const scheduler = (
  fake: AutonomyFake,
  name: string,
  run: (cycle: any) => Promise<void>,
  extra: Partial<ConstructorParameters<typeof AutonomyScheduler>[0]> = {},
) =>
  new AutonomyScheduler({
    backend: fake.client(name),
    admission: new Admission(),
    run,
    random: () => 0.5,
    ...extra,
  });

const paths = (fake: AutonomyFake, from = 0) =>
  fake.calls.slice(from).map((c) => `${c.method} ${c.path.split("?")[0]}`);

test("idle ticks read state only: no claim, no runner, zero provider calls", async () => {
  const fake = await setup();
  const r = recorder();
  const s = scheduler(fake, "installation-a", r.run);
  try {
    const before = fake.calls.length;
    for (let i = 0; i < 3; i++) {
      const tick = await s.tick();
      assert.equal(tick.outcome, "idle");
      assert.equal(tick.delayMs, 60_000);
    }
    assert.equal(r.counter.provider, 0);
    assert.ok(
      paths(fake, before).every((p) => p.startsWith("GET ")),
      "an idle tick performs no write",
    );
  } finally {
    await s.stop();
    await fake.close();
  }
});

test("mode off or a paused mandate never claims, even with due work", async () => {
  const fake = await setup("off");
  const r = recorder();
  const s = scheduler(fake, "installation-a", r.run);
  try {
    fake.enqueue({ kind: "event", subject_ids: [MEMBER] });
    const before = fake.calls.length;
    assert.equal((await s.tick()).outcome, "disabled");
    fake.state.mandate.mode = "observe";
    fake.state.mandate.paused = true;
    assert.equal((await s.tick()).outcome, "disabled");
    assert.equal(r.counter.provider, 0);
    assert.ok(
      !paths(fake, before).includes("POST /api/coach/autonomy/work/claim"),
    );
  } finally {
    await s.stop();
    await fake.close();
  }
});

test("a due item is claimed, started and dispatched to the runner once", async () => {
  const fake = await setup();
  const r = recorder();
  const s = scheduler(fake, "installation-a", r.run);
  try {
    const id = fake.enqueue({ kind: "event", subject_ids: [MEMBER] });
    const tick = await s.tick();
    assert.equal(tick.outcome, "ran");
    assert.equal(r.cycles.length, 1);
    assert.equal(r.cycles[0].id, id);
    assert.equal(r.cycles[0].status, "running");
    assert.equal(fake.state.work.get(id).status, "running");
  } finally {
    await s.stop();
    await fake.close();
  }
});

test("overlapping timers share one in-flight tick and start() is single-loop", async () => {
  const fake = await setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const r = recorder(() => gate);
  const s = scheduler(fake, "installation-a", r.run);
  try {
    fake.enqueue({ kind: "event", subject_ids: [MEMBER] });
    const before = fake.calls.length;
    const a = s.tick();
    const b = s.tick();
    assert.equal(a, b, "a second timer joins the in-flight tick");
    await new Promise((r) => setTimeout(r, 50));
    release();
    await a;
    assert.equal(
      paths(fake, before).filter((p) => p.endsWith("/work/claim")).length,
      1,
    );
    assert.equal(r.cycles.length, 1);
  } finally {
    await s.stop();
    await fake.close();
  }
});

test("two installations race one due item and only one runner executes", async () => {
  const fake = await setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const r = recorder(() => gate);
  const a = scheduler(fake, "installation-a", r.run);
  const b = scheduler(fake, "installation-b", r.run);
  try {
    fake.enqueue({ kind: "event", subject_ids: [MEMBER] });
    const ticks = [a.tick(), b.tick()];
    await new Promise((r) => setTimeout(r, 50));
    release();
    const outcomes = (await Promise.all(ticks)).map((t) => t.outcome).sort();
    assert.deepEqual(outcomes, ["contended", "ran"]);
    assert.equal(r.cycles.length, 1);
  } finally {
    await a.stop();
    await b.stop();
    await fake.close();
  }
});

test("backend outage and provider outage back off with bounded jitter, then reset", async () => {
  const fake = await setup();
  let fail = true;
  const r = recorder(async () => {
    if (fail) throw new Error("PROVIDER_UNAVAILABLE");
  });
  const jitter = [0, 1, 0.5];
  let n = 0;
  const s = scheduler(fake, "installation-a", r.run, {
    random: () => jitter[n++ % jitter.length],
    minBackoffMs: 1000,
    maxBackoffMs: 4000,
  });
  try {
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      fake.enqueue({ kind: "event", subject_ids: [MEMBER] });
      const tick = await s.tick();
      assert.equal(tick.outcome, "backoff");
      delays.push(tick.delayMs);
      fake.advance(301_000); // the failed lease expires
    }
    // equal jitter: base/2 + random*base/2, base doubling to the cap.
    assert.deepEqual(delays, [500, 2000, 3000, 2000]);
    fail = false;
    fake.advance(301_000);
    assert.equal((await s.tick()).outcome, "ran");
    // A backend that cannot be reached also backs off rather than spinning.
    await fake.close();
    const down = await s.tick();
    assert.equal(down.outcome, "backoff");
    assert.ok(down.delayMs >= 500 && down.delayMs <= 1000);
  } finally {
    await s.stop();
    await fake.close().catch(() => {});
  }
});

test("credential rejection stops admission: no further requests or claims", async () => {
  const fake = await setup();
  const r = recorder();
  const s = scheduler(fake, "installation-a", r.run);
  try {
    fake.enqueue({ kind: "event", subject_ids: [MEMBER] });
    fake.revokeAll();
    const first = await s.tick();
    assert.equal(first.outcome, "credential_rejected");
    assert.equal(s.state, "credential_rejected");
    const before = fake.calls.length;
    assert.equal((await s.tick()).outcome, "credential_rejected");
    assert.equal(fake.calls.length, before, "no request after rejection");
    assert.equal(r.counter.provider, 0);
  } finally {
    await s.stop();
    await fake.close();
  }
});

test("pause during an active cycle aborts it, completes nothing and claims nothing more", async () => {
  const fake = await setup();
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  const r = recorder(
    ({ signal }) =>
      new Promise<void>((_, reject) => {
        entered();
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  const s = scheduler(fake, "installation-a", r.run);
  try {
    const id = fake.enqueue({ kind: "event", subject_ids: [MEMBER] });
    const tick = s.tick();
    await inside;
    const before = fake.calls.length;
    await s.pause();
    assert.equal((await tick).outcome, "paused");
    assert.equal(s.state, "paused");
    assert.deepEqual(paths(fake, before), [], "pause writes nothing");
    assert.equal(fake.state.work.get(id).status, "running");
    fake.enqueue({ kind: "event", subject_ids: [MEMBER] });
    assert.equal((await s.tick()).outcome, "paused");
    assert.equal(fake.calls.length, before);
    s.resume();
    assert.notEqual(s.state, "paused");
  } finally {
    await s.stop();
    await fake.close();
  }
});

test("stop while claimed releases nothing locally; the backend lease expires to another installation", async () => {
  const fake = await setup();
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  const r = recorder(
    ({ signal }) =>
      new Promise<void>((_, reject) => {
        entered();
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  const a = scheduler(fake, "installation-a", r.run);
  const b = scheduler(fake, "installation-b", async () => {});
  try {
    const id = fake.enqueue({ kind: "event", subject_ids: [MEMBER] });
    const tick = a.tick();
    await inside;
    const before = fake.calls.length;
    await a.stop();
    await tick;
    assert.equal(a.state, "stopped");
    assert.deepEqual(paths(fake, before), []);
    // The live lease is not due work for anyone else until it expires.
    assert.equal((await b.tick()).outcome, "idle");
    fake.advance(301_000);
    assert.equal((await b.tick()).outcome, "ran");
    assert.equal(fake.state.work.get(id).lease_generation, 2);
  } finally {
    await a.stop();
    await b.stop();
    await fake.close();
  }
});

test("start() loops on the mandate cadence, independent of any browser, until stop()", async () => {
  const fake = await setup();
  fake.state.mandate.cadence.client_tick_seconds = 45;
  const r = recorder();
  const timers: number[] = [];
  const s = scheduler(fake, "installation-a", r.run, {
    wait: async (ms: number, signal: AbortSignal) => {
      timers.push(ms);
      if (timers.length >= 3)
        await new Promise((r) => signal.addEventListener("abort", r));
    },
  });
  try {
    s.start();
    s.start();
    await new Promise((r) => setTimeout(r, 200));
    await s.stop();
    assert.deepEqual(timers, [45_000, 45_000, 45_000]);
    assert.equal(s.state, "stopped");
  } finally {
    await s.stop();
    await fake.close();
  }
});

test("admission: requests take priority; due autonomy work ages to the front after 10 minutes", async () => {
  let now = 0;
  const admission = new Admission({ now: () => now, agingMs: 600_000 });
  const order: string[] = [];
  let releaseFirst!: () => void;
  const first = admission.run(
    "request",
    undefined,
    () => new Promise<void>((r) => (releaseFirst = r)),
  );
  const autonomy = admission.run("autonomy", undefined, async () => {
    order.push("autonomy");
  });
  const request = admission.run("request", undefined, async () => {
    order.push("request-2");
  });
  await new Promise((r) => setTimeout(r, 10));
  releaseFirst();
  await Promise.all([first, autonomy, request]);
  assert.deepEqual(order, ["request-2", "autonomy"]);

  // A busy Worker cannot starve autonomy forever.
  order.length = 0;
  let hold!: () => void;
  const busy = admission.run(
    "request",
    undefined,
    () => new Promise<void>((r) => (hold = r)),
  );
  const aged = admission.run("autonomy", undefined, async () => {
    order.push("autonomy");
  });
  now += 600_000;
  const later = admission.run("request", undefined, async () => {
    order.push("request-late");
  });
  await new Promise((r) => setTimeout(r, 10));
  hold();
  await Promise.all([busy, aged, later]);
  assert.deepEqual(order, ["autonomy", "request-late"]);
});

test("admission: capacity one, cancellation removes a waiter, errors release the slot", async () => {
  const admission = new Admission();
  let active = 0;
  let peak = 0;
  const job = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
  };
  await Promise.all([
    admission.run("request", undefined, job),
    admission.run("autonomy", undefined, job),
    admission.run("request", undefined, job),
  ]);
  assert.equal(peak, 1);
  let hold!: () => void;
  const busy = admission.run(
    "request",
    undefined,
    () => new Promise<void>((r) => (hold = r)),
  );
  const controller = new AbortController();
  const ran: string[] = [];
  const cancelled = admission.run("autonomy", controller.signal, async () => {
    ran.push("cancelled");
  });
  controller.abort(new Error("STOP"));
  await assert.rejects(cancelled, /STOP/);
  hold();
  await busy;
  await assert.rejects(
    admission.run("request", undefined, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  await admission.run("autonomy", undefined, async () => {
    ran.push("after-error");
  });
  assert.deepEqual(ran, ["after-error"]);
  assert.equal(admission.busy, false);
});

test("FC2: the claim negotiates coach.capability.v1 and the runner receives the admitted capability", async () => {
  const fake = await setup();
  let seen: any;
  const s = scheduler(fake, "installation-a", async (cycle: any) => {
    seen = cycle;
  });
  try {
    fake.enqueue({ kind: "event", subject_ids: [MEMBER] });
    assert.equal((await s.tick()).outcome, "ran");
    assert.deepEqual(fake.state.claims.at(-1).capability_protocols, [
      "coach.capability.v1",
    ]);
    assert.equal(seen.capability.descriptor.plane, "autonomy");
    assert.deepEqual(seen.capability.actions, ["manager_report", "follow_up"]);
    assert.equal(seen.work.kind, "event");
  } finally {
    await s.stop();
    await fake.close();
  }
});

test("C5: a pause that lands while the due queue is read admits no claim", async () => {
  const fake = await setup();
  const r = recorder();
  const backend = fake.client("installation-a");
  let reading!: () => void;
  const read = new Promise<void>((resolve) => (reading = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const list = backend.listWork.bind(backend);
  backend.listWork = async (...args: Parameters<typeof list>) => {
    reading();
    await gate;
    return list(...args);
  };
  const s = new AutonomyScheduler({
    backend,
    admission: new Admission(),
    run: r.run,
    random: () => 0.5,
  });
  try {
    fake.enqueue({ kind: "event", subject_ids: [MEMBER] });
    const tick = s.tick();
    await read;
    const paused = s.pause();
    release();
    await paused;
    assert.equal((await tick).outcome, "paused");
    assert.equal(r.cycles.length, 0);
    assert.ok(!paths(fake).includes("POST /api/coach/autonomy/work/claim"));
  } finally {
    await s.stop();
    await fake.close();
  }
});
