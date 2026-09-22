import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { command } from "../src/update/managed.js";

for (const kind of ["file", "directory"] as const) {
  test(`build disk scan tolerates a ${kind} disappearing after enumeration`, async () => {
    const home = await fs.mkdtemp(join(tmpdir(), "coach-disk-race-"));
    const target = join(home, "transient");
    if (kind === "file") await fs.writeFile(target, "temporary install data");
    else await fs.mkdir(target);
    const method = kind === "file" ? "lstat" : "readdir";
    const original = fs[method];
    let removed = false;
    const codes: string[] = [];
    (fs as any)[method] = async (...args: any[]) => {
      if (args[0] === target && !removed) {
        removed = true;
        await fs.rm(target, { recursive: true, force: true });
      }
      try {
        return await (original as any)(...args);
      } catch (error: any) {
        if (args[0] === target) codes.push(error.code);
        throw error;
      }
    };
    syncBuiltinESMExports();
    let failure: unknown;
    try {
      await command(
        process.execPath,
        ["-e", "setTimeout(()=>{},2500)"],
        home,
        home,
      ).catch((error) => {
        failure = error;
      });
    } finally {
      (fs as any)[method] = original;
      syncBuiltinESMExports();
      await fs.rm(home, { recursive: true, force: true });
    }
    assert.equal(removed, true, "the live size monitor must exercise the race");
    assert.deepEqual(codes, ["ENOENT"]);
    assert.equal(
      failure,
      undefined,
      "normal installer churn must not kill a healthy build",
    );
  });
}

test("build disk scan still rejects permission errors", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "coach-disk-permission-"));
  const target = join(home, "unreadable");
  await fs.writeFile(target, "x");
  const original = fs.lstat;
  (fs as any).lstat = async (...args: any[]) => {
    if (args[0] === target)
      throw Object.assign(new Error("fixture permission failure"), {
        code: "EACCES",
      });
    return (original as any)(...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      command(process.execPath, ["-e", "setTimeout(()=>{},2500)"], home, home),
      /BUILD_FAILED/,
    );
  } finally {
    fs.lstat = original;
    syncBuiltinESMExports();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("a late disk scan cannot kill a process after command completion", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "coach-disk-completed-"));
  const originalRead = fs.readdir;
  const originalKill = process.kill;
  const attempts: number[] = [];
  let rejectScan: ((error: Error) => void) | undefined;
  (fs as any).readdir = (...args: any[]) =>
    args[0] === home
      ? new Promise((_resolve, reject) => {
          rejectScan = reject;
        })
      : (originalRead as any)(...args);
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid < 0) {
      attempts.push(pid);
      return true;
    }
    return originalKill(pid, signal);
  }) as typeof process.kill;
  syncBuiltinESMExports();
  try {
    await command(
      process.execPath,
      ["-e", "setTimeout(()=>{},1800)"],
      home,
      home,
    );
    assert.ok(rejectScan, "a disk scan must be pending when the command exits");
    rejectScan(
      Object.assign(new Error("late scan failure"), { code: "EACCES" }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      attempts,
      [],
      "completed command process groups must never be signalled",
    );
  } finally {
    fs.readdir = originalRead;
    process.kill = originalKill;
    syncBuiltinESMExports();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("build disk scan still rejects the real logical size limit", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "coach-disk-limit-"));
  try {
    const path = join(home, "oversized");
    await fs.writeFile(path, "");
    // Sparse: exercises actual stat accounting without allocating a GiB of disk.
    await fs.truncate(path, 1024 * 1024 * 1024 + 1);
    await assert.rejects(
      command(process.execPath, ["-e", "setTimeout(()=>{},2500)"], home, home),
      /BUILD_FAILED/,
    );
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
