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
    assert.equal(
      typed.action?.per_year,
      24,
      "supported action needs canonical independent readback",
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
    assert.equal(concurrent.cycleCompletion.status, "completed");
    assert.equal(concurrent.cycleCompletion.completions.length, 1);
    assert.ok(concurrent.dynamicMemory.populated);
  },
);
