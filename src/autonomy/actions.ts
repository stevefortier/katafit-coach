import { createHash } from "node:crypto";
import { AutonomyFailure, type AutonomyBackend } from "./backend.js";
import type {
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
    receipt.text_sha256 !== sha256(input.text)
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
export const VISIBLE_REFUSALS = [
  "ACTION_CONFLICT",
  "ACTION_LIMITED",
  "ACTION_UNSUPPORTED",
  "RECIPIENT_NOT_MEMBER",
  "INTENT_REQUIRED",
  "COMPOSITION_MISMATCH",
  "COMMITMENT_EVIDENCE_REQUIRED",
  "COMMITMENT_EVIDENCE_MISMATCH",
  "CONVERSATION_NOT_AUTHORIZED",
  "AUTONOMY_CONFLICT",
] as const;
