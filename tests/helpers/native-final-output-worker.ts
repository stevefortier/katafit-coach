import cp from "node:child_process";
import { watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import { runNativeWorker } from "../../src/release/native-supervisor.js";
import { withReleaseOperatorLock } from "../../src/release/provision.js";
import { nativeOwnedExec } from "../../src/release/native-ownership.js";
runNativeWorker(async (r, signal) => {
  const original = cp.fork;
  cp.fork = ((entry: any, args: any, options: any) => {
    const child = original(
      new URL("./native-final-command.ts", import.meta.url),
      args,
      {
        ...options,
        env: {
          ...options.env,
          FINAL_CLOSURE_STATE: r.state,
          FINAL_CLOSURE_INVALID: r.invalid ? "1" : "0",
        },
      },
    );
    child.on("message", (message) =>
      writeFileSync(
        join(r.state, "wrapper-receipt.json"),
        JSON.stringify(message),
      ),
    );
    const watcher = watch(r.state, (_type, name) => {
      if (name === "cleanup-wrapper") {
        child.kill("SIGKILL");
        watcher.close();
      }
    });
    child.once("close", () => {
      watcher.close();
      writeFileSync(join(r.state, "wrapper-exited"), "exit");
    });
    return child;
  }) as any;
  syncBuiltinESMExports();
  return withReleaseOperatorLock(r.state, async () => {
    try {
      return await nativeOwnedExec(
        process.execPath,
        [
          fileURLToPath(new URL("./native-final-output.mjs", import.meta.url)),
          r.state,
          r.mode,
        ],
        { signal, timeout: 10000 },
      );
    } catch (e: any) {
      return {
        error: e.message,
        code: e.code,
        killed: e.killed,
        stdoutBytes: Buffer.byteLength(e.stdout ?? ""),
        stderrBytes: Buffer.byteLength(e.stderr ?? ""),
      };
    }
  });
});
