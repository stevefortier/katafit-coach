import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { complete } from "../src/runtime/piAdapter.js";
test("embedded Pi emits only explicit instructions, no tools, and disposes", async () => {
  let body: any;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    body = JSON.parse(raw);
    res.setHeader("Content-Type", "text/event-stream");
    res.end(
      "data: " +
        JSON.stringify({
          id: "x",
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "Take a recovery day." },
              finish_reason: null,
            },
          ],
        }) +
        "\n\ndata: " +
        JSON.stringify({
          id: "x",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const text = await complete(
      {
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        model: "synthetic",
        apiKey: "synthetic-test-key",
      },
      "You are Coach.",
      "My legs are sore.",
      new AbortController().signal,
    );
    assert.equal(text, "Take a recovery day.");
    assert.equal(body.tools, undefined);
    assert.equal(body.messages[0].content, "You are Coach.");
    assert.equal(body.messages.filter((m: any) => m.role === "user").length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("real Pi cancellation closes streaming transport and never returns late output", async () => {
  let arrived!: () => void;
  const ready = new Promise<void>((r) => (arrived = r));
  let closed!: () => void;
  const disconnected = new Promise<void>((r) => (closed = r));
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
    res.on("close", closed);
    arrived();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const controller = new AbortController();
  try {
    const pending = complete(
      {
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        model: "synthetic",
        apiKey: "synthetic-cancellation-provider-key",
      },
      "Coach",
      "Cancel",
      controller.signal,
    );
    pending.catch(() => {});
    await ready;
    controller.abort();
    await assert.rejects(pending);
    await disconnected;
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
