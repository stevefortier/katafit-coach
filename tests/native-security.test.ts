import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/native.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";

const reserved = [
  "session_id",
  "idempotency_key",
  "credential_id",
  "owner_id",
  "user_id",
  "dojo_id",
  "mode",
];

test("live catalog contains ordinary REST, not arbitrary backend MCP reads", async () => {
  const f = await fixture();
  const gateway = await openNativeGateway(f.store);
  try {
    const catalog = await gateway.handle({ kind: "catalog" });
    const names = catalog.tools.map((tool: any) => tool.name);
    assert.deepEqual(names, ["katafit_rest_request"]);
    assert.equal(
      f.calls.filter((call) => call.path === "/api/agents/coach/mcp").length,
      0,
    );
  } finally {
    await gateway.close();
    await f.close();
  }
});

test("REST request rejects injected host authority and secrets before backend dispatch", async () => {
  const f = await fixture();
  const gateway = await openNativeGateway(f.store);
  try {
    for (const key of reserved) {
      await assert.rejects(
        gateway.handle({
          kind: "tool",
          name: "katafit_rest_request",
          args: {
            method: "GET",
            path: "/api/friends/feed/dojo",
            [key]: "foreign",
          },
        }),
      );
    }
    await assert.rejects(
      gateway.handle({
        kind: "tool",
        name: "katafit_rest_request",
        args: {
          method: "GET",
          path: "/api/synthetic-backend-credential",
        },
      }),
      /SECRET_IN_CONFIG/,
    );
    assert.equal(f.calls.filter((call) => call.method === "GET").length, 0);
    const ok = await gateway.handle({
      kind: "tool",
      name: "katafit_rest_request",
      args: {
        method: "GET",
        path: "/api/friends/feed/dojo",
      },
    });
    assert.ok(ok);
    assert.deepEqual(
      f.calls.filter((call) => call.method === "GET").map((call) => call.path),
      ["/api/friends/feed/dojo"],
    );
  } finally {
    await gateway.close();
    await f.close();
  }
});

test("configured credentials cannot be saved into the active persona", async () => {
  const f = await fixture();
  try {
    const config = f.store.publicConfig();
    await assert.rejects(
      f.store.save({
        ...config,
        persona: { ...config.persona, name: "synthetic-backend-credential" },
      }),
      /SECRET_IN_CONFIG/,
    );
    assert.equal(
      f.calls.filter((call) => call.path === "/v1/chat/completions").length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("catalog and provider reject configured credentials without upstream disclosure", async () => {
  const f = await fixture();
  const gateway = await openNativeGateway(f.store);
  try {
    const catalog = await gateway.handle({ kind: "catalog" });
    assert.doesNotMatch(
      JSON.stringify(catalog),
      /synthetic-backend-credential/,
    );
    await assert.rejects(
      gateway.handle({
        kind: "provider",
        body: {
          model: "approved-custom-model",
          messages: [{ role: "user", content: "synthetic-backend-credential" }],
        },
      }),
      /SECRET_IN_CONFIG/,
    );
    assert.equal(
      f.calls.filter((call) => call.path === "/v1/chat/completions").length,
      0,
    );
  } finally {
    await gateway.close();
    await f.close();
  }
});
