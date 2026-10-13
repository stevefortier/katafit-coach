// Observes real helper settlement; optional corrupt receipt is an explicit unit
// transport fault. Never fabricates a successful receipt or close event.
import cp from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
const state = process.env.FINAL_CLOSURE_STATE!,
  original = cp.spawn;
cp.spawn = ((...args: any[]) => {
  const child = (original as any)(...args);
  child.once("close", (code: any, signal: any) =>
    writeFileSync(
      join(state, "helper-exited"),
      JSON.stringify({ code, signal }),
    ),
  );
  if (process.env.FINAL_CLOSURE_INVALID === "1") {
    const receipts = child.stdio[5],
      on = receipts.on.bind(receipts);
    receipts.on = (event: string, callback: any) =>
      on(
        event,
        event === "data"
          ? (chunk: Buffer) =>
              callback(
                Buffer.from(
                  chunk.toString().replace('"settled":true', '"settled":false'),
                ),
              )
          : callback,
      );
  }
  return child;
}) as any;
syncBuiltinESMExports();
await import("../../src/release/native-command.js");
