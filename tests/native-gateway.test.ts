import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/native.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";
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

for (const usageTrailer of [false, true])
  test(`native provider imports backend memory and retains completion with usage trailer=${usageTrailer}`, async () => {
    const memoryId = "1234567890abcdef12345678";
    const stamp = new Date().toISOString();
    const remembered = {
      id: memoryId,
      revision: 1,
      kind: "preference",
      text: "Synthetic Alice prefers short morning check-ins.",
      availability: "available",
      status: "active",
      audience: "operator_private",
      subject: {
        member_ref: "fixture-member",
        display_name: "Synthetic Alice",
      },
      confidence: 0.9,
      importance: 0.8,
      goal_relevance: 0.7,
      review_at: null,
      pinned: false,
      protected: false,
      provenance: {
        type: "derived",
        origin: "operator_turn",
        corrected: false,
        created_by: "model_extraction",
        persona_revision: "1",
      },
      sources: [{ family: "owner", label: "Coach owner authority" }],
      observed_at: stamp,
      created_at: stamp,
      updated_at: stamp,
    };
    const sse = (text: string) =>
      `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n${usageTrailer ? `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } })}\n\n` : ""}data: [DONE]\n\n`;
    const commandExpires = new Date(Date.now() + 600000).toISOString();
    const contextExpires = new Date(Date.now() + 600000).toISOString();
    const f = await fixture((name, result, body) => {
      if (name === "tools/list")
        result.tools.push(
          { name: "studio_operator_authorize_context" },
          { name: "studio_operator_advance_turn" },
          { name: "studio_operator_recall_memories" },
          { name: "studio_operator_record_interaction" },
          { name: "coach_memory_commit" },
        );
      if (name === "studio_operator_open_session")
        Object.assign(result, {
          continuity: {
            version: 1,
            host_controls: [
              "studio_operator_authorize_context",
              "studio_operator_advance_turn",
            ],
            max_turns: 8,
            max_tool_calls_per_turn: 8,
            command_ttl_ms: 600000,
            retained_ttl_ms: 600000,
            failure_requires: "destroy_runtime",
            generation_field: "turn_generation",
          },
          turn_generation: 0,
          expires_at: commandExpires,
          context_expires_at: contextExpires,
          capabilities: {
            version: 1,
            tools: [
              {
                name: "studio_operator_list_members",
                schema_ref: "mcp:tools/list#studio_operator_list_members",
                kind: "read",
                target: "dojo",
                domain: "roster",
                coverage: "current_dojo_members",
                pagination: {
                  type: "cursor",
                  default_limit: 10,
                  max_limit: 100,
                  complete_when: "has_more_false",
                },
                side_effect: "none",
                receipt: "none",
              },
            ],
          },
        });
      if (name === "studio_operator_authorize_context")
        return {
          schema_version: 1,
          session_id: "native-fixture-session",
          turn_generation: 0,
          status: "authorized",
          expires_at: commandExpires,
          context_expires_at: contextExpires,
        };
      if (name === "studio_operator_recall_memories")
        return {
          protocol: "coach.memory.v1",
          session_id: "native-fixture-session",
          turn_generation: 0,
          import_receipt_id: "import-receipt",
          ledger_revision: 1,
          items: [remembered],
        };
      if (name === "studio_operator_record_interaction")
        return {
          protocol: "coach.memory.v1",
          capture_id: "abcdefabcdefabcdefabcdef",
          memory_epoch: 0,
          extraction_expires_at: new Date(Date.now() + 600000).toISOString(),
        };
      if (name === "coach_memory_commit")
        return {
          protocol: "coach.memory.v1",
          capture_id: "abcdefabcdefabcdefabcdef",
          status: "committed",
          memory_epoch: 0,
          created: [{ id: "fedcbafedcbafedcbafedcba", revision: 1 }],
          superseded: [],
          skipped: [],
          idempotent: false,
        };
      if (name === "provider") {
        const system = body.messages
          .filter((m: any) => m.role === "system")
          .map((m: any) => m.content)
          .join("\n");
        if (/You maintain the long-term memory/.test(system))
          return sse(
            JSON.stringify({
              proposals: [
                {
                  kind: "lesson",
                  text: "Synthetic Alice responds well to short morning check-ins.",
                  confidence: 0.8,
                  importance: 0.7,
                },
              ],
            }),
          );
        assert.match(system, /Synthetic Alice prefers short morning check-ins/);
        return sse("I will keep it short and morning-focused.");
      }
      return result;
    });
    const gateway = await openNativeGateway(f.store);
    try {
      const delivered = await gateway.handle({
        kind: "provider",
        body: {
          model: "approved-custom-model",
          messages: [
            { role: "system", content: "Synthetic Coach persona" },
            { role: "user", content: "How should I brief Alice?" },
          ],
        },
      });
      await gateway.confirmDelivery(delivered.completion_id);
      const mainProvider = f.calls.find(
        (c) =>
          c.path === "/v1/chat/completions" &&
          c.body.messages?.some(
            (m: any) => m.content === "How should I brief Alice?",
          ),
      );
      assert.deepEqual(
        mainProvider?.body.messages.map((m: any) => m.role),
        ["system", "user"],
        "recalled memory must share Pi's leading persona message",
      );
      assert.match(
        mainProvider.body.messages[0].content,
        /^Synthetic Coach persona/,
      );
      assert.match(
        mainProvider.body.messages[0].content,
        /Synthetic Alice prefers short morning check-ins/,
      );
      assert.ok(
        f.calls.some(
          (c) => c.body.params?.name === "studio_operator_recall_memories",
        ),
      );
      assert.ok(
        f.calls.some(
          (c) => c.body.params?.name === "studio_operator_record_interaction",
        ),
      );
      const commit = f.calls.find(
        (c) => c.body.params?.name === "coach_memory_commit",
      );
      assert.equal(
        commit.body.params.arguments.proposals[0].text,
        "Synthetic Alice responds well to short morning check-ins.",
      );
    } finally {
      await gateway.close();
      await f.close();
    }
  });

for (const scenario of [
  "recall_denied",
  "record_denied",
  "extraction_revoked",
  "tool_call",
  "truncated",
  "cancel_extraction",
  "record_pending",
  "delivery",
])
  test(`native memory correction ${scenario}`, async () => {
    let revoked = false;
    let entered!: () => void, release!: () => void;
    const extractionEntered = new Promise<void>((r) => {
      entered = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    const cancel = new AbortController();
    const denial = {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: "OPERATOR_NOT_AUTHORIZED",
            context_revoked: true,
          }),
        },
      ],
    };
    const memoryId = "1234567890abcdef12345678";
    const stamp = new Date().toISOString();
    const remembered = {
      id: memoryId,
      revision: 1,
      kind: "preference",
      text: "Synthetic Alice prefers short morning check-ins.",
      availability: "available",
      status: "active",
      audience: "operator_private",
      subject: {
        member_ref: "fixture-member",
        display_name: "Synthetic Alice",
      },
      confidence: 0.9,
      importance: 0.8,
      goal_relevance: 0.7,
      review_at: null,
      pinned: false,
      protected: false,
      provenance: {
        type: "derived",
        origin: "operator_turn",
        corrected: false,
        created_by: "model_extraction",
        persona_revision: "1",
      },
      sources: [{ family: "owner", label: "Coach owner authority" }],
      observed_at: stamp,
      created_at: stamp,
      updated_at: stamp,
    };
    const sse = (text: string) =>
      `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    const commandExpires = new Date(Date.now() + 600000).toISOString();
    const contextExpires = new Date(Date.now() + 600000).toISOString();
    const f = await fixture(async (name, result, body) => {
      if (
        (scenario === "recall_denied" &&
          name === "studio_operator_recall_memories") ||
        (scenario === "record_denied" &&
          name === "studio_operator_record_interaction") ||
        (revoked && name === "studio_operator_authorize_context")
      )
        return denial;
      if (name === "tools/list")
        result.tools.push(
          { name: "studio_operator_authorize_context" },
          { name: "studio_operator_advance_turn" },
          { name: "studio_operator_recall_memories" },
          { name: "studio_operator_record_interaction" },
          { name: "coach_memory_commit" },
        );
      if (name === "studio_operator_open_session")
        Object.assign(result, {
          continuity: {
            version: 1,
            host_controls: [
              "studio_operator_authorize_context",
              "studio_operator_advance_turn",
            ],
            max_turns: 8,
            max_tool_calls_per_turn: 8,
            command_ttl_ms: 600000,
            retained_ttl_ms: 600000,
            failure_requires: "destroy_runtime",
            generation_field: "turn_generation",
          },
          turn_generation: 0,
          expires_at: commandExpires,
          context_expires_at: contextExpires,
          capabilities: {
            version: 1,
            tools: [
              {
                name: "studio_operator_list_members",
                schema_ref: "mcp:tools/list#studio_operator_list_members",
                kind: "read",
                target: "dojo",
                domain: "roster",
                coverage: "current_dojo_members",
                pagination: {
                  type: "cursor",
                  default_limit: 10,
                  max_limit: 100,
                  complete_when: "has_more_false",
                },
                side_effect: "none",
                receipt: "none",
              },
            ],
          },
        });
      if (name === "studio_operator_authorize_context")
        return {
          schema_version: 1,
          session_id: "native-fixture-session",
          turn_generation: 0,
          status: "authorized",
          expires_at: commandExpires,
          context_expires_at: contextExpires,
        };
      if (name === "studio_operator_recall_memories")
        return {
          protocol: "coach.memory.v1",
          session_id: "native-fixture-session",
          turn_generation: 0,
          import_receipt_id: "import-receipt",
          ledger_revision: 1,
          items: [remembered],
        };
      if (
        name === "studio_operator_record_interaction" &&
        scenario === "record_pending"
      ) {
        entered();
        await held;
      }
      if (name === "studio_operator_record_interaction")
        return {
          protocol: "coach.memory.v1",
          capture_id: "abcdefabcdefabcdefabcdef",
          memory_epoch: 0,
          extraction_expires_at: new Date(Date.now() + 600000).toISOString(),
        };
      if (name === "coach_memory_commit")
        return {
          protocol: "coach.memory.v1",
          capture_id: "abcdefabcdefabcdefabcdef",
          status: "committed",
          memory_epoch: 0,
          created: [{ id: "fedcbafedcbafedcbafedcba", revision: 1 }],
          superseded: [],
          skipped: [],
          idempotent: false,
        };
      if (name === "provider") {
        const system = body.messages
          .filter((m: any) => m.role === "system")
          .map((m: any) => m.content)
          .join("\n");
        if (/You maintain the long-term memory/.test(system)) {
          if (scenario === "extraction_revoked") revoked = true;
          if (scenario === "cancel_extraction") {
            entered();
            await held;
          }
          return sse(
            JSON.stringify({
              proposals: [
                {
                  kind: "lesson",
                  text: "Synthetic Alice responds well to short morning check-ins.",
                  confidence: 0.8,
                  importance: 0.7,
                },
              ],
            }),
          );
        }
        if (scenario === "tool_call" || scenario === "truncated")
          return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Intermediate prose", ...(scenario === "tool_call" ? { tool_calls: [{ index: 0, id: "t", type: "function", function: { name: "studio_operator_list_members", arguments: "{}" } }] } : {}) }, finish_reason: scenario === "tool_call" ? "tool_calls" : "length" }] })}\n\ndata: [DONE]\n\n`;
        assert.match(system, /Synthetic Alice prefers short morning check-ins/);
        return sse("I will keep it short and morning-focused.");
      }
      return result;
    });
    const gateway = await openNativeGateway(f.store);
    try {
      const pending = gateway.handle(
        {
          kind: "provider",
          body: {
            model: "approved-custom-model",
            messages: [{ role: "user", content: "Brief Alice" }],
          },
        },
        cancel.signal,
      );
      if (scenario === "tool_call" || scenario === "truncated") {
        await pending;
        assert.equal(
          f.calls.filter(
            (c) => c.body.params?.name === "studio_operator_record_interaction",
          ).length,
          0,
        );
      } else if (scenario === "delivery") {
        const response = await pending;
        assert.equal(
          f.calls.filter(
            (c) => c.body.params?.name === "studio_operator_record_interaction",
          ).length,
          0,
        );
        assert.ok(response.completion_id);
        await gateway.confirmDelivery(response.completion_id);
        assert.equal(
          f.calls.filter(
            (c) => c.body.params?.name === "studio_operator_record_interaction",
          ).length,
          1,
        );
        await gateway.confirmDelivery(response.completion_id);
        assert.equal(
          f.calls.filter(
            (c) => c.body.params?.name === "studio_operator_record_interaction",
          ).length,
          1,
        );
      } else if (scenario === "record_pending") {
        const delivered = await pending;
        const recording = gateway.confirmDelivery(delivered.completion_id);
        await extractionEntered;
        const next = gateway.handle({
          kind: "provider",
          body: {
            model: "approved-custom-model",
            messages: [{ role: "user", content: "Next question" }],
          },
        });
        try {
          await new Promise((resolve) => setTimeout(resolve, 40));
          assert.equal(
            f.calls.filter((c) => c.path === "/v1/chat/completions").length,
            1,
            "next provider waits only for durable interaction recording",
          );
        } finally {
          release();
          await recording;
          await next;
        }
      } else if (scenario === "cancel_extraction") {
        const delivered = await pending;
        const rejection = assert.rejects(
          gateway.confirmDelivery(delivered.completion_id),
        );
        await extractionEntered;
        cancel.abort();
        await Promise.race([
          rejection,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("cancellation did not release gateway")),
              1500,
            ),
          ),
        ]);
        release();
        assert.equal(
          f.calls.filter((c) => c.body.params?.name === "coach_memory_commit")
            .length,
          0,
        );
      } else {
        if (scenario === "recall_denied") await assert.rejects(pending);
        else {
          const delivered = await pending;
          if (scenario === "extraction_revoked") {
            await gateway.confirmDelivery(delivered.completion_id);
            assert.equal(
              f.calls.filter(
                (c) => c.body.params?.name === "coach_memory_commit",
              ).length,
              1,
              "source change does not discard acquired Coach memory evidence",
            );
            await gateway.handle({
              kind: "provider",
              body: { model: "approved-custom-model", messages: [] },
            });
          } else {
            await assert.rejects(
              gateway.confirmDelivery(delivered.completion_id),
            );
            await assert.rejects(
              gateway.handle({
                kind: "provider",
                body: { model: "approved-custom-model", messages: [] },
              }),
            );
          }
        }
        if (scenario === "recall_denied")
          assert.equal(
            f.calls.filter((c) => c.path === "/v1/chat/completions").length,
            0,
          );
      }
    } finally {
      release();
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
