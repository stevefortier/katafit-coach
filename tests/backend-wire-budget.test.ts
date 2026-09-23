import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "../src/katafit/client.js";
import { backendWireBudget } from "../src/katafit/wireBudget.js";

test("ordinary MCP response may take longer than ten seconds", async () => {
  const server = createServer(async (req, res) => {
    req.resume();
    await new Promise((resolve) => setTimeout(resolve, 11000));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = new Client(
      `http://127.0.0.1:${(server.address() as any).port}`,
      "synthetic",
      new AbortController().signal,
    );
    assert.deepEqual(await client.rpc("initialize"), { ok: true });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("worker backend budget stays below the router deadline and inside its lease", () => {
  assert.equal(backendWireBudget(120000), 25000);
  assert.equal(backendWireBudget(7000), 7000);
  assert.equal(backendWireBudget(0), 0);
});
