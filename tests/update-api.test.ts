import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { Updates } from "../src/update/updates.js";
test("HTTP acceptance waits for durable journal barrier", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-accept-");
  const store = new Store(dir);
  await store.init();
  let release!: () => void,
    executed = false,
    responded = false;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const updates = new Updates(
    null,
    async () => {
      executed = true;
    },
    undefined,
    async (op) => {
      if (op.state === "applying") await gate;
    },
  );
  updates.latest = "a".repeat(40);
  updates.checkedAt = Date.now();
  const app = await admin(store, 0, undefined, undefined, updates);
  const request = fetch(app.origin + "/api/update/apply", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + store.secrets.admin,
      Origin: app.origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sha: updates.latest, confirm: true }),
  }).then((r) => {
    responded = true;
    return r;
  });
  try {
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(responded, false);
    assert.equal(executed, false);
    release();
    assert.equal((await request).status, 202);
  } finally {
    release();
    await request;
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("authenticated updater requires explicit pinned confirmation; asynchronous apply fences all mutations", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-update-api-");
  const store = new Store(dir);
  await store.init();
  let finish!: () => void;
  const sha = "e".repeat(40);
  const updates = new Updates(
    null,
    async () =>
      new Promise<void>((r) => {
        finish = r;
      }),
    async () => new Response(JSON.stringify({ object: { sha } })),
  );
  const app = await admin(store, 0, undefined, () => {}, updates);
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  const post = (path: string, body: unknown = {}) =>
    fetch(app.origin + "/api/" + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await fetch(app.origin + "/api/update")).status, 401);
    assert.equal(
      (
        await fetch(app.origin + "/api/update/apply", {
          method: "POST",
          headers: { ...headers, Origin: "https://evil.example" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal((await post("update/check")).status, 200);
    assert.equal((await post("update/apply", { sha })).status, 400);
    assert.equal(
      (
        await post("update/apply", {
          sha,
          confirm: true,
          url: "https://evil.example",
        })
      ).status,
      400,
    );
    assert.equal(
      (await post("update/apply", { sha, confirm: true })).status,
      202,
    );
    for (const path of [
      "run",
      "config",
      "rollback",
      "preview",
      "shutdown",
      "update/apply",
    ])
      assert.equal((await post(path)).status, 409, path);
    const s = await (
      await fetch(app.origin + "/api/update", { headers })
    ).json();
    assert.equal(s.applying, true);
    finish();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(
      (await (await fetch(app.origin + "/api/update", { headers })).json())
        .installed,
      sha,
    );
  } finally {
    finish?.();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
