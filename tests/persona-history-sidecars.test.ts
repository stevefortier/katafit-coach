import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  readdir,
  stat,
  symlink,
  mkdir,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { managedFile } from "../src/update/managed.js";

async function snapshot(dir: string, record: unknown) {
  const bytes = JSON.stringify(record, null, 2);
  const name =
    "persona-" + createHash("sha256").update(bytes).digest("hex") + ".json";
  await writeFile(dir + "/persona-history/" + name, bytes, { mode: 0o600 });
  return name;
}
async function rootBytes(dir: string) {
  const result = new Map<string, Buffer>();
  for (const name of await readdir(dir))
    if (name.endsWith(".json"))
      result.set(name, await managedFile(dir + "/" + name, 4 * 1024 * 1024));
  return result;
}

async function allBytes(dir: string) {
  const result = await rootBytes(dir);
  for (const name of await readdir(dir + "/persona-history"))
    result.set(
      "persona-history/" + name,
      await readFile(dir + "/persona-history/" + name),
    );
  return result;
}

test("old-owner rollback restores manifest and ignores leftover candidate snapshots", async () => {
  const dir = await mkdtemp(tmpdir() + "/history-owner-rollback-");
  try {
    const s = new Store(dir);
    await s.init();
    const c = s.publicConfig();
    await s.save({ ...c, persona: { ...c.persona, name: "Committed" } });
    const backup = await rootBytes(dir);
    assert.deepEqual([...backup.keys()].sort(), [
      "config.json",
      "secrets.json",
    ]);
    const originals = await allBytes(dir);
    await s.save({
      ...c,
      persona: { ...c.persona, name: "Discarded candidate" },
    });
    await s.save({ ...c, persona: { ...c.persona, name: "Discarded later" } });
    const candidates = [...(await allBytes(dir))].filter(
      ([name]) => !originals.has(name),
    );
    assert.equal(candidates.length, 2);
    // This deliberately does not delete files created after the old backup.
    for (const [name, bytes] of backup)
      await writeFile(dir + "/" + name, bytes);
    const t = new Store(dir);
    await t.init();
    assert.equal(t.personaHistory().total, 2);
    assert.throws(() => t.personaRevision(3), /REVISION_NOT_FOUND/);
    await t.save({ ...c, persona: { ...c.persona, name: "Real next" } });
    assert.equal(t.publicConfig().revision, 3);
    const u = new Store(dir);
    await u.init();
    assert.equal(u.personaHistory().total, 3);
    assert.equal(u.personaRevision(3).persona.name, "Real next");
    assert.equal(u.personaRevision(2).persona.name, "Committed");
    assert.throws(() => u.personaRevision(4), /REVISION_NOT_FOUND/);
    for (const [name, bytes] of candidates)
      assert.deepEqual(await readFile(dir + "/" + name), bytes);
    // Startup follows only the head; even malformed unreferenced files are ignored.
    await writeFile(
      dir + "/persona-history/persona-" + "0".repeat(64) + ".json",
      "not JSON",
    );
    const v = new Store(dir);
    await v.init();
    assert.equal(v.personaHistory().total, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed config or secret write cleans only newly created blobs and preserves committed files", async () => {
  const dir = await mkdtemp(tmpdir() + "/history-sidecar-failure-");
  try {
    const s = new Store(dir);
    await s.init();
    const c = s.publicConfig();
    // Preexisting byte-identical orphan for the synthetic legacy revision.
    const orphan = await snapshot(dir, {
      version: 1,
      revision: 1,
      savedAt: null,
      persona: c.persona,
      previous: null,
    });
    const originalAtomic = s.atomic.bind(s);
    for (const fail of ["secrets", "config"]) {
      const before = await allBytes(dir);
      s.atomic = async (file, data) => {
        if (file === fail) throw new Error("synthetic " + fail);
        await originalAtomic(file, data);
      };
      await assert.rejects(
        s.save({ ...c, token: "synthetic-replacement" }),
        /synthetic/,
      );
      assert.deepEqual(await allBytes(dir), before);
      assert.equal(s.personaHistory().total, 1);
      assert.equal(s.publicConfig().revision, 1);
      const t = new Store(dir);
      await t.init();
      assert.deepEqual(t.secrets, s.secrets);
    }
    s.atomic = originalAtomic;
    await s.save(c);
    assert.ok((await readdir(dir + "/persona-history")).includes(orphan));
    const before = await allBytes(dir);
    const metadata = new Map(
      await Promise.all(
        [...before.keys()]
          .filter((n) => n.startsWith("persona-"))
          .map(async (n) => [n, await stat(dir + "/" + n)] as const),
      ),
    );
    s.atomic = async (file, data) => {
      if (file === "config") throw new Error("synthetic config");
      await originalAtomic(file, data);
    };
    await assert.rejects(s.save(c), /synthetic config/);
    assert.deepEqual(await allBytes(dir), before);
    for (const [name, old] of metadata) {
      const current = await stat(dir + "/" + name);
      assert.equal(current.ino, old.ino);
      assert.equal(current.mtimeMs, old.mtimeMs);
      assert.equal(current.mode & 0o777, 0o600);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("committed chain rejects missing, hash-invalid, oversized, symlink, directory and FIFO snapshots", async () => {
  const dir = await mkdtemp(tmpdir() + "/history-sidecar-files-");
  try {
    const s = new Store(dir);
    await s.init();
    await s.save(s.publicConfig());
    const config = JSON.parse(await readFile(dir + "/config.json", "utf8"));
    const path = dir + "/persona-history/" + config.history.head;
    const bytes = await readFile(path);
    await writeFile(dir + "/target", bytes);
    for (const kind of [
      "missing",
      "hash",
      "oversized",
      "symlink",
      "directory",
      "fifo",
    ]) {
      await rm(path, { recursive: true, force: true });
      if (kind === "hash")
        await writeFile(path, Buffer.concat([bytes, Buffer.from(" ")]));
      if (kind === "oversized")
        await writeFile(path, Buffer.alloc(1024 * 1024));
      if (kind === "symlink") await symlink(dir + "/target", path);
      if (kind === "directory") await mkdir(path);
      if (kind === "fifo") execFileSync("mkfifo", [path]);
      await assert.rejects(new Store(dir).init(), undefined, kind);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hashed records and manifest fail closed for malformed shapes, links, IDs, timestamps and secrets", async () => {
  const dir = await mkdtemp(tmpdir() + "/history-sidecar-shapes-");
  try {
    const s = new Store(dir);
    await s.init();
    await s.save(s.publicConfig());
    const config = JSON.parse(await readFile(dir + "/config.json", "utf8"));
    const valid = JSON.parse(
      await readFile(dir + "/persona-history/" + config.history.head, "utf8"),
    );
    for (const record of [
      { ...valid, extra: true },
      { ...valid, version: 2 },
      { ...valid, savedAt: "not a date" },
      { ...valid, revision: 0 },
      { ...valid, revision: 1.5 },
      { ...valid, revision: valid.revision + 1 },
      { ...valid, persona: { ...valid.persona, name: "Head mismatch" } },
      { ...valid, previous: "../secrets.json" },
      { ...valid, previous: "persona-" + "a".repeat(64) + ".json" },
      { ...valid, previous: config.history.head }, // Valid hash, nondecreasing revision.
      { ...valid, persona: { ...valid.persona, extra: "forbidden" } },
      { ...valid, persona: { ...valid.persona, name: "" } },
      { ...valid, persona: { ...valid.persona, voice: 7 } },
      { ...valid, persona: { ...valid.persona, markdown: "x".repeat(8001) } },
      { ...valid, persona: { ...valid.persona, markdown: s.secrets.admin } },
    ]) {
      const head = await snapshot(dir, record);
      await writeFile(
        dir + "/config.json",
        JSON.stringify({ ...config, history: { version: 1, head } }),
      );
      await assert.rejects(new Store(dir).init());
    }
    // A matching current record cannot hide secret-bearing older snapshots.
    const previous = await snapshot(dir, {
      version: 1,
      revision: 1,
      savedAt: null,
      persona: { ...valid.persona, markdown: s.secrets.admin },
      previous: null,
    });
    const head = await snapshot(dir, { ...valid, previous });
    await writeFile(
      dir + "/config.json",
      JSON.stringify({ ...config, history: { version: 1, head } }),
    );
    await assert.rejects(new Store(dir).init(), /SECRET_IN_CONFIG/);
    for (const history of [
      null,
      {},
      { version: 2, head },
      { version: 1, head, extra: true },
      { version: 1, head: "../secrets.json" },
      { version: 1, head: null },
    ]) {
      await writeFile(
        dir + "/config.json",
        JSON.stringify({ ...config, history }),
      );
      await assert.rejects(new Store(dir).init());
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot directory rejects symlinks and non-directories on init and save", async () => {
  const dir = await mkdtemp(tmpdir() + "/history-directory-");
  try {
    const s = new Store(dir);
    await s.init();
    const archive = dir + "/persona-history";
    assert.equal((await stat(archive)).mode & 0o777, 0o700);
    const before = await rootBytes(dir);
    await mkdir(dir + "/outside");
    for (const kind of ["symlink", "file", "fifo"]) {
      await rm(archive, { recursive: true, force: true });
      if (kind === "symlink") await symlink(dir + "/outside", archive);
      if (kind === "file") await writeFile(archive, "not a directory");
      if (kind === "fifo") execFileSync("mkfifo", [archive]);
      await assert.rejects(new Store(dir).init());
      await assert.rejects(s.save(s.publicConfig()));
      assert.deepEqual(await rootBytes(dir), before);
      assert.equal(s.personaHistory().total, 1);
      assert.deepEqual(await readdir(dir + "/outside"), []);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot collision fails before changing secrets or manifest and does not remove an existing orphan", async () => {
  const dir = await mkdtemp(tmpdir() + "/history-collision-");
  try {
    const s = new Store(dir);
    await s.init();
    const c = s.publicConfig();
    const name = await snapshot(dir, {
      version: 1,
      revision: 1,
      savedAt: null,
      persona: c.persona,
      previous: null,
    });
    const path = dir + "/persona-history/" + name;
    await writeFile(path, "corrupt preexisting orphan");
    const before = await allBytes(dir);
    await assert.rejects(
      s.save({ ...c, token: "synthetic-new-secret" }),
      /INVALID_HISTORY/,
    );
    assert.deepEqual(await allBytes(dir), before);
    assert.equal(s.personaHistory().total, 1);
    assert.equal(s.secrets.token, "");
    // Orphan corruption does not block reads of the actual committed legacy state.
    const t = new Store(dir);
    await t.init();
    assert.equal(t.personaHistory().total, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("interrupted snapshot writes never expose a partial final hash and orphan temps do not block retry", async () => {
  const dir = await mkdtemp(tmpdir() + "/history-interrupted-");
  const probe = await open(dir + "/probe", "wx");
  const prototype = Object.getPrototypeOf(probe);
  const originalWrite = prototype.writeFile;
  await probe.close();
  try {
    const s = new Store(dir);
    await s.init();
    const c = s.publicConfig();
    const archive = dir + "/persona-history";
    for (const existingHead of [false, true]) {
      const before = await allBytes(dir);
      const committed = new Set(await readdir(archive));
      let partialFinalPublished = false;
      prototype.writeFile = async function (data: unknown, ...args: unknown[]) {
        if (Buffer.isBuffer(data) && data.toString().includes('"previous"')) {
          await originalWrite.call(this, data.subarray(0, 12));
          partialFinalPublished = (await readdir(archive)).some(
            (n) => n.endsWith(".json") && !committed.has(n),
          );
          throw new Error("interrupted snapshot write");
        }
        return originalWrite.call(this, data, ...args);
      };
      try {
        await assert.rejects(s.save(c), /interrupted snapshot write/);
      } finally {
        prototype.writeFile = originalWrite;
      }
      assert.equal(partialFinalPublished, false);
      assert.deepEqual(await allBytes(dir), before);
      assert.equal(s.personaHistory().total, existingHead ? 2 : 1);
      // A process killed before finally leaves only an unreferenced temp.
      const abandoned =
        archive + "/.snapshot-abandoned-" + existingHead + ".tmp";
      await writeFile(abandoned, '{"version":', { mode: 0o600 });
      const reopened = new Store(dir);
      await reopened.init();
      assert.equal(reopened.personaHistory().total, existingHead ? 2 : 1);
      await s.save(c);
      assert.equal(await readFile(abandoned, "utf8"), '{"version":');
    }
    const t = new Store(dir);
    await t.init();
    assert.equal(t.personaHistory().total, 3);
  } finally {
    prototype.writeFile = originalWrite;
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot file and directory entries are synced before config publication", async () => {
  const dir = await mkdtemp(tmpdir() + "/history-sync-");
  const probe = await open(dir + "/probe", "wx");
  const prototype = Object.getPrototypeOf(probe);
  const originalSync = prototype.sync;
  await probe.close();
  const events: string[] = [];
  const homeInode = (await stat(dir)).ino;
  prototype.sync = async function () {
    const info = await this.stat();
    events.push(
      info.isDirectory()
        ? info.ino === homeInode
          ? "home"
          : "archive"
        : "file",
    );
    return originalSync.call(this);
  };
  try {
    const s = new Store(dir);
    await s.init();
    assert.ok(
      events.includes("home"),
      "new archive directory entry must be durable",
    );
    events.length = 0;
    const atomic = s.atomic.bind(s);
    s.atomic = async (file, data) => {
      if (file === "config") {
        events.push("config");
        assert.deepEqual(events, ["home", "file", "file", "archive", "config"]);
      }
      await atomic(file, data);
    };
    await s.save(s.publicConfig());
  } finally {
    prototype.sync = originalSync;
    await rm(dir, { recursive: true, force: true });
  }
});

test("inline-history migration reads without writes then persists a linked chain", async () => {
  const dir = await mkdtemp(tmpdir() + "/history-inline-");
  try {
    const s = new Store(dir);
    await s.init();
    const c = s.publicConfig();
    const current = { ...c, revision: 8 };
    const history = [
      {
        revision: 2,
        savedAt: null,
        persona: { ...c.persona, name: "Old inline" },
      },
      { revision: 8, savedAt: "2026-01-01T00:00:00.000Z", persona: c.persona },
    ];
    await writeFile(dir + "/config.json", JSON.stringify({ current, history }));
    const before = await allBytes(dir);
    const t = new Store(dir);
    await t.init();
    assert.deepEqual(await allBytes(dir), before);
    await t.restorePersona(2);
    const manifest = JSON.parse(
      await readFile(dir + "/config.json", "utf8"),
    ).history;
    assert.deepEqual(Object.keys(manifest).sort(), ["head", "version"]);
    const u = new Store(dir);
    await u.init();
    assert.deepEqual(
      u.personaHistory().items.map((e) => e.revision),
      [9, 8, 2],
    );
    assert.equal(u.personaRevision(8).savedAt, history[1].savedAt);
    assert.equal(u.publicConfig().persona.name, "Old inline");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
