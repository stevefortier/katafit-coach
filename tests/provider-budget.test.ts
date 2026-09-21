import { test } from "node:test";
import assert from "node:assert/strict";
import { providerTextBytes } from "../src/runtime/piAdapter.js";

const data = Buffer.alloc(30000, 1).toString("base64");
const image = (url = `data:image/png;base64,${data}`) => ({
  type: "image_url",
  image_url: { url },
});
const payload = (parts: unknown[]) => ({
  messages: [{ role: "user", content: parts }],
});

test("provider budget exempts only actual image data without mutating the payload", () => {
  const body = payload([image()]);
  const before = JSON.stringify(body);
  assert.equal(
    providerTextBytes(body),
    Buffer.byteLength(before) - data.length,
  );
  assert.equal(JSON.stringify(body), before);
  assert.ok(providerTextBytes(body) < 28000);
});
for (const [name, body] of Object.entries({
  "part extras": payload([{ ...image(), padding: "x".repeat(28001) }]),
  "URL metadata": payload([
    {
      type: "image_url",
      image_url: { ...image().image_url, detail: "x".repeat(28001) },
    },
  ]),
  "nested mimic": payload([{ type: "text", nested: image() }]),
  "schema mimic": { tools: [{ default: image() }] },
  "text string": payload([{ type: "text", text: JSON.stringify(image()) }]),
  "image extra nested mimic": payload([{ ...image(), nested: image() }]),
})) {
  test(`provider budget counts oversized ${name}`, () => {
    assert.ok(providerTextBytes(body) > 28000);
  });
}
for (const url of [
  "https://example.test/" + "x".repeat(30000),
  "data:image/svg+xml;base64,AAAA",
  "data:image/png;base64,???",
  "data:image/png;base64,AB==",
  "data:image/png;base64,",
  "data:image/png;base64," +
    Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64"),
]) {
  test(`provider budget rejects invalid or oversized image URL (${url.length} chars)`, () => {
    assert.throws(
      () => providerTextBytes(payload([image(url)])),
      /MEDIA_REJECTED/,
    );
  });
}
test("provider budget enforces four-image and aggregate 16 MiB caps", () => {
  assert.throws(
    () => providerTextBytes(payload(Array.from({ length: 5 }, () => image()))),
    /MEDIA_REJECTED/,
  );
  const large = image(
    "data:image/jpeg;base64," +
      Buffer.alloc(6 * 1024 * 1024).toString("base64"),
  );
  assert.throws(
    () => providerTextBytes(payload([large, large, large])),
    /MEDIA_REJECTED/,
  );
});
