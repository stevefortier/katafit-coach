import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "../src/katafit/client.js";
import { discoverReads } from "../src/katafit/readTools.js";
import { complete } from "../src/runtime/piAdapter.js";
import { fence, readFixture } from "./data-fixtures.js";

test("Pi rejects text budget overflow before network dispatch", async () => {
  await assert.rejects(
    complete(
      {
        baseUrl: "http://127.0.0.1:1/v1",
        model: "synthetic",
        apiKey: "private",
      },
      "Coach",
      "x".repeat(1024 * 1024),
      AbortSignal.timeout(1000),
    ),
    /MODEL_INPUT_TOO_LARGE/,
  );
});
for (const mode of ["cancel", "timeout"])
  test(`${mode}: MCP media stream closes without exposing a result`, async () => {
    let entered!: () => void, closed!: () => void;
    const arrived = new Promise<void>((r) => (entered = r)),
      disconnected = new Promise<void>((r) => (closed = r));
    const f = await readFixture();
    const stream = createServer(async (req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"jsonrpc":"2.0","id":1,"result":{"content":[');
      res.on("close", closed);
      entered();
    });
    await new Promise<void>((r) => stream.listen(0, "127.0.0.1", r));
    const ctrl = new AbortController();
    try {
      const c = new Client(
        `http://127.0.0.1:${(stream.address() as any).port}`,
        "synthetic-token",
        ctrl.signal,
      );
      const pending = c.rpc(
        "tools/call",
        { name: "coach_read_media", arguments: fence },
        false,
        mode === "timeout" ? 30 : 10000,
        12 * 1024 * 1024,
      );
      pending.catch(() => {});
      await arrived;
      if (mode === "cancel") ctrl.abort();
      await assert.rejects(pending);
      await disconnected;
    } finally {
      stream.closeAllConnections();
      await new Promise((r) => stream.close(r));
      await f.close();
    }
  });
test("MCP text secrets encoded inside JSON are blocked", async () => {
  const secret = 'synthetic-"secret"';
  const f = await readFixture({
    content: [{ type: "text", text: JSON.stringify({ value: secret }) }],
  });
  try {
    const r = await discoverReads(
      new Client(f.origin, "token", AbortSignal.timeout(2000)),
      fence,
      { vision: false, secrets: [secret] },
    );
    await assert.rejects(r.tools[0].execute("x", {}), /SECRET_IN_CONFIG/);
  } finally {
    await f.close();
  }
});
