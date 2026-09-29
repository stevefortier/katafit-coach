import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { fixture } from "./helpers/native.js";
import {
  startRelay,
  loadExtension,
  piTurn,
  imageParts,
} from "./helpers/native-relay.js";
import { NativeConversations } from "../src/sandbox/conversations.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";

for (const image of [false, true])
  test(`real native REST selection and host-owned history follow-up (${image ? "pixels" : "JSON"})`, async () => {
    let shared = true;
    const pixels = await sharp({
      create: { width: 200, height: 180, channels: 3, background: "blue" },
    })
      .jpeg()
      .toBuffer();
    const path = image
      ? "/api/media/activity/files/photo"
      : "/api/new-uncatalogued-route";
    const frames: any[] = [];
    const f = await fixture(
      (name, _value, body) => {
        if (name !== "provider") return;
        const read = body.messages.some((m: any) => m.role === "tool");
        if (read && image) assert.equal(imageParts(body).length, 1);
        const delta = read
          ? { content: "Synthetic result based on the acquired REST response." }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: "call-katafit_rest_request",
                  type: "function",
                  function: {
                    name: "katafit_rest_request",
                    arguments: JSON.stringify({ method: "GET", path }),
                  },
                },
              ],
            };
        return `data: ${JSON.stringify({ id: "rest", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "rest", choices: [{ index: 0, delta: {}, finish_reason: read ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
      },
      () =>
        shared
          ? image
            ? { type: "image/jpeg", body: pixels }
            : { body: '{"acquired":"synthetic-data"}' }
          : { status: 403, body: '{"private":"denied"}' },
    );
    await f.store.save({
      ...f.store.publicConfig(),
      provider: { ...f.store.publicConfig().provider, vision: true },
    });
    const history = new NativeConversations(f.store);
    let gateway: Awaited<ReturnType<typeof openNativeGateway>> | undefined;
    let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
    try {
      gateway = await openNativeGateway(f.store, undefined, {
        onBeforeDispatch: () => history.flush(),
        onExchange: async (capture) => {
          frames.push(capture);
          await history.capture(gateway!, capture);
        },
      });
      await history.bind(gateway, await history.prepare());
      relay = await startRelay(gateway);
      const ext = await loadExtension(relay);
      const messages: any[] = [
        {
          role: "user",
          content: "Read the requested ordinary data.",
          timestamp: Date.now(),
        },
      ];
      const selected = await piTurn(relay, "approved-custom-model", messages);
      assert.equal(selected.stopReason, "toolUse");
      messages.push(selected);
      const result = await ext.call("katafit_rest_request", {
        method: "GET",
        path,
      });
      const { normalizeToolResultImages } = await import(
        new URL(
          "./utils/tool-result-images.js",
          import.meta.resolve("@earendil-works/pi-coding-agent"),
        ).href
      );
      messages.push({
        role: "toolResult",
        toolCallId: "call-katafit_rest_request",
        toolName: "katafit_rest_request",
        content: await normalizeToolResultImages(result.content),
        isError: false,
        timestamp: Date.now(),
      });
      shared = false;
      const before = f.calls.length;
      const answer = await piTurn(relay, "approved-custom-model", messages);
      assert.equal(answer.stopReason, "stop", JSON.stringify(answer));
      assert.deepEqual(
        f.calls.slice(before).map((c) => c.path),
        ["/v1/chat/completions"],
      );
      assert.ok(frames.length >= 2);
      const id = history.active!.id;
      await history.finish(gateway);
      await relay.close();
      relay = undefined;
      await gateway.close();
      gateway = undefined;
      const reopened = new NativeConversations(f.store);
      const beforeRead = f.calls.length;
      const view = await reopened.read(id);
      assert.equal(view.status, "authorized");
      assert.ok(
        JSON.stringify(view.entries).includes("Synthetic result based"),
      );
      if (!image) {
        const prepared = await reopened.prepare();
        assert.ok(prepared.seed?.length);
        assert.equal(prepared.resume, undefined);
        gateway = await openNativeGateway(f.store, undefined, {
          seed: prepared.seed,
          onBeforeDispatch: () => reopened.flush(),
          onExchange: (capture) => reopened.capture(gateway!, capture),
        });
        await reopened.bind(gateway, prepared);
        relay = await startRelay(gateway);
        const resumedMessages = prepared
          .seed!.filter((entry: any) => entry.type === "message")
          .map((entry: any) => entry.message);
        resumedMessages.push({
          role: "user",
          content: "Use the already acquired data again.",
          timestamp: Date.now(),
        });
        const continued = await piTurn(
          relay,
          "approved-custom-model",
          resumedMessages,
        );
        assert.equal(continued.stopReason, "stop", JSON.stringify(continued));
        await reopened.finish(gateway);
      } else assert.equal(view.reason, "images_not_retained");
      assert.equal(f.calls.length, beforeRead + (image ? 0 : 1));
      assert.ok(
        !f.calls.some(
          (c) => c.body?.params?.name === "studio_operator_authorize_context",
        ),
      );
    } finally {
      await relay?.close();
      await gateway?.close();
      await f.close();
    }
  });
