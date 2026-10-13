import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { superviseNativeWorker } from "../src/release/native-supervisor.js";
import { withReleaseOperatorLock } from "../src/release/provision.js";
async function event(state: string, name: string) {
  const watcher = watch(state);
  const wait = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("event timeout " + name)),
      5000,
    );
    watcher.on("change", (_type, file) => {
      if (file === name) {
        clearTimeout(timer);
        resolve();
      }
    });
    void readFile(join(state, name)).then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {},
    );
  });
  try {
    await wait;
  } finally {
    watcher.close();
  }
}
async function free(state: string) {
  const child = spawn("/usr/bin/flock", [
    "--exclusive",
    "--timeout",
    "5",
    join(state, "operator.lock"),
    "/usr/bin/true",
  ]);
  assert.equal((await once(child, "close"))[0], 0);
}
for (const crash of [false, true])
  test(
    `detached closed-pipe descendant retains actual operator flock${crash ? " after worker crash" : ""}`,
    { timeout: 15000 },
    async (t) => {
      const state = await mkdtemp("/dev/shm/native-descendant-");
      let child!: ChildProcess, exited!: Promise<unknown>;
      const operation = superviseNativeWorker(
        { state },
        { workMs: 6000, drainMs: 100 },
        {
          entry: new URL(
            "./helpers/native-descendant-worker.ts",
            import.meta.url,
          ),
          onSpawn(c) {
            child = c;
            exited = once(c, "exit");
          },
        },
      ).then(
        (v) => ({ value: v }),
        (e) => ({ error: e.message }),
      );
      try {
        await event(state, "descendant-ready");
        await event(state, "direct-exited");
        if (crash) {
          child.kill("SIGKILL");
          await exited;
          await operation;
        }
        // Event barriers establish the direct CLI exited and a detached child remains.
        assert.equal(
          await withReleaseOperatorLock(state, async () => "entered").catch(
            (e) => e.message,
          ),
          "RELEASE_BUSY",
        );
        await writeFile(join(state, "release-descendant"), "settle");
        await event(state, "descendant-exited");
        await operation;
        await free(state);
        t.diagnostic(
          JSON.stringify({
            directExited: true,
            detachedClosedPipes: true,
            workerCrash: crash,
            contender: "RELEASE_BUSY",
            releasedAfterReaping: true,
          }),
        );
      } finally {
        await writeFile(join(state, "release-descendant"), "cleanup");
        await event(state, "descendant-exited");
        await operation;
        await exited;
        await free(state);
        await rm(state, { recursive: true, force: true });
      }
    },
  );

for (const phase of ["version", "relay", "cleanup"])
  for (const crash of phase === "cleanup" ? [true] : [false, true])
    test(
      `actual preflight ${phase} command ownership${crash ? " survives worker crash" : ""}`,
      { timeout: 15000 },
      async (t) => {
        const state = await mkdtemp("/dev/shm/native-descendant-");
        let child!: ChildProcess, exited!: Promise<unknown>;
        const operation = superviseNativeWorker(
          { state, phase, crash },
          { workMs: 6000, drainMs: 100 },
          {
            entry: new URL(
              "./helpers/native-preflight-owned-worker.ts",
              import.meta.url,
            ),
            onSpawn(c) {
              child = c;
              exited = once(c, "exit");
            },
          },
        ).then(
          (v) => ({ value: v }),
          (e) => ({ error: e.message }),
        );
        let ready = false;
        try {
          await event(state, "descendant-ready");
          ready = true;
          await event(state, "direct-exited");
          if (crash) {
            child.kill("SIGKILL");
            await exited;
            await operation;
          }
          if (!crash && phase === "relay")
            await event(state, "preflight-returned");
          assert.equal(
            await withReleaseOperatorLock(state, async () => "entered").catch(
              (e) => e.message,
            ),
            "RELEASE_BUSY",
          );
          if (crash) {
            const receipt = JSON.parse(
              await readFile(join(state, "native-probe-cleanup.json"), "utf8"),
            );
            assert.equal(
              receipt.containerId,
              phase === "relay" ? "1".repeat(64) : null,
            );
          }
          await writeFile(join(state, "release-descendant"), "settle");
          await event(state, "descendant-exited");
          await operation;
          await free(state);
          t.diagnostic(
            JSON.stringify({
              actualNativeRuntime: true,
              phase,
              workerCrash: crash,
              contender: "RELEASE_BUSY",
              localClientsOnly: true,
            }),
          );
        } finally {
          await writeFile(join(state, "release-descendant"), "cleanup");
          if (ready) await event(state, "descendant-exited");
          await operation;
          await exited;
          await free(state);
          await rm(state, { recursive: true, force: true });
        }
      },
    );

for (const fault of [
  "launcher-crash",
  "wrapper-crash",
  "prctl-failure",
  "interpreter-missing",
  "helper-missing",
])
  test(
    `single fault ${fault} fails closed at actual owned launcher`,
    { timeout: 15000 },
    async (t) => {
      const state = await mkdtemp("/dev/shm/native-descendant-");
      let child!: ChildProcess, exited!: Promise<unknown>;
      const operation = superviseNativeWorker(
        { state, fault },
        { workMs: 900, drainMs: 100 },
        {
          entry: new URL(
            "./helpers/native-descendant-worker.ts",
            import.meta.url,
          ),
          onSpawn(c) {
            child = c;
            exited = once(c, "exit");
          },
        },
      ).then(
        (v) => ({ value: v }),
        (e) => ({ error: e.message }),
      );
      const hasClient = fault.endsWith("crash");
      try {
        if (hasClient) {
          await event(state, "descendant-ready");
          await event(state, "direct-exited");
          await writeFile(
            join(
              state,
              fault === "launcher-crash"
                ? "release-launcher"
                : "release-wrapper",
            ),
            "kill exact owned ChildProcess",
          );
          await event(
            state,
            fault === "launcher-crash" ? "launcher-exited" : "wrapper-exited",
          );
        }
        const result = await operation;
        assert.ok("error" in result);
        if (fault === "helper-missing") {
          await exited;
          await free(state);
        } else {
          assert.equal(result.error, "RELEASE_NATIVE_OWNERSHIP_RETAINED");
          assert.equal(
            await withReleaseOperatorLock(state, async () => "entered").catch(
              (e) => e.message,
            ),
            "RELEASE_BUSY",
          );
        }
        if (hasClient) {
          await writeFile(join(state, "release-descendant"), "settle");
          await event(state, "descendant-exited");
          assert.equal(
            await withReleaseOperatorLock(state, async () => "entered").catch(
              (e) => e.message,
            ),
            "RELEASE_BUSY",
          );
        } else
          await assert.rejects(readFile(join(state, "direct-exited")), {
            code: "ENOENT",
          });
        t.diagnostic(
          JSON.stringify({
            fault,
            result,
            clients: hasClient ? 1 : 0,
            retained: fault !== "helper-missing",
          }),
        );
      } finally {
        await writeFile(join(state, "release-descendant"), "cleanup");
        if (hasClient) await event(state, "descendant-exited");
        await writeFile(
          join(state, "release-wrapper"),
          "test cleanup exact wrapper",
        );
        await event(state, "wrapper-exited");
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        await exited;
        await free(state);
        await rm(state, { recursive: true, force: true });
      }
    },
  );

for (const unexpected of [false, true])
  test(
    `detached descendant survives supervisor ${unexpected ? "unexpected exit" : "bounded result and exit"} with lock held`,
    { timeout: 15000 },
    async (t) => {
      const state = await mkdtemp("/dev/shm/native-descendant-");
      const { fork } = await import("node:child_process");
      const parent = fork(
        new URL("./helpers/native-descendant-parent.ts", import.meta.url),
        [JSON.stringify({ state })],
        {
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      const exited = once(parent, "exit");
      try {
        await event(state, "descendant-ready");
        await event(state, "direct-exited");
        if (unexpected) parent.send("exit-now");
        await exited;
        if (!unexpected)
          assert.equal(
            JSON.parse(await readFile(join(state, "parent-result"), "utf8"))
              .error,
            "RELEASE_NATIVE_OWNERSHIP_RETAINED",
          );
        assert.equal(
          await withReleaseOperatorLock(state, async () => "entered").catch(
            (e) => e.message,
          ),
          "RELEASE_BUSY",
        );
        await writeFile(join(state, "release-descendant"), "settle");
        await event(state, "descendant-exited");
        await event(state, "worker-exited");
        await free(state);
        t.diagnostic(
          JSON.stringify({
            supervisorExited: true,
            unexpected,
            contender: "RELEASE_BUSY",
            adoptedDescendantReaped: true,
          }),
        );
      } finally {
        await writeFile(join(state, "release-descendant"), "cleanup");
        await event(state, "descendant-exited");
        await event(state, "worker-exited");
        await exited;
        await free(state);
        await rm(state, { recursive: true, force: true });
      }
    },
  );

test(
  "cancellation before launcher request dispatch has zero client starts and settles",
  { timeout: 10000 },
  async (t) => {
    const state = await mkdtemp("/dev/shm/native-descendant-");
    const controller = new AbortController();
    let child!: ChildProcess, exited!: Promise<unknown>;
    const operation = superviseNativeWorker(
      { state, fault: "startup-cancel" },
      { signal: controller.signal, workMs: 4000, drainMs: 100 },
      {
        entry: new URL(
          "./helpers/native-descendant-worker.ts",
          import.meta.url,
        ),
        onSpawn(c) {
          child = c;
          exited = once(c, "exit");
        },
      },
    ).catch((e) => e.message);
    try {
      await event(state, "launcher-started");
      controller.abort();
      await operation;
      await exited;
      await free(state);
      await assert.rejects(readFile(join(state, "direct-exited")), {
        code: "ENOENT",
      });
      t.diagnostic(
        "private startup pipe cancelled before dispatch; zero direct or descendant starts; actual lock released after settlement",
      );
    } finally {
      await operation;
      await exited;
      await free(state);
      await rm(state, { recursive: true, force: true });
    }
  },
);

test(
  "retired async lock context cannot launch against a reused unrelated file descriptor",
  { timeout: 10000 },
  async (t) => {
    const state = await mkdtemp("/dev/shm/native-descendant-");
    const { nativeOwnedExec, nativeLockContext } = await import(
      "../src/release/native-ownership.js"
    );
    const { open } = await import("node:fs/promises");
    let trigger!: () => void, run!: Promise<unknown>, oldFd!: number;
    const gate = new Promise<void>((resolve) => {
      trigger = resolve;
    });
    await withReleaseOperatorLock(state, async () => {
      oldFd = nativeLockContext.getStore()!.fd;
      run = gate.then(() =>
        nativeOwnedExec(
          process.execPath,
          [
            "-e",
            'require("node:fs").writeFileSync(process.argv[1],"unauthorized")',
            join(state, "late-client"),
          ],
          { timeout: 2000 },
        ),
      );
    });
    const unrelated = await open(join(state, "unrelated"), "wx+", 0o600);
    try {
      assert.equal(
        unrelated.fd,
        oldFd,
        "real released descriptor reused by unrelated regular file",
      );
      const result = run.then(
        () => "launched",
        (e: any) => e.message,
      );
      trigger();
      assert.equal(await result, "RELEASE_OPERATOR_SCOPE_CLOSED");
      await assert.rejects(readFile(join(state, "late-client")), {
        code: "ENOENT",
      });
      t.diagnostic(
        "retired async scope + real descriptor reuse: zero client launches",
      );
    } finally {
      await unrelated.close();
      await free(state);
      await rm(state, { recursive: true, force: true });
    }
  },
);

test(
  "lock scope drains a runtime exit callback that launches another owned command",
  { timeout: 10000 },
  async (t) => {
    const state = await mkdtemp("/dev/shm/native-descendant-");
    const { nativeOwnedSpawn } = await import(
      "../src/release/native-ownership.js"
    );
    const { fileURLToPath } = await import("node:url");
    let returned = false;
    const exits: Promise<unknown>[] = [];
    const scope = withReleaseOperatorLock(state, async () => {
      const first = nativeOwnedSpawn(process.execPath, [
        "-e",
        "process.exit(0)",
      ]);
      first.stdout.resume();
      first.stderr.resume();
      first.stdin.end();
      exits.push(once(first, "close"));
      first.once("exit", () => {
        const second = nativeOwnedSpawn(process.execPath, [
          fileURLToPath(
            new URL("./helpers/native-descendant-cli.mjs", import.meta.url),
          ),
          state,
          "direct",
        ]);
        second.stdout.resume();
        second.stderr.resume();
        second.stdin.end();
        exits.push(once(second, "close"));
      });
    }).then(() => {
      returned = true;
    });
    try {
      await event(state, "descendant-ready");
      await event(state, "direct-exited");
      assert.equal(
        returned,
        false,
        "scope must not report settlement while exit-triggered owned command remains",
      );
      assert.equal(
        await withReleaseOperatorLock(state, async () => "entered").catch(
          (e) => e.message,
        ),
        "RELEASE_BUSY",
      );
      await writeFile(join(state, "release-descendant"), "settle");
      await scope;
      await free(state);
      t.diagnostic(
        "actual child exit callback adds owned descendant lifetime; drain includes it before scope returns",
      );
    } finally {
      await writeFile(join(state, "release-descendant"), "cleanup");
      await event(state, "descendant-exited");
      await scope;
      await Promise.all(exits);
      await free(state);
      await rm(state, { recursive: true, force: true });
    }
  },
);
