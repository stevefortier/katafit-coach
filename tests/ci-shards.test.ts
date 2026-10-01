import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { planShards, validateInventory } from "../scripts/test-shards.js";

const planner = new URL("../scripts/test-shards.ts", import.meta.url);

test("runner selects one serial shard and propagates a real test failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "coach-shard-run-"));
  try {
    await mkdir(join(root, "tests"));
    // Direct link to this retained dependency tree; never a sibling worktree.
    await symlink(
      new URL("../node_modules", import.meta.url).pathname,
      join(root, "node_modules"),
    );
    for (const name of ["a", "b", "c", "d", "e"])
      await writeFile(
        join(root, `tests/${name}.test.ts`),
        String.raw`import { test } from "node:test"; import { appendFileSync } from "node:fs"; test("${name}", async () => { appendFileSync("receipt", "${name} start\n"); await new Promise(r => setTimeout(r, 20)); appendFileSync("receipt", "${name} end\n"); ${name === "e" ? 'throw new Error("deliberate failure");' : ""} });`,
      );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; // This fixture starts an independent test runner.
    const run = (shard: string) =>
      spawnSync(
        process.execPath,
        ["--import", "tsx", planner.pathname, "run", shard],
        { cwd: root, encoding: "utf8", timeout: 10000, env },
      );
    assert.equal(run("0").status, 1);
    assert.equal(run("5").status, 1);
    assert.equal(run("1.5").status, 1);
    const result = run("1");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /deliberate failure/);
    assert.equal(
      await readFile(join(root, "receipt"), "utf8"),
      "a start\na end\ne start\ne end\n",
    );
    assert.equal(run("2").status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inventory fails closed on empty, duplicate, missing or extra tests", () => {
  assert.throws(() => planShards([]), /EMPTY/);
  assert.throws(() => planShards(["a", "a"]), /DUPLICATE/);
  const files = ["a", "b", "c", "d"];
  assert.throws(
    () => validateInventory(files, [["a"], ["b"], ["c"], []]),
    /MISSING/,
  );
  assert.throws(
    () => validateInventory(files, [["a"], ["b"], ["c"], ["d", "e"]]),
    /EXTRA/,
  );
  assert.throws(
    () => validateInventory(files, [["a"], ["b"], ["c"], ["d", "a"]]),
    /DUPLICATE/,
  );
  assert.throws(() => planShards(["a", "b", "c"]), /EMPTY_SHARD/);
});

test("shard inventory discovers every nested test once and keeps files serial", async () => {
  const root = await mkdtemp(join(tmpdir(), "coach-shards-"));
  try {
    await mkdir(join(root, "tests/nested"), { recursive: true });
    for (const name of ["a", "b", "c", "d", "e"])
      await writeFile(join(root, `tests/${name}.test.ts`), "");
    await writeFile(join(root, "tests/nested/f.test.ts"), "");
    await writeFile(join(root, "tests/ignored.ts"), "");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", planner.pathname, "inventory", root],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.total, 6);
    assert.equal(plan.shards.length, 4);
    assert.deepEqual(plan.shards.flat().sort(), [
      "tests/a.test.ts",
      "tests/b.test.ts",
      "tests/c.test.ts",
      "tests/d.test.ts",
      "tests/e.test.ts",
      "tests/nested/f.test.ts",
    ]);
    assert.equal(new Set(plan.shards.flat()).size, plan.total);
    assert.deepEqual(
      JSON.parse(
        spawnSync(
          process.execPath,
          ["--import", "tsx", planner.pathname, "inventory", root],
          { encoding: "utf8" },
        ).stdout,
      ),
      plan,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
