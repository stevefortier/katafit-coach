import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { command } from "../src/update/managed.js";

async function eventually(check: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("owned process-tree condition exceeded its deadline");
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

for (const reason of ["abort", "timeout"] as const) {
  test(
    `native Windows build ${reason} terminates its real child and grandchild`,
    {
      skip:
        process.platform !== "win32"
          ? "requires native Windows taskkill, not a Linux adapter"
          : false,
      timeout: 15000,
    },
    async (t) => {
      const home = await fs.mkdtemp(join(tmpdir(), "coach-command-tree-"));
      await fs.chmod(home, 0o700);
      const controller = new AbortController();
      const pids: number[] = [];
      let result: Promise<unknown> | undefined;
      let timeout: (() => void) | undefined;
      const originalTimeout = globalThis.setTimeout;
      // Capture only command's existing 180s deadline; invoke after both real
      // processes are ready. All fixture/cleanup deadlines use real clocks.
      t.mock.method(
        globalThis,
        "setTimeout",
        (callback: any, ms?: number, ...args: any[]) => {
          if (ms === 180000) timeout = callback;
          return originalTimeout(callback, ms, ...args);
        },
      );
      try {
        const leaf = join(home, "leaf.cjs"),
          root = join(home, "root.cjs");
        await fs.writeFile(
          leaf,
          `const fs=require('node:fs'); fs.writeFileSync('leaf.pid',String(process.pid)); setInterval(()=>{try{fs.appendFileSync('heartbeat','x')}catch{process.exit(0)}},30); setTimeout(()=>process.exit(0),12000);`,
        );
        await fs.writeFile(
          root,
          `const fs=require('node:fs'); fs.writeFileSync('root.pid',String(process.pid)); require('node:child_process').spawn(process.execPath,[${JSON.stringify(leaf)}],{stdio:'ignore'}); setInterval(()=>{},1000); setTimeout(()=>process.exit(0),12000);`,
        );
        result = command(
          process.execPath,
          [root],
          home,
          home,
          controller.signal,
        ).then(
          () => undefined,
          (error) => error,
        );
        await eventually(async () => {
          try {
            const rootPid = Number(
              await fs.readFile(join(home, "root.pid"), "utf8"),
            );
            const leafPid = Number(
              await fs.readFile(join(home, "leaf.pid"), "utf8"),
            );
            assert.ok(Number.isSafeInteger(rootPid) && rootPid > 0);
            assert.ok(Number.isSafeInteger(leafPid) && leafPid > 0);
            pids.splice(0, pids.length, rootPid, leafPid);
            return (await fs.stat(join(home, "heartbeat"))).size > 0;
          } catch (error: any) {
            if (error.code === "ENOENT") return false;
            throw error;
          }
        });
        assert.ok(pids.every(alive), "both owned processes are initially live");
        if (reason === "abort") controller.abort();
        else {
          assert.ok(timeout);
          timeout();
        }
        const error = (await result) as Error;
        assert.equal(
          error?.message,
          reason === "abort" ? "BUILD_CANCELLED" : "BUILD_FAILED",
        );
        assert.equal(
          error.cause,
          undefined,
          "tree cleanup must be confirmed, not uncertain",
        );
        await eventually(async () => pids.every((pid) => !alive(pid)), 2000);
        const heartbeat = await fs.readFile(join(home, "heartbeat"));
        await new Promise((resolve) => setTimeout(resolve, 120));
        assert.ok(
          heartbeat.equals(await fs.readFile(join(home, "heartbeat"))),
          "grandchild must stop writing",
        );
      } finally {
        controller.abort();
        // Exact test-owned identities only, never taskkill by image or a host scan.
        for (const pid of pids.reverse())
          if (alive(pid)) process.kill(pid, "SIGKILL");
        await result;
        t.mock.restoreAll();
        await fs.rm(home, { recursive: true, force: true });
      }
    },
  );
}

test("build command retains success, nonzero, pre-abort and pidless spawn-error receipts", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "coach-command-receipts-"));
  try {
    await command(process.execPath, ["-e", "process.exit(0)"], home, home);
    await assert.rejects(
      command(process.execPath, ["-e", "process.exit(2)"], home, home),
      /^Error: BUILD_FAILED$/,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      command(process.execPath, [], home, home, controller.signal),
      /^Error: BUILD_CANCELLED$/,
    );
    await assert.rejects(
      command(join(home, "missing-executable"), [], home, home),
      /^Error: BUILD_TOOL_UNAVAILABLE$/,
    );
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
