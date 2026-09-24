import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { operatorBackend } from "./operator-tools.test.js";
test("old backend operator capability fails closed before inference with honest unsupported guidance", async () => {
  const f = await operatorBackend((name, result) =>
    name === "tools/list" ? { tools: [] } : result,
  );
  const dir = await mkdtemp(tmpdir() + "/operator-old-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
    apiKey: "synthetic-key",
  });
  let calls = 0;
  const app = await admin(store, 0, async () => {
    calls++;
    return "not real";
  });
  try {
    const r = await fetch(app.origin + "/api/operator/chat", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + store.secrets.admin,
        Origin: app.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: "Read member",
      }),
    });
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.text, "not real");
    assert.equal(calls, 1);
    assert.equal(
      f.calls.filter((c) => c.params?.name === "studio_operator_send_message")
        .length,
      0,
    );
  } finally {
    await app.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
