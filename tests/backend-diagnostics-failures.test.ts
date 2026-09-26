import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client, ToolFailure } from "../src/katafit/client.js";
import { Diagnostics, type LogInput } from "../src/diagnostics/log.js";

async function scenario(
  mode: string,
  invoke: (
    client: Client,
    rows: LogInput[],
    stop: AbortController,
  ) => Promise<void>,
  sinkThrows = false,
) {
  const rows: LogInput[] = [];
  const stop = new AbortController();
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const request = raw ? JSON.parse(raw) : {};
    if (mode === "http")
      return void res.writeHead(503).end("PRIVATE_BACKEND_BODY");
    if (mode === "auth")
      return void res.writeHead(401).end("PRIVATE_BACKEND_BODY");
    if (mode === "network") return void req.socket.destroy();
    if (mode === "timeout" || mode === "cancel") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"jsonrpc":"2.0",');
      if (mode === "cancel") stop.abort();
      return;
    }
    if (mode === "large") return void res.end("X".repeat(300));
    if (mode === "invalid-json") return void res.end("PRIVATE_MALFORMED_BODY");
    if (mode === "instructions") return void res.end("PRIVATE_INSTRUCTIONS");
    const result =
      mode === "tool"
        ? {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  code: "OPERATOR_NOT_AUTHORIZED",
                  context_revoked: true,
                  private: "PRIVATE_BACKEND_BODY",
                }),
              },
            ],
          }
        : mode === "invalid-tool"
          ? { content: [{ type: "text", text: "PRIVATE_MALFORMED_BODY" }] }
          : { structuredContent: { ok: true } };
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: mode === "wrong-id" ? -1 : request.id,
        ...(mode === "rpc-error"
          ? { error: { code: -1, message: "PRIVATE_BACKEND_BODY" } }
          : { result }),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await invoke(
      new Client(origin, "PRIVATE_TOKEN", stop.signal, (event) => {
        rows.push(event);
        if (sinkThrows) throw new Error("PRIVATE_LOG_FAILURE");
      }),
      rows,
      stop,
    );
    assert.equal(rows.length, 1, "one receipt per physical attempt");
    assert.ok(Number.isFinite(rows[0].metadata?.elapsedMs));
    assert.ok(Number(rows[0].metadata?.elapsedMs) >= 0);
    assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_|127\.0\.0/);
  } finally {
    stop.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

for (const [mode, outcome, code] of [
  ["http", "http_error", "CONNECTIVITY_ERROR"],
  ["auth", "http_error", "CREDENTIAL_REJECTED"],
  ["network", "network_error", "CONNECTIVITY_ERROR"],
  ["timeout", "timeout", "BACKEND_TIMEOUT"],
  ["cancel", "cancelled", "CANCELLED"],
  ["wrong-id", "protocol_error", "MCP_PROTOCOL_ERROR"],
  ["rpc-error", "protocol_error", "MCP_PROTOCOL_ERROR"],
] as const) {
  test(`backend receipt preserves ${mode} classification and original failure`, async () => {
    await scenario(mode, async (client, rows) => {
      await assert.rejects(
        client.rpc("tools/list", {}, false, mode === "timeout" ? 300 : 1000),
        (error) => (error as Error).message === code,
      );
      assert.equal(rows[0].backendCall?.outcome, outcome);
      assert.equal(rows[0].level, "warn");
      if (["http", "auth"].includes(mode))
        assert.equal(rows[0].metadata?.statusCode, mode === "http" ? 503 : 401);
      if (mode === "timeout") {
        assert.equal(rows[0].metadata?.statusCode, 200);
        assert.ok(
          Number(rows[0].metadata?.elapsedMs) >= 70,
          "timing includes stalled body",
        );
        assert.ok(Number(rows[0].metadata?.responseBytes) > 0);
      }
    });
  });
}

for (const mode of ["invalid-json", "invalid-tool"]) {
  test(`backend receipt classifies ${mode} without exporting raw syntax error`, async () => {
    await scenario(mode, async (client, rows) => {
      await assert.rejects(client.call("coach_list_requests", {}), SyntaxError);
      assert.equal(rows[0].backendCall?.outcome, "protocol_error");
    });
  });
}

test("HTTP 200 tool failures are visible for raw rpc and typed call without changing return semantics", async () => {
  await scenario("tool", async (client, rows) => {
    const result = await client.rpc("tools/call", {
      name: "studio_read_member_media",
      arguments: { private: "PRIVATE_ARGS" },
    });
    assert.equal(result.isError, true);
    assert.equal(rows[0].backendCall?.outcome, "tool_error");
    assert.equal(rows[0].backendCall?.tool, "studio_read_member_media");
    assert.equal(rows[0].metadata?.statusCode, 200);
  });
  await scenario("tool", async (client, rows) => {
    await assert.rejects(
      client.call("coach_list_requests", {}),
      (error) =>
        error instanceof ToolFailure &&
        error.contextRevoked &&
        error.code === "OPERATOR_NOT_AUTHORIZED",
    );
    assert.equal(rows[0].backendCall?.outcome, "tool_error");
  });
});

test("body size rejection emits one receipt with consumed byte count", async () => {
  await scenario("large", async (client, rows) => {
    await assert.rejects(
      client.rpc("tools/list", {}, false, 1000, 50),
      /RESPONSE_TOO_LARGE/,
    );
    assert.equal(rows[0].backendCall?.outcome, "response_too_large");
    assert.ok(Number(rows[0].metadata?.responseBytes) > 50);
  });
});

test("instruction fetch and throwing diagnostic sink preserve successful return value", async () => {
  await scenario(
    "instructions",
    async (client, rows) => {
      const result = await client.fetch("/api/agents/coach.md");
      assert.equal(result.text, "PRIVATE_INSTRUCTIONS");
      assert.equal(rows[0].backendCall?.route, "instructions");
      assert.equal(rows[0].backendCall?.method, "GET");
      assert.equal(rows[0].backendCall?.outcome, "ok");
    },
    true,
  );
  await scenario(
    "http",
    async (client, rows) => {
      await assert.rejects(client.rpc("tools/list"), /CONNECTIVITY_ERROR/);
      assert.equal(rows[0].backendCall?.outcome, "http_error");
    },
    true,
  );
});

test("untrusted restored call descriptors cannot expose arbitrary names or fields", async () => {
  const dir = await mkdtemp(tmpdir() + "/backend-untrusted-log-");
  try {
    await writeFile(
      dir + "/diagnostics.jsonl",
      JSON.stringify({
        time: "2026-09-26T21:30:00.000Z",
        source: "backend",
        stage: "backend-call",
        level: "verbose",
        backendCall: {
          route: "mcp",
          method: "POST",
          operation: "PRIVATE_OPERATION",
          tool: "coach_PRIVATE_TOKEN",
          outcome: "ok",
          arguments: "PRIVATE_ARGS",
          url: "https://PRIVATE_ORIGIN",
        },
        metadata: {
          elapsedMs: 32,
          statusCode: 200,
          responseBytes: 4,
          budgetMs: 1000,
          token: "PRIVATE_TOKEN",
        },
      }) + "\n",
      { mode: 0o600 },
    );
    const snapshot = new Diagnostics(dir).snapshot();
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0].backendCall?.tool, "other");
    assert.equal(snapshot.entries[0].backendCall?.operation, "other");
    assert.equal(snapshot.entries[0].level, "verbose");
    assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
