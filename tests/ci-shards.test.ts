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

import {
  planShards,
  validateInventory,
  loadDurations,
} from "../scripts/test-shards.js";

const planner = new URL("../scripts/test-shards.ts", import.meta.url);

test("planner assigns the entire inventory exactly once to eight deterministic shards", () => {
  const files = Array.from({ length: 17 }, (_, i) => `tests/${i}.test.ts`);
  const plan = planShards(files);
  assert.equal(plan.shards.length, 8);
  assert.deepEqual(plan.shards.flat().sort(), files.sort());
  assert.deepEqual(planShards([...files].reverse()), plan);
});

test("duration balancing greedily pairs long and short files with stable ties", () => {
  const files = Array.from(
    { length: 16 },
    (_, i) => `tests/${String(i).padStart(2, "0")}.test.ts`,
  );
  const durations = Object.fromEntries(files.map((file, i) => [file, 16 - i]));
  const plan = planShards(files, durations);
  assert.deepEqual(
    plan.shards,
    Array.from({ length: 8 }, (_, i) => [files[i], files[15 - i]]),
  );
  assert.deepEqual(plan.estimatedMs, Array(8).fill(17));
  assert.deepEqual(planShards([...files].reverse(), durations), plan);
});

test("duration metadata is bounded and fails closed while new files get a startup fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "coach-durations-"));
  const files = Array.from({ length: 9 }, (_, i) => `tests/${i}.test.ts`);
  try {
    await mkdir(join(root, "scripts"));
    assert.deepEqual(await loadDurations(root), {});
    const path = join(root, "scripts/test-durations.json");
    const valid = {
      version: 1,
      source: "genuine test receipt",
      durationsMs: { [files[0]]: 5000 },
    };
    await writeFile(path, JSON.stringify(valid));
    const durations = await loadDurations(root);
    const plan = planShards(files, durations);
    assert.equal(
      plan.estimatedMs.reduce((a, b) => a + b, 0),
      45000,
    );
    assert.equal(plan.shards[0][0], files[0]);
    assert.deepEqual(plan.shards.flat().sort(), files);
    for (const value of [0, -1, 1.5, Infinity, NaN, 3600001, "100"])
      assert.throws(
        () => planShards(files, { [files[0]]: value as number }),
        /INVALID_DURATION/,
      );
    for (const metadata of [
      null,
      [],
      {},
      { ...valid, version: 2 },
      { ...valid, source: "" },
      { ...valid, extra: true },
      { ...valid, durationsMs: [] },
      { ...valid, durationsMs: { "../escape.test.ts": 1 } },
      { ...valid, durationsMs: { "tests/../escape.test.ts": 1 } },
      { ...valid, durationsMs: { "tests/a.ts": 1 } },
      { ...valid, durationsMs: { "tests/a.test.ts": 0 } },
    ]) {
      await writeFile(path, JSON.stringify(metadata));
      await assert.rejects(loadDurations(root), /INVALID_DURATION/);
    }
    await writeFile(path, "{");
    await assert.rejects(loadDurations(root), /INVALID_DURATION/);
    await writeFile(path, " ".repeat(1048577));
    await assert.rejects(loadDurations(root), /INVALID_DURATION/);
    await rm(path);
    await symlink(join(root, "absent"), path);
    await assert.rejects(loadDurations(root), /INVALID_DURATION/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runner selects one serial shard and propagates a real test failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "coach-shard-run-"));
  try {
    await mkdir(join(root, "tests"));
    // Direct link to this retained dependency tree; never a sibling worktree.
    await symlink(
      new URL("../node_modules", import.meta.url).pathname,
      join(root, "node_modules"),
    );
    for (const name of ["a", "b", "c", "d", "e", "f", "g", "h", "i"])
      await writeFile(
        join(root, `tests/${name}.test.ts`),
        String.raw`import { test } from "node:test"; import { appendFileSync } from "node:fs"; test("${name}", async () => { appendFileSync("receipt", "${name} start\n"); await new Promise(r => setTimeout(r, 20)); appendFileSync("receipt", "${name} end\n"); ${name === "i" ? 'throw new Error("deliberate failure");' : ""} });`,
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
    assert.equal(run("9").status, 1);
    assert.equal(run("1.5").status, 1);
    for (const index of ["01", "1e0", " 1", "Infinity", "-1"])
      assert.equal(run(index).status, 1);
    const result = run("1");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /deliberate failure/);
    assert.equal(
      await readFile(join(root, "receipt"), "utf8"),
      "a start\na end\ni start\ni end\n",
    );
    for (const shard of ["2", "3", "4", "5", "6", "7", "8"])
      assert.equal(run(shard).status, 0);
    const receipt = await readFile(join(root, "receipt"), "utf8");
    const starts = receipt
      .split("\n")
      .filter((line) => line.endsWith(" start"))
      .map((line) => line.split(" ")[0]);
    assert.deepEqual(starts.sort(), [
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
    ]);
    const lines = receipt.trim().split("\n");
    for (let i = 0; i < lines.length; i += 2)
      assert.equal(lines[i + 1], lines[i].replace(" start", " end"));
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "scripts/test-durations.json"), "{");
    const before = await readFile(join(root, "receipt"), "utf8");
    const malformed = run("1");
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /INVALID_DURATION_METADATA/);
    assert.equal(await readFile(join(root, "receipt"), "utf8"), before);
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
    for (const name of ["a", "b", "c", "d", "e", "f", "g", "h", "i"])
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
    assert.equal(plan.total, 10);
    assert.equal(plan.shards.length, 8);
    assert.deepEqual(plan.shards.flat().sort(), [
      "tests/a.test.ts",
      "tests/b.test.ts",
      "tests/c.test.ts",
      "tests/d.test.ts",
      "tests/e.test.ts",
      "tests/f.test.ts",
      "tests/g.test.ts",
      "tests/h.test.ts",
      "tests/i.test.ts",
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
