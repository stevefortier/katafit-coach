import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
test("vision defaults off, validates opt-in, persists and rolls back", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-vision-");
  try {
    const s = new Store(dir);
    await s.init();
    const c = s.publicConfig();
    assert.equal(c.provider.vision, false);
    await s.save({ ...c, provider: { ...c.provider, vision: true } });
    const loaded = new Store(dir);
    await loaded.init();
    assert.equal(loaded.publicConfig().provider.vision, true);
    await loaded.rollback();
    assert.equal(loaded.publicConfig().provider.vision, false);
    await assert.rejects(
      loaded.save({ ...c, provider: { ...c.provider, vision: "true" } }),
      /INVALID_CONFIG/,
    );
    const legacy = structuredClone(c);
    delete legacy.provider.vision;
    await writeFile(dir + "/config.json", JSON.stringify({ current: legacy }));
    const migrated = new Store(dir);
    await migrated.init();
    assert.equal(migrated.publicConfig().provider.vision, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
