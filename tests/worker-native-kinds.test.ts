import test from "node:test";
import assert from "node:assert/strict";
import { perKindAcceptance } from "./helpers/autonomy-native-task.js";
const enabled = process.env.AUTONOMY_NATIVE_ACCEPTANCE === "1";
test(
  "actual advertised per-kind installed native capability and canonical publishers",
  { skip: !enabled, timeout: 400000 },
  async () => {
    const receipt = await perKindAcceptance(process.env.NATIVE_TEST_IMAGE!);
    assert.equal(receipt.passed, true);
    assert.deepEqual(
      receipt.generationInventory.map((r) => r.kind).sort(),
      [...receipt.inventory.advertised, "main_member_reply"].sort(),
    );
    assert.deepEqual(receipt.inventory.unadvertised, [
      "activity_followup",
      "exercise_chat",
    ]);
  },
);
