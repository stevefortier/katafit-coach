// Synthetic source admission; real Worker.stop plus real admin HTTP lifecycle.
import "./fixtures/legacy-source-check.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "../src/worker/runner.js";
import { deferred, forceHarness, until } from "./helpers/force-upgrade.js";

test("a never-started worker remains confirmed stopped", async () => {
  const worker = new Worker({
    origin: "http://127.0.0.1:1",
    token: "synthetic-unused-token",
    system: "Coach",
    complete: async () => "unused",
  });
  assert.equal(worker.state, "stopped");
  assert.equal(worker.stopConfirmed, true);
  await worker.stop();
  assert.equal(worker.stopConfirmed, true);
});

test("timed-out Force retains the real worker until its pending Stop settles", async () => {
  const h = await forceHarness({ heldWorker: true, forceStopMs: 100 });
  const entered = deferred(),
    release = deferred();
  let worker: any;
  try {
    assert.equal((await h.post("/api/run")).status, 200);
    const sha = h.updates.latest!;
    const { id } = await (
      await h.post("/api/update/apply", { sha, confirm: true })
    ).json();
    await until(async () => (await h.queue()).phase === "waiting-worker");
    worker = h.worker;
    await until(() => worker.presence === "reported");
    const runningReports = () =>
      h.f.calls.filter(
        (c: any) =>
          c.body?.params?.name === "coach_report_worker_presence" &&
          c.body.params.arguments.state === "running",
      ).length;
    const before = runningReports();
    const report = worker.report.bind(worker);
    worker.report = async (state: string, ...args: unknown[]) => {
      if (state === "stopped") {
        entered.resolve();
        await release.promise;
      }
      return report(state, ...args);
    };
    assert.equal(
      (await h.post("/api/update/force", { id, sha, confirm: true })).status,
      202,
    );
    await entered.promise;
    await until(() => worker.state === "stopped" && worker.safeToReplace);
    const failed = await until(async () => {
      const queue = await h.queue();
      return queue.phase === "failed" && queue;
    });
    assert.equal(failed.reason, "WORKER_STOP_UNCONFIRMED");
    assert.equal(
      worker.stopConfirmed,
      false,
      "a previous reported presence is not completion of the current Stop",
    );
    assert.equal(
      runningReports(),
      before,
      "failure recovery must not construct a replacement before Stop settles",
    );
    const state = await (
      await fetch(h.app.origin + "/api/status", {
        headers: h.headers,
      })
    ).json();
    assert.equal(state.state, "stopped");
    assert.equal(state.stopConfirmed, false);
    const refusedRun = await h.post("/api/run");
    assert.equal(
      refusedRun.status,
      400,
      "new Run cannot overtake the same pending Stop",
    );
    assert.equal((await refusedRun.json()).error, "WORKER_STOP_UNCONFIRMED");
    assert.deepEqual(h.applications, []);
    release.resolve();
    await worker.stop();
    assert.equal(worker.stopConfirmed, true);
    assert.equal(
      (await h.post("/api/run")).status,
      200,
      "settled cleanup restores normal Run without another global gate",
    );
  } finally {
    release.resolve();
    if (worker) await worker.stop();
    await h.close();
  }
});
