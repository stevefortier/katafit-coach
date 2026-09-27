import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

async function fixture() {
  const dir = await mkdtemp(tmpdir() + "/memory-admin-correction-");
  const store = new Store(dir);
  await store.init();
  const calls: string[] = [];
  let handle = async (_name: string) => ({
    private_text: "prior-owner-private-prose",
  });
  const backend = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const rpc = JSON.parse(raw);
    let result: any = {};
    if (rpc.method === "initialize") result = { protocolVersion: "2025-03-26" };
    if (rpc.method === "tools/call") {
      calls.push(rpc.params.name);
      const value = await handle(rpc.params.name);
      result = {
        structuredContent: value,
        content: [{ type: "text", text: JSON.stringify(value) }],
      };
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(backend.address() as any).port}`,
    token: "synthetic-backend-secret",
    apiKey: "synthetic-provider-secret",
  });
  const app = await admin(store, 0);
  return {
    store,
    calls,
    hold: (h: typeof handle) => {
      handle = h;
    },
    request: (path: string, body?: unknown) =>
      fetch(app.origin + "/api/memories" + path, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: "Bearer " + store.secrets.admin,
          Origin: app.origin,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    close: async () => {
      await app.close();
      backend.closeAllConnections();
      await new Promise((r) => backend.close(r));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
for (const path of [
  "",
  "/000000000000000000000001",
  "/000000000000000000000001/forget",
]) {
  test(`memory ${path || "list"} fences replaced credential before disclosing response`, async () => {
    const f = await fixture();
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((r) => {
      entered = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    f.hold(async () => {
      entered();
      await held;
      return { private_text: "prior-owner-private-prose" };
    });
    try {
      const request = f.request(
        path,
        path.endsWith("forget") ? { expected_revision: 1 } : undefined,
      );
      await waiting;
      await f.store.save({
        ...f.store.publicConfig(),
        token: "synthetic-replacement-secret",
      });
      release();
      const response = await request;
      assert.notEqual(response.status, 200);
      assert.doesNotMatch(await response.text(), /prior-owner-private-prose/);
    } finally {
      release();
      await f.close();
    }
  });
}
test("memory create and update reject every configured secret before dispatch", async () => {
  const f = await fixture();
  try {
    for (const secret of Object.values(f.store.secrets)) {
      if (!secret) continue;
      for (const path of ["", "/000000000000000000000001"]) {
        const response = await f.request(path, {
          audience: "operator_private",
          kind: "fact",
          text: "Remember " + secret,
          expected_revision: 1,
        });
        assert.notEqual(response.status, 200);
      }
    }
    assert.deepEqual(f.calls, []);
  } finally {
    await f.close();
  }
});
