import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  cp,
  readFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metadata } from "../src/update/managed.js";

test("native build advertises a protocol real prior metadata rejects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "native-gate-"));
  try {
    await mkdir(join(dir, "dist"));
    for (const name of ["package.json", "package-lock.json", "sandbox"])
      await cp(name, join(dir, name), { recursive: true });
    execFileSync(
      process.execPath,
      [join(process.cwd(), "scripts/build-metadata.mjs")],
      {
        cwd: dir,
        env: { ...process.env, KATAFIT_BUILD_REVISION: "a".repeat(40) },
      },
    );
    // Execute the actual prior validator, not a rewritten protocol mock.
    const source = execFileSync(
      "git",
      [
        "show",
        "ee17899f2a1ff332826c6750e1f31714deda7d63:src/update/managed.ts",
      ],
      { encoding: "utf8" },
    );
    await writeFile(
      join(dir, "legacy.ts"),
      source.replace(
        '"./updates.js"',
        JSON.stringify(join(process.cwd(), "src/update/updates.ts")),
      ),
    );
    const legacy = await import(join(dir, "legacy.ts"));
    await assert.rejects(legacy.metadata(dir), /INCOMPATIBLE_BUILD/);
    assert.match((await metadata(dir)).fingerprint!, /^[a-f0-9]{64}$/);
    assert.equal(
      await readFile(join(dir, "dist/native/npm-lock.json"), "utf8"),
      await readFile("package-lock.json", "utf8"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("new launcher still accepts unchanged-schema legacy rollback metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "legacy-rollback-"));
  try {
    await mkdir(join(dir, "dist"));
    await writeFile(
      join(dir, "dist/build.json"),
      JSON.stringify({ revision: "a".repeat(40), protocol: 1 }),
    );
    assert.equal((await metadata(dir)).protocol, 1);
    await writeFile(
      join(dir, "dist/build.json"),
      JSON.stringify({
        revision: "a".repeat(40),
        protocol: 2,
        fingerprint: "b".repeat(64),
      }),
    );
    assert.equal((await metadata(dir)).protocol, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "actual frozen protocol-1 supervisor rejects native candidate without replacing its healthy child",
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "actual-old-launcher-"));
    let owner: any;
    try {
      const old = join(dir, "old");
      await mkdir(old);
      execFileSync("tar", ["-x", "-C", old], {
        input: execFileSync(
          "git",
          ["archive", "ee17899f2a1ff332826c6750e1f31714deda7d63"],
          { maxBuffer: 32 * 1024 * 1024 },
        ),
      });
      await symlink(
        join(process.cwd(), "node_modules"),
        join(old, "node_modules"),
      );
      execFileSync(join(process.cwd(), "node_modules/.bin/tsc"), [], {
        cwd: old,
        timeout: 30000,
      });
      await writeFile(
        join(old, "dist/build.json"),
        JSON.stringify({
          revision: "ee17899f2a1ff332826c6750e1f31714deda7d63",
          protocol: 1,
        }),
      );
      const { Store } = await import(join(old, "dist/config/store.js"));
      const { supervise } = await import(
        join(old, "dist/update/supervisor.js")
      );
      const home = join(dir, "home"),
        candidate = join(dir, "candidate"),
        sha = "a".repeat(40);
      const store = new Store(home);
      await store.init();
      const before = await readFile(join(home, "secrets.json"), "utf8");
      owner = await supervise(store, 0, undefined, {
        prepare: async () => {
          await mkdir(join(candidate, "dist"), { recursive: true });
          await writeFile(
            join(candidate, "dist/build.json"),
            JSON.stringify({
              revision: sha,
              protocol: 2,
              fingerprint: "b".repeat(64),
            }),
          );
          return candidate;
        },
      });
      const pid = owner.pid;
      owner.updates.latest = sha;
      owner.updates.checkedAt = Date.now();
      await assert.rejects(owner.updates.apply(sha), /UPGRADE_FAILED/);
      assert.equal(owner.pid, pid);
      assert.equal(owner.updates.lastOperation.state, "failed");
      const response = await fetch(owner.origin + "/api/status", {
        headers: { Authorization: "Bearer " + store.secrets.admin },
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).state, "stopped");
      assert.equal(await readFile(join(home, "secrets.json"), "utf8"), before);
      await assert.rejects(readFile(join(home, "active.json")), {
        code: "ENOENT",
      });
    } finally {
      await owner?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
