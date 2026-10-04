import { Ajv } from "ajv";

// coach.autonomy.v1 wire contract (work-packages.md §2). The backend owns
// authority, scheduling, claims and receipts; these validators only bound the
// shapes this host sends and accepts. Unknown fields are rejected both ways.
export const AUTONOMY_PROTOCOL = "coach.autonomy.v1";
export const AUTONOMY_ROOT = "/api/coach/autonomy";

export const BACKEND_CODES = [
  "AUTONOMY_NOT_AUTHORIZED",
  "AUTONOMY_SCOPE_UNSUPPORTED",
  "AUTONOMY_SCOPE_CHANGED",
  "AUTONOMY_INVALID",
  "AUTONOMY_CONFLICT",
  "AUTONOMY_IDEMPOTENCY_CONFLICT",
  "AUTONOMY_MANDATE_CHANGED",
  "AUTONOMY_DISABLED",
  "AUTONOMY_NOT_FOUND",
  "LEASE_LOST",
  "ACTION_CONFLICT",
  "ACTION_LIMITED",
  "ACTION_UNSUPPORTED",
  "ACTION_NOT_FOUND",
  "ACTION_UNRESOLVED",
  "RECIPIENT_NOT_MEMBER",
  "AUTONOMY_UNAVAILABLE",
  // [v2] praise and explicit-commitment evidence
  "PRAISE_NOT_AUTHORIZED",
  "PRAISE_SOURCE_CHANGED",
  "PRAISE_TEXT_REJECTED",
  "COMMITMENT_EVIDENCE_REQUIRED",
  "COMMITMENT_EVIDENCE_MISMATCH",
  "CONVERSATION_NOT_AUTHORIZED",
  // [AC1] finite intents and stored compositions
  "INTENT_CONFLICT",
  "INTENT_INVALID",
  "INTENT_EVIDENCE_NOT_AUTHORIZED",
  "INTENT_REQUIRED",
  "INTENT_NOT_FOUND",
  "COMPOSITION_INVALID",
  "COMPOSITION_MISMATCH",
] as const;
/** Host-side classifications; never carry backend prose. */
export const HOST_CODES = [
  "AUTONOMY_AUTH_EXPIRED",
  "AUTONOMY_UNSUPPORTED",
  "AUTONOMY_OUTCOME_UNKNOWN",
  "AUTONOMY_RESULT_REJECTED",
] as const;
export type AutonomyCode =
  | (typeof BACKEND_CODES)[number]
  | (typeof HOST_CODES)[number];
export const LIMITS = [
  "quiet_hours",
  "cooldown",
  "member_daily",
  "dojo_daily",
  "budget",
  "praise_daily",
  "praise_in_progress",
] as const;
export type Limit = (typeof LIMITS)[number];

export const MODES = ["off", "observe", "message"] as const;
export const ACTION_TYPES = [
  "member_message",
  "manager_report",
  "follow_up",
  "public_praise",
] as const;
export const DELEGATED_ACTION_TYPES = [
  ...ACTION_TYPES,
  "configured_integration",
  "rest_mutation",
  "proposal_approval",
] as const;
export const WORK_KINDS = [
  "event",
  "conversation",
  "reconcile",
  "follow_up",
  "digest",
] as const;
export const WORK_STATUSES = [
  "queued",
  "claimed",
  "running",
  "completed",
  "deferred",
  "blocked",
  "failed",
  "cancelled",
] as const;
export const WORK_FILTERS = [
  "due",
  "queued",
  "running",
  "blocked",
  "recent",
] as const;
export const BLOCKED_REASONS = [
  "uncertain_write",
  "insufficient_authority",
  "manager_decision_needed",
  "budget_exhausted",
  "attempts_exhausted",
] as const;
/**
 * Host-owned outcome reasons. The planner never chooses these; the host sends
 * one only when the backend advertises it in mandate capabilities (710d4513).
 */
export const HOST_BLOCKED_REASONS = [
  ...BLOCKED_REASONS,
  "composition_rejected",
] as const;
export const UNOBSERVED = ["member_chat", "images", "pages_truncated"] as const;
export const DECISIONS = [
  "no_action",
  "acted",
  "deferred",
  "escalated",
] as const;
export const FOLLOW_UP_BASES = [
  "member_commitment",
  "manager_instruction",
  "coach_request",
] as const;
export const FOLLOW_UP_STATUSES = ["open", "closed", "cancelled"] as const;
export const PAGE_SOURCES = [
  "day_events",
  "member_conversation",
  "roster",
  "memory",
] as const;
/** [AC1] Finite intent vocabulary; no field of an intent carries free text. */
export const INTENT_TYPES = ["member_message", "public_praise"] as const;
export const MEMBER_PURPOSES = [
  "progress_praise",
  "follow_up_reminder",
  "missed_commitment_check",
  "answer_question",
  "check_in",
] as const;
export const PRAISE_PURPOSES = [
  "completion_praise",
  "personal_record_praise",
] as const;
export const TONES = ["warm", "direct", "celebratory", "gentle"] as const;
export const INTENT_STATUSES = [
  "intended",
  "composed",
  "dispatched",
  "blocked",
] as const;
export const REF_PATTERN = /^(ev|act|msg|fu|rcpt|pub):[A-Za-z0-9._:/-]{1,600}$/;
export const PRAISE_TEXT_LIMIT = 100;
export const CLOSURE_REASONS = [
  "evidence_met",
  "superseded",
  "manager_cancelled",
  "scope_changed",
  "expired",
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];
export type WorkStatus = (typeof WORK_STATUSES)[number];
export type WorkFilter = (typeof WORK_FILTERS)[number];
export type Mode = (typeof MODES)[number];
export type ActionType = (typeof ACTION_TYPES)[number];
export type IntentType = (typeof INTENT_TYPES)[number];
export type Purpose =
  | (typeof MEMBER_PURPOSES)[number]
  | (typeof PRAISE_PURPOSES)[number];

export const ID = "^[a-f0-9]{24}$";
export const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
export const SLOT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const ACTION_KEY_PATTERN = /^ca1_[A-Za-z0-9_-]{43}$/;
export const CHECKPOINT_LIMIT = 4096;
const ISO = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";
const CLOCK = "^(?:[01]\\d|2[0-3]):[0-5]\\d$";

const int = (minimum: number, maximum: number) => ({
  type: "integer",
  minimum,
  maximum,
});
const object = (
  properties: Record<string, unknown>,
  optional: string[] = [],
) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties).filter((k) => !optional.includes(k)),
  properties,
});
const nullable = (schema: Record<string, unknown>) => ({
  anyOf: [{ type: "null" }, schema],
});
/** Response envelope: every coach.autonomy.v1 response names its protocol. */
const envelope = (properties: Record<string, unknown>) =>
  object({ protocol: { const: AUTONOMY_PROTOCOL }, ...properties });
const id = { type: "string", pattern: ID };
const iso = { type: "string", pattern: ISO };
const clock = { type: "string", pattern: CLOCK };
const slot = { type: "string", pattern: SLOT_PATTERN.source };
const list = (items: unknown, maxItems: number) => ({
  type: "array",
  maxItems,
  items,
});
const count = int(0, Number.MAX_SAFE_INTEGER);
const digest = { type: "string", pattern: "^[a-f0-9]{64}$" };

/** Backend 44273475 exact completion receipt (per lease generation). */
export const COMPLETION_DIGEST = "sha256-rfc8785";
export const COMPLETION_STATES = [
  "committed",
  "pending",
  "not_committed",
  "unrecorded",
] as const;
const generation = int(1, 999_999_999);
const completionReceipt = object({
  work_id: id,
  mandate_id: id,
  dojo_id: id,
  chief_id: id,
  mandate_revision: count,
  lease_generation: generation,
  credential_match: { enum: [true, false, null] },
  digest_algorithm: { const: COMPLETION_DIGEST },
  request_sha256: digest,
  result: { enum: ["completed", "deferred", "blocked", "failed"] },
  status_after: { enum: ["completed", "blocked", "deferred", "queued"] },
  report_id: id,
  committed_at: iso,
});

const actionReceipt = object(
  {
    slot,
    type: { enum: ["member_message", "manager_report", "public_praise"] },
    status: { enum: ["delivered", "published", "already_published"] },
    recipient_id: id,
    message_id: { type: "string", minLength: 1, maxLength: 256 },
    idempotency_key: { type: "string", pattern: ACTION_KEY_PATTERN.source },
    comment_id: { type: "string", minLength: 1, maxLength: 128 },
    activity_id: id,
    subject_user_id: id,
    text_sha256: digest,
    committed_at: iso,
  },
  [
    "recipient_id",
    "message_id",
    "idempotency_key",
    "comment_id",
    "activity_id",
    "subject_user_id",
  ],
);
const ref = { type: "string", pattern: REF_PATTERN.source };
const intentFields = {
  type: { enum: INTENT_TYPES },
  recipient_id: id,
  activity_id: id,
  completed_at: iso,
  purpose: { enum: [...MEMBER_PURPOSES, ...PRAISE_PURPOSES] },
  tone: { enum: TONES },
  evidence_refs: { ...list(ref, 8), minItems: 1 },
};
const intentOptional = ["recipient_id", "activity_id", "completed_at", "tone"];
/** [AC1] Content-free intent summary carried on a work item. */
const workIntent = object(
  {
    slot,
    type: { enum: INTENT_TYPES },
    recipient_id: id,
    activity_id: id,
    purpose: intentFields.purpose,
    status: { enum: INTENT_STATUSES },
    composition_sha256: nullable(digest),
  },
  ["recipient_id", "activity_id"],
);
const intentRecord = object(
  {
    slot,
    ...intentFields,
    status: { enum: INTENT_STATUSES },
    created_at: iso,
  },
  intentOptional,
);
const publicProjection = object({
  subject_display_name: { type: "string", minLength: 1, maxLength: 120 },
  activity_type: { type: "string", minLength: 1, maxLength: 64 },
  activity_name: { type: "string", minLength: 0, maxLength: 200 },
  completed_at: iso,
  personal_record: { type: "boolean" },
});
const storedComposition = object({
  text: { type: "string", minLength: 1, maxLength: 8000 },
  text_sha256: digest,
  stored_at: iso,
});
const workItem = object(
  {
    id,
    kind: { enum: WORK_KINDS },
    mandate_id: id,
    mandate_revision: count,
    status: { enum: WORK_STATUSES },
    due_at: iso,
    attempts: count,
    subject_ids: list(id, 50),
    source: object(
      {
        event_ids: list(id, 100),
        follow_up_id: id,
        digest_local_date: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        },
        reconcile_bucket: { type: "string", minLength: 1, maxLength: 64 },
        events: list(
          object({
            ledger_id: id,
            occurred_at: iso,
            event_type: { type: "string", minLength: 1, maxLength: 64 },
            subject: object({
              type: { type: "string", minLength: 1, maxLength: 32 },
              id: { type: "string", minLength: 1, maxLength: 64 },
            }),
          }),
          100,
        ),
        conversation: object({
          member_id: id,
          from_epoch: count,
          to_epoch: count,
        }),
      },
      [
        "event_ids",
        "follow_up_id",
        "digest_local_date",
        "reconcile_bucket",
        "events",
        "conversation",
      ],
    ),
    checkpoint: nullable({ type: "string", maxLength: CHECKPOINT_LIMIT }),
    lease_generation: count,
    lease_expires_at: nullable(iso),
    // Contract amendment 1: null until the current attempt is claimed.
    timeout_at: nullable(iso),
    actions: list(
      {
        anyOf: [
          actionReceipt,
          object({
            slot,
            type: { const: "rest_mutation" },
            status: { const: "response_received" },
            request_sha256: digest,
            opened_lease_generation: generation,
            effect_receipt: { const: false },
            observed_at: iso,
          }),
        ],
      },
      64,
    ),
    // [AC1] Pinned in §2.2; tolerated as absent until the backend ships B11.
    intents: list(workIntent, 64),
    follow_ups: list(id, 64),
    blocked_reason: nullable({ type: "string", minLength: 1, maxLength: 64 }),
    created_at: iso,
    updated_at: iso,
  },
  ["intents"],
);
/** [v2] The member's own verbatim words, bound to one message or request. */
const commitmentEvidence = object(
  {
    message_ref: { type: "string", minLength: 1, maxLength: 4096 },
    request_id: id,
    quote: { type: "string", minLength: 8, maxLength: 300 },
  },
  ["message_ref", "request_id"],
);
const followUp = object({
  id,
  subject_id: id,
  status: { enum: FOLLOW_UP_STATUSES },
  basis: { enum: FOLLOW_UP_BASES },
  summary: { type: "string", minLength: 1, maxLength: 500 },
  due_at: iso,
  timezone: { type: "string", minLength: 1, maxLength: 64 },
  next_condition: { type: "string", minLength: 1, maxLength: 300 },
  last_evidence_at: nullable(iso),
  source: object(
    {
      work_id: id,
      slot,
      action_message_id: { type: "string", minLength: 1, maxLength: 256 },
      request_id: id,
    },
    ["work_id", "action_message_id", "request_id"],
  ),
  evidence: nullable(commitmentEvidence),
  closure_reason: { enum: [null, ...CLOSURE_REASONS] },
  revision: count,
  created_at: iso,
  updated_at: iso,
});
const page = (items: unknown) =>
  envelope({
    items: list(items, 50),
    next_cursor: nullable({ type: "string", minLength: 1, maxLength: 2048 }),
    has_more: { type: "boolean" },
  });
const cycleOutcome = object(
  {
    result: { enum: ["completed", "deferred", "blocked", "failed"] },
    next_due_at: iso,
    blocked_reason: { enum: BLOCKED_REASONS },
    coverage: object(
      {
        members_considered: count,
        members_read: count,
        partial: { type: "boolean" },
        unobserved: { ...list({ enum: UNOBSERVED }, 3), uniqueItems: true },
        pages: list(
          object({
            source: { enum: PAGE_SOURCES },
            read: count,
            denied: count,
            failed: count,
            truncated: count,
          }),
          16,
        ),
      },
      ["pages"],
    ),
    decisions: list(
      object({
        subject_id: nullable(id),
        decision: { enum: DECISIONS },
        action_slots: list(slot, 16),
        follow_up_ids: list(id, 16),
      }),
      50,
    ),
    uncertainty: list({ type: "string", minLength: 1, maxLength: 200 }, 10),
    budget: object({
      provider_tokens: count,
      tool_calls: count,
      elapsed_ms: count,
    }),
  },
  ["next_due_at", "blocked_reason"],
);

/** Manager-editable mandate fields (PUT body `mandate`). */
const mandateFields = {
  mode: { enum: MODES },
  paused: { type: "boolean" },
  timezone: nullable({ type: "string", minLength: 1, maxLength: 64 }),
  quiet_hours: nullable(object({ start: clock, end: clock })),
  contact_limits: object({
    member_daily: int(0, 5),
    member_cooldown_minutes: int(0, 1440),
    dojo_daily: int(0, 200),
    praise_daily: int(0, 100),
  }),
  cadence: object({
    client_tick_seconds: int(30, 600),
    reconcile_minutes: int(60, 1440),
    event_debounce_minutes: int(1, 60),
  }),
  digest: object({
    enabled: { type: "boolean" },
    local_time: clock,
    weekdays: {
      type: "array",
      maxItems: 7,
      uniqueItems: true,
      items: int(0, 6),
    },
    suppress_empty: { type: "boolean" },
  }),
  budgets: object({
    cycle_seconds: int(30, 300),
    tool_calls: int(1, 64),
    provider_tokens: int(5000, 200000),
    images_per_cycle: int(0, 5),
    max_attempts: int(1, 10),
  }),
  delegated_actions: {
    type: "array",
    maxItems: DELEGATED_ACTION_TYPES.length,
    uniqueItems: true,
    items: { enum: DELEGATED_ACTION_TYPES },
  },
  instructions: { type: "string", maxLength: 4000 },
};
const mandateProperties = {
  protocol: { const: AUTONOMY_PROTOCOL },
  mandate_id: nullable(id),
  dojo_id: id,
  chief_id: id,
  revision: int(0, Number.MAX_SAFE_INTEGER),
  ...mandateFields,
  status: { enum: ["active", "suspended"] },
  suspended_reason: { enum: [null, "scope_changed"] },
  updated_at: nullable(iso),
  updated_by: { enum: [null, "account_owner_session", "external_coach"] },
};
export const schemas = {
  mandateFields: object(mandateFields),
  mandate: object(mandateProperties),
  actionReceipt,
  workItem,
  workPage: page(workItem),
  workResult: envelope({ work: workItem }),
  actResult: envelope({
    receipt: actionReceipt,
    idempotent: { type: "boolean" },
  }),
  receiptResult: envelope({ receipt: actionReceipt }),
  completionReceiptResult: envelope({
    work_id: id,
    lease_generation: generation,
    current_lease_generation: count,
    state: { enum: COMPLETION_STATES },
    receipt: nullable(completionReceipt),
  }),
  claimResult: envelope({ work: nullable(workItem) }),
  completeResult: object(
    {
      protocol: { const: AUTONOMY_PROTOCOL },
      work: workItem,
      report_id: id,
      idempotent: { type: "boolean" },
    },
    ["idempotent"],
  ),
  cycleOutcome,
  followUp,
  followUpInput: object(
    {
      lease_generation: count,
      mandate_revision: count,
      subject_id: id,
      basis: { enum: FOLLOW_UP_BASES },
      summary: { type: "string", minLength: 1, maxLength: 500 },
      due_at: iso,
      next_condition: { type: "string", minLength: 1, maxLength: 300 },
      evidence: commitmentEvidence,
    },
    ["evidence"],
  ),
  intentInput: object({
    lease_generation: count,
    mandate_revision: count,
    intent: object(intentFields, intentOptional),
  }),
  intentResult: object(
    {
      protocol: { const: AUTONOMY_PROTOCOL },
      intent: intentRecord,
      idempotent: { type: "boolean" },
      public_projection: publicProjection,
    },
    ["public_projection"],
  ),
  compositionInput: object({
    lease_generation: count,
    text: { type: "string", minLength: 1, maxLength: 8000 },
    composer: object({
      persona_revision: { type: "string", minLength: 1, maxLength: 128 },
      provider_request_sha256: { ...list(digest, 4), minItems: 1 },
    }),
  }),
  compositionResult: envelope({
    composition: object(
      {
        slot,
        text: { type: "string", minLength: 1, maxLength: 8000 },
        text_sha256: digest,
        stored_at: iso,
      },
      ["text"],
    ),
    stored: { type: "boolean" },
  }),
  intentState: envelope({
    intent: intentRecord,
    composition: nullable(storedComposition),
    receipt: nullable(actionReceipt),
  }),
  followUpPatch: object(
    {
      expected_revision: count,
      status: { enum: ["closed", "cancelled"] },
      closure_reason: { enum: CLOSURE_REASONS },
      lease: object({ work_id: id, lease_generation: count }),
    },
    ["lease"],
  ),
  followUpResult: envelope({
    follow_up: followUp,
    idempotent: { type: "boolean" },
  }),
  followUpPatchResult: envelope({ follow_up: followUp }),
  followUpPage: page(followUp),
  status: envelope({
    mandate: object({
      mode: { enum: MODES },
      paused: { type: "boolean" },
      status: { enum: ["active", "suspended"] },
      revision: count,
    }),
    queue: object({ queued: count, running: count, blocked: count }),
    last_completed_at: nullable(iso),
    next_due_at: nullable(iso),
    blocked: list(
      object({
        work_id: id,
        reason: { type: "string", minLength: 1, maxLength: 64 },
      }),
      10,
    ),
    ingest: object({
      roster_pass_completed_at: nullable(iso),
      members_pending_in_pass: count,
      members_total: count,
      lagging_members: count,
    }),
  }),
  reportPage: page(
    object({
      id,
      work_id: id,
      kind: { enum: WORK_KINDS },
      result: { enum: ["completed", "deferred", "blocked", "failed"] },
      coverage: cycleOutcome.properties.coverage,
      counts: object({
        acted: count,
        no_action: count,
        deferred: count,
        escalated: count,
      }),
      action_slots: list(slot, 64),
      created_at: iso,
    }),
  ),
  putMandate: object({
    idempotency_key: { type: "string", pattern: KEY_PATTERN.source },
    expected_revision: int(0, Number.MAX_SAFE_INTEGER),
    mandate: object(mandateFields),
  }),
  putMandateResult: envelope({
    mandate: object(mandateProperties),
    idempotent: { type: "boolean" },
  }),
  mandateView: object({
    ...mandateProperties,
    capabilities: object(
      {
        action_types: {
          type: "array",
          maxItems: DELEGATED_ACTION_TYPES.length,
          uniqueItems: true,
          items: { enum: DELEGATED_ACTION_TYPES },
        },
        scopes: { type: "array", maxItems: 4, items: { const: "dojo" } },
        max_lease_seconds: int(15, 300),
        blocked_reasons: {
          type: "array",
          maxItems: 32,
          uniqueItems: true,
          items: { type: "string", pattern: "^[a-z_]{1,64}$" },
        },
        configured_integrations: object({
          protocol: { const: "coach.integrations.v1" },
          delegation: { const: "configured_integration" },
          dispatch_mode: { const: "message" },
          discover_path: { const: "/api/coach/integrations/discover" },
          dispatch_path: { const: "/api/coach/integrations/call" },
        }),
      },
      ["blocked_reasons", "configured_integrations"],
    ),
  }),
};

export interface MandateFields {
  mode: Mode;
  paused: boolean;
  timezone: string | null;
  quiet_hours: { start: string; end: string } | null;
  contact_limits: {
    member_daily: number;
    member_cooldown_minutes: number;
    dojo_daily: number;
    praise_daily: number;
  };
  cadence: {
    client_tick_seconds: number;
    reconcile_minutes: number;
    event_debounce_minutes: number;
  };
  digest: {
    enabled: boolean;
    local_time: string;
    weekdays: number[];
    suppress_empty: boolean;
  };
  budgets: {
    cycle_seconds: number;
    tool_calls: number;
    provider_tokens: number;
    images_per_cycle: number;
    max_attempts: number;
  };
  delegated_actions: (typeof DELEGATED_ACTION_TYPES)[number][];
  instructions: string;
}
export interface Mandate extends MandateFields {
  protocol: typeof AUTONOMY_PROTOCOL;
  mandate_id: string | null;
  dojo_id: string;
  chief_id: string;
  revision: number;
  status: "active" | "suspended";
  suspended_reason: null | "scope_changed";
  updated_at: string | null;
  updated_by: "account_owner_session" | "external_coach" | null;
}
export interface ActionReceipt {
  slot: string;
  type: "member_message" | "manager_report" | "public_praise";
  status: "delivered" | "published" | "already_published";
  recipient_id?: string;
  message_id?: string;
  idempotency_key?: string;
  comment_id?: string;
  activity_id?: string;
  subject_user_id?: string;
  text_sha256: string;
  committed_at: string;
}
/** A worker transport observation, never a canonical delivery/effect receipt. */
export interface WorkActionObservation {
  slot: string;
  type: "rest_mutation";
  status: "response_received";
  request_sha256: string;
  opened_lease_generation: number;
  effect_receipt: false;
  observed_at: string;
}
export interface CompletionReceipt {
  work_id: string;
  mandate_id: string;
  dojo_id: string;
  chief_id: string;
  mandate_revision: number;
  lease_generation: number;
  /** true: the reading bearer committed it; false: another bearer of the account; null: unattributed. */
  credential_match: boolean | null;
  digest_algorithm: typeof COMPLETION_DIGEST;
  request_sha256: string;
  result: "completed" | "deferred" | "blocked" | "failed";
  status_after: "completed" | "blocked" | "deferred" | "queued";
  report_id: string;
  committed_at: string;
}
export interface CompletionReceiptResult {
  work_id: string;
  lease_generation: number;
  current_lease_generation: number;
  state: (typeof COMPLETION_STATES)[number];
  receipt: CompletionReceipt | null;
}
export interface WorkIntent {
  slot: string;
  type: IntentType;
  recipient_id?: string;
  activity_id?: string;
  purpose: Purpose;
  status: (typeof INTENT_STATUSES)[number];
  composition_sha256: string | null;
}
/** [AC1] The planner's finite handoff; deliberately has no text field. */
export interface Intent {
  type: IntentType;
  recipient_id?: string;
  activity_id?: string;
  completed_at?: string;
  purpose: Purpose;
  tone?: (typeof TONES)[number];
  evidence_refs: string[];
}
export interface IntentRecord extends Intent {
  slot: string;
  status: (typeof INTENT_STATUSES)[number];
  created_at: string;
}
export interface PublicProjection {
  subject_display_name: string;
  activity_type: string;
  activity_name: string;
  completed_at: string;
  personal_record: boolean;
}
export interface IntentInput {
  lease_generation: number;
  mandate_revision: number;
  intent: Intent;
}
export interface CompositionInput {
  lease_generation: number;
  text: string;
  composer: { persona_revision: string; provider_request_sha256: string[] };
}
export interface StoredComposition {
  text: string;
  text_sha256: string;
  stored_at: string;
}
export interface IntentState {
  intent: IntentRecord;
  composition: StoredComposition | null;
  receipt: ActionReceipt | null;
}
export interface WorkItem {
  id: string;
  kind: WorkKind;
  mandate_id: string;
  mandate_revision: number;
  status: WorkStatus;
  due_at: string;
  attempts: number;
  subject_ids: string[];
  source: {
    event_ids?: string[];
    follow_up_id?: string;
    digest_local_date?: string;
    reconcile_bucket?: string;
    events?: {
      ledger_id: string;
      occurred_at: string;
      event_type: string;
      subject: { type: string; id: string };
    }[];
    conversation?: { member_id: string; from_epoch: number; to_epoch: number };
  };
  checkpoint: string | null;
  lease_generation: number;
  lease_expires_at: string | null;
  timeout_at: string | null;
  actions: (ActionReceipt | WorkActionObservation)[];
  intents?: WorkIntent[];
  follow_ups: string[];
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
}
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
}
export interface CycleOutcome {
  result: "completed" | "deferred" | "blocked" | "failed";
  next_due_at?: string;
  blocked_reason?: (typeof HOST_BLOCKED_REASONS)[number];
  coverage: {
    members_considered: number;
    members_read: number;
    partial: boolean;
    unobserved: (typeof UNOBSERVED)[number][];
    pages?: {
      source: (typeof PAGE_SOURCES)[number];
      read: number;
      denied: number;
      failed: number;
      truncated: number;
    }[];
  };
  decisions: {
    subject_id: string | null;
    decision: (typeof DECISIONS)[number];
    action_slots: string[];
    follow_up_ids: string[];
  }[];
  uncertainty: string[];
  budget: { provider_tokens: number; tool_calls: number; elapsed_ms: number };
}
export const ACTION_TEXT_LIMIT = 8000;
export type ActionIntent = {
  lease_generation: number;
  mandate_revision: number;
  text: string;
} & (
  | { type: "member_message"; recipient_id: string }
  | { type: "manager_report"; recipient_id?: never }
  | {
      type: "public_praise";
      activity_id: string;
      completed_at: string;
      recipient_id?: never;
    }
);
export interface CommitmentEvidence {
  message_ref?: string;
  request_id?: string;
  quote: string;
}
export interface FollowUp {
  id: string;
  subject_id: string;
  status: (typeof FOLLOW_UP_STATUSES)[number];
  basis: (typeof FOLLOW_UP_BASES)[number];
  summary: string;
  due_at: string;
  timezone: string;
  next_condition: string;
  last_evidence_at: string | null;
  source: {
    work_id?: string;
    slot: string;
    action_message_id?: string;
    request_id?: string;
  };
  evidence: CommitmentEvidence | null;
  closure_reason: null | (typeof CLOSURE_REASONS)[number];
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface FollowUpInput {
  lease_generation: number;
  mandate_revision: number;
  subject_id: string;
  basis: (typeof FOLLOW_UP_BASES)[number];
  summary: string;
  due_at: string;
  next_condition: string;
  evidence?: CommitmentEvidence;
}
export interface FollowUpPatch {
  expected_revision: number;
  status: "closed" | "cancelled";
  closure_reason: (typeof CLOSURE_REASONS)[number];
  lease?: { work_id: string; lease_generation: number };
}
export interface AutonomyStatus {
  mandate: {
    mode: Mode;
    paused: boolean;
    status: "active" | "suspended";
    revision: number;
  };
  queue: { queued: number; running: number; blocked: number };
  last_completed_at: string | null;
  next_due_at: string | null;
  blocked: { work_id: string; reason: string }[];
  ingest: {
    roster_pass_completed_at: string | null;
    members_pending_in_pass: number;
    members_total: number;
    lagging_members: number;
  };
}
/** Content-free cycle receipt; message text lives only in its audience. */
export interface Report {
  id: string;
  work_id: string;
  kind: WorkKind;
  result: CycleOutcome["result"];
  coverage: CycleOutcome["coverage"];
  counts: {
    acted: number;
    no_action: number;
    deferred: number;
    escalated: number;
  };
  action_slots: string[];
  created_at: string;
}
export interface PutMandate {
  idempotency_key: string;
  expected_revision: number;
  mandate: MandateFields;
}
export interface MandateView extends Mandate {
  capabilities: {
    action_types: (typeof DELEGATED_ACTION_TYPES)[number][];
    scopes: "dojo"[];
    max_lease_seconds: number;
    blocked_reasons?: string[];
  };
}

const ajv = new Ajv({
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
  strict: true,
  allowUnionTypes: true,
});
export const validate = {
  mandateFields: ajv.compile<MandateFields>(schemas.mandateFields),
  mandate: ajv.compile<Mandate>(schemas.mandate),
  mandateView: ajv.compile<MandateView>(schemas.mandateView),
  putMandate: ajv.compile<PutMandate>(schemas.putMandate),
  workPage: ajv.compile<Page<WorkItem>>(schemas.workPage),
  workResult: ajv.compile<{ work: WorkItem }>(schemas.workResult),
  actResult: ajv.compile<{ receipt: ActionReceipt; idempotent: boolean }>(
    schemas.actResult,
  ),
  receiptResult: ajv.compile<{ receipt: ActionReceipt }>(schemas.receiptResult),
  completionReceiptResult: ajv.compile<CompletionReceiptResult>(
    schemas.completionReceiptResult,
  ),
  claimResult: ajv.compile<{ work: WorkItem | null }>(schemas.claimResult),
  completeResult: ajv.compile<{
    work: WorkItem;
    report_id: string;
    idempotent?: boolean;
  }>(schemas.completeResult),
  intentInput: ajv.compile<IntentInput>(schemas.intentInput),
  intentResult: ajv.compile<{
    intent: IntentRecord;
    idempotent: boolean;
    public_projection?: PublicProjection;
  }>(schemas.intentResult),
  compositionInput: ajv.compile<CompositionInput>(schemas.compositionInput),
  compositionResult: ajv.compile<{
    composition: StoredComposition & { slot: string };
    stored: boolean;
  }>(schemas.compositionResult),
  intentState: ajv.compile<IntentState>(schemas.intentState),
  cycleOutcome: ajv.compile<CycleOutcome>(schemas.cycleOutcome),
  hostOutcome: ajv.compile<CycleOutcome>({
    ...schemas.cycleOutcome,
    properties: {
      ...schemas.cycleOutcome.properties,
      blocked_reason: { enum: HOST_BLOCKED_REASONS },
    },
  }),
  followUpInput: ajv.compile<FollowUpInput>(schemas.followUpInput),
  followUpPatch: ajv.compile<FollowUpPatch>(schemas.followUpPatch),
  followUpResult: ajv.compile<{ follow_up: FollowUp; idempotent: boolean }>(
    schemas.followUpResult,
  ),
  followUpPatchResult: ajv.compile<{ follow_up: FollowUp }>(
    schemas.followUpPatchResult,
  ),
  followUpPage: ajv.compile<Page<FollowUp>>(schemas.followUpPage),
  status: ajv.compile<AutonomyStatus>(schemas.status),
  reportPage: ajv.compile<Page<Report>>(schemas.reportPage),
  putMandateResult: ajv.compile<{ mandate: Mandate; idempotent: boolean }>(
    schemas.putMandateResult,
  ),
};

/**
 * Cross-field rules the backend also enforces: time is never inferred from
 * the server, so leaving "off" needs an explicit valid zone, and member
 * messaging additionally needs declared quiet hours.
 */
export function mandateCoherent(m: MandateFields) {
  if (m.timezone !== null) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: m.timezone });
    } catch {
      return false;
    }
  }
  return (
    (m.mode === "off" || m.timezone !== null) &&
    (m.mode !== "message" || m.quiet_hours !== null)
  );
}

/** A page that claims more results must say where they continue. */
export const pageCoherent = (p: Page<unknown>) =>
  !p.has_more || p.next_cursor !== null;

/** Deferral needs its next due time; only a block carries a block reason. */
export const outcomeCoherent = (o: CycleOutcome) =>
  (o.result === "deferred") === (o.next_due_at !== undefined) &&
  (o.result === "blocked") === (o.blocked_reason !== undefined) &&
  o.coverage.members_read <= o.coverage.members_considered;

/**
 * [AC1] Purpose must fit the intent type; a member message names exactly one
 * recipient and a public praise names exactly one occurrence and no recipient.
 */
export const intentCoherent = (i: Intent) =>
  i.type === "member_message"
    ? (MEMBER_PURPOSES as readonly string[]).includes(i.purpose) &&
      i.recipient_id !== undefined &&
      i.activity_id === undefined &&
      i.completed_at === undefined
    : (PRAISE_PURPOSES as readonly string[]).includes(i.purpose) &&
      i.recipient_id === undefined &&
      i.activity_id !== undefined &&
      i.completed_at !== undefined;

/** [v2] Only a trainee commitment carries (and needs) the member's quote. */
export const followUpCoherent = (f: FollowUpInput) =>
  f.basis === "member_commitment"
    ? f.evidence !== undefined &&
      (f.evidence.message_ref === undefined) !==
        (f.evidence.request_id === undefined)
    : f.evidence === undefined;
