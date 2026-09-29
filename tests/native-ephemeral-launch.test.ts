import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Pi always launches without saved session even if obsolete history config is present", async () => {
  const source = await readFile(
    new URL("../sandbox/launch.mjs", import.meta.url),
    "utf8",
  );
  let args: string[] = [];
  const run = new Function(
    "existsSync",
    "readFileSync",
    "spawn",
    "process",
    `return (async()=>{${source.replace(/^import .*;$/gm, "")} })()`,
  );
  await run(
    () => true,
    () =>
      JSON.stringify({
        model: "synthetic",
        prompt: "synthetic",
        history: true,
      }),
    (_name: string, selected: string[]) => {
      args = selected;
      return { on: () => {}, kill: () => {} };
    },
    {
      env: { NATIVE_GATEWAY: "1", TMPDIR: "/synthetic/tmp" },
      on: () => {},
      exit: () => {
        throw new Error("unexpected exit");
      },
    },
  );
  assert.ok(args.includes("--no-session"));
  assert.ok(!args.includes("--session"));
  assert.ok(args.includes("--offline"));
});
