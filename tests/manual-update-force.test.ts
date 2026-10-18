import "./fixtures/legacy-source-check.js";
import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Store } from "../src/config/store.js";
import { NativeRuntime } from "../src/sandbox/runtime.js";
import {
  forceHarness as harness,
  deferred,
  settled,
  until,
} from "./helpers/force-upgrade.js";

test("explicit Force interrupts waiting worker and a never-ending native turn and installs the pinned candidate once", async () => {
  const h = await harness({ heldWorker: true });
  try {
    await h.post("/api/run");
    await h.connect();
    const turn = h.neverEndingTurn();
    void turn.catch(() => {});
    await until(() => h.providerCalls === 1);
    const response = await h.post("/api/update/apply", {
      sha: h.updates.latest,
      confirm: true,
    });
    assert.equal(response.status, 202);
    const { id } = await response.json();
    await until(async () => (await h.queue())?.phase === "waiting-worker");
    // Accepted worker drainage still waits; owned Pi is closed automatically.
    await new Promise((r) => setTimeout(r, 600));
    assert.equal((await h.queue()).phase, "waiting-worker");
    assert.equal((await h.queue()).forced, undefined);
    assert.equal(h.runtimes[0].stops, 1);
    assert.equal(await settled(turn, 2000), "rejected");
    assert.deepEqual(h.applications, []);
    // New native admission stays denied while queued.
    assert.equal((await h.post("/api/terminal/ticket")).status, 409);

    const sha = h.updates.latest!;
    // Authenticated, exact queue ID + SHA, explicit confirmation.
    assert.equal(
      (
        await h.post(
          "/api/update/force",
          { id, sha, confirm: true },
          { ...h.headers, Authorization: "Bearer wrong" },
        )
      ).status,
      401,
    );
    for (const body of [
      { id, sha },
      { id, sha, confirm: "yes" },
      { id, sha, confirm: true, extra: 1 },
    ])
      assert.equal((await h.post("/api/update/force", body)).status, 400);
    for (const body of [
      { id: "00000000-0000-4000-8000-000000000000", sha, confirm: true },
      { id, sha: "c".repeat(40), confirm: true },
    ]) {
      const rejected = await h.post("/api/update/force", body);
      assert.equal(rejected.status, 409);
      assert.equal((await rejected.json()).error, "QUEUE_ID_MISMATCH");
    }
    assert.equal(
      h.runtimes[0].stops,
      1,
      "rejections do not repeat native teardown",
    );

    // Double click: both coalesce onto one worker Stop and installation.
    const [first, second] = await Promise.all([
      h.post("/api/update/force", { id, sha, confirm: true }),
      h.post("/api/update/force", { id, sha, confirm: true }),
    ]);
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    const a = await first.json(),
      b = await second.json();
    assert.equal(a.id, id);
    assert.equal(b.id, id);
    assert.equal(a.manualQueue.forced, true);
    // Cancel is refused once the explicit force is accepted.
    assert.equal(
      (await h.post("/api/update/cancel", { id })).status,
      409,
      "forced queue is no longer cancellable",
    );
    await until(async () => (await h.queue()).phase === "accepted");
    // The in-flight model call was interrupted, not awaited to completion.
    assert.equal(await settled(turn, 2000), "rejected");
    assert.equal(h.runtimes[0].stops, 1);
    assert.deepEqual(h.applications, [sha], "same target installed once");
    assert.equal(h.applyCalls.length, 1);
    assert.equal(h.applyCalls[0][0], sha);
    assert.equal(h.applyCalls[0][1], true, "original running intent retained");
    assert.equal(h.applyCalls[0][2], true, "original pinned preparation");
    assert.equal(h.preparations, 1, "preparation is not restarted");
    assert.equal(h.cancellations, 0, "prepared candidate is not cancelled");
    // No replay: neither a new runtime nor a repeated model request.
    assert.equal(h.runtimes.length, 1);
    assert.equal(h.providerCalls, 1);
    const late = await h.post("/api/update/force", { id, sha, confirm: true });
    assert.equal(late.status, 202, "late duplicate click is coalesced");
    assert.equal((await late.json()).manualQueue.phase, "accepted");
    assert.deepEqual(h.applications, [sha]);
    // Configuration credentials are retained on disk.
    const disk = new Store(h.f.store.dir);
    await disk.init();
    assert.equal(disk.secrets.token, "synthetic-backend-credential");
    assert.equal(disk.secrets.apiKey, "synthetic-provider-credential");
  } finally {
    await h.close();
  }
});

test("Force is unavailable without an active waiting queue", async () => {
  const h = await harness();
  try {
    const sha = h.updates.latest!;
    const none = await h.post("/api/update/force", {
      id: "00000000-0000-4000-8000-000000000000",
      sha,
      confirm: true,
    });
    assert.equal(none.status, 409);
    assert.equal((await none.json()).error, "QUEUE_ID_MISMATCH");
    // Idle native: the queue proceeds without force and nothing is interrupted.
    const response = await h.post("/api/update/apply", { sha, confirm: true });
    const { id } = await response.json();
    await until(async () => (await h.queue()).phase === "accepted");
    const after = await h.post("/api/update/force", { id, sha, confirm: true });
    assert.equal(after.status, 409);
    assert.equal((await after.json()).error, "FORCE_UNAVAILABLE");
    assert.deepEqual(h.applications, [sha]);
  } finally {
    await h.close();
  }
});

test("normal confirmed upgrade closes a starting Pi and preserves running Coach resume intent", async () => {
  const h = await harness({ heldStart: true });
  try {
    assert.equal((await h.post("/api/run")).status, 200);
    const starting = await h.connect(false);
    await h.startEntered.promise;
    const response = await h.post("/api/update/apply", {
      sha: h.updates.latest,
      confirm: true,
    });
    assert.equal(response.status, 202);
    const { id } = await response.json();
    assert.equal((await h.queue()).wasRunning, true);
    assert.equal(await starting.closed, 1008);
    await until(async () => (await h.queue()).phase === "accepted");
    assert.equal(h.applyCalls.length, 1);
    assert.equal(h.applyCalls[0][1], true, "captured running intent kept");
    assert.equal(h.preparations, 1);
    assert.equal(h.cancellations, 0);
    const status = await (
      await fetch(h.app.origin + "/api/status", { headers: h.headers })
    ).json();
    assert.equal(status.state, "stopped");
    assert.equal(status.nativeActive, false);
  } finally {
    await h.close();
  }
});

test("normal noncooperative native teardown fails visibly within the stop bound and never installs", async () => {
  const h = await harness({ teardown: "never", forceStopMs: 300 });
  try {
    await h.connect();
    const turn = h.neverEndingTurn();
    void turn.catch(() => {});
    await until(() => h.providerCalls === 1);
    const sha = h.updates.latest!;
    const { id } = await (
      await h.post("/api/update/apply", { sha, confirm: true })
    ).json();
    const started = Date.now();
    const failed = await until(async () => {
      const q = await h.queue();
      return q.phase === "failed" && q;
    }, 3000);
    assert.ok(Date.now() - started < 3000, "finite, not an endless spinner");
    assert.equal(failed.reason, "NATIVE_STOP_UNCONFIRMED");
    assert.equal(failed.forced, undefined);
    assert.deepEqual(h.applications, [], "never claims installation");
    assert.equal(h.updates.snapshot().lastOperation, undefined);
    // Teardown remains owned by the native lifecycle: admission stays denied.
    const denied = await h.post("/api/terminal/ticket");
    assert.equal(denied.ok, false);
    assert.equal(h.runtimes.length, 1, "no replacement runtime started");
    // Supported teardown eventually completes; Pi and upgrade are usable again.
    h.releaseStop();
    await until(async () => (await h.post("/api/terminal/ticket")).ok);
    h.teardown = "cooperative";
    const retry = await h.post("/api/update/apply", { sha, confirm: true });
    assert.equal(retry.status, 202);
    await until(async () => (await h.queue()).phase === "accepted");
    assert.deepEqual(h.applications, [sha]);
  } finally {
    await h.close();
  }
});

test("rejected native teardown reports an actionable failure and keeps controls", async () => {
  const h = await harness({ teardown: "reject" });
  try {
    await h.connect();
    const sha = h.updates.latest!;
    const { id } = await (
      await h.post("/api/update/apply", { sha, confirm: true })
    ).json();

    const failed = await until(async () => {
      const q = await h.queue();
      return q.phase === "failed" && q;
    }, 3000);
    assert.equal(failed.reason, "NATIVE_STOP_UNCONFIRMED");
    assert.deepEqual(h.applications, []);
    // Supported Close / Stop Pi recovers the native lifecycle.
    h.teardown = "cooperative";
    assert.equal((await h.post("/api/terminal/stop")).status, 200);
    assert.equal((await h.post("/api/terminal/ticket")).status, 200);
  } finally {
    await h.close();
  }
});

test("only the Coach-owned native runtime gates or is stopped by Force; unrelated host Pi is untouched", async () => {
  // A separately opened Pi on the same host (e.g. another terminal session).
  const external = spawn(
    process.execPath,
    ["-e", "process.title = 'pi'; setInterval(() => {}, 1000)"],
    { argv0: "pi", stdio: "ignore" },
  );
  const alive = () => {
    try {
      process.kill(external.pid!, 0);
      return external.exitCode === null;
    } catch {
      return false;
    }
  };
  try {
    await until(async () =>
      (await readFile(`/proc/${external.pid}/cmdline`, "utf8")).startsWith(
        "pi",
      ),
    );
    // Idle Coach-owned terminal: the external Pi never causes waiting-native.
    const idle = await harness();
    try {
      const sha = idle.updates.latest!;
      const { id } = await (
        await idle.post("/api/update/apply", { sha, confirm: true })
      ).json();
      await until(async () => (await idle.queue()).phase === "accepted");
      assert.equal((await idle.queue()).id, id);
      assert.equal((await idle.queue()).forced, undefined);
      assert.deepEqual(idle.applications, [sha]);
    } finally {
      await idle.close();
    }
    assert.equal(alive(), true, "unrelated Pi is not stopped by an upgrade");

    // Active Coach-owned runtime: normal confirmation stops exactly that runtime.
    const owned = await harness();
    try {
      const pane = await owned.connect();
      void owned.neverEndingTurn().catch(() => {});
      await until(() => owned.providerCalls === 1);
      // Browser disconnected; the owned runtime stays open (as observed live).
      pane.ws.terminate();
      await pane.closed;
      const open = await (
        await fetch(owned.app.origin + "/api/status", {
          headers: owned.headers,
        })
      ).json();
      assert.equal(open.nativeActive, true);
      const sha = owned.updates.latest!;
      const { id } = await (
        await owned.post("/api/update/apply", { sha, confirm: true })
      ).json();

      await until(async () => (await owned.queue()).phase === "accepted");
      assert.equal(owned.runtimes.length, 1);
      assert.equal(owned.runtimes[0].stops, 1);
    } finally {
      await owned.close();
    }
    assert.equal(alive(), true, "Force never kills an unrelated host Pi");
  } finally {
    external.kill("SIGKILL");
  }

  // Supported native teardown removes its own exact container name only; it
  // never lists, filters or scans host containers/processes.
  const commands: string[][] = [];
  const runtime: any = new NativeRuntime("sha256:" + "a".repeat(64), {
    socketPath: "/nonexistent/docker.sock",
    exec: async (file, args) => {
      commands.push([file, ...args]);
      return { stdout: "" };
    },
  });
  runtime.created = true;
  await runtime.stop();
  assert.match(runtime.name, /^katafit-pi-[0-9a-f-]{36}$/);
  assert.deepEqual(commands, [
    [
      "docker",
      "--host=unix:///nonexistent/docker.sock",
      "rm",
      "--force",
      runtime.name,
    ],
  ]);
});

for (const phase of ["waiting-publication", "waiting-worker"] as const) {
  test(`Force ${phase} ends finitely without discarding unresolved identity or pretending installation`, async () => {
    const h = await harness({
      heldPublication: phase === "waiting-publication",
      heldWorker: phase === "waiting-worker",
      heldWorkerStop: phase === "waiting-worker",
      forceStopMs: 200,
    });
    try {
      assert.equal((await h.post("/api/run")).status, 200);
      const sha = h.updates.latest!;
      const { id } = await (
        await h.post("/api/update/apply", { sha, confirm: true })
      ).json();
      await until(async () => (await h.queue()).phase === phase);
      const identity = h.worker.pendingTask;
      assert.equal(
        (await h.post("/api/update/force", { id, sha, confirm: true })).status,
        202,
      );
      const failed = await until(async () => {
        const q = await h.queue();
        return q.phase === "failed" && q;
      }, 2000);
      assert.equal(failed.reason, "WORKER_STOP_UNCONFIRMED");
      assert.equal(
        h.worker.pendingTask,
        identity,
        "same original unresolved identity remains owned",
      );
      assert.deepEqual(h.applications, []);
      assert.equal(h.updates.snapshot().lastOperation, undefined);
    } finally {
      await h.close();
    }
  });
}

test("automatic native closure is noncancellable; later Cancel cancels installation only", async () => {
  const h = await harness({
    teardown: "never",
    heldWorker: true,
    forceStopMs: 2000,
  });
  try {
    await h.post("/api/run");
    await h.connect();
    const sha = h.updates.latest!;
    const { id } = await (
      await h.post("/api/update/apply", { sha, confirm: true })
    ).json();
    await until(() => h.runtimes[0].stops === 1);
    assert.equal((await h.queue()).phase, "stopping-native");
    assert.equal((await h.post("/api/update/cancel", { id })).status, 409);
    assert.equal(
      (await h.post("/api/update/force", { id, sha, confirm: true })).status,
      409,
    );
    assert.equal((await h.post("/api/terminal/ticket")).status, 409);
    h.releaseStop();
    await until(async () => (await h.queue()).phase === "waiting-worker");
    assert.equal((await h.post("/api/update/cancel", { id })).status, 200);
    assert.equal((await h.queue()).phase, "cancelled");
    assert.equal(
      h.runtimes[0].stops,
      1,
      "native closure is not reversed or replayed",
    );
    assert.deepEqual(h.applications, []);
  } finally {
    await h.close();
  }
});

test("Force accepted during final readiness still performs supported Worker Stop", async () => {
  const h = await harness({ heldWorker: true });
  const ready = deferred(),
    entered = deferred();
  try {
    await h.post("/api/run");
    const sha = h.updates.latest!;
    const { id } = await (
      await h.post("/api/update/apply", { sha, confirm: true })
    ).json();
    await until(async () => (await h.queue()).phase === "waiting-worker");
    const assertReady = h.updates.assertReady.bind(h.updates);
    h.updates.assertReady = async (...args: Parameters<typeof assertReady>) => {
      entered.resolve();
      await ready.promise;
      return assertReady(...args);
    };
    h.releaseWorker();
    await entered.promise;
    assert.equal(
      (await h.post("/api/update/force", { id, sha, confirm: true })).status,
      202,
    );
    ready.resolve();
    const final = await until(async () => {
      const q = await h.queue();
      return ["failed", "accepted"].includes(q.phase) && q;
    });
    assert.equal(final.phase, "accepted", JSON.stringify(final));
    assert.equal(h.worker.stopConfirmed, true);
    assert.deepEqual(h.applications, [sha]);
  } finally {
    ready.resolve();
    await h.close();
  }
});
