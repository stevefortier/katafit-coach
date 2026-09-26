import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/native.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";
import { Actions } from "../src/chat/actions.js";

test("native provider result is withheld after backend authorization changes during inference", async () => {
  let revoked = false;
  const f = await fixture((name, result) => {
    if (name === "provider") revoked = true;
    if (name === "studio_operator_list_members" && revoked)
      return { schema_version: 1, error: "not_authorized" };
    return result;
  });
  const gateway = await openNativeGateway(f.store);
  try {
    await gateway.handle({
      kind: "tool",
      name: "studio_operator_list_members",
      args: {},
    });
    await assert.rejects(
      gateway.handle({
        kind: "provider",
        body: { model: "approved-custom-model", messages: [] },
      }),
    );
    assert.equal(
      f.calls.filter((c) => c.path === "/v1/chat/completions").length,
      1,
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

test("native MCP catalog consumes bounded pages, rejects repeated cursors", async () => {
  let repeated = false;
  const f = await fixture((name, result, body) => {
    if (name === "tools/list")
      return body.params?.cursor
        ? {
            tools: result.tools.slice(2),
            ...(repeated ? { nextCursor: "next" } : {}),
          }
        : { tools: result.tools.slice(0, 2), nextCursor: "next" };
    return result;
  });
  try {
    const gateway = await openNativeGateway(f.store);
    assert.equal((await gateway.handle({ kind: "catalog" })).tools.length, 1);
    await gateway.close();
    repeated = true;
    await assert.rejects(openNativeGateway(f.store), /MCP_CATALOG_REJECTED/);
  } finally {
    await f.close();
  }
});

test("uncertain native mutation persists before dispatch and cannot be replayed after restart", async () => {
  let pendingAtDispatch = false;
  const f = await fixture((name, result) => {
    if (name === "tools/list")
      result.tools.push(
        { name: "studio_operator_send_message" },
        { name: "studio_operator_get_action" },
      );
    if (name === "studio_operator_open_session")
      result.allowed_tools.push("studio_operator_send_message");
    if (name === "studio_operator_send_message") {
      pendingAtDispatch = new Actions(f.store)
        .snapshot()
        .some((a) => a.status === "pending");
      return { schema_version: 1, status: "unknown" };
    }
    return result;
  });
  const gateway = await openNativeGateway(f.store);
  try {
    const request = {
      kind: "tool",
      name: "studio_operator_send_message",
      args: {
        member_ref: "fixture-member",
        text: "Synthetic authorized action",
      },
    };
    await assert.rejects(gateway.handle(request));
    await assert.rejects(gateway.handle(request));
    assert.equal(pendingAtDispatch, true);
    assert.equal(
      f.calls.filter(
        (c) => c.body.params?.name === "studio_operator_send_message",
      ).length,
      1,
    );
    await gateway.close();
    assert.ok(
      new Actions(f.store).snapshot().some((a) => a.status === "unknown"),
    );
    await assert.rejects(openNativeGateway(f.store), /DELIVERY_UNVERIFIED/);
  } finally {
    await gateway.close();
    await f.close();
  }
});

test("scoped native gateway negotiates MCP and never accepts a proxy destination or backend session", async () => {
  const f = await fixture();
  let gateway: any;
  try {
    const module = await import("../src/sandbox/gateway.js");
    gateway = await module.openNativeGateway(f.store);
    const catalog = await gateway.handle({ kind: "catalog" });
    assert.equal(catalog.model, "approved-custom-model");
    assert.deepEqual(
      catalog.tools.map((t: any) => t.name),
      ["studio_operator_list_members"],
    );
    assert.doesNotMatch(
      JSON.stringify(catalog),
      /synthetic-.*credential|native-fixture-session/,
    );
    const result = await gateway.handle({
      kind: "tool",
      name: "studio_operator_list_members",
      args: {},
    });
    assert.match(JSON.stringify(result), /Synthetic Alice/);
    const call = f.calls.find(
      (c) => c.body.params?.name === "studio_operator_list_members",
    );
    assert.equal(call.auth, "Bearer synthetic-backend-credential");
    assert.equal(
      call.body.params.arguments.session_id,
      "native-fixture-session",
    );
    await assert.rejects(
      gateway.handle({
        kind: "tool",
        name: "studio_operator_list_members",
        args: { session_id: "foreign" },
      }),
    );
    await assert.rejects(
      gateway.handle({ kind: "tool", name: "coach_poll", args: {} }),
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
    await gateway.close();
    await assert.rejects(gateway.handle({ kind: "catalog" }));
  } finally {
    await gateway?.close();
    await f.close();
  }
});
