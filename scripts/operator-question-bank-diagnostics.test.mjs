import test from "node:test";
import assert from "node:assert/strict";
import { diagnosticPhase } from "./operator-question-bank-diagnostics.mjs";

test("native phase evidence excludes text, arguments, and arbitrary metadata", () => {
  const secret = "DO_NOT_RECORD_MEMBER_DRAFT";
  const payload = diagnosticPhase({
    kind: "provider-payload",
    shape: { groundingReview: true, raw: secret },
    text: secret,
    args: { secret },
  });
  assert.deepEqual(payload, {
    kind: "provider-payload",
    groundingReview: true,
  });
  const result = diagnosticPhase({
    kind: "model-result",
    hasText: true,
    nativeToolCallCount: 0,
    stopReason: "stop",
    texts: [secret],
    nativeCalls: [{ arguments: secret }],
  });
  assert.deepEqual(result, {
    kind: "model-result",
    hasText: true,
    nativeToolCallCount: 0,
    stopReason: "stop",
  });
  assert.equal(diagnosticPhase({ kind: "other", text: secret }), null);
  assert(!JSON.stringify([payload, result]).includes(secret));
});
