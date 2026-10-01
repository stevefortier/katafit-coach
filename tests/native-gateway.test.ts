import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/native.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";

test("native provider retains already acquired REST data when its source is revoked", async () => {
  let revoked = false;
  const f = await fixture(
    (name, result, body) => {
      if (name === "provider") {
        revoked = true;
        assert.match(JSON.stringify(body.messages), /Synthetic Alice/);
        return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Previously acquired roster remains internal Coach data." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
      }
      return result;
    },
    (url) =>
      url === "/api/dojos/current/members"
        ? {
            status: revoked ? 403 : 200,
            body: JSON.stringify({
              members: [{ display_name: "Synthetic Alice" }],
            }),
          }
        : { status: 404 },
  );
  const gateway = await openNativeGateway(f.store);
  try {
    const request = {
      kind: "tool",
      name: "katafit_rest_request",
      args: { method: "GET", path: "/api/dojos/current/members" },
    };
    const acquired = await gateway.handle(request);
    assert.match(JSON.stringify(acquired), /Synthetic Alice/);
    const completion = await gateway.handle({
      kind: "provider",
      body: {
        model: "approved-custom-model",
        messages: [{ role: "user", content: JSON.stringify(acquired) }],
      },
    });
    assert.match(
      JSON.stringify(completion),
      /Previously acquired roster remains internal Coach data/,
    );
    assert.deepEqual(await gateway.handle(request), {
      restReadError: { status: 403 },
    });
    assert.equal(
      f.calls.filter((c) => c.path === "/api/dojos/current/members").length,
      2,
    );
    assert.equal(
      f.calls.filter((c) => c.path === "/v1/chat/completions").length,
      1,
    );
    assert.equal(
      f.calls.filter((c) => c.path === "/api/agents/coach/mcp").length,
      0,
    );
  } finally {
    await gateway.close();
    await f.close();
  }
});

test("known credentials echoed by provider cannot enter the sandbox transcript", async () => {
  const f = await fixture((name, result) =>
    name === "provider" ? "synthetic-backend-credential" : result,
  );
  const gateway = await openNativeGateway(f.store);
  try {
    await assert.rejects(
      gateway.handle({
        kind: "provider",
        body: { model: "approved-custom-model", messages: [] },
      }),
      /SECRET_IN_CONFIG/,
    );
  } finally {
    await gateway.close();
    await f.close();
  }
});

test("native catalog exposes only REST and rejects proxy destinations and unknown tools", async () => {
  const f = await fixture();
  const gateway = await openNativeGateway(f.store);
  try {
    const catalog = await gateway.handle({ kind: "catalog" });
    assert.equal(catalog.model, "approved-custom-model");
    assert.deepEqual(
      catalog.tools.map((t: { name: string }) => t.name),
      ["katafit_rest_request"],
    );
    assert.doesNotMatch(
      JSON.stringify(catalog),
      /synthetic-.*credential|native-fixture-session/,
    );
    await assert.rejects(
      gateway.handle({
        kind: "tool",
        name: "studio_operator_list_members",
        args: {},
      }),
      /NATIVE_TOOL_REJECTED/,
    );
    await assert.rejects(
      gateway.handle({ kind: "tool", name: "coach_poll", args: {} }),
      /NATIVE_TOOL_REJECTED/,
    );
    await assert.rejects(
      gateway.handle({
        kind: "provider",
        url: "http://169.254.169.254",
        body: { model: catalog.model, messages: [] },
      }),
    );
    await gateway.handle({
      kind: "provider",
      body: { model: catalog.model, messages: [] },
    });
    assert.equal(
      f.calls.filter((c) => c.path === "/v1/chat/completions").length,
      1,
    );
    assert.equal(
      f.calls.find((c) => c.path === "/v1/chat/completions").auth,
      "Bearer synthetic-provider-credential",
    );
    assert.equal(
      f.calls.filter((c) => c.path === "/api/agents/coach/mcp").length,
      0,
    );
    await gateway.close();
    await assert.rejects(gateway.handle({ kind: "catalog" }));
  } finally {
    await gateway.close();
    await f.close();
  }
});
