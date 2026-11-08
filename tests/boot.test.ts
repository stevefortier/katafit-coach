import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { constants, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as bootModule from "../src/boot.js";
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

test("only a new bootstrap lifetime authorizes configured startup, not a managed handover", async () => {
  const { home, seed } = await setup();
  try {
    await write(home, "active.json", { revision: A });
    const s = supervisors(home, {
      A: ["handover"],
      B: ["healthyExit0", "healthyExit0"],
      seed: [],
    });
    const continuation: unknown[] = [];
    const start = (...args: any[]) => {
      continuation.push(args[3]);
      return s.start(args[0]);
    };
    assert.equal(await boot({ home, seed, start, healthMs: 5000 }), 0);
    assert.deepEqual(continuation, [false, true]);
    assert.equal(await boot({ home, seed, start, healthMs: 5000 }), 0);
    assert.deepEqual(
      continuation,
      [false, true, false],
      "a genuinely new launch must forget prior Stop/handover suppression",
    );
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

// Each managed version may bring its own Node as versions/<SHA>.node. These
// run the real supervisor start, so the recorded executable and argv are the
// spawned child's own.
const C = "c".repeat(40);
const exe = windows() ? ["node.exe"] : ["bin", "node"];
function windows() {
  return process.platform === "win32";
}
const runtimeOf = (home: string, sha: string) =>
  join(home, "versions", `${sha}.node`, ...exe);

async function realSetup(behaviour: Record<string, "healthy" | "crash">) {
  const home = await mkdtemp(join(realpathSync(tmpdir()), "boot-node-"));
  const seed = join(home, "seed");
  const roots: Record<string, string> = {
    seed,
    A: join(home, "versions", A),
    B: join(home, "versions", B),
    C: join(home, "versions", C),
  };
  for (const [name, root] of Object.entries(roots)) {
    if (!behaviour[name]) continue;
    const started = JSON.stringify(join(home, "started.jsonl"));
    const service = JSON.stringify(join(home, "service.json"));
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(
      join(root, "dist/cli.js"),
      `const fs = require("fs");
      fs.appendFileSync(${started}, JSON.stringify({ name: ${JSON.stringify(name)}, execPath: process.execPath, argv: process.argv.slice(1), protocol: process.env.KATAFIT_BOOT_PROTOCOL, home: process.env.KATAFIT_COACH_HOME }) + "\\n");
      ${behaviour[name] === "healthy" ? `fs.writeFileSync(${service}, "{}"); setTimeout(() => process.exit(0), 100);` : "process.exit(1);"}`,
    );
  }
  return { home, seed, roots };
}
/** A copy of this Node, as an archive's node/ directory would carry. */
async function bringNode(home: string, sha: string) {
  const path = runtimeOf(home, sha);
  await mkdir(dirname(path), { recursive: true });
  await copyFile(process.execPath, path, constants.COPYFILE_FICLONE);
  await chmod(path, 0o755);
  return path;
}
const startedIn = async (home: string) =>
  existsSync(join(home, "started.jsonl"))
    ? (await readFile(join(home, "started.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
const bootNode = realpathSync(process.execPath);

test("the active version's supervisor runs under the Node that version brought", async () => {
  const { home, seed, roots } = await realSetup({ A: "healthy" });
  try {
    const node = await bringNode(home, A);
    await write(home, "active.json", { revision: A });
    assert.equal(await boot({ home, seed }), 0);
    assert.deepEqual(await startedIn(home), [
      {
        name: "A",
        execPath: node,
        argv: [join(roots.A, "dist/cli.js"), "serve"],
        protocol: "1",
        home,
      },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a version without its own Node, and the seed, run under the bootstrap's Node", async () => {
  const { home, seed, roots } = await realSetup({
    A: "healthy",
    seed: "healthy",
  });
  try {
    await write(home, "active.json", { revision: A });
    assert.equal(await boot({ home, seed }), 0);
    // While no usable version is active, the seed runs: a runtime beside a
    // version without an application, or beside the seed, is never used.
    await bringNode(home, C);
    await mkdir(join(`${seed}.node`, ...exe.slice(0, -1)), { recursive: true });
    await copyFile(process.execPath, join(`${seed}.node`, ...exe));
    await write(home, "active.json", { revision: C });
    assert.equal(await boot({ home, seed }), 0);
    assert.deepEqual(
      (await startedIn(home)).map(({ name, execPath, argv }) => ({
        name,
        execPath,
        argv,
      })),
      [
        {
          name: "A",
          execPath: bootNode,
          argv: [join(roots.A, "dist/cli.js"), "serve"],
        },
        {
          name: "seed",
          execPath: bootNode,
          argv: [join(seed, "dist/cli.js"), "serve"],
        },
      ],
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a rolled-back version runs again under its own Node", async () => {
  const { home, seed } = await realSetup({ A: "healthy", B: "crash" });
  try {
    const nodeA = await bringNode(home, A),
      nodeB = await bringNode(home, B);
    await write(home, "active.json", { revision: B });
    await write(home, "handoff.json", {
      revision: B,
      previous: { revision: A },
    });
    assert.equal(await boot({ home, seed, healthMs: 5000 }), 0);
    assert.deepEqual(
      (await startedIn(home)).map(({ name, execPath }) => ({
        name,
        execPath,
      })),
      [
        { name: "B", execPath: nodeB },
        { name: "A", execPath: nodeA },
      ],
    );
    assert.equal((await read(home, "active.json")).revision, A);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// A runtime that is present but unusable is refused, never silently replaced
// by the bootstrap's own Node.
const unusable: Record<string, (home: string, sha: string) => Promise<void>> = {
  "no executable": async (home, sha) => {
    await mkdir(join(home, "versions", `${sha}.node`), { recursive: true });
  },
  "a directory for the executable": async (home, sha) => {
    await mkdir(runtimeOf(home, sha), { recursive: true });
  },
  // Laid out correctly, but the operating system cannot run it.
  "an executable that is not a program": async (home, sha) => {
    await mkdir(dirname(runtimeOf(home, sha)), { recursive: true });
    await writeFile(runtimeOf(home, sha), "not a program", { mode: 0o755 });
  },
  ...(windows()
    ? {}
    : {
        "a linked executable": async (home: string, sha: string) => {
          await mkdir(dirname(runtimeOf(home, sha)), { recursive: true });
          await symlink(process.execPath, runtimeOf(home, sha));
        },
        "a dangling executable": async (home: string, sha: string) => {
          await mkdir(dirname(runtimeOf(home, sha)), { recursive: true });
          await symlink(join(home, "missing"), runtimeOf(home, sha));
        },
        "a linked runtime directory": async (home: string, sha: string) => {
          await mkdir(join(home, "versions"), { recursive: true });
          await symlink(
            dirname(dirname(process.execPath)),
            join(home, "versions", `${sha}.node`),
          );
        },
        "an executable whose interpreter is missing": async (
          home: string,
          sha: string,
        ) => {
          await mkdir(dirname(runtimeOf(home, sha)), { recursive: true });
          await writeFile(runtimeOf(home, sha), "#!/missing/interpreter\n", {
            mode: 0o755,
          });
        },
        // Its owner lacks the execute bit others have: the spawn itself fails.
        ...(process.getuid?.() === 0
          ? {}
          : {
              "an executable its owner may not run": async (
                home: string,
                sha: string,
              ) => {
                await mkdir(dirname(runtimeOf(home, sha)), {
                  recursive: true,
                });
                await writeFile(runtimeOf(home, sha), "#!/bin/sh\n");
                await chmod(runtimeOf(home, sha), 0o055);
              },
            }),
        "a non-executable file": async (home: string, sha: string) => {
          await mkdir(dirname(runtimeOf(home, sha)), { recursive: true });
          await writeFile(runtimeOf(home, sha), "#!/bin/sh\n", {
            mode: 0o644,
          });
        },
      }),
};
for (const [defect, make] of Object.entries(unusable))
  test(`a version whose runtime has ${defect} is refused, and rolled back from after a handover`, async () => {
    const { home, seed } = await realSetup({ A: "healthy", B: "healthy" });
    try {
      await make(home, B);
      await write(home, "active.json", { revision: B });
      assert.notEqual(await boot({ home, seed }), 0);
      assert.deepEqual(await startedIn(home), []);
      await write(home, "handoff.json", {
        revision: B,
        previous: { revision: A },
      });
      assert.equal(await boot({ home, seed, healthMs: 2000 }), 0);
      assert.deepEqual(
        (await startedIn(home)).map(({ name, execPath }) => ({
          name,
          execPath,
        })),
        [{ name: "A", execPath: bootNode }],
      );
      assert.equal((await read(home, "active.json")).revision, A);
      assert.equal((await read(home, "boot-rollback.json")).revision, B);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

test(
  "a runtime is never found through a linked versions directory or home ancestor",
  { skip: windows() },
  async () => {
    const { home, seed } = await realSetup({ A: "healthy", seed: "healthy" });
    const alias = `${home}-alias`;
    try {
      await bringNode(home, A);
      await write(home, "active.json", { revision: A });
      // The version and its runtime are real; only a link leads to them.
      const real = join(home, "real-versions");
      await rename(join(home, "versions"), real);
      await symlink(real, join(home, "versions"));
      assert.notEqual(await boot({ home, seed }), 0);
      await rm(join(home, "versions"));
      await rename(real, join(home, "versions"));
      await symlink(home, alias);
      assert.notEqual(await boot({ home: alias, seed }), 0);
      assert.deepEqual(await startedIn(home), []);
      assert.throws(() => bootModule.versionNode(alias, A), /UNSAFE_RUNTIME/);
      // Without a runtime there is nothing to follow; the seed needs none.
      assert.equal(bootModule.versionNode(alias, B), undefined);
      await rm(join(home, "active.json"));
      assert.equal(await boot({ home: alias, seed }), 0);
      assert.deepEqual(
        (await startedIn(home)).map(({ name, execPath }) => ({
          name,
          execPath,
        })),
        [{ name: "seed", execPath: bootNode }],
      );
    } finally {
      await rm(alias, { force: true });
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("runtime lookup follows each platform's archive layout", async () => {
  assert.equal(typeof bootModule.versionNode, "function");
  const home = await mkdtemp(join(realpathSync(tmpdir()), "boot-layout-"));
  try {
    const versionNode = bootModule.versionNode as (
      home: string,
      revision: string,
      platform?: NodeJS.Platform,
    ) => string | undefined;
    assert.equal(versionNode(home, A, "win32"), undefined);
    assert.equal(versionNode(home, A, "linux"), undefined);
    const runtime = join(home, "versions", `${A}.node`);
    await mkdir(join(runtime, "bin"), { recursive: true });
    await writeFile(join(runtime, "node.exe"), "MZ");
    await writeFile(join(runtime, "bin/node"), "\x7fELF", { mode: 0o755 });
    await chmod(join(runtime, "bin/node"), 0o755);
    assert.equal(versionNode(home, A, "win32"), join(runtime, "node.exe"));
    if (!windows())
      assert.equal(versionNode(home, A, "linux"), join(runtime, "bin/node"));
    // One platform's layout is not the other's.
    await rm(join(runtime, "node.exe"));
    assert.throws(() => versionNode(home, A, "win32"), /UNSAFE_RUNTIME/);
    await rm(join(runtime, "bin"), { recursive: true });
    await writeFile(join(runtime, "node.exe"), "MZ");
    assert.throws(() => versionNode(home, A, "linux"), /UNSAFE_RUNTIME/);
    // Only a full SHA names a version's runtime.
    for (const revision of ["../seed", "", "A".repeat(40), undefined])
      assert.throws(
        () => versionNode(home, revision as any, "linux"),
        /UNSAFE_RUNTIME/,
      );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
