// A release with a self-contained archive for this platform is staged from it:
// no git, npm or build. The archive must pass its digest and attestation
// checks, and its application directory becomes versions/<sha>. The whole
// Node runtime it carries is kept beside it as versions/<sha>.node.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { stageArchive } from "../src/update/managed.js";
import { CandidateOwnership } from "../src/update/candidate.js";

const sha = "a".repeat(40);
const windows = process.platform === "win32";
const hostPlatform = windows ? "win-x64" : "linux-x64";

/** The node/ directory platform-archive.mjs builds for each platform. */
async function runtimeTree(node: string, platform: string) {
  await mkdir(node, { recursive: true });
  await writeFile(join(node, "LICENSE"), "Node.js licence\n");
  if (platform.startsWith("win-")) {
    await writeFile(join(node, "node.exe"), "MZ fake node.exe");
    return;
  }
  await mkdir(join(node, "bin"));
  await mkdir(join(node, "lib"));
  // Stand-ins for the RUNPATH-patched executable and its private library.
  await writeFile(join(node, "bin/node"), "\x7fELF RUNPATH=$ORIGIN/../lib");
  await chmod(join(node, "bin/node"), 0o755);
  await writeFile(join(node, "lib/libatomic.so.1"), "\x7fELF libatomic");
  await writeFile(join(node, "lib/README"), "libatomic.so.1 from Debian\n");
}

async function setup(
  revision = sha,
  options: {
    platform?: string;
    runtime?: (node: string) => Promise<void>;
  } = {},
) {
  const platform = options.platform ?? hostPlatform;
  const name = `coach-${sha}-${platform}.${platform.startsWith("win-") ? "zip" : "tar.gz"}`;
  const dir = await mkdtemp(join(tmpdir(), "archive-stage-"));
  const home = join(dir, "home");
  await mkdir(home, { mode: 0o700 });
  // A minimal archive: katafit-coach/{node,app}, as platform-archive.mjs builds.
  const tree = join(dir, "tree", "katafit-coach");
  await mkdir(join(tree, "app/dist/server"), { recursive: true });
  await runtimeTree(join(tree, "node"), platform);
  await options.runtime?.(join(tree, "node"));
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
  // Off Windows a Windows-layout fixture is a tarball under the .zip name;
  // GNU tar recognises it by content, and the layout is what is under test.
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
    platform: platform as "linux-x64" | "win-x64",
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
  return { dir, home, tree, name, boundary, artifact, downloads, verified };
}

/** Every entry under a directory with its kind, bytes and executable bit. */
async function contents(root: string) {
  const found: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const entry of (await readdir(dir)).sort()) {
      const path = join(dir, entry),
        info = await lstat(path),
        key = relative(root, path).split("\\").join("/");
      if (info.isDirectory()) {
        found[key] = "dir";
        await walk(path);
      } else
        found[key] =
          (windows ? "" : info.mode & 0o111 ? "x:" : "-:") +
          (await readFile(path)).toString("base64");
    }
  };
  await walk(root);
  return found;
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
    assert.deepEqual(f.verified, [{ file: f.name, revision: sha }]);
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
    assert.equal(existsSync(join(f.home, "versions", `${sha}.node`)), false);
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
    assert.equal(
      existsSync(join(other.home, "versions", `${sha}.node`)),
      false,
    );
  } finally {
    await rm(other.dir, { recursive: true, force: true });
  }
});

for (const platform of windows ? [hostPlatform] : [hostPlatform, "win-x64"])
  test(`the whole ${platform} Node runtime is kept unchanged beside the app as versions/<sha>.node`, async () => {
    const f = await setup(sha, { platform });
    try {
      const expected = await contents(join(f.tree, "node"));
      assert.ok(
        expected[platform.startsWith("win-") ? "node.exe" : "bin/node"],
      );
      const candidate = await stageArchive(f.home, sha, f.artifact, f.boundary);
      assert.equal(candidate, join(f.home, "versions", sha));
      assert.ok(existsSync(join(f.home, "versions", `${sha}.node`)));
      // Every file, private library included, byte for byte and still
      // executable: nothing is rewritten, so Node's RUNPATH still holds.
      assert.deepEqual(
        await contents(join(f.home, "versions", `${sha}.node`)),
        expected,
      );
      assert.deepEqual((await readdir(join(f.home, "versions"))).sort(), [
        sha,
        `${sha}.node`,
      ]);
      assert.equal(existsSync(join(f.home, "update-staging")), false);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

test("an owned preparation marks the runtime it publishes with the app's token", async () => {
  const f = await setup();
  try {
    const owner = new CandidateOwnership(f.home);
    const token = await owner.begin(sha);
    await stageArchive(f.home, sha, f.artifact, {
      ...f.boundary,
      candidateToken: token,
    });
    const expected = await contents(join(f.tree, "node"));
    assert.ok(existsSync(join(f.home, "versions", `${sha}.node`)));
    const kept = await contents(join(f.home, "versions", `${sha}.node`));
    const marker = JSON.parse(
      await readFile(
        join(f.home, "versions", `${sha}.node`, ".update-candidate.json"),
        "utf8",
      ),
    );
    assert.deepEqual(marker, { version: 1, sha, token, state: "preparing" });
    delete kept[".update-candidate.json"];
    assert.deepEqual(kept, expected);
    // A failed preparation's cleanup removes the pair together.
    await owner.cleanup(sha);
    assert.deepEqual(await readdir(join(f.home, "versions")), []);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

const exe = windows ? "node.exe" : "bin/node";
const invalid: Record<string, [RegExp, (node: string) => Promise<void>]> = {
  "no runtime": [/PACKAGE_REJECTED/, (node) => rm(node, { recursive: true })],
  "no executable": [/PACKAGE_REJECTED/, (node) => rm(join(node, exe))],
  "a directory for the executable": [
    /PACKAGE_REJECTED/,
    async (node) => {
      await rm(join(node, exe));
      await mkdir(join(node, exe));
    },
  ],
  ...(windows
    ? {}
    : {
        "a non-executable executable": [
          /PACKAGE_REJECTED/,
          (node: string) => chmod(join(node, exe), 0o644),
        ],
        "a linked executable": [
          /UNSAFE_PATH/,
          async (node: string) => {
            await rm(join(node, exe));
            await symlink(process.execPath, join(node, exe));
          },
        ],
        "a dangling executable": [
          /UNSAFE_PATH/,
          async (node: string) => {
            await rm(join(node, exe));
            await symlink("../missing", join(node, exe));
          },
        ],
        "a linked private library": [
          /UNSAFE_PATH/,
          async (node: string) => {
            await rm(join(node, "lib/libatomic.so.1"));
            await symlink("/etc/passwd", join(node, "lib/libatomic.so.1"));
          },
        ],
        "a hard-linked file": [
          /UNSAFE_PATH/,
          (node: string) => link(join(node, "LICENSE"), join(node, "COPYING")),
        ],
        "a linked runtime directory": [
          /UNSAFE_PATH/,
          async (node: string) => {
            await rm(node, { recursive: true });
            await symlink("/usr", node);
          },
        ],
        "a special file": [
          /UNSAFE_PATH/,
          async (node: string) => {
            execFileSync("mkfifo", [join(node, "lib/pipe")]);
          },
        ],
      }),
};
for (const [defect, [error, make]] of Object.entries(invalid))
  test(`an archive whose runtime has ${defect} publishes nothing`, async () => {
    const f = await setup(sha, { runtime: make });
    try {
      await assert.rejects(
        stageArchive(f.home, sha, f.artifact, f.boundary),
        error,
      );
      assert.deepEqual(await readdir(join(f.home, "versions")), []);
      assert.equal(existsSync(join(f.home, "update-staging")), false);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

// Publication never replaces anything already at either name, even an empty
// directory or a link; those are left exactly as they were.
const existing: Record<string, (path: string) => Promise<void>> = {
  "an empty directory": (path) => mkdir(path),
  "a directory with files": async (path) => {
    await mkdir(path);
    await writeFile(join(path, "keep"), "someone else's");
  },
  "a file": (path) => writeFile(path, "keep"),
  ...(windows
    ? {}
    : {
        "a link": (path: string) => symlink(tmpdir(), path),
        "a dangling link": (path: string) =>
          symlink(join(tmpdir(), "missing-target"), path),
      }),
};
for (const [kind, make] of Object.entries(existing))
  for (const at of [sha, `${sha}.node`])
    test(`staging refuses ${kind} already at versions/${at === sha ? "<sha>" : "<sha>.node"}`, async () => {
      const f = await setup();
      try {
        await mkdir(join(f.home, "versions"), { mode: 0o700 });
        const path = join(f.home, "versions", at);
        await make(path);
        const before = await lstat(path);
        await assert.rejects(
          stageArchive(f.home, sha, f.artifact, f.boundary),
          /UNSAFE_PATH/,
        );
        assert.deepEqual(await readdir(join(f.home, "versions")), [at]);
        const after = await lstat(path);
        assert.equal(after.ino, before.ino);
        assert.equal(after.isSymbolicLink(), before.isSymbolicLink());
        assert.equal(existsSync(join(f.home, "update-staging")), false);
      } finally {
        await rm(f.dir, { recursive: true, force: true });
      }
    });
