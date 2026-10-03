import { createHash } from "node:crypto";
import { AutonomyFailure, type AutonomyBackend } from "./backend.js";
import { PRAISE_TEXT_LIMIT } from "./types.js";
import type {
  WorkItem,
  ActionIntent,
  ActionReceipt,
  FollowUp,
  FollowUpInput,
} from "./types.js";

// C4 settle-then-prove: a slot write whose response was lost is resolved
// from the backend, never guessed. Slot writes are idempotent per
// (work, slot), so only an identical body is ever sent again.

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const failed = (error: unknown, code: string) =>
  error instanceof AutonomyFailure && error.code === code;
export const isUnknown = (error: unknown) =>
  failed(error, "AUTONOMY_OUTCOME_UNKNOWN");

/**
 * Commit one action slot exactly once. A lost response is settled by reading
 * the slot's receipt; a slot the backend never saw (404) is re-sent once with
 * the identical body. Anything still unresolved stays AUTONOMY_OUTCOME_UNKNOWN.
 */
export async function settleAction(
  backend: AutonomyBackend,
  workId: string,
  slot: string,
  input: ActionIntent,
): Promise<{
  receipt: ActionReceipt;
  idempotent: boolean;
  recovered: boolean;
}> {
  let lost: unknown;
  try {
    return { ...(await backend.act(workId, slot, input)), recovered: false };
  } catch (error) {
    if (!isUnknown(error)) throw error;
    lost = error;
  }
  let receipt: ActionReceipt;
  try {
    receipt = await backend.actionReceipt(workId, slot);
  } catch (error) {
    if (!failed(error, "ACTION_NOT_FOUND")) throw lost;
    // Never committed: the identical body is still the same occurrence.
    return { ...(await backend.act(workId, slot, input)), recovered: true };
  }
  const recipient =
    input.type === "member_message" ? input.recipient_id : receipt.recipient_id;
  if (
    receipt.type !== input.type ||
    receipt.recipient_id !== recipient ||
    receipt.text_sha256 !== sha256(input.text) ||
    (input.type === "public_praise" &&
      (receipt.activity_id !== input.activity_id ||
        !["published", "already_published"].includes(receipt.status)))
  )
    throw new AutonomyFailure("ACTION_CONFLICT");
  return { receipt, idempotent: true, recovered: true };
}

/**
 * Create one follow-up slot exactly once. The backend has no per-slot read,
 * but the PUT is idempotent per (work, slot): one identical re-send settles a
 * lost response.
 */
export async function settleFollowUp(
  backend: AutonomyBackend,
  workId: string,
  slot: string,
  input: FollowUpInput,
): Promise<{ follow_up: FollowUp; idempotent: boolean; recovered: boolean }> {
  try {
    return {
      ...(await backend.followUp(workId, slot, input)),
      recovered: false,
    };
  } catch (error) {
    if (!isUnknown(error)) throw error;
  }
  return {
    ...(await backend.followUp(workId, slot, input)),
    recovered: true,
  };
}

/** Backend refusals the planner can see and adapt to; nothing was sent. */
// contracts §14 step 2: the work's own completion events attest the activity.
// completed_at is the occurrence the planner read; the backend checks it.
export function praiseIntentFault(
  work: Pick<WorkItem, "source">,
  intent: { activity_id?: string; completed_at?: string },
): "AUTONOMY_INVALID" | "PRAISE_NOT_AUTHORIZED" | null {
  if (
    typeof intent.completed_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(
      intent.completed_at,
    ) ||
    Number.isNaN(Date.parse(intent.completed_at))
  )
    return "AUTONOMY_INVALID";
  const attested = (work.source.events ?? []).some(
    (e) =>
      e.subject?.id === intent.activity_id &&
      /\.(completed|completion_time_corrected)$/.test(e.event_type),
  );
  return attested && typeof intent.activity_id === "string"
    ? null
    : "PRAISE_NOT_AUTHORIZED";
}

// Mirrors the backend's sanitizePublicCoachComment so a doomed praise is
// refused before any write; the backend remains authoritative.
export function praiseTextFault(text: string): "PRAISE_TEXT_REJECTED" | null {
  const t = String(text ?? "").trim();
  if (
    !t ||
    t.length > PRAISE_TEXT_LIMIT ||
    /[\r\n\u0000-\u001f]/.test(t) ||
    /https?:\/\/|www\.|```|ignore\s+(all\s+)?previous|system\s+prompt|developer\s+message/i.test(
      t,
    ) ||
    /\b(kill\s+yourself|kys|pathetic|loser|worthless|idiot|moron|stupid|hate|subhuman|f+u+c+k(?:ing)?|bitch|asshole|rape|rapist|sex(?:y|ual)?|nude|naked|porn|dick|cock|pussy|whore|slut)\b/i.test(
      t,
    )
  )
    return "PRAISE_TEXT_REJECTED";
  return null;
}

export const VISIBLE_REFUSALS = [
  "ACTION_CONFLICT",
  "ACTION_LIMITED",
  "ACTION_UNSUPPORTED",
  "RECIPIENT_NOT_MEMBER",
  "INTENT_REQUIRED",
  "INTENT_CONFLICT",
  "INTENT_EVIDENCE_NOT_AUTHORIZED",
  "COMPOSITION_MISMATCH",
  "PRAISE_NOT_AUTHORIZED",
  "PRAISE_SOURCE_CHANGED",
  "PRAISE_TEXT_REJECTED",
  "COMMITMENT_EVIDENCE_REQUIRED",
  "COMMITMENT_EVIDENCE_MISMATCH",
  "CONVERSATION_NOT_AUTHORIZED",
  "AUTONOMY_CONFLICT",
] as const;
