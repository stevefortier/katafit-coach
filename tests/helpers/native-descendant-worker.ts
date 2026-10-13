import cp from "node:child_process";
import { watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { runNativeWorker } from "../../src/release/native-supervisor.js";
import { withReleaseOperatorLock } from "../../src/release/provision.js";
import { nativeOwnedExec } from "../../src/release/native-ownership.js";
import { fileURLToPath } from "node:url";
runNativeWorker(async (r, signal) => {
  process.once("exit", () =>
    writeFileSync(join(r.state, "worker-exited"), "exit"),
  );
  if (r.fault) {
    const original = cp.fork;
    cp.fork = ((entry: any, args: any, options: any) => {
      const child = original(
        new URL("./native-descendant-command.ts", import.meta.url),
        args,
        {
          ...options,
          env: {
            ...options.env,
            OWNED_TEST_STATE: r.state,
            OWNED_TEST_FAULT: r.fault,
          },
        },
      );
      const watcher = watch(r.state, (_event, name) => {
        if (name === "release-wrapper") {
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
  }
  return withReleaseOperatorLock(r.state, async () => {
    return nativeOwnedExec(
      process.execPath,
      [
        fileURLToPath(new URL("./native-descendant-cli.mjs", import.meta.url)),
        r.state,
        "direct",
      ],
      { signal },
    );
  });
});
