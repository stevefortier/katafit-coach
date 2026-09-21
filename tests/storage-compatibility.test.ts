import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";

test("credential JSON stays compatible across vision save, restart and rollback", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-storage-compatibility-");
  try {
    const store = new Store(dir);
    await store.init();
    const config = store.publicConfig();
    await store.save({
      ...config,
      provider: { ...config.provider, vision: true },
      token: "synthetic-connection-compatibility",
      apiKey: "synthetic-provider-compatibility",
    });
    const persisted = JSON.parse(await readFile(dir + "/secrets.json", "utf8"));
    assert.deepEqual(persisted, store.secrets);
    assert.deepEqual(Object.keys(persisted).sort(), [
      "admin",
      "apiKey",
      "token",
    ]);
    assert.equal((await readdir(dir)).includes("secrets.key"), false);
    const restarted = new Store(dir);
    await restarted.init();
    assert.equal(restarted.publicConfig().provider.vision, true);
    await restarted.rollback();
    assert.equal(restarted.publicConfig().provider.vision, false);
    assert.deepEqual(
      JSON.parse(await readFile(dir + "/secrets.json", "utf8")),
      persisted,
    );
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    for (const file of ["config.json", "secrets.json"])
      assert.equal((await stat(dir + "/" + file)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
