import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { normalizeHostToolImages } from "../src/sandbox/toolImageNormalization.js";

// Compare the host proof input with the Pi package's actual pre-history image
// normalization. Synthetic pixels only; no production image bytes on disk.
test("host normalizes image and hint exactly as Pi does before history", async () => {
  const bytes = await sharp({
    create: {
      width: 2736,
      height: 3648,
      channels: 3,
      background: "#406080",
    },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  const original = {
    content: [
      { type: "text", text: "synthetic receipt" },
      { type: "image", mimeType: "image/jpeg", data: bytes.toString("base64") },
    ],
  };
  const piModule = new URL(
    "./utils/tool-result-images.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  );
  const { normalizeToolResultImages } = await import(piModule.href);
  const expected = await normalizeToolResultImages(original.content);
  const normalized = await normalizeHostToolImages(original);
  assert.deepEqual(normalized.content, expected);
  assert.notEqual(normalized.content[1].data, original.content[1].data);
  assert.equal(original.content[1].data, bytes.toString("base64"));
});

test("non-image results are unchanged; unsupported image formats fail closed", async () => {
  const text = { content: [{ type: "text", text: "safe" }] };
  assert.equal(await normalizeHostToolImages(text), text);
  await assert.rejects(
    normalizeHostToolImages({
      content: [{ type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" }],
    }),
    /NATIVE_IMAGE_REJECTED/,
  );
});
