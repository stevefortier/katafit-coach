import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { complete } from "../src/runtime/piAdapter.js";

async function provider(run: (config: any, bodies: any[]) => Promise<void>) {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw));
    res.setHeader("Content-Type", "text/event-stream");
    res.end(
      'data: {"id":"x","choices":[{"index":0,"delta":{"role":"assistant","content":"Safe reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await run(
      {
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        model: "synthetic",
        apiKey: "synthetic-key",
      },
      bodies,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
test("actual Pi sends a near-1MiB UTF8 provider envelope and blocks overflow before dispatch", async () => {
  await provider(async (config, bodies) => {
    assert.equal(
      await complete(
        config,
        "Coach",
        "é".repeat(500000),
        AbortSignal.timeout(5000),
      ),
      "Safe reply",
    );
    assert.equal(bodies.length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(bodies[0])) > 1000000);
    await assert.rejects(
      complete(config, "Coach", "é".repeat(524288), AbortSignal.timeout(5000)),
      /MODEL_INPUT_TOO_LARGE/,
    );
    assert.equal(bodies.length, 1);
  });
});

for (const [status, code, expected] of [
  [401, "invalid_api_key", "PROVIDER_AUTH_FAILED"],
  [404, "model_not_found", "PROVIDER_REQUEST_REJECTED"],
  [408, "unknown", "PROVIDER_TIMEOUT"],
  [413, "unknown", "PROVIDER_PAYLOAD_TOO_LARGE"],
  [504, "unknown", "PROVIDER_TIMEOUT"],
  [429, "quota_exceeded", "PROVIDER_QUOTA_EXCEEDED"],
  [400, "max_tokens_exceeded", "PROVIDER_REQUEST_REJECTED"],
  [400, "MODEL_INPUT_TOO_LARGE", "PROVIDER_REQUEST_REJECTED"],
  [403, "permission_denied", "PROVIDER_AUTH_FAILED"],
  [429, "rate_limit_exceeded", "PROVIDER_RATE_LIMITED"],
  [400, "context_length_exceeded", "PROVIDER_CONTEXT_LIMIT"],
  [400, "unknown", "PROVIDER_REQUEST_REJECTED"],
  [503, "unknown", "PROVIDER_UNAVAILABLE"],
] as const) {
  test(`real Pi HTTP ${status}/${code} preserves safe ${expected}`, async () => {
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code,
            message: "PRIVATE prompt persona key URL https://secret.test",
          },
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      await assert.rejects(
        complete(
          {
            baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
            model: "synthetic",
            apiKey: "key-fixture",
          },
          "Coach",
          "Question",
          AbortSignal.timeout(5000),
        ),
        (e: any) => {
          assert.equal(e.code, expected);
          assert.equal(e.metadata.status, status);
          assert.ok(e.hint.length > 10);
          assert.ok(!JSON.stringify(e).includes("PRIVATE"));
          return true;
        },
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
}

test("actual Pi preserves payload secret rejection before dispatch", async () => {
  await provider(async (config, bodies) => {
    await assert.rejects(
      complete(
        {
          ...config,
          model: "model-with-private-marker",
          secrets: ["private-marker"],
        },
        "Coach",
        "Question",
        AbortSignal.timeout(5000),
      ),
      (e: any) => e.code === "SECRET_IN_CONFIG",
    );
    assert.equal(bodies.length, 0);
  });
});
for (const [mode, expected] of [
  ["empty", "MODEL_EMPTY_RESPONSE"],
  ["timeout", "PROVIDER_TIMEOUT"],
  ["cancel", "CANCELLED"],
  ["quota", "PROVIDER_QUOTA_EXCEEDED"],
] as const) {
  test(`actual Pi ${mode} returns safe ${expected}`, async () => {
    const controller = new AbortController();
    const server = createServer((req, res) => {
      req.resume();
      if (mode === "quota") {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "insufficient_quota",
              message: "PRIVATE arbitrary text",
            },
          }),
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      if (mode === "empty")
        res.end(
          'data: {"id":"x","choices":[{"index":0,"delta":{"role":"assistant","content":" "},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
      else if (mode === "cancel") controller.abort();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      await assert.rejects(
        complete(
          {
            baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
            model: "synthetic",
            apiKey: "key-fixture",
          },
          "Coach",
          "Question",
          mode === "timeout" ? AbortSignal.timeout(80) : controller.signal,
        ),
        (e: any) => {
          assert.equal(e.code, expected);
          return true;
        },
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
}
