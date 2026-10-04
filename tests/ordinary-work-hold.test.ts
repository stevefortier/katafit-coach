import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Actions } from "../src/chat/actions.js";
import { Store } from "../src/config/store.js";

for (const scenario of [
  "owned-pending",
  "owned-unknown",
  "foreign-pending",
  "foreign-unknown",
  "cross-credential-unknown",
] as const) {
  test(`ordinary shared exclusion preserves ${scenario}`, async () => {
    const dir = await mkdtemp(tmpdir() + "/ordinary-shared-hold-");
    try {
      const store = new Store(dir);
      await store.init();
      const actions = new Actions(store);
      const action = {
        session_id: "synthetic-work",
        idempotency_key: scenario.startsWith("foreign")
          ? "foreign-key"
          : "owned-key",
        status: scenario.endsWith("pending")
          ? ("pending" as const)
          : ("unknown" as const),
        tool_name: "katafit_rest_request",
      };
      actions.save(action);
      assert.equal(actions.unresolved(), true);
      if (scenario === "cross-credential-unknown") {
        store.secrets.token = "synthetic-rotated-token";
        new Actions(store).save({ ...action, status: "pending" });
        assert.equal(new Actions(store).snapshot().length, 2);
      }
      assert.equal(
        new Actions(store).unresolved("owned-key"),
        scenario !== "owned-pending",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
