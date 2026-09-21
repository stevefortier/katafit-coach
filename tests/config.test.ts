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
