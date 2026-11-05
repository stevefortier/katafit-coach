import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { watch } from "node:fs";
import { join, dirname } from "node:path";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { superviseNativeWorker } from "../src/release/native-supervisor.js";
import { withReleaseOperatorLock } from "../src/release/provision.js";
import {
  syntheticArchive,
  sha256,
  tar,
} from "./helpers/native-import-archive.js";
import { gzipSync } from "node:zlib";
async function event(state: string, name: string) {
  const watcher = watch(state);
  let timer: ReturnType<typeof setTimeout>;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(Error("missing event " + name)), 5000);
      watcher.on("change", (_kind, file) => {
        if (file === name) resolve();
      });
      void readFile(join(state, name)).then(
        () => resolve(),
        () => {},
      );
    });
  } finally {
    clearTimeout(timer!);
    watcher.close();
  }
}
async function free(state: string) {
  const c = spawn("/usr/bin/flock", [
    "--exclusive",
    "--timeout",
    "5",
    join(state, "operator.lock"),
    "/usr/bin/true",
  ]);
  assert.equal((await once(c, "close"))[0], 0);
}
async function contender(state: string) {
  return withReleaseOperatorLock(state, async () => "entered").catch(
    (e) => e.message,
  );
}
for (const mode of ["direct", "descendant"])
  test(
    `real ${mode} output overflow is settled failure, with bounded capture and released flock`,
    { timeout: 15000 },
    async (t) => {
      const state = await mkdtemp("/dev/shm/native-final-");
      let worker!: ChildProcess, exited!: Promise<unknown>;
      const operation = superviseNativeWorker(
        { state, mode },
        { workMs: 1800, drainMs: 100 },
        {
          entry: new URL(
            "./helpers/native-final-output-worker.ts",
            import.meta.url,
          ),
          onSpawn(c) {
            worker = c;
            exited = once(c, "exit");
          },
        },
      ).catch((e) => ({ error: e.message }));
      try {
        await event(state, "overflow-produced");
        await event(state, "descendant-ready");
        await event(state, "direct-exited");
        assert.equal(await contender(state), "RELEASE_BUSY");
        await writeFile(join(state, "release-descendant"), "settle");
        await event(state, "descendant-exited");
        await event(state, "helper-exited");
        const result: any = await operation;
        assert.equal(result.error, "RELEASE_CHILD_OUTPUT_LIMIT");
        assert.equal(result.code, "RELEASE_CHILD_OUTPUT_LIMIT");
        const receipt = JSON.parse(
          await readFile(join(state, "wrapper-receipt.json"), "utf8"),
        );
        assert.equal(receipt.outputLimit, true);
        assert.ok(receipt.capture.retainedBytes <= 65536);
        assert.equal(receipt.capture.allocatedBytes, 131072);
        assert.equal(
          JSON.parse(await readFile(join(state, "overflow-produced"), "utf8"))
            .bytes,
          16777216,
        );
        assert.deepEqual(
          JSON.parse(await readFile(join(state, "helper-exited"), "utf8")),
          { code: 0, signal: null },
        );
        await exited;
        await free(state);
        assert.equal(await contender(state), "entered");
        t.diagnostic(
          JSON.stringify({
            mode,
            result,
            emittedBytes: 16777216,
            capture: receipt.capture,
            reaped: true,
            workerExited: true,
            contender: "entered",
          }),
        );
      } finally {
        await writeFile(join(state, "release-descendant"), "cleanup");
        await event(state, "descendant-exited");
        await event(state, "helper-exited");
        await writeFile(
          join(state, "cleanup-wrapper"),
          "exact wrapper cleanup if RED retained",
        );
        await event(state, "wrapper-exited");
        if (worker.exitCode === null && worker.signalCode === null)
          worker.kill("SIGKILL");
        await exited;
        await operation;
        await free(state);
        await rm(state, { recursive: true, force: true });
      }
    },
  );

test(
  "overflow plus invalid private receipt retains uncertainty despite clean helper exit",
  { timeout: 10000 },
  async (t) => {
    const state = await mkdtemp("/dev/shm/native-final-");
    let worker!: ChildProcess, exited!: Promise<unknown>;
    const operation = superviseNativeWorker(
      { state, mode: "descendant", invalid: true },
      { workMs: 1500, drainMs: 100 },
      {
        entry: new URL(
          "./helpers/native-final-output-worker.ts",
          import.meta.url,
        ),
        onSpawn(c) {
          worker = c;
          exited = once(c, "exit");
        },
      },
    ).catch((e) => ({ error: e.message }));
    try {
      await event(state, "overflow-produced");
      await event(state, "descendant-ready");
      await event(state, "direct-exited");
      await writeFile(join(state, "release-descendant"), "settle");
      await event(state, "descendant-exited");
      await event(state, "helper-exited");
      const result: any = await operation;
      assert.equal(result.error, "RELEASE_NATIVE_OWNERSHIP_RETAINED");
      assert.equal(await contender(state), "RELEASE_BUSY");
      assert.deepEqual(
        JSON.parse(await readFile(join(state, "helper-exited"), "utf8")),
        { code: 0, signal: null },
      );
      await assert.rejects(readFile(join(state, "wrapper-receipt.json")), {
        code: "ENOENT",
      });
      t.diagnostic(
        "real output overflow + deliberately invalid settlement receipt: no success receipt, clean helper exit alone does not release lock",
      );
    } finally {
      await writeFile(join(state, "release-descendant"), "cleanup");
      await event(state, "descendant-exited");
      await event(state, "helper-exited");
      await writeFile(join(state, "cleanup-wrapper"), "exact wrapper cleanup");
      await event(state, "wrapper-exited");
      if (worker.exitCode === null && worker.signalCode === null)
        worker.kill("SIGKILL");
      await exited;
      await operation;
      await free(state);
      await rm(state, { recursive: true, force: true });
    }
  },
);
