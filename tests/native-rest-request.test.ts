import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fixture } from "./helpers/native.js";
import { startRelay, loadExtension, piTurn } from "./helpers/native-relay.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";
import { NativeConversations } from "../src/sandbox/conversations.js";

import { Actions } from "../src/chat/actions.js";

test("actual relay/extension exposes one HTTP tool; uncertain mutation is journaled and never replayed or reconciled via MCP", async () => {
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
    await assert.rejects(
      () => tool.execute("POST", { method: "POST", path: "/api/success" }),
      /replay/i,
    );
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
    assert.equal(new Actions(f.store).snapshot().at(-1)?.status, "unknown");
    await assert.rejects(
      () => tool.execute("retry", { method: "PATCH", path: "/api/lost" }),
      /unknown|unverified|replay/i,
    );
    await assert.rejects(
      () =>
        ext.call("studio_operator_send_message", {
          member_ref: "anything",
          text: "retry through legacy",
        }),
      /unknown|unverified|replay/i,
    );
    await new Actions(f.store).reconcile();
    assert.deepEqual(calls, [
      "GET /api/docs/coach",
      "POST /api/success",
      "PUT /api/success",
      "PATCH /api/success",
      "DELETE /api/success",
      "GET /api/compat",
      "PATCH /api/lost",
    ]);
    await gateway.close();
    await assert.rejects(
      () => openNativeGateway(f.store),
      /DELIVERY_UNVERIFIED/,
    );
    await f.store.save({
      ...f.store.publicConfig(),
      apiKey: "replacement-synthetic-provider-key",
    });
    await assert.rejects(
      () => openNativeGateway(f.store),
      /DELIVERY_UNVERIFIED/,
    );
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
  const history = new NativeConversations(f.store);
  let gateway: Awaited<ReturnType<typeof openNativeGateway>> | undefined;
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  try {
    gateway = await openNativeGateway(f.store, undefined, {
      onBeforeDispatch: () => history.flush(),
      onExchange: (capture) => history.capture(gateway!, capture),
    });
    await history.bind(gateway, await history.prepare());
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
    const id = history.active!.id;
    await history.finish(gateway);
    assert.deepEqual(writes, [args.body, args.body]);
    assert.deepEqual(
      new Actions(f.store).snapshot().map((a) => a.status),
      ["completed", "completed"],
    );
    const reopened = new NativeConversations(f.store);
    const view = await reopened.read(id);
    assert.equal(view.status, "authorized");
    const prepared = await reopened.prepare();
    const results = prepared
      .seed!.filter((e: any) => e.type === "message")
      .map((e: any) => e.message)
      .filter((m: any) => m.role === "toolResult");
    assert.equal(results.length, 2);
    assert.deepEqual(
      results.map((m: any) => m.toolCallId),
      ["reused-mutation", "reused-mutation"],
    );
    // No new provider selection: the just-consumed occurrence cannot replay.
    await assert.rejects(
      () => tool.execute("reused-mutation", args),
      /history|replay|unverified/i,
    );
    assert.equal(writes.length, 2);
    assert.equal(new Actions(f.store).snapshot().length, 2);
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

for (const mode of [false, true, "seal"] as const)
  test(`real Pi serialization and saved history retain mutation ${mode} outcome`, async () => {
    const lost = mode === true;
    const sealFailure = mode === "seal";
    let mutations = 0;
    const backend = createServer(async (req, res) => {
      for await (const _chunk of req) {
      }
      if (req.url === "/api/future") {
        mutations++;
        if (lost) {
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"saved":true}');
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
      }
    });
    await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
    const args = {
      method: "PUT",
      path: "/api/future",
      body: { exact_id: "slug", unit: "lbs", value: 0 },
    };
    const f = await fixture((name, _value, body) => {
      if (name !== "provider") return;
      const tool = body.messages.find((m: any) => m.role === "tool");
      if (tool && lost)
        assert.match(tool.content, /outcome is unknown.*do not replay/i);
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
    const history = new NativeConversations(f.store);
    let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
    let gateway: Awaited<ReturnType<typeof openNativeGateway>> | undefined;
    try {
      gateway = await openNativeGateway(f.store, undefined, {
        onBeforeDispatch: () => history.flush(),
        onExchange: (capture) => {
          if (sealFailure && JSON.stringify(capture).includes("toolResult"))
            throw new Error("synthetic seal failure");
          return history.capture(gateway!, capture);
        },
      });
      await history.bind(gateway, await history.prepare());
      relay = await startRelay(gateway);
      const ext = await loadExtension(relay);
      const messages: any[] = [
        {
          role: "user",
          content: "Apply the requested exact change once.",
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
      assert.equal(Boolean(result.isError), lost || sealFailure);
      if (sealFailure) {
        assert.ok(
          ["pending", "unknown"].includes(
            new Actions(f.store).snapshot().at(-1)!.status,
          ),
        );
        assert.equal(mutations, 1);
        return;
      }
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
      const id = history.active!.id;
      await history.finish(gateway);
      await relay.close();
      relay = undefined;
      await gateway.close();
      gateway = undefined;
      const reopened = new NativeConversations(f.store);
      const view = await reopened.read(id);
      assert.equal(view.status, "authorized");
      assert.match(
        JSON.stringify(view.entries),
        lost ? /outcome is unknown/i : /saved/,
      );
      if (lost)
        await assert.rejects(() => reopened.prepare(), /DELIVERY_UNVERIFIED/);
      else assert.ok((await reopened.prepare()).seed?.length);
      assert.equal(mutations, 1);
      assert.equal(
        new Actions(f.store).snapshot().at(-1)?.status,
        lost ? "unknown" : "completed",
      );
    } finally {
      await relay?.close();
      await gateway?.close();
      await f.close();
      backend.closeAllConnections();
      await new Promise<void>((r) => backend.close(() => r()));
    }
  });

for (const unknown of [false, true])
  test(`mutation host outcome is retained through actual Pi history (${unknown ? "unknown" : "success"})`, async () => {
    const { NativeConversations } = await import(
      "../src/sandbox/conversations.js"
    );
    const { Store } = await import("../src/config/store.js");
    let writes = 0;
    const backend = createServer(async (req, res) => {
      for await (const _ of req) {
        /* drain */
      }
      if (req.url !== "/api/example") {
        res.writeHead(404);
        res.end();
        return;
      }
      writes++;
      if (unknown) {
        req.socket.destroy();
        return;
      }
      res.writeHead(204);
      res.end();
    });
    await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
    const args = {
      method: "PUT",
      path: "/api/example",
      body: { exact_id: "slug-1", value: 0 },
    };
    const f = await fixture((name, _value, body) => {
      if (name !== "provider") return;
      const hasResult = body.messages.some((m: any) => m.role === "tool");
      const delta = hasResult
        ? {
            content: unknown
              ? "Unknown outcome; no replay."
              : "HTTP acknowledged; canonical readback is still required.",
          }
        : {
            tool_calls: [
              {
                index: 0,
                id: "call-katafit_rest_request",
                type: "function",
                function: {
                  name: "katafit_rest_request",
                  arguments: JSON.stringify(args),
                },
              },
            ],
          };
      return `data: ${JSON.stringify({ id: "http-action", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "http-action", choices: [{ index: 0, delta: {}, finish_reason: hasResult ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
    });
    await f.store.save({
      ...f.store.publicConfig(),
      origin: `http://127.0.0.1:${(backend.address() as any).port}`,
    });
    const history = new NativeConversations(f.store);
    let gateway: Awaited<ReturnType<typeof openNativeGateway>> | undefined;
    let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
    try {
      gateway = await openNativeGateway(f.store, undefined, {
        onBeforeDispatch: () => history.flush(),
        onExchange: (capture) => history.capture(gateway!, capture),
      });
      await history.bind(gateway, await history.prepare());
      relay = await startRelay(gateway);
      const ext = await loadExtension(relay);
      const messages: any[] = [
        {
          role: "user",
          content: "Apply this requested change once.",
          timestamp: Date.now(),
        },
      ];
      const selected = await piTurn(relay, "approved-custom-model", messages);
      assert.equal(selected.stopReason, "toolUse");
      messages.push(selected);
      let content: any[],
        isError = false;
      try {
        content = (await ext.call("katafit_rest_request", args)).content;
      } catch (error) {
        isError = true;
        content = [{ type: "text", text: (error as Error).message }];
      }
      assert.equal(isError, unknown);
      messages.push({
        role: "toolResult",
        toolCallId: "call-katafit_rest_request",
        toolName: "katafit_rest_request",
        content,
        isError,
        timestamp: Date.now(),
      });
      const answer = await piTurn(relay, "approved-custom-model", messages);
      assert.equal(answer.stopReason, "stop", JSON.stringify(answer));
      const id = history.active!.id;
      await history.finish(gateway);
      await relay.close();
      relay = undefined;
      await gateway.close();
      gateway = undefined;
      const restarted = new Store(f.store.dir);
      await restarted.init();
      const reopened = new NativeConversations(restarted);
      const view = await reopened.read(id);
      assert.equal(view.status, "authorized");
      assert.match(
        JSON.stringify(view.entries),
        unknown ? /outcome is unknown/ : /204/,
      );
      if (unknown)
        await assert.rejects(() => reopened.prepare(), /DELIVERY_UNVERIFIED/);
      else assert.ok((await reopened.prepare()).seed?.length);
      assert.equal(writes, 1);
    } finally {
      await relay?.close();
      await gateway?.close();
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
