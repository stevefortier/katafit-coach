import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readdir } from "node:fs/promises";
import { managedFile } from "../src/update/managed.js";

test("large legitimate history fits every stable-owner backup cap and immutable bounded snapshots", async () => {
  const dir = await mkdtemp(tmpdir() + "/history-large-");
  try {
    const s = new Store(dir);
    await s.init();
    const c = s.publicConfig();
    const persona = Object.fromEntries(
      Object.keys(c.persona).map((k) => [k, "x".repeat(8000)]),
    );
    for (let i = 0; i < 70; i++) await s.save({ ...c, persona });
    const archive = dir + "/persona-history";
    const rootNames = (await readdir(dir)).filter((n) => n.endsWith(".json"));
    const backup = new Map<string, Buffer>();
    for (const name of rootNames)
      backup.set(name, await managedFile(dir + "/" + name, 4 * 1024 * 1024));
    assert.deepEqual(rootNames.sort(), ["config.json", "secrets.json"]);
    assert.ok(
      [...backup.values()].reduce((n, b) => n + b.buffer.byteLength, 0) <=
        2 * (4 * 1024 * 1024 + 1),
    );
    const names = (await readdir(archive)).filter((n) => n.endsWith(".json"));
    const originals = new Map<string, Buffer>();
    let total = 0;
    for (const name of names) {
      const bytes = await managedFile(archive + "/" + name, 1024 * 1024);
      total += bytes.length;
      if (name.startsWith("persona-")) {
        assert.ok(bytes.length < 1024 * 1024);
        originals.set(name, bytes);
      }
    }
    assert.ok(total > 4 * 1024 * 1024);
    assert.equal(originals.size, 71);
    assert.ok((await stat(dir + "/config.json")).size < 150000);
    const t = new Store(dir);
    await t.init();
    const ids: number[] = [];
    let before: number | undefined;
    do {
      const page = t.personaHistory(before, 9);
      ids.push(...page.items.map((e) => e.revision));
      before = page.nextBefore ?? undefined;
    } while (before);
    assert.deepEqual(
      ids,
      Array.from({ length: 71 }, (_, i) => 71 - i),
    );
    await t.restorePersona(2);
    assert.equal(t.publicConfig().revision, 72);
    assert.deepEqual(t.publicConfig().persona, persona);
    for (const [name, bytes] of originals)
      assert.deepEqual(await readFile(archive + "/" + name), bytes);
    const controls = Object.fromEntries(
      Object.keys(c.persona).map((k) => [k, "x" + "\u0000".repeat(7999)]),
    );
    await t.save({ ...c, persona: controls });
    for (const name of (await readdir(archive)).filter((n) =>
      n.startsWith("persona-"),
    ))
      assert.ok((await stat(archive + "/" + name)).size < 1024 * 1024);
    const u = new Store(dir);
    await u.init();
    assert.deepEqual(u.publicConfig().persona, controls);
    assert.equal(u.personaHistory().total, 73);
    const surrogates = Object.fromEntries(
      Object.keys(c.persona).map((k) => [k, "\ud800".repeat(8000)]),
    );
    await u.save({ ...c, persona: surrogates });
    const v = new Store(dir);
    await v.init();
    assert.deepEqual(v.publicConfig().persona, surrogates);
    assert.equal(v.personaHistory().total, 74);
    for (const name of await readdir(archive))
      assert.ok((await stat(archive + "/" + name)).size < 1024 * 1024);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
import { Store } from "../src/config/store.js";

test("migration keeps legacy IDs and unknown dates without rewriting config", async () => {
  const dir = await mkdtemp(tmpdir() + "/history-legacy-");
  try {
    const s = new Store(dir);
    await s.init();
    const c = s.publicConfig();
    const legacy = {
      current: { ...c, revision: 8 },
      previous: {
        ...c,
        revision: 5,
        persona: { ...c.persona, name: "Legacy" },
      },
    };
    await writeFile(dir + "/config.json", JSON.stringify(legacy));
    const before = await stat(dir + "/config.json");
    const t = new Store(dir);
    await t.init();
    assert.equal((await stat(dir + "/config.json")).ino, before.ino);
    assert.deepEqual(
      t.personaHistory().items.map((e) => [e.revision, e.savedAt]),
      [
        [8, null],
        [5, null],
      ],
    );
    await t.restorePersona(5);
    const u = new Store(dir);
    await u.init();
    assert.deepEqual(
      u.personaHistory().items.map((e) => e.revision),
      [9, 8, 5],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("serialized concurrent saves, restore and rollback never lose revisions", async () => {
  const dir = await mkdtemp(tmpdir() + "/history-concurrent-");
  try {
    const s = new Store(dir);
    await s.init();
    const c = s.publicConfig();
    await Promise.all(
      Array.from({ length: 55 }, (_, i) =>
        s.save({ ...c, persona: { ...c.persona, name: "Synthetic " + i } }),
      ),
    );
    await Promise.all([s.restorePersona(1), s.rollback(), s.save(c)]);
    const seen: number[] = [];
    let before: number | undefined;
    do {
      const page = s.personaHistory(before, 7);
      seen.push(...page.items.map((e) => e.revision));
      before = page.nextBefore ?? undefined;
    } while (before);
    assert.equal(seen.length, 59);
    assert.equal(new Set(seen).size, 59);
    assert.equal(s.personaHistory().items.length, 20);
    const t = new Store(dir);
    await t.init();
    assert.equal(t.personaHistory().total, 59);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("failed config persistence leaves memory, secrets, disk and history unchanged", async () => {
  const dir = await mkdtemp(tmpdir() + "/history-failure-");
  try {
    const s = new Store(dir);
    await s.init();
    const before = s.publicConfig(),
      secrets = { ...s.secrets };
    const bytes = await readFile(dir + "/config.json", "utf8");
    const atomic = s.atomic.bind(s);
    s.atomic = async (file, data) => {
      if (file === "config") throw new Error("synthetic write failure");
      await atomic(file, data);
    };
    await assert.rejects(
      s.save({ ...before, token: "synthetic-new-secret" }),
      /synthetic write failure/,
    );
    assert.deepEqual(s.publicConfig(), before);
    assert.deepEqual(s.secrets, secrets);
    assert.equal(s.personaHistory().total, 1);
    assert.equal(await readFile(dir + "/config.json", "utf8"), bytes);
    const t = new Store(dir);
    await t.init();
    assert.deepEqual(t.secrets, secrets);
    s.atomic = atomic;
    await s.save(before);
    assert.equal(s.publicConfig().revision, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("corrupted and secret-bearing archives fail closed; credential rotation screens oldest snapshots", async () => {
  const dir = await mkdtemp(tmpdir() + "/history-invalid-");
  try {
    const s = new Store(dir);
    await s.init();
    const c = s.publicConfig();
    await s.save({
      ...c,
      persona: { ...c.persona, markdown: "synthetic-future-secret" },
    });
    await s.save(c);
    await s.save(c);
    await s.save(c);
    await assert.rejects(
      s.save({ ...c, token: "synthetic-future-secret" }),
      /SECRET_IN_CONFIG/,
    );
    const disk = JSON.parse(await readFile(dir + "/config.json", "utf8"));
    const good = {
      ...disk,
      history: Array.from({ length: 5 }, (_, i) => {
        const { current: _current, ...entry } = s.personaRevision(i + 1);
        return entry;
      }),
    };
    for (const history of [
      null,
      [],
      [...good.history, good.history[0]],
      good.history.map((e: any, i: number) =>
        i ? e : { ...e, provider: { model: "forbidden" } },
      ),
      good.history.map((e: any, i: number) =>
        i ? e : { ...e, persona: { ...e.persona, markdown: s.secrets.admin } },
      ),
    ]) {
      await writeFile(
        dir + "/config.json",
        JSON.stringify({ ...good, history }),
      );
      await assert.rejects(new Store(dir).init());
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("invalid and unknown revision IDs cannot mutate storage", async () => {
  const dir = await mkdtemp(tmpdir() + "/history-id-");
  try {
    const s = new Store(dir);
    await s.init();
    const bytes = await readFile(dir + "/config.json", "utf8");
    for (const id of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      99,
      "1",
      null,
    ]) {
      await assert.rejects(s.restorePersona(id as number));
      assert.throws(() => s.personaRevision(id as number));
    }
    assert.equal(await readFile(dir + "/config.json", "utf8"), bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("every save survives restart; restore appends persona only", async () => {
  const dir = await mkdtemp(tmpdir() + "/persona-history-");
  try {
    const s = new Store(dir);
    await s.init();
    const a = s.publicConfig();
    await s.save({
      ...a,
      persona: { ...a.persona, name: "Synthetic A" },
      token: "synthetic-secret",
    });
    await s.save({
      ...s.publicConfig(),
      provider: { ...a.provider, model: "synthetic-model" },
      persona: { ...a.persona, name: "Synthetic B" },
    });
    const t = new Store(dir);
    await t.init();
    assert.equal(t.personaHistory().total, 3);
    const before = t.publicConfig();
    const secrets = { ...t.secrets };
    await t.restorePersona(2);
    assert.equal(t.publicConfig().revision, 4);
    assert.equal(t.publicConfig().persona.name, "Synthetic A");
    assert.deepEqual(t.publicConfig().provider, before.provider);
    assert.deepEqual(t.secrets, secrets);
    assert.equal(t.personaRevision(3).persona.name, "Synthetic B");
    assert.deepEqual(
      t.personaHistory().items.map((x) => x.revision),
      [4, 3, 2, 1],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
