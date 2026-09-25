import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/native.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";

test("generic reads without a backend source-authorization contract fail before private hydration", async () => {
  const generic = "studio_operator_future_read";
  const f = await fixture((name, result) => {
    if (name === "tools/list")
      result.tools.push({
        name: generic,
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: true,
        },
      });
    if (name === "studio_operator_open_session") {
      result.allowed_tools.push(generic);
      result.capabilities = {
        version: 1,
        tools: result.allowed_tools.map((name: string) => ({
          name,
          schema_ref: `mcp:tools/list#${name}`,
          kind: "read",
          target: "dojo",
          domain: "context",
          coverage: "current",
          pagination: { type: "none" },
          side_effect: "none",
          receipt: "none",
        })),
      };
    }
    if (name === generic)
      return {
        schema_version: 1,
        private_context: "synthetic retained private source",
      };
    return result;
  });
  let gateway!: Awaited<ReturnType<typeof openNativeGateway>>;
  try {
    gateway = await openNativeGateway(f.store);
    await assert.rejects(
      gateway.handle({ kind: "tool", name: generic, args: {} }),
      /SOURCE_AUTHORIZATION_UNSUPPORTED/,
    );
    assert.equal(
      f.calls.filter((c) => c.body.params?.name === generic).length,
      0,
      "never hydrate a source we cannot reauthorize",
    );
    // Mixed-source path: supported legacy reads still use their retained fence.
    await gateway.handle({
      kind: "tool",
      name: "studio_operator_list_members",
      args: {},
    });
    await gateway.handle({
      kind: "provider",
      body: { model: "approved-custom-model", messages: [] },
    });
    assert.equal(
      f.calls.filter(
        (c) => c.body.params?.name === "studio_operator_list_members",
      ).length,
      3,
    );
  } finally {
    await gateway?.close();
    await f.close();
  }
});

test("every legacy adapter and generic write rejects caller authority under permissive schemas", async () => {
  const legacy = [
    "studio_operator_list_members",
    "studio_operator_read_member_coach_feed",
    "studio_operator_send_message",
    "studio_operator_list_activities",
    "studio_operator_read_activity",
    "studio_operator_list_dojo_checkins",
    "studio_operator_read_dojo_checkin_image",
  ];
  const generic = "studio_operator_future_write";
  const names = [...legacy, generic];
  const f = await fixture((name, result) => {
    if (name === "tools/list") {
      result.tools = result.tools.filter((t: any) => !names.includes(t.name));
      result.tools.push(
        ...names.map((name) => ({
          name,
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: true,
          },
        })),
        { name: "studio_operator_get_action" },
      );
    }
    if (name === "studio_operator_open_session") {
      result.allowed_tools = names;
      result.capabilities = {
        version: 1,
        tools: names.map((name) => ({
          name,
          schema_ref: `mcp:tools/list#${name}`,
          kind:
            name.includes("write") || name.includes("send") ? "write" : "read",
          target: "dojo",
          domain: "context",
          coverage: "current",
          pagination: { type: "none" },
          side_effect:
            name.includes("write") || name.includes("send")
              ? "durable_change"
              : "none",
          receipt:
            name.includes("write") || name.includes("send")
              ? "canonical_result"
              : "none",
        })),
      };
    }
    return result;
  });
  let gateway!: Awaited<ReturnType<typeof openNativeGateway>>;
  try {
    gateway = await openNativeGateway(f.store);
    for (const name of names) {
      for (const key of [
        "session_id",
        "idempotency_key",
        "credential_id",
        "owner_id",
        "user_id",
        "dojo_id",
        "mode",
      ]) {
        await assert.rejects(
          gateway.handle({ kind: "tool", name, args: { [key]: "foreign" } }),
          /ARGUMENTS_REJECTED/,
          `${name}: ${key}`,
        );
      }
    }
    assert.equal(
      f.calls.filter((c) => names.includes(c.body.params?.name)).length,
      0,
    );
  } finally {
    await gateway?.close();
    await f.close();
  }
});

for (const location of ["description", "nested-schema"]) {
  test(`complete catalog rejects known credential in ${location}`, async () => {
    const f = await fixture((name, result) => {
      if (name === "tools/list") {
        const tool = result.tools.find(
          (t: any) => t.name === "studio_operator_list_members",
        );
        if (location === "description")
          tool.description = "synthetic-backend-credential";
        else
          tool.inputSchema = {
            type: "object",
            properties: {
              limit: {
                type: "integer",
                description: "synthetic-backend-credential",
              },
            },
          };
      }
      return result;
    });
    const gateway = await openNativeGateway(f.store);
    try {
      await assert.rejects(
        gateway.handle({ kind: "catalog" }),
        /SECRET_IN_CONFIG/,
      );
      assert.equal(
        f.calls.filter((c) => c.path === "/v1/chat/completions").length,
        0,
      );
    } finally {
      await gateway?.close();
      await f.close();
    }
  });
}

for (const schema of [
  { type: "object", properties: {} },
  { type: "object", properties: {}, additionalProperties: true },
  { type: "object", properties: {}, patternProperties: { ".*": {} } },
]) {
  test(`reserved host authority cannot be supplied through schema ${JSON.stringify(schema)}`, async () => {
    const f = await fixture((name, result) => {
      if (name === "tools/list")
        result.tools.find(
          (t: any) => t.name === "studio_operator_list_members",
        ).inputSchema = schema;
      return result;
    });
    const gateway = await openNativeGateway(f.store);
    try {
      for (const key of [
        "session_id",
        "idempotency_key",
        "credential_id",
        "owner_id",
        "user_id",
        "dojo_id",
        "mode",
      ]) {
        await assert.rejects(
          gateway.handle({
            kind: "tool",
            name: "studio_operator_list_members",
            args: { [key]: "foreign" },
          }),
          /ARGUMENTS_REJECTED/,
        );
      }
      assert.equal(
        f.calls.filter(
          (c) => c.body.params?.name === "studio_operator_list_members",
        ).length,
        0,
      );
      await gateway.handle({
        kind: "tool",
        name: "studio_operator_list_members",
        args: {},
      });
      await gateway.handle({
        kind: "provider",
        body: { model: "approved-custom-model", messages: [] },
      });
      const reads = f.calls.filter(
        (c) => c.body.params?.name === "studio_operator_list_members",
      );
      assert.equal(reads.length, 3);
      assert.ok(
        reads.every(
          (c) =>
            c.body.params.arguments.session_id === "native-fixture-session",
        ),
      );
    } finally {
      await gateway?.close();
      await f.close();
    }
  });
}
