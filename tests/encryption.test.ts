import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
test("credentials encrypted at rest with protected key, legacy migration and authenticated failure", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-encryption-");
  try {
    const s = new Store(dir);
    await s.init();
    await s.save({
      ...s.publicConfig(),
      token: "synthetic-private-connection",
      apiKey: "synthetic-private-provider",
    });
    const raw = await readFile(dir + "/secrets.json", "utf8");
    assert.equal(raw.includes("synthetic-private"), false);
    assert.equal((await stat(dir + "/secrets.key")).mode & 0o777, 0o600);
    const next = new Store(dir);
    await next.init();
    assert.equal(next.secrets.token, s.secrets.token);
    await next.rollback();
    assert.equal(next.secrets.apiKey, s.secrets.apiKey);
    await writeFile(dir + "/secrets.json", JSON.stringify(s.secrets));
    const legacy = new Store(dir);
    await legacy.init();
    assert.equal(legacy.secrets.token, s.secrets.token);
    assert.equal(
      (await readFile(dir + "/secrets.json", "utf8")).includes(
        "synthetic-private",
      ),
      false,
    );
    const envelope = JSON.parse(await readFile(dir + "/secrets.json", "utf8"));
    envelope.tag = "AAAAAAAAAAAAAAAAAAAAAA==";
    await writeFile(dir + "/secrets.json", JSON.stringify(envelope));
    await assert.rejects(new Store(dir).init(), /SECRET_STORAGE_REJECTED/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
