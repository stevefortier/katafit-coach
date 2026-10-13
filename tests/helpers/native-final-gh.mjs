// Executable-only gh substitute. Actual manifest/provision verifier is untouched.
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync, watch, existsSync } from "node:fs";
import { join, basename } from "node:path";
const [state, target, ...args] = process.argv.slice(2);
appendFileSync(
  join(state, "attestations.jsonl"),
  JSON.stringify({ args, pid: process.pid }) + "\n",
);
if (basename(args[2]) === target) {
  process.on("SIGTERM", () => {});
  const child = spawn(
    process.execPath,
    [
      new URL("./native-descendant-cli.mjs", import.meta.url).pathname,
      state,
      "descendant",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  process.once("exit", () =>
    writeFileSync(join(state, "verifier-exited"), "exit"),
  );
  const watcher = watch(state, (_kind, name) => {
    if (name === "release-verifier") watcher.close();
  });
  writeFileSync(join(state, "verifier-held"), "held");
  if (existsSync(join(state, "release-verifier"))) watcher.close();
}
