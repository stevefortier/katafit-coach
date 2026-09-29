import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/native.js";
import { openNativeGateway } from "./helpers/legacy-gateway.js";
import { Actions } from "../src/chat/actions.js";

test("native provider retains acquired data when source authorization changes during inference", async () => {
  let revoked = false;
  const f = await fixture((name, result, body) => {
    if (name === "provider") {
      revoked = true;
      assert.match(JSON.stringify(body.messages), /Synthetic Alice/);
      return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Previously acquired roster remains internal Coach data." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    }
    if (name === "studio_operator_list_members" && revoked)
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ code: "OPERATOR_NOT_AUTHORIZED" }),
          },
        ],
      };
    return result;
  });
  const gateway = await openNativeGateway(f.store);
  try {
    const acquired = await gateway.handle({
      kind: "tool",
      name: "studio_operator_list_members",
      args: {},
    });
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
    assert.equal(
      f.calls.filter((c) => c.path === "/v1/chat/completions").length,
      1,
    );
    await assert.rejects(
      gateway.handle({
        kind: "tool",
        name: "studio_operator_list_members",
        args: {},
      }),
      /MCP_TOOL_FAILED/,
    );
    assert.equal(
      f.calls.filter(
        (c) => c.body.params?.name === "studio_operator_list_members",
      ).length,
      2,
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
    assert.equal((await gateway.handle({ kind: "catalog" })).tools.length, 3);
    await gateway.handle({
      kind: "tool",
      name: "studio_operator_list_members",
      args: {},
    });
    await gateway.close();
    repeated = true;
    const next = await openNativeGateway(f.store);
    try {
      await assert.rejects(
        next.handle({
          kind: "tool",
          name: "studio_operator_list_members",
          args: {},
        }),
        /MCP_CATALOG_REJECTED/,
      );
    } finally {
      await next.close();
    }
  } finally {
    await f.close();
  }
});

test("uncertain native mutation is recorded before dispatch and not replayed in the same session", async () => {
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
  } finally {
    await gateway.close();
    await f.close();
  }
});

test("scoped native gateway negotiates MCP and never accepts a proxy destination or backend session", async () => {
  const f = await fixture();
  let gateway: any;
  try {
    const module = await import("./helpers/legacy-gateway.js");
    gateway = await module.openNativeGateway(f.store);
    const catalog = await gateway.handle({ kind: "catalog" });
    assert.equal(catalog.model, "approved-custom-model");
    assert.deepEqual(
      catalog.tools.map((t: any) => t.name),
      [
        "katafit_rest_request",
        "studio_operator_list_members",
        "studio_operator_send_message",
      ],
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
