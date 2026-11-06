import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { CandidateOwnership } from "../src/update/candidate.js";
import { publishCandidate } from "../src/update/managed.js";
const sha = "a".repeat(40);
for (const defect of [
  "malformed",
  "symlink",
  "foreign",
  "writable",
  "hardlink",
  "active",
  "retained",
  "unowned-version",
] as const)
  test(`candidate recovery preserves ${defect} authority/version`, async (t) => {
    const home = await fs.mkdtemp(join(tmpdir(), "candidate-ownership-"));
    try {
      const owner = new CandidateOwnership(home),
        root = join(home, "versions", sha),
        record = join(home, "update-candidate.json");
      if (defect === "unowned-version") {
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        await fs.writeFile(join(root, "keep"), "retained rollback");
        await assert.rejects(owner.begin(sha));
        await fs.access(join(root, "keep"));
        return;
      }
      const token = await owner.begin(sha),
        staging = join(home, "staging");
      await fs.mkdir(staging, { mode: 0o700 });
      await fs.writeFile(join(staging, "keep"), "private retained bytes");
      await publishCandidate(home, sha, staging, token);
      if (defect === "malformed") await fs.writeFile(record, "{}");
      if (defect === "symlink") {
        await fs.rename(record, join(home, "alias"));
        await fs.symlink(join(home, "alias"), record);
      }
      if (defect === "writable") await fs.chmod(record, 0o660);
      if (defect === "hardlink") await fs.link(record, join(home, "alias"));
      if (defect === "active")
        await fs.writeFile(
          join(home, "active.json"),
          JSON.stringify({ revision: sha }),
          { mode: 0o600 },
        );
      if (defect === "retained") await owner.retain(sha);
      if (defect === "foreign") {
        const open = fs.open;
        t.mock.method(
          fs,
          "open",
          async (...args: Parameters<typeof fs.open>) => {
            const h = await open(...args);
            if (String(args[0]) === record) {
              const stat = h.stat.bind(h);
              h.stat = async (...a: any[]) =>
                Object.assign(await stat(...a), {
                  uid: process.getuid!() + 1,
                }) as any;
            }
            return h;
          },
        );
        syncBuiltinESMExports();
      }
      if (defect === "retained") await owner.recover();
      else await assert.rejects(owner.recover());
      assert.equal(
        await fs.readFile(join(root, "keep"), "utf8"),
        "private retained bytes",
      );
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

test("retained rollback can be re-prepared without surrendering its retention on cancellation", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "candidate-retained-retry-"));
  try {
    const owner = new CandidateOwnership(home),
      token = await owner.begin(sha),
      staging = join(home, "staging");
    await fs.mkdir(staging, { mode: 0o700 });
    await fs.writeFile(join(staging, "keep"), "rollback");
    await publishCandidate(home, sha, staging, token);
    await owner.retain(sha);
    await owner.recover();
    await owner.begin(sha);
    assert.equal((await owner.read())?.state, "retained");
    await owner.cleanup(sha);
    assert.equal(
      await fs.readFile(join(home, "versions", sha, "keep"), "utf8"),
      "rollback",
    );
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("interrupted candidate removal retains exact directory authority after its marker is gone", async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "candidate-removal-retry-"));
  try {
    const owner = new CandidateOwnership(home),
      token = await owner.begin(sha),
      staging = join(home, "staging"),
      target = join(home, "versions", sha);
    await fs.mkdir(staging, { mode: 0o700 });
    await fs.writeFile(join(staging, "keep"), "not yet removed");
    await publishCandidate(home, sha, staging, token);
    const remove = fs.rm;
    t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]) === target) {
        await remove(join(target, ".update-candidate.json"));
        throw Error("interrupted owned removal");
      }
      return remove(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(owner.cleanup(sha));
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rename(target, join(home, "original-removal"));
    await fs.mkdir(target, { mode: 0o700 });
    await fs.writeFile(join(target, "replacement"), "retained replacement");
    await assert.rejects(new CandidateOwnership(home).recover());
    assert.equal(
      await fs.readFile(join(target, "replacement"), "utf8"),
      "retained replacement",
    );
    await fs.rm(target, { recursive: true });
    await fs.rename(join(home, "original-removal"), target);
    await new CandidateOwnership(home).recover();
    await assert.rejects(fs.access(target), { code: "ENOENT" });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("candidate cleanup refuses a writable active binding even when it names another version", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "candidate-active-authority-"));
  try {
    const owner = new CandidateOwnership(home),
      token = await owner.begin(sha),
      staging = join(home, "staging");
    await fs.mkdir(staging, { mode: 0o700 });
    await fs.writeFile(
      join(staging, "keep"),
      "owned but unsafe active authority",
    );
    await publishCandidate(home, sha, staging, token);
    await fs.writeFile(
      join(home, "active.json"),
      JSON.stringify({ revision: "b".repeat(40) }),
      { mode: 0o666 },
    );
    await fs.chmod(join(home, "active.json"), 0o666);
    await assert.rejects(owner.cleanup(sha));
    assert.equal(
      await fs.readFile(join(home, "versions", sha, "keep"), "utf8"),
      "owned but unsafe active authority",
    );
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

// An archive's runtime is published beside its application as
// versions/<sha>.node. The pair is owned, recovered and removed together.
async function stagedPair(home: string) {
  const app = join(home, "staging"),
    runtime = join(home, "staging-node");
  await fs.mkdir(app, { mode: 0o700 });
  await fs.writeFile(join(app, "keep"), "application");
  await fs.mkdir(join(runtime, "bin"), { recursive: true, mode: 0o700 });
  await fs.chmod(runtime, 0o700);
  await fs.writeFile(join(runtime, "bin/node"), "runtime", { mode: 0o755 });
  return { app, runtime };
}
const runtimeOf = (home: string) => join(home, "versions", `${sha}.node`);

test("an interrupted pair publication leaves only owned state that recovery removes", async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "candidate-pair-publish-"));
  try {
    const owner = new CandidateOwnership(home),
      token = await owner.begin(sha),
      { app, runtime } = await stagedPair(home);
    const rename = fs.rename;
    t.mock.method(
      fs,
      "rename",
      async (...args: Parameters<typeof fs.rename>) => {
        if (String(args[1]) === runtimeOf(home))
          throw Error("interrupted publication");
        return rename(...args);
      },
    );
    syncBuiltinESMExports();
    await assert.rejects(
      publishCandidate(home, sha, app, token, runtime),
      /interrupted publication/,
    );
    t.mock.restoreAll();
    syncBuiltinESMExports();
    // The application went first and carries the lease's token.
    await fs.access(join(home, "versions", sha, "keep"));
    await assert.rejects(fs.access(runtimeOf(home)), { code: "ENOENT" });
    await new CandidateOwnership(home).recover();
    assert.deepEqual(await fs.readdir(join(home, "versions")), []);
    assert.equal(await new CandidateOwnership(home).read(), undefined);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("a published pair is removed together, including after an interrupted removal", async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "candidate-pair-remove-"));
  try {
    const owner = new CandidateOwnership(home),
      token = await owner.begin(sha),
      { app, runtime } = await stagedPair(home),
      target = join(home, "versions", sha);
    await publishCandidate(home, sha, app, token, runtime);
    assert.ok(existsSync(runtimeOf(home)), "runtime published");
    assert.equal(
      await fs.readFile(join(runtimeOf(home), "bin/node"), "utf8"),
      "runtime",
    );
    const remove = fs.rm;
    t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]) === target) {
        await remove(join(target, ".update-candidate.json"));
        throw Error("interrupted owned removal");
      }
      return remove(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(owner.cleanup(sha), /interrupted owned removal/);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    // The runtime's own marker is gone with its directory's move under the
    // application; the recorded identity still authorises the retry.
    await assert.rejects(fs.access(runtimeOf(home)), { code: "ENOENT" });
    await new CandidateOwnership(home).recover();
    assert.deepEqual(await fs.readdir(join(home, "versions")), []);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("an owned runtime left without its application is still removed by its owner", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "candidate-pair-orphan-"));
  try {
    const owner = new CandidateOwnership(home),
      token = await owner.begin(sha),
      { app, runtime } = await stagedPair(home);
    await publishCandidate(home, sha, app, token, runtime);
    await fs.rm(join(home, "versions", sha), { recursive: true });
    assert.ok(existsSync(runtimeOf(home)), "runtime published");
    await owner.recover();
    assert.deepEqual(await fs.readdir(join(home, "versions")), []);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

const foreignRuntime: Record<string, (home: string) => Promise<void>> = {
  "no marker": (home) => fs.rm(join(runtimeOf(home), ".update-candidate.json")),
  "another token's marker": async (home) => {
    const path = join(runtimeOf(home), ".update-candidate.json");
    const marker = JSON.parse(await fs.readFile(path, "utf8"));
    await fs.writeFile(
      path,
      JSON.stringify({ ...marker, token: randomUUID() }),
      { mode: 0o600 },
    );
  },
  "a link in its place": async (home) => {
    await fs.rename(runtimeOf(home), join(home, "moved-node"));
    await fs.symlink(join(home, "moved-node"), runtimeOf(home));
  },
  "a file in its place": async (home) => {
    await fs.rm(runtimeOf(home), { recursive: true });
    await fs.writeFile(runtimeOf(home), "not a runtime");
  },
};
for (const [defect, make] of Object.entries(foreignRuntime))
  test(`cleanup keeps an owned application whose runtime has ${defect}`, async () => {
    const home = await fs.mkdtemp(join(tmpdir(), "candidate-pair-foreign-"));
    try {
      const owner = new CandidateOwnership(home),
        token = await owner.begin(sha),
        { app, runtime } = await stagedPair(home);
      await publishCandidate(home, sha, app, token, runtime);
      assert.ok(existsSync(runtimeOf(home)), "runtime published");
      await make(home);
      const before = await fs.lstat(runtimeOf(home));
      await assert.rejects(owner.recover(), /UPDATE_CLEANUP_PENDING/);
      assert.equal(
        await fs.readFile(join(home, "versions", sha, "keep"), "utf8"),
        "application",
      );
      assert.equal((await fs.lstat(runtimeOf(home))).ino, before.ino);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

test("a retained pair survives re-preparation and its cancellation", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "candidate-pair-retained-"));
  try {
    const owner = new CandidateOwnership(home),
      token = await owner.begin(sha),
      { app, runtime } = await stagedPair(home);
    await publishCandidate(home, sha, app, token, runtime);
    await owner.retain(sha);
    await owner.recover();
    await owner.begin(sha);
    assert.equal((await owner.read())?.state, "retained");
    await owner.cleanup(sha);
    assert.deepEqual((await fs.readdir(join(home, "versions"))).sort(), [
      sha,
      `${sha}.node`,
    ]);
    assert.equal(
      await fs.readFile(join(runtimeOf(home), "bin/node"), "utf8"),
      "runtime",
    );
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

const unowned: Record<string, (path: string) => Promise<void>> = {
  "an empty directory": (path) => fs.mkdir(path),
  "a runtime": async (path) => {
    await fs.mkdir(join(path, "bin"), { recursive: true });
    await fs.writeFile(join(path, "bin/node"), "someone else's");
  },
  "a file": (path) => fs.writeFile(path, "someone else's"),
  "a link": (path) => fs.symlink(tmpdir(), path),
  "a dangling link": (path) => fs.symlink(join(tmpdir(), "missing"), path),
};
for (const [kind, make] of Object.entries(unowned))
  test(`${kind} at versions/<sha>.node without its application blocks preparing that version`, async () => {
    const home = await fs.mkdtemp(join(tmpdir(), "candidate-pair-unowned-"));
    try {
      await fs.mkdir(join(home, "versions"), { mode: 0o700 });
      await make(runtimeOf(home));
      const before = await fs.lstat(runtimeOf(home));
      await assert.rejects(
        new CandidateOwnership(home).begin(sha),
        /UPDATE_CLEANUP_PENDING/,
      );
      assert.equal((await fs.lstat(runtimeOf(home))).ino, before.ino);
      assert.equal(await new CandidateOwnership(home).read(), undefined);
      // A source build, which brings no runtime, refuses it too.
      const staging = join(home, "staging");
      await fs.mkdir(staging, { mode: 0o700 });
      await assert.rejects(publishCandidate(home, sha, staging), /UNSAFE_PATH/);
      await fs.access(staging);
      assert.deepEqual(await fs.readdir(join(home, "versions")), [
        `${sha}.node`,
      ]);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

for (const kind of ["an empty directory", "a payload"])
  test(`cleanup never moves a runtime over ${kind} already inside its application`, async () => {
    const home = await fs.mkdtemp(join(tmpdir(), "candidate-pair-adopt-"));
    try {
      const owner = new CandidateOwnership(home),
        token = await owner.begin(sha),
        { app, runtime } = await stagedPair(home),
        inside = join(home, "versions", sha, ".update-runtime");
      await fs.mkdir(join(app, ".update-runtime"), { mode: 0o700 });
      if (kind === "a payload")
        await fs.writeFile(join(app, ".update-runtime", "payload"), "kept");
      await publishCandidate(home, sha, app, token, runtime);
      const lease = await owner.read();
      await assert.rejects(owner.recover(), /UPDATE_CLEANUP_PENDING/);
      // Everything stays for a retry: the payload, the runtime and the lease.
      assert.deepEqual(
        await fs.readdir(inside),
        kind === "a payload" ? ["payload"] : [],
      );
      assert.equal(
        await fs.readFile(join(runtimeOf(home), "bin/node"), "utf8"),
        "runtime",
      );
      assert.deepEqual(await owner.read(), lease);
      await fs.rm(inside, { recursive: true });
      await owner.recover();
      assert.deepEqual(await fs.readdir(join(home, "versions")), []);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

test("a runtime already moved inside its application before an interruption is removed with it", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "candidate-pair-adopted-"));
  try {
    const owner = new CandidateOwnership(home),
      token = await owner.begin(sha),
      { app, runtime } = await stagedPair(home);
    await publishCandidate(home, sha, app, token, runtime);
    // Where cleanup moves it, before it records the directory to remove.
    await fs.rename(
      runtimeOf(home),
      join(home, "versions", sha, ".update-runtime"),
    );
    await new CandidateOwnership(home).recover();
    assert.deepEqual(await fs.readdir(join(home, "versions")), []);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
