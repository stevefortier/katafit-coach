import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

test("authenticated export, rollback and preview fail closed for legacy credential collisions", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-api-secrets-");
  const store = new Store(dir);
  await store.init();
  let inferenceCalls = 0;
  const app = await admin(store, 0, async () => {
    inferenceCalls++;
    return "must not run";
  });
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  try {
    for (const key of ["token", "apiKey"] as const) {
      const clean = store.publicConfig();
      const secret = "synthetic-api-collision";
      await store.save({
        ...clean,
        persona: { ...clean.persona, markdown: secret },
      });
      store.secrets[key] = secret; // simulate an unsafe pre-fix loaded state
      for (const path of ["/api/config", "/api/preview"]) {
        const response = await fetch(app.origin + path, {
          headers,
          ...(path.endsWith("preview")
            ? { method: "POST", body: JSON.stringify({ text: "Question" }) }
            : {}),
        });
        assert.equal(response.status, 400);
        assert.equal((await response.text()).includes(secret), false);
      }
      store.secrets[key] = "";
      await store.save(clean);
      store.secrets[key] = secret;
      const rollback = await fetch(app.origin + "/api/rollback", {
        method: "POST",
        headers,
        body: "{}",
      });
      assert.equal(rollback.status, 400);
      assert.equal((await rollback.text()).includes(secret), false);
      assert.equal(
        store.publicConfig().persona.markdown,
        clean.persona.markdown,
      );
      store.secrets[key] = "";
    }
    assert.equal(inferenceCalls, 0);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("unavailable backend instructions cannot be labeled an exact preview or invoke inference", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-unavailable-");
  const store = new Store(dir);
  await store.init();
  const backend = createServer((_req, res) => res.writeHead(503).end());
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(backend.address() as any).port}`,
  });
  let calls = 0;
  const app = await admin(store, 0, async () => {
    calls++;
    return "must not run";
  });
  try {
    const response = await fetch(app.origin + "/api/preview", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + store.secrets.admin,
        Origin: app.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "Question" }),
    });
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.equal(result.error, "BACKEND_INSTRUCTIONS_UNAVAILABLE");
    assert.equal(result.prompt, undefined);
    assert.equal(calls, 0);
    const status = await (
      await fetch(app.origin + "/api/status", {
        headers: { Authorization: "Bearer " + store.secrets.admin },
      })
    ).json();
    assert.equal(status.preview, false);
  } finally {
    await app.close();
    backend.closeAllConnections();
    await new Promise((r) => backend.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
