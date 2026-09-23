import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store, compile } from "../src/config/store.js";
test("save canonical persona revisions without exporting secrets, rollback and private modes", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-");
  try {
    const s = new Store(dir);
    await s.init();
    const c = s.publicConfig();
    await s.save({
      ...c,
      persona: { ...c.persona, name: "Ada" },
      token: "private-token",
      apiKey: "private-key",
    });
    assert.equal(s.publicConfig().revision, 2);
    assert.ok(!JSON.stringify(s.publicConfig()).includes("private-"));
    assert.ok(compile(s.publicConfig()).includes("Ada"));
    assert.match(compile(s.publicConfig()), /Local MCP runtime is disabled/);
    assert.ok(compile(s.publicConfig()).includes("owner"));
    assert.equal((await stat(dir + "/secrets.json")).mode & 0o777, 0o600);
    await s.rollback();
    assert.equal(s.publicConfig().persona.name, "Coach");
    assert.equal(s.publicConfig().revision, 3);
    assert.equal(s.secrets.token, "private-token");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("opening status storage never overwrites newer saved configuration", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-read-");
  try {
    const first = new Store(dir);
    await first.init();
    const second = new Store(dir);
    await second.init();
    const c = first.publicConfig();
    await first.save({ ...c, persona: { ...c.persona, name: "New revision" } });
    await second.init();
    assert.equal(second.publicConfig().persona.name, "New revision");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("rejects copying known secrets into exportable persona configuration", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-secret-");
  try {
    const s = new Store(dir);
    await s.init();
    await s.save({ ...s.publicConfig(), apiKey: "hidden-provider-secret" });
    const c = s.publicConfig();
    await assert.rejects(
      s.save({
        ...c,
        persona: { ...c.persona, markdown: "hidden-provider-secret" },
      }),
      /SECRET_IN_CONFIG/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const key of ["apiKey", "token"] as const) {
  test(`credential rotation rejects a secret in a retained persona (${key})`, async () => {
    const dir = await mkdtemp(tmpdir() + "/coach-rotation-");
    try {
      const s = new Store(dir);
      await s.init();
      const c = s.publicConfig();
      await s.save({
        ...c,
        [key]: "synthetic-old-credential",
        persona: { ...c.persona, markdown: "synthetic-future-credential" },
      });
      const before = s.publicConfig();
      await assert.rejects(
        s.save({
          ...before,
          [key]: "synthetic-future-credential",
          persona: { ...before.persona, markdown: "clean" },
        }),
        /SECRET_IN_CONFIG/,
      );
      assert.deepEqual(s.publicConfig(), before);
      assert.equal(s.secrets[key], "synthetic-old-credential");
      // Even the older retained revision is checked before credential replacement.
      await s.save({
        ...before,
        persona: { ...before.persona, markdown: "clean" },
      });
      await assert.rejects(
        s.save({ ...s.publicConfig(), [key]: "synthetic-future-credential" }),
        /SECRET_IN_CONFIG/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

for (const key of ["apiKey", "token"] as const) {
  test(`rechecks export, compilation, restore and loaded revisions against ${key}`, async () => {
    const dir = await mkdtemp(tmpdir() + "/coach-boundaries-");
    try {
      const s = new Store(dir);
      await s.init();
      const c = s.publicConfig();
      await s.save({
        ...c,
        persona: { ...c.persona, markdown: "synthetic-lifecycle-secret" },
      });
      s.secrets[key] = "synthetic-lifecycle-secret";
      assert.throws(() => s.publicConfig(), /SECRET_IN_CONFIG/);
      assert.throws(
        () =>
          compile(
            { ...c, persona: { ...c.persona, markdown: s.secrets[key] } },
            Object.values(s.secrets),
          ),
        /SECRET_IN_CONFIG/,
      );
      s.secrets[key] = "";
      await s.save(c);
      s.secrets[key] = "synthetic-lifecycle-secret";
      const before = s.publicConfig();
      await assert.rejects(s.rollback(), /SECRET_IN_CONFIG/);
      assert.deepEqual(s.publicConfig(), before);
      // Reproduce a pre-fix disk state with safe current but unsafe previous.
      await s.atomic("secrets", s.secrets);
      await assert.rejects(new Store(dir).init(), /SECRET_IN_CONFIG/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("escaped credential characters cannot bypass export and prompt checks", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-escaped-");
  try {
    const s = new Store(dir);
    await s.init();
    const c = s.publicConfig();
    const secret = 'synthetic-"quoted"-credential';
    await assert.rejects(
      s.save({
        ...c,
        apiKey: secret,
        persona: { ...c.persona, markdown: secret },
      }),
      /SECRET_IN_CONFIG/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loading an existing store does not rewrite its files", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-load-");
  try {
    const s = new Store(dir);
    await s.init();
    const before = await stat(dir + "/config.json");
    await new Store(dir).init();
    assert.equal((await stat(dir + "/config.json")).ino, before.ino);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
