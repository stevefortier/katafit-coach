import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/config/store.js";
import { LocalMcp } from "../src/mcp/local.js";
import { admin } from "../src/server/admin.js";

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

test("local registration remains private and inert until backend authority exists", async () => {
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
    assert.deepEqual(discovery.tools, []);
    assert.deepEqual(peer.calls, []);
    discovery.dispose();
    await local.remove(record.id);
    assert.equal(local.list().length, 0);
  } finally {
    await peer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Dojo registrations never contact local endpoints or expose mutation tools without backend authority", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coach-local-mcp-"));
  const peer = await fixture();
  try {
    const store = new Store(dir);
    await store.init();
    const local = new LocalMcp(store);
    await local.add({ label: "Unverified", url: peer.url });
    const discovery = await local.discover("dojo", AbortSignal.timeout(5000));
    assert.deepEqual(discovery.tools, []);
    assert.deepEqual(peer.calls, []);
    discovery.dispose();
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
