import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, HANDOVER_EXIT } from "../src/boot.js";

const A = "a".repeat(40),
  B = "b".repeat(40);

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "boot-"));
  const seed = join(home, "seed");
  for (const root of [
    seed,
    join(home, "versions", A),
    join(home, "versions", B),
  ]) {
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist/cli.js"), "");
  }
  return { home, seed };
}
const write = (home: string, name: string, value: unknown) =>
  writeFile(join(home, name), JSON.stringify(value));
const read = async (home: string, name: string) =>
  JSON.parse(await readFile(join(home, name), "utf8"));

// A fake supervisor: per root, a list of behaviours consumed in order.
function supervisors(home: string, plan: Record<string, string[]>) {
  const started: string[] = [];
  const start = (root: string) => {
    const name = root.endsWith(A) ? "A" : root.endsWith(B) ? "B" : "seed";
    started.push(name);
    const step = plan[name].shift()!;
    const service = JSON.stringify(join(home, "service.json"));
    const script = {
      healthyExit0: `require("fs").writeFileSync(${service}, "{}"); setTimeout(() => process.exit(0), 100)`,
      // The upgrading supervisor publishes both records before handing over.
      // Writing these from the parent races the child's exit on Windows.
      handover: `
        const fs = require("fs");
        fs.writeFileSync(${JSON.stringify(join(home, "active.json"))}, ${JSON.stringify(JSON.stringify({ revision: B }))});
        fs.writeFileSync(${JSON.stringify(join(home, "handoff.json"))}, ${JSON.stringify(JSON.stringify({ revision: B, previous: { revision: A } }))});
        process.exit(${HANDOVER_EXIT});
      `,
      hang: `setInterval(() => {}, 1000)`,
      crash: `process.exit(1)`,
    }[step]!;
    return spawn(process.execPath, ["-e", script], { stdio: "ignore" });
  };
  return { start, started };
}

test("with no active version the seed runs, and its exit code is the bootstrap's", async () => {
  const { home, seed } = await setup();
  try {
    const s = supervisors(home, { seed: ["healthyExit0"], A: [], B: [] });
    assert.equal(await boot({ home, seed, start: s.start }), 0);
    assert.deepEqual(s.started, ["seed"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a handover starts the newly active version's own supervisor", async () => {
  const { home, seed } = await setup();
  try {
    await write(home, "active.json", { revision: A });
    const s = supervisors(home, {
      A: ["handover"],
      B: ["healthyExit0"],
      seed: [],
    });
    const run = boot({ home, seed, start: s.start, healthMs: 5000 });
    assert.equal(await run, 0);
    assert.deepEqual(s.started, ["A", "B"]);
    assert.equal(existsSync(join(home, "handoff.json")), false);
    assert.equal((await read(home, "active.json")).revision, B);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

for (const failure of ["hang", "crash"])
  test(`a handed-over version that ${failure === "hang" ? "never becomes healthy" : "crashes before healthy"} is rolled back`, async () => {
    const { home, seed } = await setup();
    try {
      await write(home, "active.json", { revision: B });
      await write(home, "handoff.json", {
        revision: B,
        previous: { revision: A, image: "sha256:" + "c".repeat(64) },
      });
      const s = supervisors(home, {
        B: [failure],
        A: ["healthyExit0"],
        seed: [],
      });
      assert.equal(
        await boot({ home, seed, start: s.start, healthMs: 600 }),
        0,
      );
      assert.deepEqual(s.started, ["B", "A"]);
      // The previous pointer is restored exactly, image binding included.
      assert.deepEqual(await read(home, "active.json"), {
        revision: A,
        image: "sha256:" + "c".repeat(64),
      });
      const rollback = await read(home, "boot-rollback.json");
      assert.equal(rollback.revision, B);
      assert.equal(rollback.restored, A);
      assert.equal(existsSync(join(home, "handoff.json")), false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

test("an ordinary exit is passed on, not treated as a handover", async () => {
  const { home, seed } = await setup();
  try {
    await write(home, "active.json", { revision: A });
    const s = supervisors(home, { A: ["crash"], B: [], seed: [] });
    assert.equal(await boot({ home, seed, start: s.start }), 1);
    assert.deepEqual(s.started, ["A"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a stop requested during the health window is not a failed version", async () => {
  const { home, seed } = await setup();
  try {
    await write(home, "active.json", { revision: B });
    await write(home, "handoff.json", {
      revision: B,
      previous: { revision: A },
    });
    const s = supervisors(home, { B: ["hang"], A: [], seed: [] });
    const run = boot({ home, seed, start: s.start, healthMs: 10000 });
    setTimeout(() => process.emit("SIGTERM"), 300);
    await run;
    assert.deepEqual(s.started, ["B"]);
    assert.equal((await read(home, "active.json")).revision, B);
    assert.equal(existsSync(join(home, "boot-rollback.json")), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
