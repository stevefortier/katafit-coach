import { Ajv } from "ajv";
import { restGetTool } from "../katafit/restGet.js";
import {
  CLOSURE_REASONS,
  FOLLOW_UP_BASES,
  ID,
  INTENT_TYPES,
  MEMBER_PURPOSES,
  PRAISE_PURPOSES,
  REF_PATTERN,
  SLOT_PATTERN,
  TONES,
  intentCoherent,
  type Intent,
} from "./types.js";

/**
 * [AC1] Manager-private planner tools. None carries trainee/public text: the
 * planner selects a finite intent and only the isolated composer drafts it.
 * The private manager report is the only free-text tool.
 */
export const INTEND_TOOL = "coach_autonomy_intend";
export const REPORT_TOOL = "coach_autonomy_report";
export const FOLLOW_UP_TOOL = "coach_autonomy_follow_up";
export const PLANNER_TOOL_NAMES = [
  restGetTool.name,
  INTEND_TOOL,
  REPORT_TOOL,
  FOLLOW_UP_TOOL,
];

const object = (
  properties: Record<string, unknown>,
  optional: string[] = [],
) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties).filter((k) => !optional.includes(k)),
  properties,
});
const id = { type: "string", pattern: ID };
const slot = { type: "string", pattern: SLOT_PATTERN.source };
const iso = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
};

const intendParameters = object({
  slot,
  intent: object(
    {
      type: { enum: INTENT_TYPES },
      recipient_id: id,
      activity_id: id,
      completed_at: iso,
      purpose: { enum: [...MEMBER_PURPOSES, ...PRAISE_PURPOSES] },
      tone: { enum: TONES },
      evidence_refs: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: { type: "string", pattern: REF_PATTERN.source },
      },
    },
    ["recipient_id", "activity_id", "completed_at", "tone"],
  ),
});
const reportParameters = object({
  slot,
  text: { type: "string", minLength: 1, maxLength: 8000 },
});
const followUpParameters = object(
  {
    slot,
    op: { enum: ["create", "close"] },
    subject_id: id,
    basis: { enum: FOLLOW_UP_BASES },
    summary: { type: "string", minLength: 1, maxLength: 500 },
    due_at: iso,
    next_condition: { type: "string", minLength: 1, maxLength: 300 },
    evidence: object(
      {
        message_ref: { type: "string", minLength: 1, maxLength: 4096 },
        request_id: id,
        quote: { type: "string", minLength: 8, maxLength: 300 },
      },
      ["message_ref", "request_id"],
    ),
    follow_up_id: id,
    expected_revision: { type: "integer", minimum: 0 },
    closure_reason: { enum: CLOSURE_REASONS },
  },
  [
    "subject_id",
    "basis",
    "summary",
    "due_at",
    "next_condition",
    "evidence",
    "follow_up_id",
    "expected_revision",
    "closure_reason",
  ],
);

export interface IntendArgs {
  slot: string;
  intent: Intent;
}
export interface ReportArgs {
  slot: string;
  text: string;
}
export type FollowUpArgs =
  | {
      slot: string;
      op: "create";
      subject_id: string;
      basis: (typeof FOLLOW_UP_BASES)[number];
      summary: string;
      due_at: string;
      next_condition: string;
      evidence?: { message_ref?: string; request_id?: string; quote: string };
    }
  | {
      slot: string;
      op: "close";
      follow_up_id: string;
      expected_revision: number;
      closure_reason: (typeof CLOSURE_REASONS)[number];
    };

/** Host callbacks; each runs under the claimed work item's lease. */
export interface PlannerCallbacks {
  intend(args: IntendArgs, signal?: AbortSignal): Promise<unknown>;
  report(args: ReportArgs, signal?: AbortSignal): Promise<unknown>;
  followUp(args: FollowUpArgs, signal?: AbortSignal): Promise<unknown>;
}

const ajv = new Ajv({ strict: true, coerceTypes: false, useDefaults: false });
const followUpCreate = [
  "subject_id",
  "basis",
  "summary",
  "due_at",
  "next_condition",
];
const followUpClose = ["follow_up_id", "expected_revision", "closure_reason"];
const validators: Record<string, (args: any) => boolean> = {
  [INTEND_TOOL]: (
    (check) => (args: any) =>
      check(args) && intentCoherent((args as unknown as IntendArgs).intent)
  )(ajv.compile(intendParameters)),
  [REPORT_TOOL]: ajv.compile(reportParameters),
  [FOLLOW_UP_TOOL]: ((check) => (args: any) => {
    if (!check(args)) return false;
    const [needed, banned] =
      args.op === "create"
        ? [followUpCreate, followUpClose]
        : [followUpClose, [...followUpCreate, "evidence"]];
    return needed.every((k) => k in args) && !banned.some((k) => k in args);
  })(ajv.compile(followUpParameters)),
};

export const plannerTools = [
  restGetTool,
  {
    name: INTEND_TOOL,
    description:
      "Select one finite outbound intent for this work item (member_message to one current roster member, or public_praise for one completed activity). You never write the outbound words: an isolated composer drafts them from approved public facts only. Cite evidence refs you read (ev:, act:, msg:, fu:, rcpt:).",
    parameters: intendParameters,
  },
  {
    name: REPORT_TOOL,
    description:
      "Send the manager (dojo chief) a private, receipt-grounded report for this work item. Never visible to trainees.",
    parameters: reportParameters,
  },
  {
    name: FOLLOW_UP_TOOL,
    description:
      "Create a follow-up (op=create) for a later check, or close one you own (op=close with follow_up_id, expected_revision, closure_reason). A member_commitment needs the member's own quoted words.",
    parameters: followUpParameters,
  },
];

/** Strict argument admission; anything else is refused before any callback. */
export function plannerArgs(name: string, args: unknown): boolean {
  const check = validators[name];
  return !!check && check(args);
}
