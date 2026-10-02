import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { fixture } from "./helpers/native.js";
import {
  startRelay,
  loadExtension,
  piTurn,
  imageTranscript,
  imageParts,
} from "./helpers/native-relay.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";

test("ordinary REST image survives sharing change in actual Pi provider serialization; new fetch denied", async () => {
  let shared = true;
  const pixels = await sharp({
    create: { width: 20, height: 20, channels: 3, background: "blue" },
  })
    .jpeg()
    .toBuffer();
  const f = await fixture(
    (name, _result, body) => {
      if (name !== "provider") return;
      const images = imageParts(body);
      assert.equal(images.length, 1);
      return `data: ${JSON.stringify({ id: "rest", choices: [{ index: 0, delta: { content: "Synthetic retained-image response." }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "rest", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    },
    () =>
      shared
        ? { type: "image/jpeg", body: pixels }
        : { status: 403, body: '{"error":"private sharing policy"}' },
  );
  await f.store.save({
    ...f.store.publicConfig(),
    provider: { ...f.store.publicConfig().provider, vision: true },
  });
  const gateway = await openNativeGateway(f.store);
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  try {
    relay = await startRelay(gateway);
    const ext = await loadExtension(relay);
    const args = { method: "GET", path: "/api/media/activity/files/photo" };
    const result = await ext.call("katafit_rest_request", args);
    const images = result.content.filter((p: any) => p.type === "image");
    assert.equal(images.length, 1);
    const transcript = imageTranscript(images, "Inspect the acquired photo.");
    (transcript[1] as any).content = [
      {
        type: "toolCall",
        id: "call-katafit_rest_request",
        name: "katafit_rest_request",
        arguments: args,
      },
    ];
    Object.assign(transcript[2], {
      toolCallId: "call-katafit_rest_request",
      toolName: "katafit_rest_request",
      content: result.content,
    });
    // Initial provider may acquire optional memory once; continuation may not.
    await piTurn(relay, "approved-custom-model", transcript);
    shared = false;
    const before = f.calls.length;
    const response = await piTurn(relay, "approved-custom-model", transcript);
    assert.equal(response.stopReason, "stop");
    assert.match(JSON.stringify(response.content), /retained-image response/);
    // The continuation acquires no new memory recall; the previous turn's
    // delivered-reply learning may still read the account learning setting.
    assert.deepEqual(
      f.calls
        .slice(before)
        .map((c) => c.path)
        .filter((p) => !p.startsWith("/api/coach/memory/")),
      ["/v1/chat/completions"],
    );
    await assert.rejects(() => ext.call("katafit_rest_request", args), /403/);
    assert.equal(
      f.calls.filter(
        (c) => c.method === "GET" && !c.path.startsWith("/api/coach/memory"),
      ).length,
      2,
    );
    assert.ok(
      !f.calls.some(
        (c) => c.body?.params?.name === "studio_operator_authorize_context",
      ),
    );
  } finally {
    await relay?.close();
    await gateway.close();
    await f.close();
  }
});

test("ordinary member native REST does not require a chief-only MCP session", async () => {
  const f = await fixture(
    (name) =>
      name === "studio_operator_open_session"
        ? {
            isError: true,
            content: [{ type: "text", text: "OPERATOR_NOT_AUTHORIZED" }],
          }
        : undefined,
    () => ({ body: '{"ordinaryMember":true}' }),
  );
  let gateway: Awaited<ReturnType<typeof openNativeGateway>> | undefined;
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  try {
    gateway = await openNativeGateway(f.store);
    relay = await startRelay(gateway);
    const ext = await loadExtension(relay);
    const result = await ext.call("katafit_rest_request", {
      method: "GET",
      path: "/api/new-member-route",
    });
    assert.match(result.content[0].text, /ordinaryMember/);
    assert.equal(f.calls.filter((c) => c.method !== "GET").length, 0);
    await assert.rejects(() => ext.call("studio_operator_list_members", {}));
    const stillRead = await ext.call("katafit_rest_request", {
      method: "GET",
      path: "/api/new-member-route",
    });
    assert.match(stillRead.content[0].text, /ordinaryMember/);
    assert.equal(f.calls.filter((c) => c.method === "GET").length, 2);
  } finally {
    await relay?.close();
    await gateway?.close();
    await f.close();
  }
});

test("acquired REST pixels can be sent to this operator without a new permission request", async () => {
  const bytes = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "green" },
  })
    .png()
    .toBuffer();
  const f = await fixture(undefined, () => ({
    type: "image/png",
    body: bytes,
  }));
  const published: any[] = [];
  const gateway = await openNativeGateway(f.store, undefined, {
    attachments: {
      read: async () => {
        throw Error("unused");
      },
      publish: (item) => {
        published.push(item);
        return true;
      },
      connected: () => true,
    },
  });
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  try {
    relay = await startRelay(gateway);
    const ext = await loadExtension(relay);
    const result = await ext.call("katafit_rest_request", {
      method: "GET",
      path: "/api/media/a/files/b",
    });
    const receipt = JSON.parse(result.content[0].text).image_receipt;
    assert.equal(typeof receipt, "string");
    const before = f.calls.length;
    await ext.call("send_to_operator", { image_receipt: receipt });
    assert.equal(published.length, 1);
    assert.equal(f.calls.length, before);
  } finally {
    await relay?.close();
    await gateway.close();
    await f.close();
  }
});
