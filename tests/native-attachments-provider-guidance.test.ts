import test from "node:test";
import assert from "node:assert/strict";
import { gatewayHarness } from "./helpers/attachments.js";

test("live Pi provider does not require an expired legacy command turn", async () => {
  const g = await gatewayHarness({ commandTtlMs: 1200 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 1300));
    const result = await g.gateway.handle({
      kind: "provider",
      body: { model: "approved-custom-model", messages: [] },
    });
    assert.ok(result);
    assert.deepEqual(g.terminated, []);
    assert.equal(g.f.named("studio_operator_authorize_context").length, 0);
  } finally {
    await g.close();
  }
});
