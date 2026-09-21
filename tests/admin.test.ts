import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
test("loopback admin requires bearer, exact origin, hides secrets, previews and controls worker", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-admin-");
  const store = new Store(dir);
  await store.init();
  const app = await admin(store, 0, async () => "Synthetic preview");
  const origin = app.origin;
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: origin,
    "Content-Type": "application/json",
  };
  try {
    assert.equal((await fetch(origin + "/api/config")).status, 401);
    assert.equal(
      (
        await fetch(origin + "/api/config", {
          headers: { ...headers, Origin: "https://attacker.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(origin + "/api/config", { headers })).status,
      200,
    );
    assert.equal(
      (
        await fetch(origin + "/api/config", {
          method: "POST",
          headers,
          body: JSON.stringify({
            ...store.publicConfig(),
            apiKey: "private-key",
            token: "private-token",
          }),
        })
      ).status,
      200,
    );
    const config = await (
      await fetch(origin + "/api/config", { headers })
    ).text();
    assert.ok(!config.includes("private-"));
    const preview = await (
      await fetch(origin + "/api/preview", {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "How should I recover?" }),
      })
    ).json();
    assert.equal(preview.text, "Synthetic preview");
    assert.ok(preview.prompt.includes("owner"));
    assert.equal(
      (
        await fetch(origin + "/api/stop", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      200,
    );
    assert.ok((await (await fetch(origin)).text()).includes("Kata.fit"));
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
