import { channel } from "node:diagnostics_channel";

// Optional, content-free release qualification observation. No URLs, subjects,
// response prose or arbitrary error/header strings cross this boundary.
export const provenanceDiagnostics = channel("katafit.release-provenance");
export const provenanceDiagnosticLimit = 8;
const stages = ["attestation-fetch", "attestation-read", "attestation-parse"];
const failures = [
  "http",
  "network",
  "body-unavailable",
  "read",
  "cap",
  "parse",
];
export function sanitizeProvenanceDiagnostic(value: unknown) {
  const v = value as Record<string, unknown> | undefined;
  if (
    !v ||
    v.protocol !== 1 ||
    !stages.includes(v.stage as string) ||
    !failures.includes(v.failure as string)
  )
    return;
  const row: Record<string, string | number> = {
    protocol: 1,
    stage: v.stage as string,
    failure: v.failure as string,
  };
  if (
    Number.isInteger(v.status) &&
    Number(v.status) >= 100 &&
    Number(v.status) <= 599
  )
    row.status = Number(v.status);
  // GitHub's request ID is colon-separated hexadecimal, not arbitrary prose.
  if (
    typeof v.requestId === "string" &&
    /^[A-Fa-f0-9]{1,16}(?::[A-Fa-f0-9]{1,16}){3,5}$/.test(v.requestId)
  )
    row.requestId = v.requestId;
  for (const key of ["rateLimit", "rateRemaining", "rateReset", "retryAfter"]) {
    if (
      Number.isSafeInteger(v[key]) &&
      Number(v[key]) >= 0 &&
      Number(v[key]) <= 9_999_999_999
    )
      row[key] = Number(v[key]);
  }
  return row;
}
export function provenanceFailure(
  stage: string,
  failure: string,
  response?: Response,
) {
  if (!provenanceDiagnostics.hasSubscribers) return;
  const row: Record<string, unknown> = { protocol: 1, stage, failure };
  if (response) {
    row.status = response.status;
    row.requestId = response.headers.get("x-github-request-id");
    for (const [key, header] of [
      ["rateLimit", "x-ratelimit-limit"],
      ["rateRemaining", "x-ratelimit-remaining"],
      ["rateReset", "x-ratelimit-reset"],
      ["retryAfter", "retry-after"],
    ]) {
      const value = response.headers.get(header);
      if (value && /^(0|[1-9][0-9]{0,9})$/.test(value))
        row[key] = Number(value);
    }
  }
  const safe = sanitizeProvenanceDiagnostic(row);
  if (safe) provenanceDiagnostics.publish(safe);
}
