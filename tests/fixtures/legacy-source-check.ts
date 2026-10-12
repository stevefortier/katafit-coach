/** Existing lifecycle fixtures replace the published-source boundary only.
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
