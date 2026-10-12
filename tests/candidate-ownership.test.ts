import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
