// Native relay transport limits in both directions over the ACTUAL
// sandbox/relay.mjs process and NativeRuntime framing, with stub gateways.
// Also pins the host envelope validator and relay/host constant parity.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { nativeProviderEnvelope } from "../src/sandbox/gateway.js";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import * as failures from "../src/sandbox/failures.js";
import { PROVIDER_IMAGE_COUNT } from "../src/runtime/providerEnvelope.js";
import { startRelay } from "./helpers/native-relay.js";

const {
  NATIVE_FAILURE_CODES,
  NATIVE_PROVIDER_UPLOAD_LIMIT,
  NATIVE_PROVIDER_WIRE_LIMIT,
  NATIVE_REQUEST_FRAME_LIMIT,
  NATIVE_RESPONSE_FRAME_LIMIT,
  NATIVE_TEXT_LIMIT,
  NativeFailure,
  failureFrame,
} = failures as typeof failures & { NATIVE_PROVIDER_UPLOAD_LIMIT: number };
const MODEL = "approved-vision-model";
const MiB = 1024 * 1024;
const catalog = {
  model: MODEL,
  vision: true,
  prompt: "p",
  skills: [],
  tools: [],
};
const post = (base: string, path: string, body: string | object) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const errorOf = async (response: Response) => ({
  status: response.status,
  retry: response.headers.get("x-should-retry"),
  ...(await response.json()).error,
});
const imagePart = (url: string) => ({ type: "image_url", image_url: { url } });

test("results up to the return frame budget arrive intact; larger ones are withheld without tearing down the runtime", async () => {
  let size = 0;
  const relay = await startRelay({
    handle: async (request: any) =>
      request.kind === "catalog" ? catalog : { blob: "r".repeat(size) },
    close: async () => {},
  });
  try {
    size = NATIVE_RESPONSE_FRAME_LIMIT - 1024;
    const ok = await post(relay.base, "/tool", { name: "t", args: {} });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).blob.length, size);
    size = NATIVE_RESPONSE_FRAME_LIMIT + 1;
    const withheld = await errorOf(
      await post(relay.base, "/tool", { name: "t", args: {} }),
    );
    assert.equal(withheld.status, 413);
    assert.equal(withheld.code, "NATIVE_RESULT_TOO_LARGE");
    assert.equal(withheld.retry, "false");
    assert.match(withheld.message, /outcome is unknown; do not replay/);
    assert.equal(relay.stops(), 0, "runtime was not torn down");
    assert.ok(relay.alive());
    size = 3;
    const after = await post(relay.base, "/tool", { name: "t", args: {} });
    assert.deepEqual(await after.json(), { blob: "rrr" });
  } finally {
    await relay.close();
  }
});

test("relay upload caps answer with fixed codes, drain the upload and forward nothing", async () => {
  const seen: any[] = [];
  const relay = await startRelay({
    handle: async (request: any) => {
      if (request.kind === "catalog") return catalog;
      seen.push(request);
      return { ok: true };
    },
    close: async () => {},
  });
  try {
    const tool = await errorOf(
      await post(relay.base, "/tool", {
        name: "t",
        args: { text: "x".repeat(NATIVE_TEXT_LIMIT) },
      }),
    );
    assert.equal(tool.status, 413);
    assert.equal(tool.code, "NATIVE_TEXT_TOO_LARGE");
    const upload = await errorOf(
      await post(relay.base, "/v1/chat/completions", {
        model: MODEL,
        messages: [],
        padding: "w".repeat(2 * NATIVE_PROVIDER_WIRE_LIMIT),
      }),
    );
    assert.equal(upload.status, 413);
    assert.equal(upload.code, "NATIVE_WIRE_TOO_LARGE");
    const path = await errorOf(await post(relay.base, "/other", {}));
    assert.equal(path.code, "NATIVE_REQUEST_REJECTED");
    const json = await errorOf(await post(relay.base, "/tool", "{"));
    assert.equal(json.status, 400);
    assert.equal(json.code, "NATIVE_REQUEST_REJECTED");
    assert.equal(seen.length, 0, "nothing reached the host");
    assert.equal(relay.stops(), 0);
    assert.ok(relay.alive());
  } finally {
    await relay.close();
  }
});

test("relay busy is a fixed not-dispatched 409, not a relay exit", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let handled = 0;
  const relay = await startRelay({
    handle: async (request: any) => {
      if (request.kind === "catalog") return catalog;
      handled++;
      await gate;
      return { ok: true };
    },
    close: async () => {},
  });
  try {
    const held = Array.from({ length: 4 }, () =>
      post(relay.base, "/tool", { name: "t", args: {} }),
    );
    while (handled < 4) await new Promise((r) => setTimeout(r, 10));
    const busy = await errorOf(
      await post(relay.base, "/tool", { name: "t", args: {} }),
    );
    assert.equal(busy.status, 409);
    assert.equal(busy.code, "NATIVE_REQUEST_BUSY");
    assert.match(busy.message, /not dispatched/);
    assert.equal(handled, 4);
    release();
    for (const response of await Promise.all(held))
      assert.equal(response.status, 200);
    assert.equal(relay.stops(), 0);
    assert.ok(relay.alive());
  } finally {
    release();
    await relay.close();
  }
});

test("relay forwards raw provider history losslessly up to the upload limit; the host alone validates and compacts", async () => {
  const seen: any[] = [];
  const relay = await startRelay({
    handle: async (request: any) => {
      if (request.kind === "catalog") return catalog;
      seen.push(request.body);
      return { body: "{}", type: "application/json" };
    },
    close: async () => {},
  });
  try {
    // 7 x 3 MiB decoded (~28 MiB raw): over the 24 MiB provider wire, within
    // the 32 MiB raw history limit. Includes an invalid older data URL, a
    // non-data-URL part and metadata the relay must neither drop nor judge.
    const big = "data:image/png;base64," + "A".repeat(4 * MiB);
    const body = {
      model: MODEL,
      messages: [
        {
          role: "user",
          content: [
            imagePart("data:image/png;base64,QUJD"),
            imagePart("https://example.invalid/x.png"),
            { ...imagePart(big), metadata: "m".repeat(1024) },
          ],
        },
        ...Array.from({ length: 6 }, () => ({
          role: "user",
          content: [{ type: "text", text: "photo" }, imagePart(big)],
        })),
      ],
    };
    assert.ok(JSON.stringify(body).length > NATIVE_PROVIDER_WIRE_LIMIT);
    const response = await post(relay.base, "/v1/chat/completions", body);
    assert.equal(response.status, 200);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], body, "byte-for-byte raw history reached host");
    assert.equal(relay.stops(), 0);
  } finally {
    await relay.close();
  }
});

test("host envelope measures the original raw envelope, exempts only header-validated canonical image data and compacts afterward", async () => {
  const png = (
    await sharp({
      create: { width: 3, height: 2, channels: 3, background: "#123456" },
    })
      .png()
      .toBuffer()
  ).toString("base64");
  const body = (content: any[], extra: Record<string, any> = {}) => ({
    model: MODEL,
    messages: [{ role: "user", content }],
    ...extra,
  });
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      assert.ok(error instanceof NativeFailure);
      return (error as NativeFailure).code;
    }
    return "accepted";
  };
  const url = "data:image/png;base64," + png;
  assert.equal(
    code(() => nativeProviderEnvelope(body([imagePart(url)]))),
    "accepted",
  );
  // Text budget: everything except exempt base64 image data counts.
  assert.equal(
    code(() =>
      nativeProviderEnvelope(
        body([{ type: "text", text: "t".repeat(NATIVE_TEXT_LIMIT) }]),
      ),
    ),
    "NATIVE_TEXT_TOO_LARGE",
  );
  // Original-envelope bound before any image is decoded.
  assert.equal(
    code(() =>
      nativeProviderEnvelope(
        body([imagePart("data:image/png;base64,QUJD")], {
          padding: "w".repeat(NATIVE_PROVIDER_UPLOAD_LIMIT),
        }),
      ),
    ),
    "NATIVE_WIRE_TOO_LARGE",
  );
  // Non-image metadata on an OLDER valid image counts before compaction,
  // even though compaction would replace that whole part with a notice.
  assert.equal(
    code(() =>
      nativeProviderEnvelope(
        body([
          { ...imagePart(url), unexpectedMetadata: "x".repeat(2 * MiB) },
          ...Array.from({ length: PROVIDER_IMAGE_COUNT }, () => imagePart(url)),
        ]),
      ),
    ),
    "NATIVE_TEXT_TOO_LARGE",
  );
  // A single image over the aggregate is rejected, never silently omitted.
  assert.equal(
    code(() =>
      nativeProviderEnvelope(
        body([
          imagePart(
            "data:image/png;base64," +
              Buffer.concat([
                Buffer.from(png, "base64"),
                Buffer.alloc(17 * MiB),
              ]).toString("base64"),
          ),
        ]),
      ),
    ),
    "NATIVE_IMAGE_REJECTED",
  );
  // Compaction notices are text too: measured again on the final envelope.
  const nearLimit = (images: number) => {
    const parts = Array.from({ length: images }, () => imagePart(url));
    const fixed =
      Buffer.byteLength(
        JSON.stringify(body([{ type: "text", text: "" }, ...parts])),
      ) -
      images * png.length;
    return body([
      { type: "text", text: "t".repeat(NATIVE_TEXT_LIMIT - fixed) },
      ...parts,
    ]);
  };
  assert.equal(
    code(() => nativeProviderEnvelope(nearLimit(PROVIDER_IMAGE_COUNT))),
    "accepted",
  );
  assert.equal(
    code(() => nativeProviderEnvelope(nearLimit(PROVIDER_IMAGE_COUNT + 2))),
    "NATIVE_TEXT_TOO_LARGE",
  );
  // An invalid OLDER image is rejected even when compaction would drop it.
  const history = [
    imagePart("data:image/png;base64,QUJD"),
    ...Array.from({ length: PROVIDER_IMAGE_COUNT + 1 }, () => imagePart(url)),
  ];
  assert.equal(
    code(() => nativeProviderEnvelope(body(history))),
    "NATIVE_IMAGE_REJECTED",
  );
  const wire = JSON.parse(
    nativeProviderEnvelope(
      body(
        Array.from({ length: PROVIDER_IMAGE_COUNT + 2 }, () => imagePart(url)),
      ),
    ),
  );
  assert.deepEqual(
    wire.messages[0].content.map((p: any) => p.type),
    ["text", "text", ...Array(PROVIDER_IMAGE_COUNT).fill("image_url")],
  );
});

test("unclassified failures stay content-free; only allowlisted codes and integer statuses cross the frame", () => {
  assert.deepEqual(failureFrame(new Error("sk-secret at /srv/x")), {
    error: "NATIVE_GATEWAY_FAILED",
  });
  assert.deepEqual(failureFrame(new Error("boom"), "tool"), {
    error: "NATIVE_TOOL_FAILED",
  });
  assert.deepEqual(failureFrame(new Error("NATIVE_HISTORY_UNTRUSTED_RESULT")), {
    error: "NATIVE_GATEWAY_FAILED",
  });
  assert.deepEqual(failureFrame(new Error("NATIVE_HISTORY_MISMATCH")), {
    error: "NATIVE_GATEWAY_FAILED",
  });
  assert.deepEqual(
    failureFrame(
      new NativeFailure("NATIVE_TOOL_FAILED", "NATIVE_HISTORY_MISMATCH"),
      "tool",
    ),
    { error: "NATIVE_TOOL_FAILED" },
  );
  assert.deepEqual(
    failureFrame(new NativeFailure("NATIVE_HISTORY_UNTRUSTED_RESULT")),
    { error: "NATIVE_HISTORY_UNTRUSTED_RESULT" },
  );
  assert.deepEqual(
    failureFrame(new Error("NATIVE_HISTORY_MISMATCH with sk-secret")),
    { error: "NATIVE_GATEWAY_FAILED" },
  );
  assert.deepEqual(
    failureFrame(new NativeFailure("NATIVE_PROVIDER_AUTH_FAILED", "x", 403)),
    { error: "NATIVE_PROVIDER_AUTH_FAILED", status: 403 },
  );
  assert.deepEqual(
    failureFrame(new NativeFailure("NATIVE_PROVIDER_AUTH_FAILED", "x", 4031)),
    { error: "NATIVE_PROVIDER_AUTH_FAILED" },
  );
});

test("relay limits mirror the host constants and the relay carries no image or compaction logic", async () => {
  const relay = await readFile(
    new URL("../sandbox/relay.mjs", import.meta.url),
    "utf8",
  );
  const scope: Record<string, number> = {};
  for (const [, name, expr] of relay.matchAll(
    /^const ([A-Z_]+_LIMIT) =\s*([^;]+);/gm,
  ))
    scope[name] = new Function(...Object.keys(scope), `return ${expr};`)(
      ...Object.values(scope),
    );
  assert.deepEqual(scope, {
    TEXT_LIMIT: NATIVE_TEXT_LIMIT,
    UPLOAD_LIMIT: NATIVE_PROVIDER_UPLOAD_LIMIT,
    REQUEST_FRAME_LIMIT: NATIVE_REQUEST_FRAME_LIMIT,
    RESPONSE_FRAME_LIMIT: NATIVE_RESPONSE_FRAME_LIMIT,
  });
  assert.equal(
    NATIVE_REQUEST_FRAME_LIMIT,
    NATIVE_PROVIDER_UPLOAD_LIMIT + 65536,
  );
  assert.ok(NATIVE_PROVIDER_UPLOAD_LIMIT > NATIVE_PROVIDER_WIRE_LIMIT);
  assert.doesNotMatch(relay, /image_url|OMITTED_IMAGE_TEXT|compact\s*\(/);
});

test("every host failure code has exactly one fixed relay message with the pinned Pi retry semantics", async () => {
  const relay = await readFile(
    new URL("../sandbox/relay.mjs", import.meta.url),
    "utf8",
  );
  const table = new Map<string, [number, string]>();
  for (const [, code, status, text] of relay.matchAll(
    /^\s+(NATIVE_[A-Z_]+): \[\s*(\d+),\s*("(?:[^"\\]|\\.)*"),?\s*\]/gm,
  )) {
    assert.ok(!table.has(code), "duplicate " + code);
    table.set(code, [Number(status), JSON.parse(text)]);
  }
  assert.deepEqual(
    [...table.keys()].sort(),
    [...NATIVE_FAILURE_CODES, "NATIVE_GATEWAY_TIMEOUT"].sort(),
    "host codes and relay messages are the same set (plus relay-local timeout)",
  );
  const retryable = new Set([
    "NATIVE_PROVIDER_RATE_LIMITED",
    "NATIVE_PROVIDER_TIMEOUT",
    "NATIVE_PROVIDER_UNAVAILABLE",
    "NATIVE_PROVIDER_NETWORK_FAILED",
    "NATIVE_PROVIDER_OUTPUT_REJECTED",
    "NATIVE_TOOL_FAILED",
    "NATIVE_GATEWAY_TIMEOUT",
    "NATIVE_GATEWAY_FAILED",
  ]);
  for (const [code, [status, text]] of table) {
    assert.ok(text.length > 20, code);
    // Pi's own rendering of an OpenAI APIError from the relay body.
    const message = {
      role: "assistant",
      stopReason: "error",
      content: [],
      errorMessage: `${status}: ${JSON.stringify({ message: `${code}: ${text}`, type: "native_gateway", code })}`,
    } as any;
    assert.equal(isRetryableAssistantError(message), retryable.has(code), code);
    assert.equal(isContextOverflow(message, 128000), false, code);
  }
  // Oversize recovery: /compact may need the same oversized request, so it is
  // never promised; a fresh session with a focused question is.
  for (const code of [
    "NATIVE_TEXT_TOO_LARGE",
    "NATIVE_WIRE_TOO_LARGE",
    "NATIVE_PROVIDER_PAYLOAD_TOO_LARGE",
    "NATIVE_PROVIDER_CONTEXT_LIMIT",
  ]) {
    const text = table.get(code)![1];
    assert.doesNotMatch(text, /run \/compact|\/compact or/i, code);
    assert.match(text, /new Pi session/, code);
    assert.match(text, /focused question/, code);
  }
  const [turnStatus, turn] = table.get("NATIVE_TURN_REQUIRED")!;
  assert.equal(turnStatus, 409);
  assert.match(turn, /send a new message/i);
  assert.doesNotMatch(turn, /connection|network/i);
  assert.match(turn, /do not replay/i);
});

test("real relay emits provider output without a delivery callback", async () => {
  const r = await startRelay({
    handle: async (request: any) =>
      request.kind === "catalog"
        ? { model: "m", vision: false, prompt: "p", skills: [], tools: [] }
        : {
            type: "application/json",
            body: '{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Complete"}}]}',
          },
    close: async () => {},
  });
  try {
    const response = await fetch(r.base + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    assert.match(await response.text(), /Complete/);
    assert.equal(r.stops(), 0);
  } finally {
    await r.close();
  }
});
