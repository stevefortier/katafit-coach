import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { fixture } from "./helpers/native.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";
import { loadExtension, startRelay } from "./helpers/native-relay.js";

// The default catalog is REST-only: image acquisition is an ordinary GET,
// not a check-in-specific MCP tool or a separate host-side image quota.
test("REST image acquisition preserves decoded pixels and never advertises legacy image tools", async () => {
  const pixels = await sharp({
    create: { width: 3, height: 2, channels: 3, background: "#224466" },
  })
    .jpeg()
    .toBuffer();
  const path = "/api/media/activity-1/files/photo-1";
  const f = await fixture(undefined, (url) =>
    url === path
      ? { type: "image/jpeg", body: pixels }
      : { status: 404, body: "private backend response" },
  );
  const gateway = await openNativeGateway(f.store);
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  try {
    relay = await startRelay(gateway);
    const ext = await loadExtension(relay);
    assert.ok(ext.tools.has("katafit_rest_request"));
    assert.equal(ext.tools.has("studio_operator_list_dojo_checkins"), false);
    assert.equal(
      ext.tools.has("studio_operator_read_dojo_checkin_image"),
      false,
    );
    const result = await ext.call("katafit_rest_request", {
      method: "GET",
      path,
    });
    const image = result.content.find((part: any) => part.type === "image");
    assert.equal(image.mimeType, "image/jpeg");
    assert.deepEqual(Buffer.from(image.data, "base64"), pixels);
    const metadata = await sharp(Buffer.from(image.data, "base64")).metadata();
    assert.deepEqual([metadata.width, metadata.height], [3, 2]);
    assert.deepEqual(
      f.calls.filter((call) => call.method === "GET").map((call) => call.path),
      [path],
    );
    assert.doesNotMatch(
      JSON.stringify(result.content[0]),
      /synthetic-backend-credential/,
    );
  } finally {
    await relay?.close();
    await gateway.close();
    await f.close();
  }
});
