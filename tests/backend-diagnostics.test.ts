import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "../src/katafit/client.js";
import {
  Diagnostics,
  LOG_ENTRIES,
  type LogInput,
} from "../src/diagnostics/log.js";
import { fixture } from "./helpers/native.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { admin } from "../src/server/admin.js";

test("authenticated Studio connect and roster calls reach persisted Diagnostics", async () => {
  const f = await fixture((name, result) =>
    name === "studio_list_members"
      ? {
          schema_version: 1,
          owner_type: "dojo",
          members: [],
          has_more: false,
          next_cursor: null,
        }
      : result,
  );
  const app = await admin(f.store, 0);
  const headers = {
    Authorization: "Bearer " + f.store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  try {
    assert.equal(
      (
        await fetch(app.origin + "/api/connect", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      200,
    );
    assert.equal(
      (await fetch(app.origin + "/api/members", { headers })).status,
      200,
    );
    const snapshot = await (
      await fetch(app.origin + "/api/logs", { headers })
    ).json();
    const receipts = snapshot.entries.filter(
      (e: any) => e.stage === "backend-call",
    );
    assert.equal(receipts.length, f.calls.length);
    assert.ok(
      receipts.some((e: any) => e.backendCall.tool === "studio_list_members"),
    );
    assert.ok(
      receipts.every(
        (e: any) => e.level === "verbose" && e.metadata.statusCode === 200,
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(receipts),
      /synthetic-backend-credential|fixture-member|127\.0\.0/,
    );
    assert.deepEqual(
      new Diagnostics(f.store.dir)
        .snapshot()
        .entries.filter((e) => e.stage === "backend-call"),
      receipts,
    );
  } finally {
    await app.close();
    await f.close();
  }
});

test("native REST read and close never open legacy MCP sessions", async () => {
  const f = await fixture();
  const rows: LogInput[] = [];
  let gateway;
  try {
    gateway = await openNativeGateway(f.store, undefined, {
      onDiagnostic: (e) => rows.push(e),
    });
    await gateway.handle({
      kind: "tool",
      name: "katafit_rest_request",
      args: { method: "GET", path: "/api/docs/coach" },
    });
    await gateway.close();
    assert.equal(f.calls.filter((c) => c.path === "/api/docs/coach").length, 1);
    assert.equal(
      f.calls.filter((c) => c.path === "/api/agents/coach/mcp").length,
      0,
    );
    assert.equal(rows.filter((e) => e.backendCall?.route === "mcp").length, 0);
  } finally {
    await gateway?.close();
    await f.close();
  }
});

test("retains newest ordinary call rows through restart", async () => {
  const dir = await mkdtemp(tmpdir() + "/backend-retention-");
  try {
    const log = new Diagnostics(dir);
    for (let i = 0; i < LOG_ENTRIES + 1000; i++)
      log.record({
        source: "backend",
        stage: "backend-call",
        level: "verbose",
        backendCall: {
          route: "mcp",
          method: "POST",
          operation: "tools/call",
          tool: "coach_list_requests",
          outcome: "ok",
        },
        metadata: {
          elapsedMs: i,
          statusCode: 200,
          responseBytes: 234,
          budgetMs: 25000,
        },
      });
    for (const snapshot of [log.snapshot(), new Diagnostics(dir).snapshot()]) {
      assert.equal(snapshot.capacity, LOG_ENTRIES);
      assert.equal(snapshot.entries.length, LOG_ENTRIES);
      assert.equal(snapshot.entries[0].metadata.elapsedMs, 1000);
      assert.equal(snapshot.entries.at(-1)?.level, "verbose");
      assert.equal(
        snapshot.entries.at(-1)?.backendCall?.tool,
        "coach_list_requests",
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("raw RPC malformed result is diagnosed without changing its return semantics", async () => {
  const rows: LogInput[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const c = new Client(
      `http://127.0.0.1:${(server.address() as any).port}`,
      "token",
      new AbortController().signal,
      (e) => rows.push(e),
    );
    assert.equal(await c.rpc("tools/list"), undefined);
    assert.equal(rows[0].backendCall?.outcome, "protocol_error");
    assert.equal(rows[0].level, "warn");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("structured application isError is not confused with the MCP envelope", async () => {
  const rows: LogInput[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { structuredContent: { isError: true, value: 1 } },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const c = new Client(
      `http://127.0.0.1:${(server.address() as any).port}`,
      "token",
      new AbortController().signal,
      (e) => rows.push(e),
    );
    assert.deepEqual(await c.call("coach_list_requests", {}), {
      isError: true,
      value: 1,
    });
    assert.equal(rows[0].backendCall?.outcome, "ok");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("one sanitized backend receipt includes delayed body and survives signal cloning", async () => {
  const rows: LogInput[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"jsonrpc":"2.0",');
    setTimeout(
      () =>
        res.end(
          JSON.stringify({
            id: body.id,
            result: { structuredContent: { secret: "DO_NOT_LOG" } },
          }).slice(1),
        ),
      60,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = new Client(
      `http://127.0.0.1:${(server.address() as any).port}`,
      "PRIVATE_TOKEN",
      new AbortController().signal,
      (e: LogInput) => rows.push(e),
    );
    const value = await client
      .withSignal()
      .call("coach_list_requests", { secret: "DO_NOT_LOG" });
    assert.equal(value.secret, "DO_NOT_LOG");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].level, "verbose");
    assert.equal(rows[0].stage, "backend-call");
    assert.ok(Number(rows[0].metadata?.elapsedMs) >= 50);
    assert.deepEqual(rows[0].backendCall, {
      route: "mcp",
      method: "POST",
      operation: "tools/call",
      tool: "coach_list_requests",
      outcome: "ok",
    });
    assert.doesNotMatch(
      JSON.stringify(rows),
      /PRIVATE_TOKEN|DO_NOT_LOG|127\.0\.0/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
