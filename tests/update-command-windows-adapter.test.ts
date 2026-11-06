import { test, type TestContext } from "node:test";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";

// A portable Windows-branch adapter, NOT native Windows process-tree proof.
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
Object.defineProperty(process, "platform", { value: "win32" });
const { command } = await import("../src/update/managed.js");
Object.defineProperty(process, "platform", platform);

function child(pid: number | undefined) {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kills: [] as string[],
    kill(signal: string) {
      this.kills.push(signal);
      return true;
    },
    exit(code: number) {
      this.exitCode = code;
      this.emit("exit", code, null);
    },
  });
}

test("Windows adapter: cancellation kills the exact tree and joins taskkill", async () => {
  const root = child(12345),
    killer = child(12346);
  const calls: { file: string; args: string[]; options: any }[] = [];
  const original = cp.spawn;
  cp.spawn = ((file: string, args: string[], options: any) => {
    calls.push({ file, args, options });
    return calls.length === 1 ? root : killer;
  }) as any;
  syncBuiltinESMExports();
  const controller = new AbortController();
  try {
    let settled = false;
    const result = command("build", [], ".", ".", controller.signal).catch(
      (error) => {
        settled = true;
        return error;
      },
    );
    controller.abort();
    assert.equal(
      calls.length,
      2,
      "must launch taskkill rather than kill only root",
    );
    assert.match(calls[1].file, /taskkill(?:\.exe)?$/i);
    assert.deepEqual(calls[1].args, ["/T", "/F", "/PID", "12345"]);
    assert.equal(calls[1].options.shell, false);
    root.exit(1);
    await Promise.resolve();
    assert.equal(settled, false, "root exit is not tree cleanup confirmation");
    killer.exit(0);
    assert.match((await result).message, /^BUILD_CANCELLED$/);
    assert.deepEqual(root.kills, []);
  } finally {
    cp.spawn = original;
    syncBuiltinESMExports();
    root.exit(1);
    killer.exit(0);
  }
});

async function adapter(
  t: TestContext,
  run: (f: ReturnType<typeof fixture>) => Promise<void>,
) {
  const f = fixture();
  const originalSpawn = cp.spawn,
    originalRead = fs.readdir;
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  cp.spawn = ((file: string, args: string[], options: any) => {
    f.calls.push({ file, args, options });
    if (f.calls.length === 1) return f.root;
    if (f.throwSpawn) throw new Error("taskkill unavailable");
    return f.killer;
  }) as any;
  fs.readdir = (async () => []) as any;
  syncBuiltinESMExports();
  try {
    await run(f);
  } finally {
    f.root.exit(1);
    f.killer.exit(0);
    t.mock.restoreAll();
    cp.spawn = originalSpawn;
    fs.readdir = originalRead;
    syncBuiltinESMExports();
    t.mock.timers.reset();
  }
}
function fixture() {
  return {
    root: child(12345),
    killer: child(12346),
    throwSpawn: false,
    calls: [] as { file: string; args: string[]; options: any }[],
    controller: new AbortController(),
  };
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

for (const reason of ["timeout", "disk limit", "disk error"] as const) {
  test(`Windows adapter: ${reason} retains BUILD_FAILED and cleans the tree`, async (t) =>
    adapter(t, async (f) => {
      if (reason !== "timeout") {
        fs.readdir = (
          reason === "disk error"
            ? async () => {
                throw new Error("disk unavailable");
              }
            : async () => [{ name: "large", isDirectory: () => false }]
        ) as any;
        t.mock.method(fs, "lstat", async () => ({
          size: 1024 * 1024 * 1024 + 1,
        }));
        syncBuiltinESMExports();
      }
      const result = command("build", [], ".", ".").catch((e) => e);
      t.mock.timers.tick(reason === "timeout" ? 180000 : 1000);
      await flush();
      assert.equal(f.calls.length, 2);
      f.killer.exit(0);
      f.root.exit(1);
      const error = await result;
      assert.equal(error.message, "BUILD_FAILED");
      assert.equal(error.cause, undefined);
    }));
}
for (const fault of [
  "nonzero",
  "spawn error",
  "throw",
  "hung helper",
  "missing root exit",
] as const) {
  test(`Windows adapter: ${fault} cannot masquerade as confirmed cleanup`, async (t) =>
    adapter(t, async (f) => {
      f.throwSpawn = fault === "throw";
      const result = command("build", [], ".", ".", f.controller.signal).catch(
        (e) => e,
      );
      f.controller.abort();
      if (fault === "nonzero") f.killer.exit(128);
      if (fault === "spawn error") f.killer.emit("error", new Error("ENOENT"));
      if (fault === "missing root exit") f.killer.exit(0);
      if (fault === "hung helper" || fault === "missing root exit")
        t.mock.timers.tick(5000);
      const error = await result;
      assert.equal(error.message, "BUILD_CANCELLED");
      assert.equal(error.cause?.message, "BUILD_TREE_CLEANUP_FAILED");
      assert.deepEqual(
        f.root.kills,
        ["SIGKILL"],
        "fallback is exact handle, not proof of cleanup",
      );
      if (fault === "hung helper")
        assert.deepEqual(f.killer.kills, ["SIGKILL"]);
      // Late events / deadlines must never dispatch a second PID-based kill.
      f.root.exit(0);
      f.killer.exit(0);
      t.mock.timers.tick(180000);
      assert.equal(f.calls.length, 2);
    }));
}

test("Windows adapter: completed exit before abort never invokes taskkill", async (t) =>
  adapter(t, async (f) => {
    const result = command("build", [], ".", ".", f.controller.signal);
    f.root.exit(0);
    await result;
    f.controller.abort();
    t.mock.timers.tick(180000);
    assert.equal(f.calls.length, 1);
  }));

test("Windows adapter: observed exitCode before exit event fences timeout and abort", async (t) =>
  adapter(t, async (f) => {
    const result = command("build", [], ".", ".", f.controller.signal);
    f.root.exitCode = 0;
    f.controller.abort();
    t.mock.timers.tick(180000);
    f.root.emit("exit", 0, null);
    await result;
    assert.equal(f.calls.length, 1);
  }));

test("Windows adapter: late rejected disk scan after success cannot signal a stale PID", async (t) =>
  adapter(t, async (f) => {
    let rejectScan!: (error: Error) => void;
    fs.readdir = (() =>
      new Promise((_resolve, reject) => {
        rejectScan = reject;
      })) as any;
    syncBuiltinESMExports();
    const result = command("build", [], ".", ".");
    t.mock.timers.tick(1000);
    assert.ok(rejectScan);
    f.root.exit(0);
    await result;
    rejectScan(new Error("late scan"));
    await flush();
    assert.equal(f.calls.length, 1);
  }));

test("Windows adapter: pidless spawn error never dispatches taskkill", async (t) =>
  adapter(t, async (f) => {
    f.root.pid = undefined;
    const result = command("missing", [], ".", ".").catch((e) => e);
    f.root.emit("error", new Error("ENOENT"));
    assert.equal((await result).message, "BUILD_TOOL_UNAVAILABLE");
    t.mock.timers.tick(180000);
    assert.equal(f.calls.length, 1);
  }));

test("Windows adapter: pre-aborted command never spawns", async (t) =>
  adapter(t, async (f) => {
    f.controller.abort();
    await assert.rejects(
      command("build", [], ".", ".", f.controller.signal),
      /BUILD_CANCELLED/,
    );
    assert.equal(f.calls.length, 0);
  }));

for (const pid of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`Windows adapter: invalid PID ${pid} never enters taskkill arguments`, async (t) =>
    adapter(t, async (f) => {
      f.root.pid = pid;
      const result = command("build", [], ".", ".", f.controller.signal).catch(
        (e) => e,
      );
      f.controller.abort();
      const error = await result;
      assert.equal(error.message, "BUILD_CANCELLED");
      assert.equal(error.cause?.message, "BUILD_TREE_CLEANUP_FAILED");
      assert.equal(f.calls.length, 1);
    }));
}

test("Windows adapter: timeout owns failure if abort races cleanup", async (t) =>
  adapter(t, async (f) => {
    const result = command("build", [], ".", ".", f.controller.signal).catch(
      (e) => e,
    );
    t.mock.timers.tick(180000);
    f.controller.abort();
    f.root.exit(0);
    f.killer.exit(0);
    assert.equal((await result).message, "BUILD_FAILED");
    assert.equal(f.calls.length, 2);
  }));

test("Windows adapter: late taskkill failure retains uncertainty without signaling exited root", async (t) =>
  adapter(t, async (f) => {
    const result = command("build", [], ".", ".", f.controller.signal).catch(
      (e) => e,
    );
    f.controller.abort();
    f.root.exit(0);
    f.killer.exit(128);
    const error = await result;
    assert.equal(error.message, "BUILD_CANCELLED");
    assert.equal(error.cause?.message, "BUILD_TREE_CLEANUP_FAILED");
    assert.deepEqual(f.root.kills, []);
  }));

test("Windows adapter: a started-child error retains tool-unavailable after tree cleanup", async (t) =>
  adapter(t, async (f) => {
    const result = command("build", [], ".", ".").catch((e) => e);
    f.root.emit("error", new Error("fixture failure"));
    assert.equal(f.calls.length, 2);
    f.root.exit(1);
    f.killer.exit(0);
    assert.equal((await result).message, "BUILD_TOOL_UNAVAILABLE");
  }));
