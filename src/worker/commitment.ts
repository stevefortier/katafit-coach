import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Client, ToolFailure } from "../katafit/client.js";
import { SafeError } from "../runtime/errors.js";
import { assertNoSecrets } from "../config/store.js";

// [v2 §2.7] Request-worker commitment handoff (backend B10). Offered only when
// the backend advertises the tool; the request fence is host-owned, the quote
// must be the member's own words, and no outcome ever affects coach_respond.
export const COMMITMENT_TOOL = "coach_record_commitment";
export const COMMITMENT_CODES = [
  "LEASE_LOST",
  "COMMITMENT_EVIDENCE_MISMATCH",
  "COMMITMENT_SLOT_CONFLICT",
  "SCOPE_CHANGED",
  "REQUESTER_SCOPE_CHANGED",
  "COMMITMENT_UNAVAILABLE",
] as const;
export const COMMITMENT_GUIDANCE =
  "\nCommitment handoff: coach_record_commitment is available for this request. Record a commitment only when the member explicitly committed to something in this message; pass their exact words as quote. Never infer a commitment from plans, history, records or missed items. Recording is not a reply: always answer normally, and if it returns recorded:false, do not tell the member it was recorded.\n";

const KEYS = ["slot", "quote", "due_at", "timezone", "next_condition"];
const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
const str = (v: unknown, min: number, max: number) =>
  typeof v === "string" && v.trim().length >= min && v.length <= max;
function validZone(zone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
function text(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: {},
  };
}

export function commitmentTool(options: {
  client: Client;
  fence: { request_id: string; lease_generation: number };
  message: unknown;
  current: () => boolean;
  budget: () => number;
  secrets: string[];
}): AgentTool {
  const message = typeof options.message === "string" ? options.message : "";
  return {
    name: COMMITMENT_TOOL,
    label: "Record member commitment",
    description:
      "Record one explicit commitment the member made in this message so the Coach can follow up later. quote must be copied verbatim from the member's message. Returns recorded:true with a follow_up_id, or recorded:false with a reason or error.",
    parameters: {
      type: "object",
      properties: {
        slot: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" },
        quote: { type: "string", minLength: 8, maxLength: 300 },
        due_at: { type: "string", format: "date-time" },
        timezone: { type: "string", minLength: 1, maxLength: 64 },
        next_condition: { type: "string", minLength: 1, maxLength: 300 },
      },
      required: KEYS,
      additionalProperties: false,
    } as any,
    prepareArguments(args: any) {
      if (
        !args ||
        typeof args !== "object" ||
        Object.keys(args).some((k) => !KEYS.includes(k)) ||
        typeof args.slot !== "string" ||
        !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(args.slot) ||
        !str(args.quote, 8, 300) ||
        !str(args.next_condition, 1, 300) ||
        typeof args.due_at !== "string" ||
        !Number.isFinite(Date.parse(args.due_at)) ||
        !str(args.timezone, 1, 64) ||
        !validZone(args.timezone)
      )
        throw new SafeError("ARGUMENTS_REJECTED");
      assertNoSecrets(args, options.secrets);
      return args;
    },
    execute: async (_id: string, args: any) => {
      if (!options.current())
        return text({ recorded: false, error: "LEASE_LOST" });
      if (!normalize(message).includes(normalize(args.quote)))
        return text({
          recorded: false,
          error: "COMMITMENT_EVIDENCE_MISMATCH",
          note: "quote is not the member's own words in this message; nothing was recorded",
        });
      const payload = {
        ...options.fence,
        slot: args.slot,
        quote: args.quote,
        due_at: args.due_at,
        timezone: args.timezone,
        next_condition: args.next_condition,
      };
      // One identical retry settles a lost response: the backend dedupes by
      // (request, slot) and refuses a different payload for the same slot.
      for (let attempt = 0; ; attempt++) {
        try {
          const out = await options.client.call(
            COMMITMENT_TOOL,
            payload,
            options.budget(),
          );
          assertNoSecrets(out, options.secrets);
          if (
            out?.recorded === true &&
            typeof out.follow_up_id === "string" &&
            typeof out.idempotent === "boolean"
          )
            return text({
              recorded: true,
              follow_up_id: out.follow_up_id,
              idempotent: out.idempotent,
            });
          if (
            out?.recorded === false &&
            ["no_mandate", "scope_unsupported"].includes(out.reason)
          )
            return text({ recorded: false, reason: out.reason });
          return text({ recorded: false, error: "COMMITMENT_UNAVAILABLE" });
        } catch (error) {
          options.client.signal.throwIfAborted();
          if (error instanceof ToolFailure)
            return text({
              recorded: false,
              error: (COMMITMENT_CODES as readonly string[]).includes(
                error.code ?? "",
              )
                ? error.code
                : "COMMITMENT_UNAVAILABLE",
            });
          if (attempt >= 1 || !options.current())
            return text({
              recorded: false,
              error: "COMMITMENT_OUTCOME_UNKNOWN",
              note: "the backend did not confirm; do not tell the member it was recorded",
            });
        }
      }
    },
  };
}
