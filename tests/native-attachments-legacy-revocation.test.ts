import test from "node:test";
import assert from "node:assert/strict";
import { gatewayHarness } from "./helpers/attachments.js";

test("a changed source does not revoke bytes already sent to the live panel", async () => {
  const g = await gatewayHarness();
  try {
    g.files.set("evidence.txt", Buffer.from("acquired evidence"));
    await g.tool("send_to_operator", { workspace_path: "evidence.txt" });
    const item = g.published[0];
    g.f.state.revoked = true;
    const served = await g.gateway.readAttachment(item.id);
    assert.equal(served.bytes.equals(Buffer.from("acquired evidence")), true);
    assert.equal(g.gateway.attachments().length, 1);
    assert.deepEqual(g.terminated, []);
  } finally {
    await g.close();
  }
});

test("configuration authority change revokes a live panel attachment", async () => {
  const g = await gatewayHarness();
  try {
    g.files.set("evidence.txt", Buffer.from("acquired evidence"));
    await g.tool("send_to_operator", { workspace_path: "evidence.txt" });
    const item = g.published[0];
    await g.f.store.save({
      ...g.f.store.publicConfig(),
      persona: { ...g.f.store.publicConfig().persona, name: "Reconfigured" },
    });
    await assert.rejects(g.gateway.readAttachment(item.id), /REVOKED/);
  } finally {
    await g.close();
  }
});
