/** Existing lifecycle fixtures replace published-source and native readiness boundaries.
 * Release eligibility/provenance itself is exercised in release-delivery.test.ts.
 * This preserves legacy protocol-1, cooldown and lifecycle tests without adding
 * a production main fallback or labeling their synthetic source as a release.
 */
import { Updates, validSha } from "../../src/update/updates.js";
import { boundedBytes } from "../../src/release/manifest.js";
export async function legacyReadyRelease(request: typeof fetch) {
  const response = await request(
    "https://api.github.com/repos/stevefortier/katafit-coach/git/ref/heads/main",
    { signal: AbortSignal.timeout(10000), redirect: "error" },
  );
  const data = JSON.parse((await boundedBytes(response, 100000)).toString());
  if (!validSha(data.object?.sha)) throw Error("UNAVAILABLE");
  return data.object.sha;
}
Updates.prototype.readyRelease = legacyReadyRelease;

// Legacy lifecycle fixtures intentionally hold native eligibility outside their
// scope. Production readiness is covered through real source/owner/API tests.
Updates.prototype.assertReady = async function () {};
Updates.prototype.validateReadiness = function () {};

/** Explicit ready native boundary for legacy browser lifecycle fixtures only. */
export function readyBrowserFixture(updates: Updates) {
  const snapshot = updates.snapshot.bind(updates);
  updates.snapshot = () => {
    const state = snapshot();
    return {
      ...state,
      readinessProtocol: 1,
      readinessSupported: true,
      readiness: state.latest
        ? {
            sha: state.latest,
            fingerprint: "c".repeat(64),
            checkedAt: state.checkedAt,
            observedAt: Date.now(),
            state: "ready" as const,
          }
        : undefined,
    };
  };
}
