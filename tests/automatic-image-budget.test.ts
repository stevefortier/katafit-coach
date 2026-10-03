import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { prepareModelImage } from "../src/katafit/providerImage.js";

test("transient model images are at most 1 MP even when compressed bytes are tiny", async () => {
  for (const [width, height] of [
    [1600, 1200],
    [1600, 1600],
  ]) {
    const data = await sharp({
      create: { width, height, channels: 3, background: "red" },
    })
      .jpeg()
      .toBuffer();
    assert.ok(data.length < 512 * 1024);
    const prepared = await prepareModelImage(data, "image/jpeg");
    const metadata = await sharp(prepared.data).metadata();
    assert.ok(metadata.width! * metadata.height! <= 1000000);
    const original = await sharp(data).metadata();
    assert.equal(original.width, width, "original bytes remain unchanged");
  }
});

test("already bounded originals are validated and reused unchanged", async () => {
  const data = await sharp({
    create: { width: 200, height: 100, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const prepared = await prepareModelImage(data, "image/png");
  assert.deepEqual(prepared.data, data);
  assert.equal(prepared.mimeType, "image/png");
});
