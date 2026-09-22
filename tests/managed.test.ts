import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  symlink,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { stage, buildEnvironment, metadata } from "../src/update/managed.js";

test("managed versions and metadata reject symlinks before external reads or writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "coach-paths-"));
  try {
    const home = join(root, "home"),
      outside = join(root, "outside");
    await mkdir(home);
    await mkdir(outside);
    await symlink(outside, join(home, "versions"));
    await assert.rejects(
      stage(home, "a".repeat(40), { source: join(root, "absent") }),
      /UNSAFE_PATH/,
    );
    assert.deepEqual(await readdir(outside), []);
    await mkdir(join(root, "candidate/dist"), { recursive: true });
    await writeFile(
      join(root, "metadata"),
      JSON.stringify({ revision: "a".repeat(40), protocol: 1 }),
    );
    await symlink(
      join(root, "metadata"),
      join(root, "candidate/dist/build.json"),
    );
    await assert.rejects(metadata(join(root, "candidate")), /UNSAFE_PATH/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("build environment suppresses both user and global npm credential configuration", () => {
  const env = buildEnvironment("/tmp/isolated");
  assert.equal(env.npm_config_globalconfig, "/tmp/isolated/.npm-global-empty");
  assert.equal(env.npm_config_userconfig, "/dev/null");
});

test("isolated source staging fetches exact revision, installs lockfile, validates metadata without inheriting secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "coach-stage-"));
  const source = join(root, "source");
  await mkdir(source);
  const run = (...args: string[]) => execFileSync("git", args, { cwd: source });
  try {
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        name: "@katafit/coach",
        version: "0.1.0",
        type: "module",
        scripts: { build: "node build.mjs" },
      }),
    );
    execFileSync(
      "npm",
      ["install", "--package-lock-only", "--ignore-scripts"],
      { cwd: source, stdio: "ignore" },
    );
    await writeFile(
      join(source, "build.mjs"),
      `import {mkdirSync,writeFileSync} from 'node:fs'; import {execFileSync} from 'node:child_process'; if(process.env.TEST_BUILD_SECRET) throw Error('leaked'); mkdirSync('dist/server',{recursive:true}); writeFileSync('dist/server/admin.js','export function admin() {}'); writeFileSync('dist/build.json', JSON.stringify({revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),protocol:1}));`,
    );
    run("init", "-q");
    run("add", ".");
    run(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    const sha = run("rev-parse", "HEAD").toString().trim();
    process.env.TEST_BUILD_SECRET = "must-not-inherit";
    const home = join(root, "home");
    await mkdir(home);
    const result = await stage(home, sha, { source });
    assert.equal(
      JSON.parse(await readFile(join(result, "dist/build.json"), "utf8"))
        .revision,
      sha,
    );
    assert.equal(result, join(home, "versions", sha));
    await assert.rejects(stage(home, "main", { source }), /TARGET_REJECTED/);
  } finally {
    delete process.env.TEST_BUILD_SECRET;
    await rm(root, { recursive: true, force: true });
  }
});
