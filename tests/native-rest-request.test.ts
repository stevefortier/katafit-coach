import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fixture } from "./helpers/native.js";
import { startRelay, loadExtension, piTurn } from "./helpers/native-relay.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";

import { Actions } from "../src/chat/actions.js";

test("actual relay exposes REST mutations without a Coach journal or automatic retry", async () => {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(req.method + " " + req.url);
    if (req.url === "/api/lost") {
      req.socket.destroy();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end('{"version":1,"domains":[]}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const f = await fixture();
  await f.store.save({
    ...f.store.publicConfig(),
    origin: `http://127.0.0.1:${(server.address() as any).port}`,
  });
  const gateway = await openNativeGateway(f.store);
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  try {
    relay = await startRelay(gateway);
    const ext = await loadExtension(relay);
    assert.equal(ext.tools.has("katafit_rest_request"), true);
    assert.equal(ext.tools.has("katafit_rest_get"), false);
    const tool = ext.tools.get("katafit_rest_request");
    await tool.execute("docs", { method: "GET", path: "/api/docs/coach" });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      await tool.execute(method, {
        method,
        path: "/api/success",
        body: { exact_id: "slug", value: 0 },
      });
    }
    await tool.execute("POST", { method: "POST", path: "/api/success" });
    await gateway.handle({
      kind: "tool",
      name: "katafit_rest_get",
      args: { path: "/api/compat" },
      toolCallId: "compat",
    });
    await assert.rejects(
      () =>
        tool.execute("write", {
          method: "PATCH",
          path: "/api/lost",
          body: { name: "changed" },
        }),
      /outcome is unknown.*do not replay/i,
    );
    assert.deepEqual(new Actions(f.store).snapshot(), []);
    // An unknown acknowledgement does not trigger an automatic REST replay.
    assert.deepEqual(calls, [
      "GET /api/docs/coach",
      "POST /api/success",
      "PUT /api/success",
      "PATCH /api/success",
      "DELETE /api/success",
      "POST /api/success",
      "GET /api/compat",
      "PATCH /api/lost",
    ]);
    await gateway.close();
  } finally {
    await relay?.close();
    await gateway.close();
    await f.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("actual Pi continuations may reuse a mutation ID for distinct canonical occurrences", async () => {
  const writes: unknown[] = [];
  const backend = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url !== "/api/future") {
      res.writeHead(404);
      res.end();
      return;
    }
    writes.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ saved: writes.length }));
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const args = { method: "POST", path: "/api/future", body: { value: 0 } };
  const f = await fixture((name, _value, body) => {
    if (name !== "provider") return;
    const results = body.messages.filter((m: any) => m.role === "tool");
    const done = results.length === 2;
    const delta = done
      ? { content: "Both separately selected changes acknowledged." }
      : {
          tool_calls: [
            {
              index: 0,
              id: "reused-mutation",
              type: "function",
              function: {
                name: "katafit_rest_request",
                arguments: JSON.stringify(args),
              },
            },
          ],
        };
    return `data: ${JSON.stringify({ id: "continuation", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "continuation", choices: [{ index: 0, delta: {}, finish_reason: done ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
  });
  await f.store.save({
    ...f.store.publicConfig(),
    origin: `http://127.0.0.1:${(backend.address() as any).port}`,
  });
  let gateway: Awaited<ReturnType<typeof openNativeGateway>> | undefined;
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  try {
    gateway = await openNativeGateway(f.store);
    relay = await startRelay(gateway);
    const ext = await loadExtension(relay);
    const tool = ext.tools.get("katafit_rest_request");
    const messages: any[] = [
      {
        role: "user",
        content: "Apply these two separate requested changes.",
        timestamp: Date.now(),
      },
    ];
    for (let occurrence = 0; occurrence < 2; occurrence++) {
      const selected = await piTurn(relay, "approved-custom-model", messages);
      assert.equal(selected.stopReason, "toolUse", JSON.stringify(selected));
      assert.equal((selected.content[0] as any).id, "reused-mutation");
      messages.push(selected);
      const result = await tool.execute("reused-mutation", args);
      assert.equal(Boolean(result.isError), false);
      messages.push({
        role: "toolResult",
        toolCallId: "reused-mutation",
        toolName: "katafit_rest_request",
        content: result.content,
        isError: false,
        timestamp: Date.now(),
      });
    }
    const answer = await piTurn(relay, "approved-custom-model", messages);
    assert.equal(answer.stopReason, "stop", JSON.stringify(answer));
    assert.deepEqual(writes, [args.body, args.body]);
    assert.deepEqual(new Actions(f.store).snapshot(), []);
    // Distinct provider selections dispatched despite reusing the same ID.
    assert.equal(writes.length, 2);
    assert.equal(new Actions(f.store).snapshot().length, 0);
  } finally {
    await relay?.close();
    await gateway?.close();
    await f.close();
    backend.closeAllConnections();
    await new Promise<void>((r) => backend.close(() => r()));
  }
});

test("invalid REST mutation arguments are rejected before dispatch or journaling", async () => {
  const f = await fixture();
  const gateway = await openNativeGateway(f.store);
  try {
    await assert.rejects(
      () =>
        gateway.handle({
          kind: "tool",
          name: "katafit_rest_request",
          toolCallId: "invalid",
          args: { method: "TRACE", path: "/api/future" },
        }),
      { code: "NATIVE_REQUEST_REJECTED" },
    );
    assert.deepEqual(new Actions(f.store).snapshot(), []);
  } finally {
    await gateway.close();
    await f.close();
  }
});

for (const lost of [false, true])
  test(`real Pi serialization retains REST mutation ${lost ? "unknown" : "success"} outcome in the live turn`, async () => {
    let mutations = 0;
    const backend = createServer(async (req, res) => {
      for await (const _chunk of req) {
        /* drain */
      }
      if (req.url !== "/api/future") {
        res.writeHead(404);
        res.end();
        return;
      }
      mutations++;
      if (lost) return req.socket.destroy();
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"saved":true}');
    });
    await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
    const args = {
      method: "PUT",
      path: "/api/future",
      body: { exact_id: "slug", value: 0 },
    };
    const f = await fixture((name, _value, body) => {
      if (name !== "provider") return;
      const tool = body.messages.find((m: any) => m.role === "tool");
      if (tool)
        assert.match(
          tool.content,
          lost ? /outcome is unknown.*do not replay/i : /saved/,
        );
      const delta = tool
        ? {
            content: lost
              ? "Outcome unknown; not replaying."
              : "Acknowledged; canonical readback still required.",
          }
        : {
            tool_calls: [
              {
                index: 0,
                id: "mutation",
                type: "function",
                function: {
                  name: "katafit_rest_request",
                  arguments: JSON.stringify(args),
                },
              },
            ],
          };
      return `data: ${JSON.stringify({ id: "mutation", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "mutation", choices: [{ index: 0, delta: {}, finish_reason: tool ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
    });
    await f.store.save({
      ...f.store.publicConfig(),
      origin: `http://127.0.0.1:${(backend.address() as any).port}`,
    });
    const gateway = await openNativeGateway(f.store);
    let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
    try {
      relay = await startRelay(gateway);
      const ext = await loadExtension(relay);
      const messages: any[] = [
        {
          role: "user",
          content: "Apply one exact change.",
          timestamp: Date.now(),
        },
      ];
      const selected = await piTurn(relay, "approved-custom-model", messages);
      assert.equal(selected.stopReason, "toolUse");
      messages.push(selected);
      let result;
      try {
        result = await ext.tools
          .get("katafit_rest_request")
          .execute("mutation", args);
      } catch (error) {
        result = {
          content: [{ type: "text", text: (error as Error).message }],
          isError: true,
        };
      }
      assert.equal(Boolean(result.isError), lost);
      messages.push({
        role: "toolResult",
        toolCallId: "mutation",
        toolName: "katafit_rest_request",
        content: result.content,
        isError: lost,
        timestamp: Date.now(),
      });
      const answer = await piTurn(relay, "approved-custom-model", messages);
      assert.equal(answer.stopReason, "stop", JSON.stringify(answer));
      assert.equal(mutations, 1);
      assert.deepEqual(new Actions(f.store).snapshot(), []);
      assert.equal(mutations, 1);
    } finally {
      await relay?.close();
      await gateway.close();
      await f.close();
      backend.closeAllConnections();
      await new Promise<void>((r) => backend.close(() => r()));
    }
  });

test("extension transport loss emits fixed unknown-outcome guidance, not a retryable fetch error", async () => {
  const f = await fixture();
  const gateway = await openNativeGateway(f.store);
  const relay = await startRelay(gateway);
  const ext = await loadExtension(relay);
  try {
    await relay.close();
    await assert.rejects(
      () =>
        ext.call("katafit_rest_request", {
          method: "POST",
          path: "/api/future",
        }),
      /outcome.*unknown.*[Dd]o not replay/,
    );
    assert.equal(
      new Actions(f.store).snapshot().length,
      0,
      "pre-host loss is not a fabricated dispatched receipt",
    );
  } finally {
    await gateway.close();
    await f.close();
  }
});
