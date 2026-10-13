// Only executable mapping is replaced; imports the actual default worker entry,
// default validateReleaseFiles and actual verifyProvenance/File implementations.
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
const state = process.env.FINAL_CLOSURE_STATE!,
  target = process.env.FINAL_CLOSURE_TARGET!;
const gh = fileURLToPath(new URL("./native-final-gh.mjs", import.meta.url));
const mapped = (args: string[]) => [gh, state, target, ...args];
const exec = cp.execFile;
cp.execFile = ((file: any, args: any, ...rest: any[]) => {
  if (file !== "gh") throw Error("UNEXPECTED_ORDINARY_EXECUTABLE");
  return (exec as any)(process.execPath, mapped(args), ...rest);
}) as any;
const fork = cp.fork;
cp.fork = ((entry: any, args: any, options: any) => {
  const child = fork(entry, args, options),
    send = child.send.bind(child);
  child.send = ((request: any, ...rest: any[]) => {
    if (request.file === "gh")
      request = {
        ...request,
        file: process.execPath,
        args: mapped(request.args),
      };
    else if (request.file !== "/usr/bin/true")
      throw Error("UNEXPECTED_OWNED_EXECUTABLE");
    return (send as any)(request, ...rest);
  }) as any;
  return child;
}) as any;
syncBuiltinESMExports();
await import("../../src/release/native-worker.js");
