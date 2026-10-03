import { AutonomyFailure } from "./backend.js";
import { COMPLETION_DIGEST } from "./types.js";
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
 *
 * C5 R1/R2: listings are scoped to the CURRENT mandate, so an entry recorded
 * under another mandate is never proven from them (`mandate_changed`).
 * A completion is proven only by the exact receipt of its own lease
 * generation (backend 44273475, read by the original account, independent of
 * the current mandate): committed with our recorded body digest (committed),
 * committed with another body (superseded: at most one completion commits per
 * generation), or exactly not committed (not_published). Report projections
 * and listings never prove a completion.
 */
export type Proof =
  | "committed"
  | "conflict"
  | "superseded"
  | "not_published"
  | "binding_unavailable"
  | "mandate_changed"
  | "not_fenced"
  | "unavailable"
  | "bounded"
  // Completion receipt outcomes that keep the entry.
  | "pending"
  | "unrecorded"
  | "receipt_mismatch"
  | "legacy_no_digest"
  | "denied"
  | "not_found"
  | "receipt_unsupported"
  | "malformed";
export const RESOLVED: readonly Proof[] = [
  "committed",
  "conflict",
  "superseded",
  "not_published",
];
/**
 * Who committed a completion receipt's body, as the backend attributes it to
 * the reading bearer: never claimed as this credential unless it says so.
 */
export type Attribution =
  | "this_credential"
  | "account_other_credential"
  | "unattributed";
export interface Settlement {
  proof: Proof;
  attribution: Attribution | null;
}

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
  /** The current mandate; null when unreadable (completions need none). */
  mandate: MandateView | null;
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
  return (await settle(entry, ctx)).proof;
}

export async function settle(
  entry: LedgerEntry,
  ctx: ProofContext,
): Promise<Settlement> {
  if (entry.op === "complete") return completion(entry, ctx.backend);
  if (!ctx.mandate) return { proof: "unavailable", attribution: null };
  return {
    proof: await mandated(entry, { ...ctx, mandate: ctx.mandate }),
    attribution: null,
  };
}

const failure = (error: unknown): Proof => {
  switch (code(error)) {
    case "AUTONOMY_AUTH_EXPIRED":
    case "AUTONOMY_NOT_AUTHORIZED":
      return "denied";
    case "AUTONOMY_NOT_FOUND":
      return "not_found";
    // A framework 404: a backend without exact completion receipts.
    case "AUTONOMY_UNSUPPORTED":
      return "receipt_unsupported";
    case "AUTONOMY_RESULT_REJECTED":
      return "malformed";
    default:
      return "unavailable";
  }
};

/**
 * One generation-exact receipt read. A 200 answer comes only from the
 * original account; a committed receipt must also name the entry's exact
 * work, generation, mandate, Dojo and chief.
 */
async function completion(
  entry: LedgerEntry,
  backend: AutonomyBackend,
): Promise<Settlement> {
  const keep = (proof: Proof): Settlement => ({ proof, attribution: null });
  if (backend.origin !== entry.origin) return keep("binding_unavailable");
  let answer;
  try {
    answer = await backend.completionReceipt(
      entry.work_id,
      entry.lease_generation,
    );
  } catch (error) {
    return keep(failure(error));
  }
  if (answer.state === "not_committed") return keep("not_published");
  if (answer.state !== "committed" || !answer.receipt)
    return keep(answer.state === "committed" ? "malformed" : answer.state);
  const r = answer.receipt;
  const x = entry.expect;
  if (
    r.work_id !== entry.work_id ||
    r.lease_generation !== entry.lease_generation ||
    r.mandate_id !== entry.mandate_id ||
    r.dojo_id !== entry.dojo_id ||
    r.chief_id !== entry.chief_id
  )
    return keep("receipt_mismatch");
  const attribution: Attribution =
    r.credential_match === true
      ? "this_credential"
      : r.credential_match === false
        ? "account_other_credential"
        : "unattributed";
  // An entry recorded before exact digests (projection only) can never be
  // matched to a body: no digest is synthesized for it.
  if (
    x.digest_algorithm !== COMPLETION_DIGEST ||
    typeof x.request_sha256 !== "string"
  )
    return { proof: "legacy_no_digest", attribution };
  if (r.request_sha256 !== x.request_sha256)
    return { proof: "superseded", attribution };
  // Equal digests cover mandate_revision; a disagreement is not proof.
  if (r.mandate_revision !== x.mandate_revision)
    return keep("receipt_mismatch");
  return { proof: "committed", attribution };
}

async function mandated(
  entry: LedgerEntry,
  ctx: ProofContext & { mandate: MandateView },
): Promise<Proof> {
  const proof = await read(entry, ctx);
  if (!RESOLVED.includes(proof)) return proof;
  // The reads resolved the CURRENT mandate at request time: a replacement
  // during them makes their answer (notably absence) about another mandate.
  // Mandate ids are never reused, so an unchanged id after the reads proves
  // every read was scoped to the entry's mandate.
  try {
    const after = await ctx.backend.mandate();
    if (
      after.mandate_id !== entry.mandate_id ||
      after.chief_id !== entry.chief_id ||
      after.dojo_id !== entry.dojo_id
    )
      return "mandate_changed";
  } catch {
    return "unavailable";
  }
  return proof;
}

async function read(
  entry: LedgerEntry,
  ctx: ProofContext & { mandate: MandateView },
): Promise<Proof> {
  const { backend, mandate } = ctx;
  // Absence reads are account-scoped: only the original authority may prove.
  if (
    backend.origin !== entry.origin ||
    mandate.chief_id !== entry.chief_id ||
    mandate.dojo_id !== entry.dojo_id
  )
    return "binding_unavailable";
  // Mandate-scoped reads say nothing about another mandate's operations.
  if (mandate.mandate_id !== entry.mandate_id) return "mandate_changed";
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
      case "complete":
        // Settled only by its exact generation receipt (`completion`).
        return "unavailable";
    }
  } catch {
    return "unavailable";
  }
}
