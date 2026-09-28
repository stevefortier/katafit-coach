import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { fixture } from "./helpers/native.js";
import { startRelay, loadExtension } from "./helpers/native-relay.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";
import { restGet } from "../src/katafit/restGet.js";

test("REST refuses plaintext non-loopback origins before dispatch", async () => {
  for (const origin of [
    "http://example.com",
    "http://192.0.2.8",
    "http://[2001:db8::1]",
  ])
    await assert.rejects(
      () =>
        restGet(
          origin,
          "synthetic-user-bound-bearer",
          { path: "/api/newly-added-route" },
          new AbortController().signal,
          [],
        ),
      /REST_UNAVAILABLE/,
    );
});

test("real native relay and extension GET ordinary social, JPEG and unregistered future route", async () => {
  const jpeg = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "red" },
  })
    .jpeg()
    .toBuffer();
  const responses: Record<string, { type: string; body: string | Buffer }> = {
    "/api/friends/activity/act-1": {
      type: "application/json",
      body: '{"activity":"social-detail"}',
    },
    "/api/media/act-1/files/file-1": { type: "image/jpeg", body: jpeg },
    "/api/newly-added-route?limit=2": {
      type: "application/json",
      body: '{"future":true}',
    },
  };
  const f = await fixture(
    undefined,
    (url) =>
      responses[url] ?? {
        status: 404,
        type: "application/json",
        body: "not found",
      },
  );
  f.store.secrets.restToken = "synthetic-user-bound-bearer";
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  const gateway = await openNativeGateway(f.store);
  try {
    relay = await startRelay(gateway);
    const ext = await loadExtension(relay);
    assert.ok(ext.tools.has("katafit_rest_get"));
    for (const [path, expected] of Object.entries(responses)) {
      const result = await ext.call("katafit_rest_get", { path });
      assert.equal(result.isError, undefined);
      if (expected.type === "image/jpeg") {
        assert.equal(
          result.content.find((p: any) => p.type === "image")?.mimeType,
          "image/jpeg",
        );
        assert.deepEqual(
          Buffer.from(
            result.content.find((p: any) => p.type === "image")?.data,
            "base64",
          ),
          jpeg,
        );
      } else
        assert.match(
          result.content[0].text,
          new RegExp(path.includes("newly") ? "future" : "social-detail"),
        );
    }
    const gets = f.calls.filter((c) => c.method === "GET");
    assert.deepEqual(
      gets.map((c) => c.path),
      Object.keys(responses),
    );
    assert.ok(
      gets.every((c) => c.auth === "Bearer synthetic-user-bound-bearer"),
    );
    assert.ok(gets.every((c) => !c.headers.cookie && !c.headers["x-custom"]));
    assert.ok(relay.frames.toHost > 0 && relay.frames.toRelay > 0);
  } finally {
    await relay?.close();
    await gateway.close();
    await f.close();
  }
});

test("REST refuses URLs, traversal, header injection and redirects without following or leaking bearer", async () => {
  const f = await fixture(undefined, (url) =>
    url === "/api/redirect"
      ? { status: 302, location: "/api/target" }
      : { body: "{}" },
  );
  f.store.secrets.restToken = "synthetic-user-bound-bearer";
  const gateway = await openNativeGateway(f.store);
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  try {
    relay = await startRelay(gateway);
    const ext = await loadExtension(relay);
    for (const args of [
      { path: "https://evil.test/api/x" },
      { path: "//evil.test/api/x" },
      { path: "/api/../admin" },
      { path: "/api/%2e%2e/admin" },
      { path: "/api/%252e%252e/admin" },
      { path: "/api/x%2fy" },
      { path: "/api/x\r\nX-Evil: yes" },
      { path: "/api/x", headers: { "X-Custom": "yes" } },
      { path: "/api/x", method: "POST" },
    ])
      await assert.rejects(() => ext!.call("katafit_rest_get", args));
    assert.equal(f.calls.filter((c) => c.method === "GET").length, 0);
    await assert.rejects(() =>
      ext.call("katafit_rest_get", { path: "/api/redirect" }),
    );
    assert.deepEqual(
      f.calls.filter((c) => c.method === "GET").map((c) => c.path),
      ["/api/redirect"],
    );
  } finally {
    await relay?.close();
    await gateway.close();
    await f.close();
  }
});

test("REST tool is unavailable without a separate user-scoped credential", async () => {
  const f = await fixture();
  const gateway = await openNativeGateway(f.store);
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  try {
    relay = await startRelay(gateway);
    const ext = await loadExtension(relay);
    assert.equal(ext.tools.has("katafit_rest_get"), false);
    assert.ok(ext.tools.has("studio_operator_list_members"));
    assert.equal(f.calls.filter((c) => c.method === "GET").length, 0);
  } finally {
    await relay?.close();
    await gateway.close();
    await f.close();
  }
});

test("REST rejects image MIME spoofing and oversized responses without returning upstream prose", async () => {
  const f = await fixture(undefined, (url) =>
    url === "/api/spoof"
      ? { type: "image/jpeg", body: "not pixels" }
      : url === "/api/large"
        ? {
            type: "application/json",
            body: JSON.stringify({ payload: "x".repeat(270000) }),
          }
        : {
            status: Number(url.split("/").at(-1)) || 403,
            body: '{"private":"sensitive backend denial"}',
          },
  );
  f.store.secrets.restToken = "synthetic-user-bound-bearer";
  const gateway = await openNativeGateway(f.store);
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  try {
    relay = await startRelay(gateway);
    const ext = await loadExtension(relay);
    for (const path of ["/api/spoof", "/api/large"])
      await assert.rejects(
        () => ext.call("katafit_rest_get", { path }),
        (e: any) =>
          !/not pixels|sensitive backend denial|xxxxx/.test(e.message),
      );
    for (const status of [401, 403, 404, 503])
      await assert.rejects(
        () => ext.call("katafit_rest_get", { path: `/api/${status}` }),
        (e: any) =>
          e.message.includes(String(status)) &&
          !/sensitive backend denial/.test(e.message),
      );
  } finally {
    await relay?.close();
    await gateway.close();
    await f.close();
  }
});
