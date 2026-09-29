import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { startRelay } from "./helpers/native-relay.js";

test("native launch explicitly disables Pi session persistence", async () => {
  const source = await readFile(
    new URL("../sandbox/launch.mjs", import.meta.url),
    "utf8",
  );
  const args: string[] = [];
  const run = new Function(
    "existsSync",
    "readFileSync",
    "spawn",
    "process",
    `return (async()=>{${source.replace(/^import .*;$/gm, "")} })()`,
  );
  await run(
    () => true,
    () => JSON.stringify({ model: "synthetic", prompt: "synthetic" }),
    (_name: string, a: string[]) => {
      args.push(...a);
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
  assert.ok(args.includes("--offline"));
  assert.ok(!args.includes("--session"));
});

test("relay config contains no saved transcript or native seed", async () => {
  let nonCatalog = 0;
  const relay = await startRelay({
    handle: async (request) => {
      if (request.kind !== "catalog") nonCatalog++;
      return {
        model: "synthetic",
        prompt: "Synthetic",
        skills: [],
        tools: [],
      };
    },
    close: async () => {},
  });
  try {
    const config = JSON.parse(
      await readFile(relay.root + "/tmp/native-config.json", "utf8"),
    );
    assert.deepEqual(Object.keys(config).sort(), [
      "model",
      "prompt",
      "skills",
      "tools",
    ]);
    assert.deepEqual(await readdir(relay.root + "/tmp"), [
      "native-config.json",
    ]);
    assert.equal(nonCatalog, 0);
  } finally {
    await relay.close();
  }
});
