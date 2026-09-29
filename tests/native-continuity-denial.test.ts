import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/native.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";

const read = (path: string) => ({
  kind: "tool",
  name: "katafit_rest_request",
  args: { method: "GET", path },
});
const provider = {
  kind: "provider",
  body: {
    model: "approved-custom-model",
    messages: [{ role: "user", content: "Use what was already acquired" }],
  },
};

for (const status of [401, 403, 404, 503]) {
  test(`backend HTTP ${status} denies a new REST read without erasing acquired live context`, async () => {
    const f = await fixture(undefined, () => ({
      status,
      body: "private backend refusal details",
    }));
    const terminated: string[] = [];
    const gateway = await openNativeGateway(f.store, undefined, {
      onTerminate: (reason) => terminated.push(reason),
    });
    try {
      const result = await gateway.handle(read("/api/friends/feed/dojo"));
      assert.deepEqual(result, { restReadError: { status } });
      assert.doesNotMatch(
        JSON.stringify(result),
        /private backend refusal details/,
      );
      assert.equal(
        f.calls.filter((call) => call.path === "/api/friends/feed/dojo").length,
        1,
      );
      assert.equal(
        f.calls.filter((call) => call.body?.method === "tools/call").length,
        0,
      );
      const answer = await gateway.handle(provider);
      assert.ok(answer.body);
      assert.equal(gateway.continuity(), null);
      assert.deepEqual(terminated, []);
    } finally {
      await gateway.close();
      await f.close();
    }
  });
}

test("live-only catalog rejects retired backend source-proof and turn controls", async () => {
  const f = await fixture();
  const gateway = await openNativeGateway(f.store);
  try {
    const catalog = await gateway.handle({ kind: "catalog" });
    for (const name of [
      "studio_operator_authorize_context",
      "studio_operator_advance_turn",
    ])
      assert.equal(
        catalog.tools.some((tool: any) => tool.name === name),
        false,
      );
    for (const name of [
      "studio_operator_authorize_context",
      "studio_operator_advance_turn",
    ])
      await assert.rejects(gateway.handle({ kind: "tool", name, args: {} }), {
        code: "NATIVE_REQUEST_REJECTED",
      });
    assert.equal(
      f.calls.filter((call) => call.body?.method === "tools/call").length,
      0,
    );
  } finally {
    await gateway.close();
    await f.close();
  }
});
