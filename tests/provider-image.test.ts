import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { prepareModelImage } from "../src/katafit/providerImage.js";
import { Client } from "../src/katafit/client.js";
import { discoverReads } from "../src/katafit/readTools.js";
import { providerTextBytes } from "../src/runtime/piAdapter.js";
import { wire, fence, schema } from "./data-fixtures.js";

const LARGE_IMAGE_LIMIT = 768 * 1024;

test("large authorized photos become bounded transient model images", async () => {
  const width = 1800;
  const height = 1400;
  const pixels = Buffer.alloc(width * height * 3);
  let seed = 17;
  for (let i = 0; i < pixels.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    pixels[i] = seed >>> 24;
  }
  const original = await sharp(pixels, {
    raw: { width, height, channels: 3 },
  })
    .jpeg({ quality: 97 })
    .toBuffer();
  assert.ok(original.length > LARGE_IMAGE_LIMIT);
  const image = await prepareModelImage(original, "image/jpeg");
  assert.equal(image.mimeType, "image/jpeg");
  assert.ok(image.data.length <= LARGE_IMAGE_LIMIT);
  const info = await sharp(image.data).metadata();
  assert.ok(info.width! <= 1280 && info.height! <= 1280);
  assert.ok(
    Buffer.byteLength(
      JSON.stringify({
        messages: [
          {
            role: "user",
            content: Array.from({ length: 4 }, () => ({
              type: "image_url",
              image_url: {
                url: `data:${image.mimeType};base64,${image.data.toString("base64")}`,
              },
            })),
          },
        ],
      }),
    ) <
      5 * 1024 * 1024,
  );
});

test("small supported images keep original bytes and type", async () => {
  const original = await sharp({
    create: { width: 80, height: 80, channels: 4, background: "white" },
  })
    .png()
    .toBuffer();
  const image = await prepareModelImage(original, "image/png");
  assert.equal(image.mimeType, "image/png");
  assert.deepEqual(image.data, original);
});

test("small images are decoded and MIME-checked before reuse", async () => {
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  await assert.rejects(prepareModelImage(png, "image/jpeg"), /MEDIA_REJECTED/);
  await assert.rejects(
    prepareModelImage(Buffer.from("not an image"), "image/png"),
    /MEDIA_REJECTED/,
  );
  const truncated = await sharp({
    create: { width: 64, height: 64, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  assert.equal(
    (await sharp(truncated.subarray(0, truncated.length - 20)).metadata())
      .width,
    64,
  );
  await assert.rejects(
    prepareModelImage(
      truncated.subarray(0, truncated.length - 20),
      "image/png",
    ),
    /MEDIA_REJECTED/,
  );
  const bomb = await sharp({
    create: { width: 6400, height: 6400, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  assert.ok(bomb.length < 512 * 1024);
  await assert.rejects(prepareModelImage(bomb, "image/png"), /MEDIA_REJECTED/);
});

test("animated images are rejected rather than silently assessing one frame", async () => {
  const frames = Buffer.from(
    "R0lGODlhAgACAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgACAAAIBgABCAQQEAAh+QQBCgABACwAAAAAAgACAIEAAP8AAAAAAAAAAAAIBgABCAQQEAA7",
    "base64",
  );
  await assert.rejects(
    prepareModelImage(frames, "image/gif"),
    /MEDIA_REJECTED/,
  );
});

test("authorized media read sends bounded image parts to Pi", async () => {
  const width = 1800;
  const pixels = Buffer.alloc(width * width * 3);
  let seed = 13;
  for (let i = 0; i < pixels.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    pixels[i] = seed >>> 24;
  }
  const original = await sharp(pixels, {
    raw: { width, height: width, channels: 3 },
  })
    .jpeg({ quality: 97 })
    .toBuffer();
  assert.ok(original.length > LARGE_IMAGE_LIMIT);
  const ref = "opaque-authorized-media-reference";
  const f = await wire((method, params) => {
    if (method === "tools/list")
      return {
        tools: [
          { name: "coach_get_capabilities", inputSchema: schema },
          { name: "coach_list_activities", inputSchema: schema },
          {
            name: "coach_read_media",
            inputSchema: {
              ...schema,
              properties: {
                ...schema.properties,
                media_ref: { type: "string" },
              },
            },
          },
        ],
      };
    if (params.name === "coach_get_capabilities")
      return {
        structuredContent: {
          contract_version: 2,
          allowed_tools: ["coach_list_activities", "coach_read_media"],
          domains: {},
          limits: {},
        },
      };
    if (params.name === "coach_list_activities")
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ items: [{ media_ref: ref }] }),
          },
        ],
      };
    if (params.name === "coach_read_media") {
      assert.equal(params.arguments.media_ref, ref);
      return {
        content: [
          {
            type: "image",
            mimeType: "image/jpeg",
            data: original.toString("base64"),
          },
        ],
      };
    }
    throw new Error("unexpected tool");
  });
  const signal = AbortSignal.timeout(10000);
  try {
    const reads = await discoverReads(
      new Client(f.origin, "synthetic-token", signal),
      fence,
      { vision: true, secrets: ["synthetic-token"] },
    );
    const list = reads.tools.find((t) => t.name === "coach_list_activities")!;
    const media = reads.tools.find((t) => t.name === "coach_read_media")!;
    const listResult = await list.execute("list", {}, signal);
    const handle = JSON.parse((listResult.content[0] as any).text).items[0]
      .media_ref;
    const result = await media.execute("image", { media_ref: handle }, signal);
    const image = result.content.find((c) => c.type === "image") as any;
    assert.equal(image.mimeType, "image/jpeg");
    assert.ok(Buffer.from(image.data, "base64").length <= LARGE_IMAGE_LIMIT);
    assert.ok(
      (await sharp(Buffer.from(image.data, "base64")).metadata()).width! <=
        1280,
    );
    const fourImageEnvelope = {
      messages: [
        {
          role: "user",
          content: Array.from({ length: 4 }, () => ({
            type: "image_url",
            image_url: { url: `data:${image.mimeType};base64,${image.data}` },
          })),
        },
      ],
    };
    assert.ok(
      Buffer.byteLength(JSON.stringify(fourImageEnvelope)) < 6 * 1024 * 1024,
    );
    assert.ok(providerTextBytes(fourImageEnvelope) < 1024 * 1024);
    reads.dispose();
  } finally {
    await f.close();
  }
});
