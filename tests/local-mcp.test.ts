import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/config/store.js";
import { LocalMcp } from "../src/mcp/local.js";
import { admin } from "../src/server/admin.js";
import { complete } from "../src/runtime/piAdapter.js";

async function fixture(
  schema: any = {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
) {
  const calls: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push({ body, auth: req.headers.authorization });
    if (body.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result:
          body.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "change",
                    description: "Change a fixture",
                    inputSchema: schema,
                  },
                ],
              }
            : body.method === "tools/call"
              ? { content: [{ type: "text", text: "changed" }] }
              : {
                  protocolVersion: "2025-03-26",
                  capabilities: {},
                  serverInfo: { name: "fixture", version: "1" },
                },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    calls,
    url: `http://127.0.0.1:${(server.address() as any).port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("local registration is private, dojo-only, model selected and revoked at dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coach-local-mcp-"));
  const peer = await fixture();
  try {
    const store = new Store(dir);
    await store.init();
    const local = new LocalMcp(store);
    const record = await local.add({
      label: "Fixture",
      url: peer.url,
      bearer: "fixture-private-key",
    });
    assert.equal(
      JSON.stringify(local.list()).includes("fixture-private-key"),
      false,
    );
    assert.equal(
      (await readFile(join(dir, "local-mcp.json"), "utf8")).includes(
        "fixture-private-key",
      ),
      true,
    );
    assert.equal(
      (await local.discover("personal", new AbortController().signal)).tools
        .length,
      0,
    );
    const discovery = await local.discover(
      "dojo",
      new AbortController().signal,
    );
    assert.equal(discovery.tools.length, 1);
    const tool = discovery.tools[0];
    assert.match(tool.name, /^local_mcp__[a-f0-9]{16}__change$/);
    await tool.execute("call", { value: "yes" }, new AbortController().signal);
    assert.equal(peer.calls.at(-1).body.method, "tools/call");
    assert.equal(peer.calls.at(-1).auth, "Bearer fixture-private-key");
    await local.remove(record.id);
    await assert.rejects(
      tool.execute("call", { value: "no" }, new AbortController().signal),
    );
    discovery.dispose();
    assert.equal(local.list().length, 0);
  } finally {
    await peer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("registration rejects remote, hostname, credentials, and forbidden ports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coach-local-mcp-"));
  try {
    const local = new LocalMcp(new Store(dir));
    for (const url of [
      "https://example.com/mcp",
      "http://localhost:9999/mcp",
      "http://127.0.0.1:22/mcp",
      "http://127.0.0.1:9999/mcp#x",
      "http://127.0.0.1:9999/mcp?x=1",
    ])
      await assert.rejects(local.add({ label: "x", url }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registration rejects a known credential embedded in a model-visible label", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coach-local-mcp-"));
  try {
    const store = new Store(dir);
    await store.init();
    await assert.rejects(
      new LocalMcp(store).add({
        label: `Server ${store.secrets.admin}`,
        url: "http://127.0.0.1:8765/mcp",
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("untrusted schema regex is rejected before provider sees it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coach-local-mcp-"));
  const peer = await fixture({
    type: "object",
    properties: { value: { type: "string", pattern: "(a+)+$" } },
  });
  try {
    const store = new Store(dir);
    await store.init();
    const local = new LocalMcp(store);
    await local.add({ label: "Unsafe", url: peer.url });
    await assert.rejects(
      local.discover("dojo", AbortSignal.timeout(5000)),
      /MCP_CATALOG_REJECTED/,
    );
  } finally {
    await peer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("authenticated Studio creates and deletes without disclosing bearer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coach-local-mcp-"));
  const peer = await fixture();
  const store = new Store(dir);
  await store.init();
  const app = await admin(store, 0);
  const headers = {
    Authorization: `Bearer ${store.secrets.admin}`,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  try {
    const unauthorized = await fetch(app.origin + "/api/mcp", {
      headers: { Origin: app.origin },
    });
    assert.equal(unauthorized.status, 401);
    const created = await fetch(app.origin + "/api/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        label: "Fixture",
        url: peer.url,
        bearer: "private-bearer",
      }),
    });
    assert.equal(created.status, 200);
    const record = await created.json();
    assert.equal(JSON.stringify(record).includes("private-bearer"), false);
    const listed = await (
      await fetch(app.origin + "/api/mcp", { headers })
    ).json();
    assert.equal(listed.registrations.length, 1);
    const deleted = await fetch(app.origin + "/api/mcp/remove", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: record.id }),
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(
      (await (await fetch(app.origin + "/api/mcp", { headers })).json())
        .registrations,
      [],
    );
  } finally {
    await app.close();
    await peer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("streamable HTTP session handshake precedes discovery and tools/call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coach-local-mcp-"));
  const store = new Store(dir);
  await store.init();
  const seen: string[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const message = JSON.parse(raw);
    seen.push(message.method);
    if (message.method === "initialize")
      res.setHeader("mcp-session-id", "fixture-session");
    else if (
      req.headers["mcp-session-id"] !== "fixture-session" ||
      (message.method === "tools/list" &&
        !seen.includes("notifications/initialized"))
    ) {
      res.writeHead(400).end();
      return;
    }
    if (message.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result:
          message.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "change",
                    description: "change",
                    inputSchema: {
                      type: "object",
                      properties: {},
                      additionalProperties: false,
                    },
                  },
                ],
              }
            : message.method === "tools/call"
              ? { content: [{ type: "text", text: "done" }] }
              : { protocolVersion: "2025-03-26" },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const local = new LocalMcp(store);
    await local.add({
      label: "Session",
      url: `http://127.0.0.1:${(server.address() as any).port}/mcp`,
    });
    const discovery = await local.discover("dojo", AbortSignal.timeout(5000));
    try {
      await discovery.tools[0].execute("call", {}, AbortSignal.timeout(5000));
    } finally {
      discovery.dispose();
    }
    assert.deepEqual(seen, [
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("real Pi selects a namespaced local mutation through synthetic streaming provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coach-local-mcp-"));
  const peer = await fixture();
  const store = new Store(dir);
  await store.init();
  const local = new LocalMcp(store);
  const record = await local.add({
    label: "Fixture",
    url: peer.url,
    bearer: "private-bearer",
  });
  const bodies: any[] = [];
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw));
    const first = bodies.length === 1;
    const delta = first
      ? {
          tool_calls: [
            {
              index: 0,
              id: "call-one",
              type: "function",
              function: {
                name: `local_mcp__${record.id}__change`,
                arguments: JSON.stringify({ value: "yes" }),
              },
            },
          ],
        }
      : { content: "Synthetic final" };
    res.setHeader("content-type", "text/event-stream");
    res.end(
      `data: ${JSON.stringify({ id: "synthetic", choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "synthetic", choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const signal = AbortSignal.timeout(5000);
  const discovered = await local.discover("dojo", signal);
  try {
    const text = await complete(
      {
        baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
        model: "mcp-synthetic",
        apiKey: "synthetic-provider-key",
        secrets: local.secrets(),
      },
      "Dojo Coach",
      "Change fixture",
      signal,
      discovered.tools,
    );
    assert.equal(text, "Synthetic final");
    assert.equal(
      peer.calls.filter((c) => c.body.method === "tools/call").length,
      1,
    );
    assert.deepEqual(peer.calls.at(-1).body.params.arguments, { value: "yes" });
    assert.match(JSON.stringify(bodies[1]), /changed/);
    assert.doesNotMatch(JSON.stringify(bodies), /private-bearer/);
  } finally {
    discovered.dispose();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await peer.close();
    await rm(dir, { recursive: true, force: true });
  }
});
