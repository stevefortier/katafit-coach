export function diagnosticPhase(event) {
  if (event?.kind === "provider-payload")
    return {
      kind: event.kind,
      groundingReview: event.shape?.groundingReview === true,
    };
  if (event?.kind !== "model-result") return null;
  const result = { kind: event.kind };
  if (typeof event.hasText === "boolean") result.hasText = event.hasText;
  if (
    Number.isSafeInteger(event.nativeToolCallCount) &&
    event.nativeToolCallCount >= 0
  )
    result.nativeToolCallCount = event.nativeToolCallCount;
  if (
    ["stop", "length", "toolUse", "error", "aborted"].includes(event.stopReason)
  )
    result.stopReason = event.stopReason;
  return result;
}
