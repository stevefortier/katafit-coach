import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CleanupRegistry } from "../src/autonomy/cleanup.js";
import {
  HeadlessCycleRuntime,
  HEADLESS_OWNER_LABEL,
  HEADLESS_ROLE_LABEL,
} from "../src/autonomy/headless.js";
import { productionRuntimes } from "../src/autonomy/host.js";
import { autonomyOwner } from "../src/autonomy/owner.js";
import { dockerProbeEngine } from "../src/sandbox/runtime.js";
import { closeLeaked } from "./helpers/autonomy-cycle.js";
import { autonomyAdmin, until as waitFor } from "./helpers/autonomy-admin.js";
import { MEMBER } from "./helpers/autonomy-fake.js";
import {
  fakeDaemon,
  fakeEngine,
  IMAGE,
  leaked,
  obedient,
  stubGateway,
  until,
  type FakeDaemon,
  type Script,
} from "./helpers/headless-engine.js";

// C5 F4/F5 (client-c5-independent-review.md): headless autonomy containers
// are owned by one installation. Cleanup identity is durable before create,
// a failed teardown keeps the host unsafe and blocks further cycles until a
// scoped retry proves absence, and no sweep touches another owner's live
// planner/composer, legacy or unrelated containers.

after(async () => {
  for (const close of [...leaked]) await close();
  await closeLeaked();
});

const homes: string[] = [];
after(async () => {
  for (const h of homes) await rm(h, { recursive: true, force: true });
});
async function installation() {
  const home = await mkdtemp(join(tmpdir(), "autonomy-owned-"));
  homes.push(home);
  const owner = await autonomyOwner(home);
  const cleanup = await CleanupRegistry.open(home, owner);
  return { home, owner, cleanup };
}
const records = async (home: string) =>
  (await readdir(join(home, "autonomy", "cleanup")).catch(() => [])).filter(
    (n) => n.endsWith(".json"),
  );
const exits: Script = (command, pi) => {
  if (command.type === "prompt") pi.close();
};
const held: Script = (command, pi) => {
  if (command.type === "prompt")
    pi.send({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
    });
};
const cycle = (signal?: AbortSignal) => ({
  profile: "planner" as const,
  gateway: stubGateway(),
  message: "x",
  cycleMs: 5000,
  signal,
});
const seed = (
  daemon: FakeDaemon,
  name: string,
  labels: Record<string, string>,
) => {
  const Id = name
    .replace(/[^a-f0-9]/g, "")
    .padEnd(64, "e")
    .slice(0, 64);
  daemon.containers.set(Id, {
    Id,
    Name: "/" + name,
    Image: IMAGE,
    Config: { Image: IMAGE, Labels: labels },
  });
};

test("F4: production runtimes label every container with the installation owner and record it durably before create", async () => {
  const a = await installation();
  const fake = await fakeEngine(held);
  const runtimes = await productionRuntimes(a.home, {
    owner: a.owner,
    cleanup: a.cleanup,
    image: async () => IMAGE,
    engine: fake.engine,
  });
  const controller = new AbortController();
  const run = runtimes.planner.run(cycle(controller.signal));
  await until(() => fake.commands.length > 0);
  const [create] = fake.creates();
  assert.ok(create.includes(`${HEADLESS_OWNER_LABEL}=${a.owner}`));
  assert.ok(create.includes(`${HEADLESS_ROLE_LABEL}=autonomy`));
  assert.equal((await records(a.home)).length, 1, "durable before teardown");
  controller.abort();
  await assert.rejects(run, /HEADLESS_ABORTED/);
  assert.equal(fake.daemon.containers.size, 0);
  assert.deepEqual(await records(a.home), [], "record removed after absence");
  await fake.close();
});

test("F4: one installation's startup sweep keeps another owner's live planner, legacy and unrelated containers", async () => {
  const daemon = fakeDaemon();
  const a = await installation();
  const b = await installation();
  const fakeA = await fakeEngine(held, undefined, daemon);
  const fakeB = await fakeEngine(obedient(), undefined, daemon);
  const planner = new HeadlessCycleRuntime({
    image: IMAGE,
    engine: fakeA.engine,
    cleanup: a.cleanup,
  });
  const controller = new AbortController();
  const live = planner.run(cycle(controller.signal));
  await until(() => fakeA.commands.length > 0);
  const liveName = [...daemon.containers.values()][0].Name;
  const crashed = "katafit-pi-auto-33333333-3333-4333-8333-333333333333";
  seed(daemon, crashed, {
    [HEADLESS_ROLE_LABEL]: "autonomy",
    [HEADLESS_OWNER_LABEL]: b.owner,
  });
  const legacy = "katafit-pi-auto-44444444-4444-4444-8444-444444444444";
  seed(daemon, legacy, { [HEADLESS_ROLE_LABEL]: "autonomy" });
  seed(daemon, "unrelated", {});
  // Installation B starts (production wiring) on the same daemon.
  await productionRuntimes(b.home, {
    owner: b.owner,
    cleanup: b.cleanup,
    image: async () => IMAGE,
    engine: fakeB.engine,
  });
  const names = [...daemon.containers.values()].map((c) => c.Name).sort();
  assert.deepEqual(names, [liveName, "/" + legacy, "/unrelated"].sort());
  // A's live cycle is undisturbed and still owns its teardown.
  controller.abort();
  await assert.rejects(live, /HEADLESS_ABORTED/);
  assert.ok(![...daemon.containers.values()].some((c) => c.Name === liveName));
  await fakeA.close();
  await fakeB.close();
});

test("F4: a sweep never removes a container its own installation's running cycle owns", async () => {
  const a = await installation();
  const fake = await fakeEngine(held);
  const planner = new HeadlessCycleRuntime({
    image: IMAGE,
    engine: fake.engine,
    cleanup: a.cleanup,
  });
  const controller = new AbortController();
  const live = planner.run(cycle(controller.signal));
  await until(() => fake.commands.length > 0);
  const liveName = [...fake.daemon.containers.values()][0].Name;
  const crashed = "katafit-pi-auto-55555555-5555-4555-8555-555555555555";
  seed(fake.daemon, crashed, {
    [HEADLESS_ROLE_LABEL]: "autonomy",
    [HEADLESS_OWNER_LABEL]: a.owner,
  });
  // A second runtime of the same installation (e.g. the composer) sweeps.
  const composer = new HeadlessCycleRuntime({
    image: IMAGE,
    engine: fake.engine,
    cleanup: a.cleanup,
  });
  assert.equal(await composer.sweep(), 1);
  assert.deepEqual(
    [...fake.daemon.containers.values()].map((c) => c.Name),
    [liveName],
    "the crashed container goes, the live one stays",
  );
  controller.abort();
  await assert.rejects(live, /HEADLESS_ABORTED/);
  assert.equal(fake.daemon.containers.size, 0);
  await fake.close();
});

test("F5: a failed teardown is retained durably, refuses further cycles and is retried until absence", async () => {
  const a = await installation();
  const fake = await fakeEngine(exits);
  const headless = new HeadlessCycleRuntime({
    image: IMAGE,
    engine: fake.engine,
    cleanup: a.cleanup,
  });
  fake.daemon.failRm = 1000;
  const started = Date.now();
  await assert.rejects(headless.run(cycle()), /HEADLESS_CLEANUP_PENDING/);
  assert.ok(Date.now() - started < 2500, "a dead Pi ends the cycle promptly");
  assert.equal(fake.daemon.containers.size, 1, "container survived");
  assert.equal(a.cleanup.pending, 1);
  assert.equal((await records(a.home)).length, 1);
  assert.equal(headless.active, false);
  // The next cycle retries first; still failing, it creates nothing.
  await assert.rejects(headless.run(cycle()), /HEADLESS_CLEANUP_PENDING/);
  assert.equal(fake.creates().length, 1, "no second container");
  assert.equal(a.cleanup.pending, 1);
  // Process restart: the durable record is reloaded and still pending.
  const reopened = await CleanupRegistry.open(a.home, a.owner, {
    probe: dockerProbeEngine(fake.engine.exec, fake.engine.socketPath),
  });
  assert.equal(reopened.pending, 1);
  fake.daemon.failRm = 0;
  fake.daemon.failInspect = 1;
  assert.equal(await reopened.drain(), 1, "inspect failure keeps it");
  assert.equal(await reopened.drain(), 0, "exact removal proves absence");
  assert.equal(fake.daemon.containers.size, 0);
  assert.deepEqual(await records(a.home), []);
  await fake.close();
});

test("F5: the real host stays unsafe, refuses quiesce and claims nothing more until owned cleanup is confirmed, across restart", async () => {
  const fake = await fakeEngine(exits);
  fake.daemon.failRm = 1000;
  const env = await autonomyAdmin({
    runtimes: (home, context) =>
      productionRuntimes(home, {
        ...context,
        image: async () => IMAGE,
        engine: fake.engine,
      }),
    cleanupEngine: dockerProbeEngine(fake.engine.exec, fake.engine.socketPath),
  });
  try {
    await env.call("POST", "/api/autonomy/participate", { participate: true });
    env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
    await waitFor(() => fake.creates().length === 1, "planner container");
    await waitFor(
      async () => (await env.status()).local.cleanupPending === 1,
      "cleanup pending",
    );
    env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
    await new Promise((r) => setTimeout(r, 400));
    const s = await env.status();
    assert.equal(s.local.safeToReplace, false);
    assert.equal(fake.creates().length, 1, "no further container");
    const claims = env.fake.calls.filter((c) => /\/claim/.test(c.path));
    assert.equal(claims.length, 1, "no further claim while pending");
    assert.equal(
      (await env.call("GET", "/api/status")).body.safeToReplace,
      false,
    );
    const refused = await env.call("POST", "/api/update/quiesce", {
      confirm: true,
    });
    assert.equal(refused.status, 409);
    await env.call("POST", "/api/autonomy/participate", { participate: false });
    await env.restart();
    const reloaded = await env.status();
    assert.equal(reloaded.local.cleanupPending, 1, "durable across restart");
    assert.equal(reloaded.local.safeToReplace, false);
    fake.daemon.failRm = 0;
    const quiesced = await env.call("POST", "/api/update/quiesce", {
      confirm: true,
    });
    assert.equal(quiesced.status, 200, JSON.stringify(quiesced.body));
    assert.equal(fake.daemon.containers.size, 0);
    assert.equal((await env.status()).local.cleanupPending, 0);
  } finally {
    await env.close();
    await fake.close();
  }
});
