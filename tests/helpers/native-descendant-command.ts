// Explicit local fault injection around exact production ChildProcess handles.
import cp from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
const state = process.env.OWNED_TEST_STATE!,
  fault = process.env.OWNED_TEST_FAULT!;
const original = cp.spawn;
if (fault === "helper-missing") {
  const lstat = fs.lstatSync;
  fs.lstatSync = ((path: any, ...args: any[]) => {
    if (String(path).endsWith("/native-subreaper.py"))
      throw Object.assign(Error("fixture missing packaged helper"), {
        code: "ENOENT",
      });
    return (lstat as any)(path, ...args);
  }) as any;
}
cp.spawn = ((file: any, args: any, options: any) => {
  if (file === "/usr/bin/python3" && fault === "prctl-failure") {
    const modified = fs
      .readFileSync(args[2], "utf8")
      .replace(
        "def capability():",
        'def capability():\n    raise OSError(1, "fixture prctl denied")',
      );
    const path = join(state, "denied-subreaper.py");
    fs.writeFileSync(path, modified, { mode: 0o600 });
    args = [...args];
    args[2] = path;
  }
  const child = original(
    fault === "interpreter-missing" ? "/nonexistent/trusted-python" : file,
    args,
    options,
  );
  if (fault === "startup-cancel") {
    (child.stdio as any)[5].pause();
    fs.writeFileSync(join(state, "launcher-started"), "spawned");
  }
  if (file === "/usr/bin/python3") {
    const watcher = fs.watch(state, (_event, name) => {
      if (name === "release-launcher") {
        child.kill("SIGKILL");
        watcher.close();
      }
    });
    child.once("close", (code, signal) => {
      watcher.close();
      fs.writeFileSync(
        join(state, "launcher-exited"),
        JSON.stringify({ code, signal }),
      );
    });
  }
  return child;
}) as any;
syncBuiltinESMExports();
await import("../../src/release/native-command.js");
