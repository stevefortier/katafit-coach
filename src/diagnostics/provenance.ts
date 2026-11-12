import { createHash } from "node:crypto";
import type { CoachSkill } from "../config/skills.js";

export interface Provenance {
  api?: "openai-completions";
  provider?: string;
  model?: string;
  skills?: Array<{
    id: string;
    defaultVersion: number;
    basedOnDefaultVersion: number;
    customized: boolean;
    digest: string;
  }>;
}
const skillIds = new Set([
  "review-activity",
  "understand-progress",
  "change-plan",
  "fetch-checkin-images",
  "katafit-api",
]);
// Exact identity is omitted, not rewritten, whenever the existing diagnostic
// text-screening patterns would hide credential-like material. Known-secret
// matching alone cannot protect an accidentally pasted, unrelated credential.
const credentialIdentity =
  /(?:sk-[a-z0-9_-]{12,}|kcoach_|rgn_coach_|redacted:sk-|\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|client[_-]?secret)\b[=:]|\b[A-Za-z0-9+/]{128,}\b)/i;
const identity = (value: unknown, secrets: string[]) =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value) &&
  !value.includes("://") &&
  !/^(?:sk-|kcoach_|rgn_coach_)/i.test(value) &&
  !credentialIdentity.test(value) &&
  !secrets.some((secret) => secret.length >= 4 && value.includes(secret));
// Revalidated at emission, persistence and reload. No endpoint, prose or skill
// body is retained. Unknown/unsafe identities are absent, never inferred.
export function safeProvenance(
  value: unknown,
  secrets: string[] = [],
): Provenance | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const v = value as Provenance;
    const out: Provenance = {};
    if (v.api === "openai-completions") out.api = v.api;
    if (identity(v.provider, secrets)) out.provider = v.provider;
    if (identity(v.model, secrets)) out.model = v.model;
    if (Array.isArray(v.skills) && v.skills.length <= 5) {
      out.skills = v.skills.flatMap((s) =>
        s &&
        skillIds.has(s.id) &&
        Number.isSafeInteger(s.defaultVersion) &&
        s.defaultVersion > 0 &&
        Number.isSafeInteger(s.basedOnDefaultVersion) &&
        s.basedOnDefaultVersion > 0 &&
        typeof s.customized === "boolean" &&
        /^[a-f0-9]{64}$/.test(s.digest)
          ? [
              {
                id: s.id,
                defaultVersion: s.defaultVersion,
                basedOnDefaultVersion: s.basedOnDefaultVersion,
                customized: s.customized,
                digest: s.digest,
              },
            ]
          : [],
      );
    }
    return Object.keys(out).length ? out : undefined;
  } catch {
    return;
  }
}
export function skillProvenance(skills: CoachSkill[]): Provenance | undefined {
  try {
    return safeProvenance({
      skills: skills.map((s) => ({
        id: s.id,
        defaultVersion: s.defaultVersion,
        basedOnDefaultVersion: s.basedOnDefaultVersion,
        customized: s.customized,
        digest: createHash("sha256").update(JSON.stringify(s)).digest("hex"),
      })),
    });
  } catch {
    return;
  }
}
