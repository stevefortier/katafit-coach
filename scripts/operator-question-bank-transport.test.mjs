import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { streamedTurn } from "./operator-question-bank-transport.mjs";
async function server(handler, run) {
  const s = createServer(handler);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    return await run(`http://127.0.0.1:${s.address().port}`);
  } finally {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
}
test("actual heartbeat bytes keep a slow JSON response alive", () =>
  server(
    (req, res) => {
      assert.equal(req.headers.accept, "application/vnd.katafit.operator+json");
      res.writeHead(200, {
        "Content-Type": "application/vnd.katafit.operator+json",
      });
      res.write("\n");
      const interval = setInterval(() => res.write("\n"), 20);
      const end = setTimeout(
        () => res.end(JSON.stringify({ text: "done" })),
        150,
      );
      res.on("close", () => {
        clearInterval(interval);
        clearTimeout(end);
      });
    },
    async (url) => {
      const r = await streamedTurn(url, {}, "Exact question", {
        idleMs: 100,
        totalMs: 1500,
      });
      assert.equal(r.body.text, "done");
      assert.ok(r.transport.chunks.length > 2);
      assert.ok(r.transport.elapsedMs >= 150);
    },
  ));
test("missing heartbeat fails an actual idle deadline without replay", () => {
  let count = 0;
  return server(
    (_req, res) => {
      count++;
      res.writeHead(200);
      res.write("\n");
    },
    async (url) => {
      await assert.rejects(
        streamedTurn(url, {}, "Exact question", { idleMs: 60, totalMs: 1500 }),
        (e) => {
          assert.match(e.message, /idle deadline/);
          assert.ok(e.transport.elapsedMs >= 60);
          return true;
        },
      );
      assert.equal(count, 1);
    },
  );
});
test("HTTP 200 terminal JSON error stays an error, not fabricated text", () =>
  server(
    (_req, res) => {
      res.writeHead(200);
      res.end("\n" + JSON.stringify({ error: "BACKEND_TIMEOUT" }));
    },
    async (url) => {
      const r = await streamedTurn(url, {}, "Exact question", { idleMs: 1000 });
      assert.equal(r.status, 200);
      assert.equal(r.body.error, "BACKEND_TIMEOUT");
      assert.equal(r.body.text, undefined);
    },
  ));
