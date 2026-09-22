import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { safeError } from "../src/runtime/errors.js";
import { Client } from "../src/katafit/client.js";
for (const code of [
  "DISCOVERY_REJECTED",
  "CAPABILITIES_REJECTED",
  "SCHEMA_REJECTED",
  "ARGUMENTS_REJECTED",
  "TOOL_BUDGET_EXHAUSTED",
  "RESULT_REJECTED",
  "READ_UNAVAILABLE",
]) {
  test(`safe local ${code} is not collapsed into generic failure`, () => {
    assert.equal(safeError(new Error(code)).code, code);
    assert.ok(safeError(new Error(code)).hint.length > 10);
  });
}
test("arbitrary message, code and cause are never copied into diagnostics", () => {
  const e = Object.assign(new Error("PRIVATE prompt"), {
    code: "PRIVATE-key",
    cause: { status: 401, body: "PRIVATE" },
  });
  assert.equal(safeError(e).code, "REQUEST_FAILED");
  assert.ok(!JSON.stringify(safeError(e)).includes("PRIVATE"));
});
test("backend wire deadline is BACKEND_TIMEOUT, not provider timeout", async () => {
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.flushHeaders();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const c = new Client(
      `http://127.0.0.1:${(server.address() as any).port}`,
      "synthetic",
      new AbortController().signal,
    );
    await assert.rejects(c.call("coach_read_context", {}, 50), (e: any) => {
      assert.equal(e.code, "BACKEND_TIMEOUT");
      return true;
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
