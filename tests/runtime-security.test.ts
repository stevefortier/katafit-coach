import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { complete } from "../src/runtime/piAdapter.js";
test("provider-secret echo is rejected before it can become a reply", async () => {
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.end(
      "data: " +
        JSON.stringify({
          id: "secret",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "synthetic-private-key" },
              finish_reason: "stop",
            },
          ],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(
      complete(
        {
          baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
          model: "synthetic",
          apiKey: "synthetic-private-key",
        },
        "Coach",
        "Question",
        new AbortController().signal,
      ),
      /OUTPUT_REJECTED/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
