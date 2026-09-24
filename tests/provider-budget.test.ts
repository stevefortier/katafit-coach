import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compactProviderImages,
  providerTextBytes,
} from "../src/runtime/piAdapter.js";

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
test("provider budget rejects an image envelope over the transport ceiling", () => {
  const large = image(
    "data:image/jpeg;base64," +
      Buffer.alloc(5 * 1024 * 1024).toString("base64"),
  );
  assert.throws(
    () => providerTextBytes(payload([large])),
    /PROVIDER_PAYLOAD_TOO_LARGE/,
  );
});

test("five prepared images fit only while the full serialized wire remains below 6 MiB", () => {
  const prepared = image(
    "data:image/jpeg;base64," + Buffer.alloc(768 * 1024).toString("base64"),
  );
  const five = payload(Array.from({ length: 5 }, () => prepared));
  assert.ok(providerTextBytes(five) < 1024 * 1024);
  assert.throws(
    () => providerTextBytes({ ...five, padding: "x".repeat(1024 * 1024) }),
    /PROVIDER_PAYLOAD_TOO_LARGE/,
  );
});

test("provider payload evicts older images without changing the transcript", () => {
  const body = {
    messages: Array.from({ length: 6 }, (_, i) => ({
      role: "user",
      content: [
        { type: "text", text: `receipt ${i}` },
        image(
          `data:image/png;base64,${Buffer.alloc(30000, i + 1).toString("base64")}`,
        ),
      ],
    })),
  };
  const before = JSON.stringify(body);
  const compacted = compactProviderImages(body) as typeof body;
  assert.equal(JSON.stringify(body), before);
  assert.equal(
    compacted.messages
      .flatMap((m) => m.content)
      .filter((p) => p.type === "image_url").length,
    5,
  );
  assert.deepEqual(
    compacted.messages
      .flatMap((m) => m.content)
      .filter((p) => p.type === "image_url")
      .map((p: any) => Buffer.from(p.image_url.url.split(",")[1], "base64")[0]),
    [2, 3, 4, 5, 6],
  );
  assert.ok(JSON.stringify(compacted).includes("receipt 0"));
  assert.ok(JSON.stringify(compacted).includes("Earlier image omitted"));
  assert.ok(providerTextBytes(compacted) < 1024 * 1024);
});

test("provider budget enforces five-image and aggregate 16 MiB caps", () => {
  assert.throws(
    () => providerTextBytes(payload(Array.from({ length: 6 }, () => image()))),
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
