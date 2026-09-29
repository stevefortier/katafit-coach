import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/config/store.js";
import { fork, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { stockSkills } from "../src/config/skills.js";
import { failureReason } from "../src/update/failure.js";

async function catalog(home: string) {
  const manifest = await readFile(join(home, "skills.json"));
  const head = JSON.parse(manifest.toString()).head;
  const record = await readFile(join(home, "skills-history", head));
  return {
    manifest,
    record,
    head,
    skills: JSON.parse(record.toString()).skills,
  };
}

test("launcher catalog denial survives bounded update diagnostics", () => {
  assert.equal(
    failureReason(new Error("LAUNCHER_UPGRADE_REQUIRED")),
    "LAUNCHER_UPGRADE_REQUIRED",
  );
  assert.equal(
    failureReason(new Error("untrusted path or token")),
    "UPGRADE_FAILED",
  );
});

test("old owner's candidate probe rejects the new catalog before update acceptance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coach-catalog-probe-"));
  try {
    const owner = join(dir, "owner");
    const home = join(dir, "probe-home");
    await mkdir(home);
    await mkdir(join(owner, "dist", "update"), { recursive: true });
    await mkdir(join(owner, "dist", "config"), { recursive: true });
    await writeFile(join(owner, "package.json"), '{"type":"module"}');
    await writeFile(
      join(owner, "dist", "config", "skills.js"),
      'export const stockSkills = [{id:"review-activity"},{id:"understand-progress"},{id:"change-plan"},{id:"fetch-checkin-images"}];',
    );
    await writeFile(
      join(owner, "dist", "update", "probe.js"),
      "const {Store}=await import(process.argv[2]);await new Store(process.argv[3]).init();",
    );
    const script = join(owner, "dist", "update", "probe.js");
    const candidate = new URL("../dist/config/store.js", import.meta.url).href;
    const run = () =>
      spawnSync(process.execPath, [script, candidate, home], {
        encoding: "utf8",
        timeout: 10000,
      });
    const denied = run();
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /LAUNCHER_UPGRADE_REQUIRED/);
    assert.deepEqual(await readdir(home), []);
    await writeFile(
      join(owner, "dist", "config", "skills.js"),
      'export const stockSkills = [{id:"katafit-api"}];',
    );
    const capabilityLess = run();
    assert.notEqual(
      capabilityLess.status,
      0,
      "matching IDs do not prove a compatible launcher",
    );
    assert.match(capabilityLess.stderr, /LAUNCHER_UPGRADE_REQUIRED/);
    assert.deepEqual(
      await readdir(home),
      [],
      "probe must not mutate even its disposable home",
    );
    await writeFile(
      join(owner, "dist", "config", "skills.js"),
      'export const stockSkills = [{id:"katafit-api"}]; export const launcherSkillCatalog = 2;',
    );
    const accepted = run();
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(
      (await catalog(home)).skills.map((skill: { id: string }) => skill.id),
      ["katafit-api"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function coldChild(home: string, launcherSkillCatalog?: number) {
  const child = fork(
    resolve("dist/update/runtime.js"),
    [resolve("."), home, "0", "fixture"],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      execArgv: [],
    },
  );
  try {
    const result = await new Promise<"ready" | "exit">((done, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("child startup timed out")),
        12000,
      );
      const finish = (value: "ready" | "exit") => {
        clearTimeout(timeout);
        done(value);
      };
      child.once("exit", () => finish("exit"));
      child.on("message", (message: any) => {
        if (message?.type === "ready") finish("ready");
      });
      child.send({
        type: "state",
        data: { installed: null, launcherSkillCatalog },
      });
    });
    return result;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((done) => child.once("exit", done));
    }
  }
}

test("incompatible launcher denies legacy catalog migration without changing the linked head", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-launcher-catalog-"));
  try {
    const original = new Store(home);
    await original.init();
    const unified = await catalog(home);
    const legacy = JSON.parse(
      await readFile(
        new URL("./fixtures/legacy-stock-skills.json", import.meta.url),
        "utf8",
      ),
    );
    const previous = {
      version: 1,
      revision: 1,
      savedAt: null,
      previous: null,
      skills: legacy,
    };
    const bytes = Buffer.from(JSON.stringify(previous, null, 2));
    const { createHash } = await import("node:crypto");
    const head = `skills-${createHash("sha256").update(bytes).digest("hex")}.json`;
    await writeFile(join(home, "skills-history", head), bytes);
    await writeFile(
      join(home, "skills.json"),
      JSON.stringify({ version: 1, revision: 1, head }, null, 2),
    );
    const before = await catalog(home);
    const entries = await readdir(join(home, "skills-history"));
    await assert.rejects(
      new Store(home, 1).init(),
      /LAUNCHER_UPGRADE_REQUIRED/,
    );
    assert.deepEqual(await catalog(home), before);
    assert.deepEqual(await readdir(join(home, "skills-history")), entries);
    assert.equal(
      await coldChild(home),
      "exit",
      "old owner state fails before migration",
    );
    assert.deepEqual(await catalog(home), before);
    assert.equal(
      await coldChild(home, 2),
      "ready",
      "new owner starts and migrates",
    );
    const compatible = new Store(home, 2);
    await compatible.init();
    const migrated = await catalog(home);
    assert.deepEqual(
      migrated.skills.map((skill: { id: string }) => skill.id),
      stockSkills.map((skill) => skill.id),
    );
    assert.equal(JSON.parse(migrated.record.toString()).previous, head);
    assert.deepEqual(await readFile(join(home, "skills-history", head)), bytes);
    await assert.rejects(
      new Store(home, 1).init(),
      /LAUNCHER_UPGRADE_REQUIRED|INVALID_SKILL_STORAGE/,
    );
    const restarted = new Store(home, 2);
    await restarted.init();
    assert.deepEqual(await catalog(home), migrated);
    // A rollback of only the small root head reselects the old immutable chain.
    await writeFile(join(home, "skills.json"), before.manifest);
    const restored = new Store(home, 2);
    await restored.init();
    assert.equal((await catalog(home)).head !== migrated.head, true);
    assert.deepEqual(
      await readFile(join(home, "skills-history", migrated.head)),
      migrated.record,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
