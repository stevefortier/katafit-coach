// Native Operator image gateway reliability over the ACTUAL relay transport:
// pi-ai OpenAI client -> sandbox/relay.mjs HTTP -> JSON-line stdio ->
// NativeRuntime framing -> native gateway -> synthetic upstream provider.
// All photos, credentials and backends are synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { Store } from "../src/config/store.js";
import { openNativeGateway } from "./helpers/legacy-gateway.js";
import { fixture as checkinBackend } from "./operator-checkins.test.js";
import {
  assistantText,
  imageParts,
  imageTranscript,
  loadExtension,
  piTurn,
  providerStub,
  startRelay,
} from "./helpers/native-relay.js";

const MODEL = "approved-vision-model";
const LIST = "studio_operator_list_dojo_checkins";
const IMAGE = "studio_operator_read_dojo_checkin_image";
const MiB = 1024 * 1024;
const UPSTREAM_SECRET = "sk-upstream-private-detail";

async function setup(backendOptions: Record<string, any> = {}) {
  const backend = await checkinBackend({ imageCount: 5, ...backendOptions });
  const provider = await providerStub();
  const dir = await mkdtemp(tmpdir() + "/native-image-gateway-");
  const store = new Store(dir);
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  let gateway: Awaited<ReturnType<typeof openNativeGateway>> | undefined;
  const close = async () => {
    await relay?.close();
    await gateway?.close().catch(() => {});
    await provider.close();
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  };
  try {
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin: backend.origin,
      token: "synthetic-token",
      provider: {
        baseUrl: provider.origin + "/v1",
        model: MODEL,
        vision: true,
      },
      apiKey: "synthetic-provider-credential",
    });
    gateway = await openNativeGateway(store);
    relay = await startRelay(gateway);
    return { backend, provider, store, gateway, relay, close };
  } catch (error) {
    await close();
    throw error;
  }
}

const photo = async (seed = 0) =>
  (
    await sharp({
      create: {
        width: 1200,
        height: 900,
        channels: 3,
        background: "#000000",
        noise: { type: "gaussian", mean: 96 + seed, sigma: 60 },
      },
    })
      .jpeg({ quality: 85 })
      .toBuffer()
  ).toString("base64");
const png = async (width = 3, height = 2) =>
  sharp({ create: { width, height, channels: 3, background: "#224466" } })
    .png()
    .toBuffer();
/** A structurally valid PNG padded to `size` decoded bytes. */
const paddedPng = async (size: number) => {
  const head = await png();
  return Buffer.concat([head, Buffer.alloc(size - head.length)]).toString(
    "base64",
  );
};
const post = (base: string, path: string, body: string | object) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const errorOf = async (response: Response) => {
  const text = await response.text();
  return { status: response.status, text, error: JSON.parse(text).error };
};
function assertSafe(text: string) {
  for (const leak of [
    UPSTREAM_SECRET,
    "internal.example",
    "at Object.",
    "synthetic-token",
    "synthetic-provider-credential",
    "member-photo",
    "NATIVE_GATEWAY_REJECTED",
  ])
    assert.doesNotMatch(text, new RegExp(leak.replace(/\./g, "\\.")), leak);
}

test("two delivered photos over 1 MiB and the subsequent provider turn cross the actual relay once each", async () => {
  const f = await setup();
  try {
    const images = [
      { data: await photo(0), mimeType: "image/jpeg" },
      { data: await photo(9), mimeType: "image/jpeg" },
    ];
    const total = images.reduce((n, i) => n + i.data.length, 0);
    assert.ok(total > 1.5 * MiB, "synthetic photos exceed the old 1 MiB cap");
    const transcript = imageTranscript(images);
    const first = await piTurn(f.relay, MODEL, transcript);
    assert.equal(first.stopReason, "stop", first.errorMessage);
    assert.match(JSON.stringify(first.content), /Synthetic review of 2 photos/);
    const second = await piTurn(f.relay, MODEL, [
      ...transcript,
      assistantText("Both photos show a synthetic workout.", 10),
      { role: "user", content: "Compare their lighting.", timestamp: 11 },
    ]);
    assert.equal(second.stopReason, "stop", second.errorMessage);
    assert.equal(f.provider.bodies.length, 2, "one dispatch per provider turn");
    for (const body of f.provider.bodies)
      assert.deepEqual(
        imageParts(body).map((p: any) => p.image_url.url),
        images.map((i) => `data:image/jpeg;base64,${i.data}`),
      );
    assert.equal(f.relay.stops(), 0);
  } finally {
    await f.close();
  }
});

test("header-invalid and over-limit images, oversized text and oversized raw upload are rejected before dispatch with distinct codes", async () => {
  const f = await setup();
  try {
    const small = (await png()).toString("base64");
    const cases: [string, any[], string, number][] = [
      [
        "non-base64 alphabet",
        [{ data: small.slice(0, -4) + "*AA=", mimeType: "image/png" }],
        "NATIVE_IMAGE_REJECTED",
        422,
      ],
      [
        "non-canonical base64",
        [{ data: "AB==", mimeType: "image/png" }],
        "NATIVE_IMAGE_REJECTED",
        422,
      ],
      [
        "declared MIME does not match bytes",
        [{ data: small, mimeType: "image/jpeg" }],
        "NATIVE_IMAGE_REJECTED",
        422,
      ],
      [
        "arbitrary text without a valid image header",
        [
          {
            data: Buffer.from("x".repeat(2 * MiB)).toString("base64"),
            mimeType: "image/png",
          },
        ],
        "NATIVE_IMAGE_REJECTED",
        422,
      ],
      [
        "unsupported image type",
        [
          {
            data: Buffer.from("<svg/>").toString("base64"),
            mimeType: "image/svg+xml",
          },
        ],
        "NATIVE_IMAGE_REJECTED",
        422,
      ],
      [
        "single image over 8 MiB",
        [{ data: await paddedPng(8 * MiB + 1), mimeType: "image/png" }],
        "NATIVE_IMAGE_REJECTED",
        422,
      ],
    ];
    for (const [label, images, code, status] of cases) {
      const reply = await piTurn(f.relay, MODEL, imageTranscript(images));
      assert.equal(reply.stopReason, "error", label);
      assert.match(reply.errorMessage!, new RegExp(`^${status}\\b`), label);
      assert.match(reply.errorMessage!, new RegExp(code), label);
      assert.equal(isRetryableAssistantError(reply as any), false, label);
      assertSafe(reply.errorMessage!);
    }
    const text = await piTurn(f.relay, MODEL, [
      { role: "user", content: "t".repeat(1.1 * MiB), timestamp: 1 },
    ]);
    assert.match(text.errorMessage!, /^413\b.*NATIVE_TEXT_TOO_LARGE/s);
    assert.equal(isRetryableAssistantError(text as any), false);
    assert.equal(isContextOverflow(text as any, 128000), false);
    // Raw non-image bytes are text even beyond the 24 MiB provider wire; only
    // a raw upload over the 32 MiB history limit is a transport rejection.
    const padded = await errorOf(
      await post(f.relay.base, "/v1/chat/completions", {
        model: MODEL,
        messages: [],
        padding: "w".repeat(25 * MiB),
      }),
    );
    assert.equal(padded.status, 413);
    assert.equal(padded.error.code, "NATIVE_TEXT_TOO_LARGE");
    const wire = await errorOf(
      await post(f.relay.base, "/v1/chat/completions", {
        model: MODEL,
        messages: [],
        padding: "w".repeat(49 * MiB),
      }),
    );
    assert.equal(wire.status, 413);
    assert.equal(wire.error.code, "NATIVE_WIRE_TOO_LARGE");
    assert.equal(f.provider.bodies.length, 0, "nothing was dispatched");
    // The runtime survives every rejection and still serves a valid photo turn.
    const ok = await piTurn(
      f.relay,
      MODEL,
      imageTranscript([{ data: await photo(3), mimeType: "image/jpeg" }]),
    );
    assert.equal(ok.stopReason, "stop", ok.errorMessage);
    assert.equal(f.provider.bodies.length, 1);
    assert.equal(f.relay.stops(), 0);
  } finally {
    await f.close();
  }
});

test("older header-validated images beyond count or aggregate limits are compacted host-side newest-first from raw history over the 24 MiB wire", async () => {
  const f = await setup();
  try {
    const three = await paddedPng(3 * MiB);
    const seven = await paddedPng(7 * MiB);
    // Seven 3 MiB photos across turns: count limit keeps the newest five.
    const many = imageTranscript(
      Array.from({ length: 7 }, () => ({ data: three, mimeType: "image/png" })),
    );
    const byCount = await piTurn(f.relay, MODEL, many);
    assert.equal(byCount.stopReason, "stop", byCount.errorMessage);
    // Three 7 MiB photos: 16 MiB aggregate keeps the newest two.
    const big = imageTranscript(
      Array.from({ length: 3 }, () => ({ data: seven, mimeType: "image/png" })),
    );
    const byBytes = await piTurn(f.relay, MODEL, big);
    assert.equal(byBytes.stopReason, "stop", byBytes.errorMessage);
    const [countBody, bytesBody] = f.provider.bodies;
    assert.equal(imageParts(countBody).length, 5);
    assert.equal(imageParts(bytesBody).length, 2);
    for (const [body, omitted] of [
      [countBody, 2],
      [bytesBody, 1],
    ] as const) {
      const placeholders = JSON.stringify(body).match(
        /Earlier image omitted from this provider turn/g,
      );
      assert.equal(placeholders?.length, omitted);
      // Omitted parts are the oldest ones; the newest image is always kept.
      const parts = body.messages.at(-1).content;
      assert.equal(parts.at(-1).type, "image_url");
    }
  } finally {
    await f.close();
  }
});

test("admission is measured on the original raw envelope: nothing is dropped before host validation", async () => {
  const f = await setup();
  try {
    const good = "data:image/png;base64," + (await png()).toString("base64");
    const part = (url: string, extra: Record<string, unknown> = {}) => ({
      type: "image_url",
      image_url: { url },
      ...extra,
    });
    const history = (first: any) => ({
      model: MODEL,
      messages: [
        { role: "user", content: [{ type: "text", text: "old" }, first] },
        {
          role: "user",
          content: Array.from({ length: 5 }, () => part(good)),
        },
      ],
    });
    const cases: [string, any, string, number][] = [
      [
        "older VALID image carrying >1 MiB of non-image metadata",
        history(part(good, { unexpectedMetadata: "x".repeat(2 * MiB) })),
        "NATIVE_TEXT_TOO_LARGE",
        413,
      ],
      [
        "older invalid canonical data URL followed by five good photos",
        history(part("data:image/png;base64,QUJD")),
        "NATIVE_IMAGE_REJECTED",
        422,
      ],
      [
        "single data URL over 16 MiB decoded",
        {
          model: MODEL,
          messages: [
            {
              role: "user",
              content: [
                part("data:image/png;base64," + (await paddedPng(17 * MiB))),
              ],
            },
          ],
        },
        "NATIVE_IMAGE_REJECTED",
        422,
      ],
    ];
    // Every case on both paths is collected, then compared at once.
    const actual: string[] = [];
    const expected: string[] = [];
    for (const [label, body, code, status] of cases) {
      // Direct authoritative host path.
      const host = await f.gateway.handle({ kind: "provider", body }).then(
        () => "accepted",
        (error: any) => error.code,
      );
      // Actual relay path: the relay forwards raw history and never drops,
      // compacts or reinterprets images before the host decides.
      const dispatched = f.provider.bodies.length;
      const response = await post(f.relay.base, "/v1/chat/completions", body);
      const text = await response.text();
      const relayed = `${response.status} ${response.ok ? "accepted" : JSON.parse(text).error.code}`;
      actual.push(
        `${label}: host ${host}; relay ${relayed}; dispatched ${f.provider.bodies.length - dispatched}`,
      );
      expected.push(
        `${label}: host ${code}; relay ${status} ${code}; dispatched 0`,
      );
      f.provider.bodies.length = 0;
    }
    assert.deepEqual(actual, expected);
    // Control: the same history with metadata-free valid images compacts.
    const ok = await post(
      f.relay.base,
      "/v1/chat/completions",
      history(part(good)),
    );
    assert.equal(ok.status, 200);
    assert.equal(f.provider.bodies.length, 1);
    assert.equal(imageParts(f.provider.bodies[0]).length, 5);
    assert.equal(f.provider.bodies[0].messages[0].content[1].type, "text");
    assert.equal(f.relay.stops(), 0);
  } finally {
    await f.close();
  }
});

test("image-like payloads outside canonical messages[].content[] image parts are counted as text", async () => {
  const f = await setup();
  try {
    const hidden = await paddedPng(Math.ceil(0.9 * MiB));
    const url = `data:image/png;base64,${hidden}`;
    const part = { type: "image_url", image_url: { url } };
    const small = `data:image/png;base64,${(await png()).toString("base64")}`;
    const base = (extra: any) => ({ model: MODEL, stream: true, ...extra });
    for (const [label, body] of [
      [
        "tool schema marker",
        base({
          messages: [{ role: "user", content: "hi" }],
          tools: [
            {
              type: "function",
              function: {
                name: "x",
                parameters: { type: "object", default: [part, part] },
              },
            },
          ],
        }),
      ],
      [
        "text part carrying a data URL",
        base({
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: url },
                { type: "text", text: url },
              ],
            },
          ],
        }),
      ],
      [
        "nested content array",
        base({
          messages: [
            {
              role: "user",
              content: [{ type: "text", content: [part, part] }],
            },
          ],
        }),
      ],
      [
        "extra field beside a valid image",
        base({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: small },
                  padding: "p".repeat(1.1 * MiB),
                },
              ],
            },
          ],
        }),
      ],
      [
        "image_url metadata padding",
        base({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: small, detail: "d".repeat(1.1 * MiB) },
                },
              ],
            },
          ],
        }),
      ],
      [
        "message content object mimic",
        base({
          messages: [
            { role: "user", content: part },
            { role: "user", content: part },
          ],
        }),
      ],
      ["top-level image list", base({ messages: [], images: [part, part] })],
    ] as const) {
      const response = await errorOf(
        await post(f.relay.base, "/v1/chat/completions", body),
      );
      assert.equal(response.status, 413, label);
      assert.equal(response.error.code, "NATIVE_TEXT_TOO_LARGE", label);
      assertSafe(response.text);
    }
    assert.equal(f.provider.bodies.length, 0);
  } finally {
    await f.close();
  }
});

test("provider failures reach Pi as fixed codes with numeric status only and the right retry semantics", async () => {
  const f = await setup();
  try {
    const leaky = (code?: string) =>
      JSON.stringify({
        error: {
          message: `${UPSTREAM_SECRET} https://internal.example/trace at Object.<anonymous>`,
          ...(code ? { code } : {}),
        },
      });
    const cases: [any, string, number, boolean][] = [
      [
        { status: 401, body: leaky() },
        "NATIVE_PROVIDER_AUTH_FAILED",
        401,
        false,
      ],
      [
        { status: 403, body: leaky() },
        "NATIVE_PROVIDER_AUTH_FAILED",
        403,
        false,
      ],
      [
        { status: 429, body: leaky() },
        "NATIVE_PROVIDER_RATE_LIMITED",
        429,
        true,
      ],
      [
        { status: 429, body: leaky("insufficient_quota") },
        "NATIVE_PROVIDER_QUOTA_EXCEEDED",
        429,
        false,
      ],
      [
        { status: 500, body: leaky() },
        "NATIVE_PROVIDER_UNAVAILABLE",
        503,
        true,
      ],
      [
        { status: 503, body: leaky() },
        "NATIVE_PROVIDER_UNAVAILABLE",
        503,
        true,
      ],
      [{ status: 504, body: leaky() }, "NATIVE_PROVIDER_TIMEOUT", 504, true],
      [
        { status: 413, body: leaky() },
        "NATIVE_PROVIDER_PAYLOAD_TOO_LARGE",
        413,
        false,
      ],
      [
        { status: 400, body: leaky("context_length_exceeded") },
        "NATIVE_PROVIDER_CONTEXT_LIMIT",
        400,
        false,
      ],
      [
        { status: 422, body: leaky("some_unknown_code") },
        "NATIVE_PROVIDER_REQUEST_REJECTED",
        400,
        false,
      ],
      ["destroy", "NATIVE_PROVIDER_NETWORK_FAILED", 502, true],
      [
        {
          status: 200,
          body: "data: " + "o".repeat(2 * MiB + 16) + "\n\n",
          headers: { "content-type": "text/event-stream" },
        },
        "NATIVE_PROVIDER_OUTPUT_REJECTED",
        502,
        true,
      ],
    ];
    for (const [reply, code, status, retryable] of cases) {
      f.provider.reply = () => reply;
      const before = f.provider.bodies.length;
      const message = await piTurn(f.relay, MODEL, [
        { role: "user", content: "hello", timestamp: 1 },
      ]);
      const label = code + " " + JSON.stringify(reply).slice(0, 40);
      assert.equal(
        f.provider.bodies.length,
        before + 1,
        "one dispatch " + label,
      );
      assert.equal(message.stopReason, "error", label);
      assert.match(message.errorMessage!, new RegExp(`^${status}\\b`), label);
      assert.match(message.errorMessage!, new RegExp(code), label);
      if (typeof reply === "object" && reply.status !== 200)
        assert.match(
          message.errorMessage!,
          new RegExp(`provider HTTP ${reply.status}\\b`),
          label,
        );
      assert.equal(isRetryableAssistantError(message as any), retryable, label);
      assert.equal(isContextOverflow(message as any, 128000), false, label);
      assertSafe(message.errorMessage!);
    }
    assert.equal(f.relay.stops(), 0);
  } finally {
    await f.close();
  }
});

test("unknown gateway failures are content-free and not reported as a generic rejection", async () => {
  const relay = await startRelay({
    handle: async (request: any) => {
      if (request.kind === "catalog")
        return {
          model: MODEL,
          vision: true,
          prompt: "p",
          skills: [],
          tools: [],
        };
      throw new Error(
        `${UPSTREAM_SECRET} /srv/private/path at Object.<anonymous>`,
      );
    },
    close: async () => {},
  });
  try {
    const message = await piTurn(relay, MODEL, [
      { role: "user", content: "hello", timestamp: 1 },
    ]);
    assert.match(message.errorMessage!, /^500\b.*NATIVE_GATEWAY_FAILED/s);
    assertSafe(message.errorMessage!);
    assert.doesNotMatch(message.errorMessage!, /srv\/private/);
    const tool = await errorOf(
      await post(relay.base, "/tool", { name: "x", args: {} }),
    );
    assert.equal(tool.error.code, "NATIVE_TOOL_FAILED");
    assertSafe(tool.text);
  } finally {
    await relay.close();
  }
});
