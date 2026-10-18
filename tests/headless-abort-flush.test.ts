import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NativeRuntime } from "../src/sandbox/runtime.js";
import { HeadlessCycleRuntime } from "../src/autonomy/headless.js";
import { CleanupRegistry } from "../src/autonomy/cleanup.js";
import {
  fakeEngine,
  IMAGE,
  stubGateway,
  until,
} from "./helpers/headless-engine.js";

// Reviewer R1 transport repro, strengthened to use real NativeRuntime.rpc/stop
// and a unix-socket Docker stand-in. Only the abort write callback is withheld.
for (const removalFails of [false, true]) {
  test(`held abort flush reaches owned removal; removalFails=${removalFails}`, async () => {
    const home = await mkdtemp(tmpdir() + "/abort-flush-");
    const fake = await fakeEngine((command, pi) => {
      if (command.type === "prompt")
        pi.send({ type: "response", id: command.id, success: true });
      // No abort acknowledgement either: the one grace covers flush AND ack.
    });
    const cleanup = await CleanupRegistry.open(home, "b".repeat(32));
    const originalAttach = NativeRuntime.prototype.attach;
    let releaseFlush: (() => void) | undefined;
    NativeRuntime.prototype.attach = async function () {
      await originalAttach.call(this);
      const socket = (this as any).socket;
      const write = socket.write.bind(socket);
      socket.write = (line: string, callback: () => void) => {
        if (JSON.parse(line).type === "abort") {
          releaseFlush = callback;
          return write(line); // bytes sent; flush completion remains pending
        }
        return write(line, callback);
      };
    };
    const runtime = new HeadlessCycleRuntime({
      image: IMAGE,
      engine: fake.engine,
      cleanup,
    });
    const controller = new AbortController();
    const running = runtime.run({
      profile: "planner",
      gateway: stubGateway(),
      message: "synthetic",
      cycleMs: 10000,
      signal: controller.signal,
    });
    let outcome = "pending";
    void running.then(
      () => {
        outcome = "resolved";
      },
      (error) => {
        outcome = error.code;
      },
    );
    try {
      await until(() => fake.commands.some((c) => c.type === "prompt"));
      const owned = [...fake.daemon.containers.values()][0];
      assert.ok(owned);
      if (removalFails) fake.daemon.failRm = 100;
      controller.abort();
      await until(() => !!releaseFlush);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.ok(
        fake.removes().length > 0,
        "owned removal must start before held flush is released",
      );
      assert.equal(
        outcome,
        removalFails ? "HEADLESS_CLEANUP_PENDING" : "HEADLESS_ABORTED",
      );
      assert.equal(runtime.active, false);
      for (const args of fake.removes()) assert.equal(args.at(-1), owned.Id);
      assert.equal(cleanup.pending, removalFails ? 1 : 0);
      const reopened = await CleanupRegistry.open(home, cleanup.owner);
      assert.equal(
        reopened.pending,
        removalFails ? 1 : 0,
        "unconfirmed ownership survives restart",
      );
      assert.equal(fake.daemon.containers.size, removalFails ? 1 : 0);
    } finally {
      releaseFlush?.();
      await running.catch(() => {});
      NativeRuntime.prototype.attach = originalAttach;
      await fake.close();
      await rm(home, { recursive: true, force: true });
    }
  });
}
