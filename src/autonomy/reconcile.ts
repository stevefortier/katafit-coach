import { AutonomyFailure, reportDigest } from "./backend.js";
import type { AutonomyBackend } from "./backend.js";
import type { LedgerEntry } from "./ledger.js";
import type { MandateView, Page, WorkItem } from "./types.js";

/**
 * Exact, read-only proof for one durable unknown write
 * (client-c5-lifecycle-design.md §3). Nothing is ever re-sent.
 *
 * - committed / conflict: the slot or work holds an authoritative result
 *   (ours, or a different one that ours can never replace);
 * - not_published: the write's lease was fenced BEFORE an exact read that
 *   completed (all pages) without finding it;
 * - anything else keeps the entry.
 */
export type Proof =
  | "committed"
  | "conflict"
  | "not_published"
  | "binding_unavailable"
  | "not_fenced"
  | "unavailable"
  | "bounded";
export const RESOLVED: readonly Proof[] = [
  "committed",
  "conflict",
  "not_published",
];

/**
 * Allowance past lease expiry, on the backend's own clock (the HTTP Date of
 * the listing that showed the lease), before the lease counts as fenced.
 */
export const LEASE_SKEW_MS = 120_000;
const PAGES = 4;
const LIMIT = 50;

const code = (error: unknown) =>
  error instanceof AutonomyFailure ? error.code : undefined;

/** A bounded keyset scan; "bounded" when pagination did not complete. */
async function scan<T>(
  list: (cursor?: string) => Promise<Page<T>>,
  match: (item: T) => boolean,
): Promise<T | null | "bounded"> {
  let cursor: string | undefined;
  for (let page = 0; page < PAGES; page++) {
    const result = await list(cursor);
    const found = result.items.find(match);
    if (found) return found;
    if (!result.has_more) return null;
    if (!result.next_cursor) return "bounded";
    cursor = result.next_cursor;
  }
  return "bounded";
}

export interface ProofContext {
  backend: AutonomyBackend;
  mandate: MandateView;
}

/**
 * The entry's lease can never write again. Fencing is monotonic: the lease
 * generation only grows, and an expired lease cannot be renewed.
 */
async function fenced(
  entry: LedgerEntry,
  { backend }: ProofContext,
): Promise<boolean | "bounded"> {
  const leased = await scan<WorkItem>(
    (cursor) => backend.listWork({ status: "running", limit: LIMIT, cursor }),
    (w) => w.id === entry.work_id,
  );
  if (leased === "bounded") return "bounded";
  // Not leased: only a new claim (a higher generation) can lease it again.
  if (leased === null) return true;
  if (leased.lease_generation > entry.lease_generation) return true;
  if (leased.lease_generation < entry.lease_generation) return false;
  const expires = leased.lease_expires_at
    ? Date.parse(leased.lease_expires_at)
    : NaN;
  // Without the backend's clock, an apparently expired lease is not proof.
  const now = backend.serverTime ?? NaN;
  return (
    Number.isFinite(expires) &&
    Number.isFinite(now) &&
    expires + LEASE_SKEW_MS < now
  );
}

export async function prove(
  entry: LedgerEntry,
  ctx: ProofContext,
): Promise<Proof> {
  const { backend, mandate } = ctx;
  // Absence reads are account-scoped: only the original authority may prove.
  if (
    backend.origin !== entry.origin ||
    mandate.chief_id !== entry.chief_id ||
    mandate.dojo_id !== entry.dojo_id
  )
    return "binding_unavailable";
  const x = entry.expect;
  try {
    // Fence first: an absent read taken after the fence proves the write
    // can no longer land, so absence is final.
    const f = await fenced(entry, ctx);
    const absent = (): Proof =>
      f === "bounded" ? "bounded" : f ? "not_published" : "not_fenced";
    switch (entry.op) {
      case "act": {
        let receipt;
        try {
          receipt = await backend.actionReceipt(entry.work_id, entry.slot!);
        } catch (error) {
          if (code(error) === "ACTION_NOT_FOUND") return absent();
          throw error;
        }
        return receipt.type === x.type &&
          receipt.text_sha256 === x.text_sha256 &&
          (x.recipient_id === null ||
            receipt.recipient_id === x.recipient_id) &&
          (x.activity_id === null || receipt.activity_id === x.activity_id)
          ? "committed"
          : "conflict";
      }
      case "intent":
      case "composition": {
        let state;
        try {
          state = await backend.getIntent(entry.work_id, entry.slot!);
        } catch (error) {
          if (code(error) === "INTENT_NOT_FOUND") return absent();
          throw error;
        }
        if (entry.op === "composition") {
          if (!state.composition) return absent();
          return state.composition.text_sha256 === x.text_sha256
            ? "committed"
            : "conflict";
        }
        const i = state.intent;
        return i.type === x.type &&
          i.purpose === x.purpose &&
          (i.recipient_id ?? null) === x.recipient_id &&
          (i.activity_id ?? null) === x.activity_id &&
          (i.completed_at ?? null) === x.completed_at
          ? "committed"
          : "conflict";
      }
      case "follow_up": {
        const found = await scan(
          (cursor) => backend.listFollowUps({ limit: LIMIT, cursor }),
          (u) =>
            u.source.work_id === entry.work_id && u.source.slot === entry.slot,
        );
        if (found === "bounded") return "bounded";
        if (found === null) return absent();
        return found.subject_id === x.subject_id && found.basis === x.basis
          ? "committed"
          : "conflict";
      }
      case "follow_up_patch": {
        const found = await scan(
          (cursor) => backend.listFollowUps({ limit: LIMIT, cursor }),
          (u) => u.id === entry.follow_up_id,
        );
        if (found === "bounded") return "bounded";
        if (found === null) return "unavailable";
        const expected = x.expected_revision as number;
        // CAS on revision: unchanged revision means our patch never applied.
        if (found.revision === expected) return absent();
        if (found.revision < expected) return "unavailable";
        return found.status === x.status &&
          found.closure_reason === x.closure_reason
          ? "committed"
          : "conflict";
      }
      case "complete": {
        // Only the exact report proves a completion; once fenced, its
        // complete (all pages) absence proves the completion never landed.
        if (f !== true) return absent();
        const report = await scan(
          (cursor) => backend.reports({ limit: LIMIT, cursor }),
          (r) =>
            r.work_id === entry.work_id && reportDigest(r) === x.report_sha256,
        );
        if (report === "bounded") return "bounded";
        return report ? "committed" : "not_published";
      }
    }
  } catch {
    return "unavailable";
  }
}
