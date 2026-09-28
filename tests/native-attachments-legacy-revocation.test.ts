import test from "node:test";
import assert from "node:assert/strict";
import { gatewayHarness as open } from "./helpers/attachments.js";
import { answer, IMAGE } from "./helpers/continuity.js";

test("legacy source closure after acquisition cannot revoke retained attachment", async () => {
  const g = await open({
    continuity: false,
    provider: () => answer("synthetic final answer"),
  });
  try {
    const receipt = await g.receipt();
    await g.tool("send_to_operator", { image_receipt: receipt });
    const item = g.published[0];
    const imageReads = g.f.named(IMAGE).length;
    g.f.state.status = "closed";
    await g.gateway.handle({
      kind: "provider",
      body: { model: "approved-custom-model", messages: [] },
    });
    assert.equal((await g.gateway.readAttachment(item.id)).item.id, item.id);
    assert.equal(g.f.named(IMAGE).length, imageReads);
    assert.deepEqual(g.terminated, []);
    assert.equal(g.gateway.attachments().length, 1);
  } finally {
    await g.close();
  }
});

test("legacy new source read after closure is denied without erasing already acquired bytes", async () => {
  const g = await open({ continuity: false });
  try {
    await g.tool("send_to_operator", { image_receipt: await g.receipt() });
    const item = g.published[0];
    g.f.state.status = "closed";
    const fresh = await g.tool(IMAGE, {
      member_ref: "fixture-member",
      media_ref: "media-1",
    });
    assert.equal(fresh.imageReadError?.code, "IMAGE_BACKEND_FAILED");
    assert.equal((await g.gateway.readAttachment(item.id)).item.id, item.id);
    assert.deepEqual(g.terminated, []);
  } finally {
    await g.close();
  }
});

test("explicit session revocation observed on a new read erases acquired attachments", async () => {
  const g = await open({ revocationMarker: true });
  try {
    await g.tool("send_to_operator", { image_receipt: await g.receipt() });
    const item = g.published[0];
    g.f.state.revoked = true;
    await assert.rejects(
      g.tool(IMAGE, { member_ref: "fixture-member", media_ref: "media-1" }),
      /CONTINUITY_REVOKED/,
    );
    assert.equal(g.gateway.attachments().length, 0);
    assert.equal(g.terminated.length, 1);
    await assert.rejects(g.gateway.readAttachment(item.id));
  } finally {
    await g.close();
  }
});
