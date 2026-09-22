import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { operatorBackend } from "./operator-tools.test.js";

test("member reply is discarded when authority changes during inference", async () => {
  let revoked = false;
  const backend = await operatorBackend((name, result) =>
    name === "studio_operator_read_member_coach_feed" && revoked
      ? {
          schema_version: 1,
          member_ref: "member-fixture",
          items: [],
          has_more: false,
        }
      : result,
  );
  const dir = await mkdtemp(tmpdir() + "/operator-revoke-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: backend.origin,
    token: "synthetic-token",
    apiKey: "synthetic-key",
  });
  const app = await admin(store, 0, async (_p, _s, _c, _signal, tools = []) => {
    await tools[0].execute("read", {});
    revoked = true;
    return "PRIVATE_MEMBER stale";
  });
  try {
    const res = await fetch(app.origin + "/api/operator/chat", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + store.secrets.admin,
        Origin: app.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: "Read selected member",
        member_ref: "member-fixture",
      }),
    });
    assert.equal(res.status, 400);
    assert.doesNotMatch(await res.text(), /PRIVATE_MEMBER/);
  } finally {
    await app.close();
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  }
});
