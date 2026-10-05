import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CleanupRegistry } from "../src/autonomy/cleanup.js";
import { HeadlessCycleRuntime } from "../src/autonomy/headless.js";
import {
  fakeEngine,
  IMAGE,
  obedient,
  stubGateway,
} from "./helpers/headless-engine.js";

for (const cause of [
  "setup consumes cycleMs",
  "absolute deadline already passed",
] as const) {
  test(`headless admission: ${cause} never launches a container`, async (t) => {
    const fake = await fakeEngine(obedient());
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), "deadline0210-headless-"));
      const cleanup = await CleanupRegistry.open(dir, "a".repeat(32));
      const origin = Date.now();
      t.mock.timers.enable({ apis: ["Date"], now: origin });
      const begin = cleanup.begin.bind(cleanup);
      t.mock.method(cleanup, "begin", async (record) => {
        const owned = await begin(record);
        if (cause === "setup consumes cycleMs")
          t.mock.timers.setTime(origin + 500);
        return owned;
      });
      const runtime = new HeadlessCycleRuntime({
        image: IMAGE,
        engine: fake.engine,
        cleanup,
      });
      const run = {
        profile: "planner" as const,
        gateway: stubGateway(),
        message: "never infer without time",
        cycleMs: cause === "setup consumes cycleMs" ? 100 : 5000,
        ...(cause === "absolute deadline already passed"
          ? { deadlineAt: origin - 1 }
          : {}),
      };
      let error: any;
      await runtime.run(run).catch((e) => {
        error = e;
      });
      t.diagnostic(
        JSON.stringify({
          cause,
          error: error?.code,
          creates: fake.creates().length,
          pending: cleanup.pending,
          active: runtime.active,
        }),
      );
      assert.equal(
        fake.creates().length,
        0,
        "setup time and expired absolute deadlines cannot admit unsafe inference",
      );
      assert.equal(error?.code, "HEADLESS_TIMEOUT");
      assert.equal(cleanup.pending, 0, "never-created ownership is removed");
      assert.equal(runtime.active, false);
      assert.equal(fake.daemon.containers.size, 0);
    } finally {
      t.mock.timers.reset();
      t.mock.restoreAll();
      await fake.close();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });
}
