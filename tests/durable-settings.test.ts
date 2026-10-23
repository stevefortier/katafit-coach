import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { Worker } from "../src/worker/runner.js";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { taskFixture } from "./task-fixtures.js";
import { IsolatedTaskJournal } from "../src/worker/isolatedTaskJournal.js";

test("corrupt isolation storage blocks startup but not settings save or admin status", async () => {
  const home = await mkdtemp(tmpdir() + "/corrupt-isolation-");
  const store = new Store(home);
  await store.init();
  await IsolatedTaskJournal.open(home);
  await writeFile(home + "/isolated-tasks/state.json", "corrupt");
  let app: Awaited<ReturnType<typeof admin>> | undefined;
  try {
    app = await admin(store, 0);
    const headers = {
      Authorization: "Bearer " + store.secrets.admin,
      Origin: app.origin,
      "Content-Type": "application/json",
    };
    const status = await (
      await fetch(app.origin + "/api/status", { headers })
    ).json();
    assert.equal(status.isolatedTaskRecovery.healthy, false);
    assert.equal(status.safeToReplace, false);
    const saved = await fetch(app.origin + "/api/config", {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...store.publicConfig(),
        provider: {
          ...store.publicConfig().provider,
          model: "saved-despite-history",
        },
      }),
    });
    assert.equal(saved.status, 200);
    assert.equal(store.publicConfig().provider.model, "saved-despite-history");
    const run = await fetch(app.origin + "/api/run", {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(run.ok, false);
  } finally {
    await app?.close();
    await rm(home, { recursive: true, force: true });
  }
});

for (const initiallyStopped of [false, true])
  test(`model save ${initiallyStopped ? "stopped" : "running"} worker retains isolation without replay; status survives cold admin`, async () => {
    const home = await mkdtemp(tmpdir() + "/durable-settings-");
    const f = await taskFixture({
      dropCompleteBeforeAcceptance: true,
      reconcileDenial: "TASK_SOURCE_CHANGED",
    });
    const task = f.enqueue("daily_insight");
    f.deny(task.id);
    const store = new Store(home);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin: f.origin,
      token: "synthetic-token",
      apiKey: "synthetic-provider",
    });
    const originalStart = Worker.prototype.start;
    const workers: Worker[] = [];
    Worker.prototype.start = function () {
      workers.push(this);
      (this as any).options.complete = async () =>
        JSON.stringify({
          general_advice: "synthetic",
          meal_recommendations: [],
          recovery_recommendations: [],
          workout_directives: [],
        });
      (this as any).options.pollMs = 100000;
      return originalStart.call(this);
    };
    let app = await admin(store, 0);
    const post = (path: string, body = {}) =>
      fetch(app.origin + path, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + store.secrets.admin,
          Origin: app.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const status = async () =>
      (
        await fetch(app.origin + "/api/status", {
          headers: { Authorization: "Bearer " + store.secrets.admin },
        })
      ).json();
    try {
      assert.equal((await post("/api/run")).status, 200);
      for (let n = 0; n < 400 && !workers[0]?.incidents.length; n++)
        await sleep(10);
      assert.equal(workers[0].incidents.length, 1);
      if (initiallyStopped) await post("/api/stop");
      for (let n = 0; n < 2; n++) {
        const response = await post("/api/config", {
          ...store.publicConfig(),
          provider: {
            ...store.publicConfig().provider,
            model: "saved-model-" + n,
          },
        });
        assert.equal(response.status, 200);
        for (
          let i = 0;
          i < 400 && (await status()).lifecycle?.phase !== "complete";
          i++
        )
          await sleep(10);
        if (initiallyStopped)
          assert.equal(
            (await post("/api/run")).status,
            200,
            "stopped isolated history does not strand saved settings",
          );
        else {
          assert.equal(
            (await status()).lifecycle.resumed,
            true,
            "save automatically resumes running intent",
          );
          assert.notEqual(workers.at(-1), workers[0]);
          assert.equal(
            (await status()).lifecycle.restartPending ?? false,
            false,
          );
        }
        assert.equal(workers.at(-1)!.incidents.length, 1);
        assert.equal((await status()).isolatedTaskRecovery.count, 1);
      }
      assert.equal(
        f.calls.filter((c) => c.name === "coach_complete_task").length,
        1,
      );
      assert.equal(
        f.calls.filter((c) => c.name === "coach_fail_task").length,
        0,
      );
      assert.equal(
        (workers.at(-1) as any).options.personaRevision,
        String(store.publicConfig().revision),
      );
      await app.close();
      app = await admin(store, 0);
      assert.equal((await status()).isolatedTaskRecovery.count, 1);
      assert.equal((await post("/api/run")).status, 200);
      assert.equal(workers.at(-1)!.incidents.length, 1);
    } finally {
      Worker.prototype.start = originalStart;
      await app.close();
      await f.close();
      await rm(home, { recursive: true, force: true });
    }
  });
