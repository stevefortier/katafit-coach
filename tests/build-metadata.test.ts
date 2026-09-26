import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
test("build receipt identifies clean source; dirty/unknown builds never claim exact revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "coach-meta-"));
  const script = resolve("scripts/build-metadata.mjs");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  const build = () =>
    execFileSync(process.execPath, [script], {
      cwd: root,
      env: { PATH: process.env.PATH },
    });
  try {
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "source"), "one");
    for (const name of ["package.json", "package-lock.json", "sandbox"])
      await cp(name, join(root, name), { recursive: true });
    git("init", "-q");
    git("add", "source", "package.json", "package-lock.json", "sandbox");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=t@example.invalid",
      "commit",
      "-qm",
      "one",
    );
    build();
    const sha = git("rev-parse", "HEAD").toString().trim();
    assert.equal(
      JSON.parse(await readFile(join(root, "dist/build.json"), "utf8"))
        .revision,
      sha,
    );
    await writeFile(join(root, "source"), "two");
    build();
    assert.equal(
      JSON.parse(await readFile(join(root, "dist/build.json"), "utf8"))
        .revision,
      null,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
