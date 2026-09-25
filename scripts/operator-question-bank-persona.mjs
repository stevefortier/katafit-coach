import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
// Only the synthetic bank uses this switch. Never updates live configuration.
export function verifyPersona(actual, pinned, pinnedOverride) {
  assert.ok(
    pinnedOverride === undefined || pinnedOverride === "1",
    "Invalid pinned persona option",
  );
  const matchesInstalled = isDeepStrictEqual(actual, pinned);
  if (pinnedOverride !== "1")
    assert.ok(
      matchesInstalled,
      "Installed persona changed; explicitly pin the original stress fixture or inspect configuration. Never silently weaken the persona.",
    );
  return {
    mode: pinnedOverride === "1" ? "pinned-fixture" : "installed-match",
    matchesInstalled,
  };
}
