import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "../src/worker/runner.js";
import { taskFixture } from "./task-fixtures.js";

for (const mode of ["update", "stats"] as const) {
  test(`${mode} reservation during listing prevents new idle recovery`, async () => {
    const listed = Promise.withResolvers<void>();
    const releaseList = Promise.withResolvers<void>();
    let recoveries = 0;
    const f = await taskFixture({
      memoryRecovery: async () => {
        recoveries++;
      },
      onListRequests: async () => {
        listed.resolve();
        await releaseList.promise;
      },
    });
    const worker = new Worker({
      origin: f.origin,
      token: "synthetic-worker-credential",
      system: "Coach",
      complete: async () => {
        throw new Error("no provider work admitted");
      },
    });
    const poll = worker.pollOnce();
    let pause: Promise<unknown> | undefined;
    try {
      await listed.promise;
      if (mode === "update") {
        assert.equal(worker.reserveForManualUpdate(), true);
        pause = worker.drainForUpdate();
      } else {
        pause = worker.withIdlePollingPaused(
          new AbortController().signal,
          async () => "read",
        );
      }
      releaseList.resolve();
      await poll;
      await pause;
      assert.equal(
        recoveries,
        0,
        "drain must not admit a new memory extraction",
      );
    } finally {
      releaseList.resolve();
      await poll.catch(() => {});
      await pause?.catch(() => {});
      worker.releaseUpdateQuiesce();
      await worker.stop();
      await f.close();
    }
  });
}
