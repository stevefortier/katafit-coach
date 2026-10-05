import test from "node:test";
import assert from "node:assert/strict";

const enabled = process.env.AUTONOMY_NATIVE_ACCEPTANCE === "1";
test("C10 opt-in native/real-backend acceptance harness exists", async () => {
  const harness = await import("../scripts/autonomy-acceptance.js");
  assert.equal(typeof harness.runAcceptance, "function");
});
test(
  "C10 real Pi + canonical backend acceptance",
  { skip: !enabled, timeout: 600000 },
  async () => {
    const { runAcceptance } = await import("../scripts/autonomy-acceptance.js");
    const receipt = await runAcceptance();
    assert.equal(receipt.status, "mechanism-passed");
    assert.equal(receipt.cleanup.complete, true);
    const typed = receipt.phases.find((p: any) => p.name === "typed-nutrition");
    assert.ok(
      typed?.passed,
      "real typed target acquisition and admission must be qualified",
    );
    assert.equal(
      typed.dynamicMemory?.executed,
      true,
      "dynamic memory must execute, not merely be advertised",
    );
    assert.equal(typed.action?.kind, "plan_created");
    assert.match(typed.action.resource_id, /^[a-f0-9]{24}$/);
    assert.equal(typed.action.occurrence.status, "response_received");
    assert.equal(
      typed.action.occurrence.local_effect.resource_id,
      typed.action.resource_id,
      "successor occurrence binds exact resource",
    );
    assert.equal(
      String(typed.action.publication._id),
      typed.action.resource_id,
      "supported action needs canonical independent readback",
    );
    assert.equal(
      typed.action.publication.title,
      "Synthetic native typed supported plan",
    );
    assert.equal(
      typed.action.unsupportedQuota,
      "denied_before_dispatch_no_effect",
    );
    const concurrent = receipt.phases.find(
      (p: any) => p.name === "native-concurrent-typed",
    );
    assert.ok(concurrent?.passed);
    assert.match(
      concurrent.coordination,
      /real typed Worker.*real scheduled native cycle/,
    );
    assert.equal(concurrent.action.kind, "member_message");
    assert.equal(concurrent.nativeCycle.status, "completed");
    assert.equal(concurrent.nativeCycle.completions.length, 1);
    assert.ok(concurrent.dynamicMemory.populated);
    const kinds = receipt.phases.find(
      (phase: any) => phase.name === "installed-native-per-kind",
    );
    assert.ok(kinds?.passed);
    assert.deepEqual(
      kinds.generationInventory.map((row: any) => row.kind).sort(),
      [...kinds.inventory.advertised, "main_member_reply"].sort(),
    );
    assert.ok(
      kinds.generationInventory.every(
        (row: any) => row.executed && row.status === "pass",
      ),
    );
  },
);
