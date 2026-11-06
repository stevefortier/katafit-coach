// A release with a self-contained archive for this platform is staged from it:
// no git, npm or build. The archive must pass its digest and attestation
// checks, and its application directory becomes versions/<sha>.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { stageArchive } from "../src/update/managed.js";

const sha = "a".repeat(40);
const windows = process.platform === "win32";
const platform = windows ? "win-x64" : "linux-x64";
const name = `coach-${sha}-${platform}.${windows ? "zip" : "tar.gz"}`;

async function setup(revision = sha) {
  const dir = await mkdtemp(join(tmpdir(), "archive-stage-"));
  const home = join(dir, "home");
  await mkdir(home, { mode: 0o700 });
  // A minimal archive: katafit-coach/{node,app}, as platform-archive.mjs builds.
  const tree = join(dir, "tree", "katafit-coach");
  await mkdir(join(tree, "app/dist/server"), { recursive: true });
  await mkdir(join(tree, "node/bin"), { recursive: true });
  await writeFile(
    join(tree, "app/package.json"),
    JSON.stringify({ name: "@katafit/coach" }),
  );
  await writeFile(
    join(tree, "app/dist/build.json"),
    JSON.stringify({
      revision,
      protocol: 2,
      fingerprint: "d".repeat(64),
      capabilities: ["ready-releases-v1"],
    }),
  );
  await writeFile(join(tree, "app/dist/server/admin.js"), "export {};");
  const archive = join(dir, name);
  const tar = windows
    ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    : "tar";
  execFileSync(tar, [
    ...(windows ? ["-a", "-cf"] : ["-czf"]),
    archive,
    "-C",
    join(dir, "tree"),
    "katafit-coach",
  ]);
  const downloads: unknown[] = [],
    verified: unknown[] = [];
  const boundary = {
    platform,
    download: async (
      url: string,
      target: string,
      size: number,
      sha256: string,
    ) => {
      downloads.push({ url, size, sha256 });
      await copyFile(archive, target);
    },
    verify: async (path: string, revision: string) => {
      verified.push({ file: basename(path), revision });
    },
  };
  const artifact = {
    name,
    size: 123,
    sha256: "b".repeat(64),
    url: `https://example.invalid/${name}`,
  };
  return { dir, home, boundary, artifact, downloads, verified };
}

test("an archive passes its checks and its app becomes the candidate", async () => {
  const f = await setup();
  try {
    const candidate = await stageArchive(f.home, sha, f.artifact, f.boundary);
    assert.equal(candidate, join(f.home, "versions", sha));
    assert.equal(
      JSON.parse(await readFile(join(candidate, "dist/build.json"), "utf8"))
        .revision,
      sha,
    );
    assert.deepEqual(f.downloads, [
      { url: f.artifact.url, size: 123, sha256: "b".repeat(64) },
    ]);
    assert.deepEqual(f.verified, [{ file: name, revision: sha }]);
    assert.equal(existsSync(join(f.home, "update-staging")), false);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("a failed attestation, another revision or the wrong archive publishes nothing", async () => {
  const f = await setup();
  try {
    await assert.rejects(
      stageArchive(f.home, sha, f.artifact, {
        ...f.boundary,
        verify: async () => {
          throw Error("PROVENANCE_REJECTED");
        },
      }),
      /PROVENANCE_REJECTED/,
    );
    await assert.rejects(
      stageArchive(
        f.home,
        sha,
        {
          ...f.artifact,
          name: `coach-${sha}-${windows ? "linux-x64.tar.gz" : "win-x64.zip"}`,
        },
        f.boundary,
      ),
      /TARGET_REJECTED/,
    );
    assert.equal(existsSync(join(f.home, "versions", sha)), false);
    assert.equal(existsSync(join(f.home, "update-staging")), false);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
  const other = await setup("c".repeat(40));
  try {
    await assert.rejects(
      stageArchive(other.home, sha, other.artifact, other.boundary),
      /SOURCE_MISMATCH/,
    );
    assert.equal(existsSync(join(other.home, "versions", sha)), false);
  } finally {
    await rm(other.dir, { recursive: true, force: true });
  }
});
