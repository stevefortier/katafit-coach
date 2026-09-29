import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/native.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";

const request = {
  kind: "tool",
  name: "katafit_rest_request",
  args: { method: "GET", path: "/api/activities/current" },
};

test("new ordinary REST reads use current backend authority without acquiring legacy sessions", async () => {
  let allowed = true;
  const f = await fixture(undefined, (_url, headers) => {
    assert.equal(headers.authorization, "Bearer synthetic-backend-credential");
    return allowed
      ? { body: '{"activity":"private"}' }
      : { status: 403, body: '{"error":"denied"}' };
  });
  const gateway = await openNativeGateway(f.store);
  try {
    const first = await gateway.handle(request);
    assert.match(first.content[0].text, /private/);
    allowed = false;
    assert.deepEqual(await gateway.handle(request), {
      restReadError: { status: 403 },
    });
    assert.equal(f.calls.filter((call) => call.method === "GET").length, 2);
    assert.equal(
      f.calls.filter(
        (call) =>
          call.body?.params?.name === "studio_operator_authorize_context",
      ).length,
      0,
    );
    assert.equal(
      (await gateway.handle({ kind: "catalog" })).tools.some(
        (tool: any) => tool.name === "studio_operator_read_synthetic_generic",
      ),
      false,
    );
  } finally {
    await gateway.close();
    await f.close();
  }
});
