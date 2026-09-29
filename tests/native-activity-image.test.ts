import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { fixture } from "./helpers/native.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";

const path = "/api/media/activity-1/files/activity-media-1";
const request = {
  kind: "tool",
  name: "katafit_rest_request",
  args: { method: "GET", path },
};

test("legacy activity image catalog is absent; ordinary REST supplies validated pixels and a live panel receipt", async () => {
  const pixels = await sharp({
    create: { width: 3, height: 2, channels: 3, background: "#123456" },
  })
    .png()
    .toBuffer();
  let shared = true;
  const f = await fixture(undefined, (url) =>
    url === path && shared
      ? { type: "image/png", body: pixels }
      : { status: 403, body: '{"error":"private"}' },
  );
  const published: any[] = [];
  const gateway = await openNativeGateway(f.store, undefined, {
    attachments: {
      read: async () => {
        throw new Error("unused");
      },
      publish: (item) => {
        published.push(item);
        return true;
      },
      connected: () => true,
    },
  });
  try {
    const catalog = await gateway.handle({ kind: "catalog" });
    assert.equal(
      catalog.tools.some(
        (tool: any) => tool.name === "studio_operator_read_activity_image",
      ),
      false,
    );
    assert.ok(
      catalog.tools.some((tool: any) => tool.name === "katafit_rest_request"),
    );
    assert.ok(
      catalog.tools.some((tool: any) => tool.name === "send_to_operator"),
    );
    const result = await gateway.handle(request);
    assert.equal(result.content[1].type, "image");
    assert.equal(
      Buffer.from(result.content[1].data, "base64").equals(pixels),
      true,
    );
    const receipt = JSON.parse(result.content[0].text).image_receipt;
    assert.match(receipt, /^ir_[0-9a-f]{32}$/);
    shared = false;
    const before = f.calls.length;
    const sent = JSON.parse(
      (
        await gateway.handle({
          kind: "tool",
          name: "send_to_operator",
          args: { image_receipt: receipt },
        })
      ).content[0].text,
    );
    assert.equal(sent.status, "accepted_to_operator_panel");
    assert.equal(f.calls.length, before, "panel send never refetches source");
    assert.equal(published.length, 1);
    assert.equal(published[0].source, "image_receipt");
    assert.equal(
      (await gateway.readAttachment(sent.attachment_id)).bytes.equals(pixels),
      true,
    );
    assert.deepEqual(await gateway.handle(request), {
      restReadError: { status: 403 },
    });
    assert.equal(
      (await gateway.readAttachment(sent.attachment_id)).bytes.equals(pixels),
      true,
    );
    assert.equal(f.calls.filter((call) => call.method === "GET").length, 2);
  } finally {
    await gateway.close();
    await f.close();
  }
});

test("REST image denial does not mint a receipt or publish an attachment", async () => {
  const f = await fixture(undefined, () => ({
    status: 403,
    body: '{"error":"private"}',
  }));
  const published: any[] = [];
  const gateway = await openNativeGateway(f.store, undefined, {
    attachments: {
      read: async () => Buffer.alloc(0),
      publish: (item) => {
        published.push(item);
        return true;
      },
    },
  });
  try {
    assert.deepEqual(await gateway.handle(request), {
      restReadError: { status: 403 },
    });
    assert.deepEqual(gateway.attachments(), []);
    assert.deepEqual(published, []);
    assert.deepEqual(
      await gateway.handle({
        kind: "tool",
        name: "send_to_operator",
        args: { image_receipt: "ir_" + "a".repeat(32) },
      }),
      { attachmentError: { code: "ATTACHMENT_RECEIPT_UNKNOWN" } },
    );
  } finally {
    await gateway.close();
    await f.close();
  }
});
