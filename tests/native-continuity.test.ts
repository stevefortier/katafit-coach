import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/native.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";

const provider = (content = "Current live turn") => ({
  kind: "provider",
  body: {
    model: "approved-custom-model",
    messages: [{ role: "user", content }],
  },
});

async function open() {
  const f = await fixture();
  const terminated: string[] = [];
  try {
    const gateway = await openNativeGateway(f.store, undefined, {
      onTerminate: (reason) => terminated.push(reason),
    });
    return {
      f,
      gateway,
      terminated,
      async close() {
        await gateway.close();
        await f.close();
      },
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}

test("opening and advancing a live Pi turn do not open backend sessions or archives", async () => {
  const h = await open();
  try {
    assert.equal(h.gateway.continuity(), null);
    const catalog = await h.gateway.handle({ kind: "catalog" });
    assert.equal(
      catalog.tools.some((tool: any) => tool.name === "katafit_rest_request"),
      true,
    );
    assert.equal(
      catalog.tools.some(
        (tool: any) => tool.name === "studio_operator_authorize_context",
      ),
      false,
    );
    assert.equal(
      catalog.tools.some(
        (tool: any) => tool.name === "studio_operator_advance_turn",
      ),
      false,
    );
    h.gateway.noteHumanInput("Second turn\r");
    h.gateway.noteHumanInput("Repeated enter\r");
    const result = await h.gateway.handle(provider("Second live turn"));
    assert.match(result.body, /Synthetic Alice|fixture/);
    assert.equal(
      h.f.calls.filter((call) => call.path === "/v1/chat/completions").length,
      1,
    );
    assert.equal(
      h.f.calls.filter((call) => call.body?.method === "tools/call").length,
      0,
    );
    assert.equal(h.gateway.continuity(), null);
    assert.deepEqual(h.terminated, []);
  } finally {
    await h.close();
  }
});

test("live provider traffic uses acquired context without old-session renewal or read replay", async () => {
  const h = await open();
  try {
    const first = await h.gateway.handle(
      provider("Acquired data from previous live turn"),
    );
    assert.ok(first.body);
    h.gateway.noteHumanInput("Next question\r");
    const second = await h.gateway.handle(
      provider("Acquired data from previous live turn; next question"),
    );
    assert.ok(second.body);
    const calls = h.f.calls.filter(
      (call) => call.path === "/v1/chat/completions",
    );
    assert.equal(calls.length, 2);
    assert.match(
      JSON.stringify(calls[1].body.messages),
      /Acquired data from previous live turn/,
    );
    assert.equal(
      h.f.calls.filter((call) => call.body?.method === "tools/call").length,
      0,
    );
  } finally {
    await h.close();
  }
});

test("config credential replacement revokes live gateway without backend continuity", async () => {
  const h = await open();
  try {
    await h.f.store.save({
      ...h.f.store.publicConfig(),
      apiKey: "replacement-provider-key",
    });
    await assert.rejects(h.gateway.handle(provider()), {
      code: "NATIVE_SESSION_REVOKED",
    });
    assert.equal(
      h.f.calls.filter((call) => call.path === "/v1/chat/completions").length,
      0,
    );
    assert.deepEqual(h.terminated, []);
  } finally {
    await h.close();
  }
});
