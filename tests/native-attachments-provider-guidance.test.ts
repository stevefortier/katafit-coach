import test from "node:test";
import assert from "node:assert/strict";
import { gatewayHarness } from "./helpers/attachments.js";

test("attachment-owning provider preserves actionable turn expiry after main integration", async () => {
  const g = await gatewayHarness({ commandTtlMs: 1200 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 1300));
    await assert.rejects(
      g.gateway.handle({
        kind: "provider",
        body: { model: "approved-custom-model", messages: [] },
      }),
      (error: any) => error.code === "NATIVE_TURN_REQUIRED",
    );
    assert.deepEqual(g.terminated, []);
  } finally {
    await g.close();
  }
});
