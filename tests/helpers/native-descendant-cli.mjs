// Real local process topology; Docker responses are never used here.
import { spawn } from "node:child_process";
import { watch, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const [state, mode] = process.argv.slice(2);
if (mode === "descendant") {
  process.on("SIGTERM", () => {});
  const watcher = watch(state, (_event, name) => {
    if (name === "release-descendant") {
      watcher.close();
      process.exit(0);
    }
  });
  process.once("exit", () =>
    writeFileSync(join(state, "descendant-exited"), "exit"),
  );
  writeFileSync(
    join(state, "descendant-ready"),
    JSON.stringify({ pid: process.pid, ppid: process.ppid }),
  );
  if (existsSync(join(state, "release-descendant"))) {
    watcher.close();
    process.exit(0);
  }
} else {
  const child = spawn(
    process.execPath,
    [new URL(import.meta.url).pathname, state, "descendant"],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  process.once("exit", () =>
    writeFileSync(join(state, "direct-exited"), "exit"),
  );
}
