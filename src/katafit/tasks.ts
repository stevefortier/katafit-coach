import { isDeepStrictEqual } from "node:util";
import { Ajv } from "ajv";
import { taskCatalog } from "./taskCatalog.js";
import { Client } from "./client.js";
import { assertNoSecrets } from "../config/store.js";
import {
  invocationAdmission,
  INVOCATION_ACTION_PROTOCOL,
} from "../capability/invocationActions.js";
import {
  CAPABILITY_PROTOCOL,
  validOccurrence,
  type CapabilityAction,
  type Occurrence,
} from "../capability/invocation.js";

export const TASK_PROTOCOL = "coach.tasks.v1";
export const TASK_TOOLS = [
  "coach_task_capabilities",
  "coach_claim_task",
  "coach_read_task_context",
  "coach_complete_task",
  "coach_read_task_receipt",
  "coach_reconcile_task",
  "coach_fail_task",
];
const limits = {
  result_bytes: 24000,
  evidence_bytes: 65536,
  task_lifetime_seconds: 900,
  lease_seconds_min: 15,
  lease_seconds_max: 300,
  lease_seconds_default: 60,
};
const catalog = new Map<string, any>(
  taskCatalog.contracts.map((c) => [c.kind, c]),
);
const ajv = new Ajv({
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
  strict: true,
});
const validators = new Map(
  taskCatalog.contracts.map((c) => {
    const { $schema, ...schema } = c.result_schema;
    return [c.kind as string, ajv.compile(schema)];
  }),
);
export async function discoverTasks(c: Client): Promise<string[]> {
  return (await discoverTaskPlane(c)).kinds;
}
/**
 * Kinds plus whether the backend negotiates the shared invocation capability
 * (coach.capability.v1) and its task action journal. Never sent unadvertised:
 * a strict older backend would reject the unknown claim field.
 */
export async function discoverTaskPlane(c: Client): Promise<{
  kinds: string[];
  capability: boolean;
  invocation?: boolean;
  failureDetails?: boolean;
}> {
  // Capability absence/mismatch never grants task authority or breaks legacy chat.
  try {
    const listed = await c.rpc("tools/list");
    if (!TASK_TOOLS.every((n) => listed.tools?.some((t: any) => t.name === n)))
      return { kinds: [], capability: false };
    const cap = await c.call("coach_task_capabilities", {});
    if (
      cap.protocol !== TASK_PROTOCOL ||
      cap.direct_mutations_forbidden !== true ||
      cap.completion_is_publication !== false ||
      !isDeepStrictEqual(cap.limits, limits) ||
      !Array.isArray(cap.kinds) ||
      !Array.isArray(cap.contracts)
    )
      return { kinds: [], capability: false };
    const capability =
      Array.isArray(cap.capability_protocols) &&
      cap.capability_protocols.includes(CAPABILITY_PROTOCOL) &&
      cap.negotiated_capability?.protocol === CAPABILITY_PROTOCOL &&
      cap.negotiated_capability?.tools_during_generation === true &&
      JOURNAL_TOOLS.every((n) => listed.tools?.some((t: any) => t.name === n));
    const kinds = [...catalog.keys()].filter(
      (kind) =>
        cap.kinds.includes(kind) &&
        cap.contracts.filter((x: any) => x.kind === kind).length === 1 &&
        isDeepStrictEqual(
          cap.contracts.find((x: any) => x.kind === kind),
          catalog.get(kind),
        ),
    );
    const claim = listed.tools?.find((t: any) => t.name === "coach_claim_task");
    const invocation =
      capability &&
      claim?.inputSchema?.properties?.capability_protocols?.items?.enum?.includes(
        INVOCATION_ACTION_PROTOCOL,
      ) &&
      [
        "coach_open_invocation_action",
        "coach_read_invocation_action",
        "coach_settle_invocation_action",
      ].every((n) => listed.tools?.some((t: any) => t.name === n));
    return {
      kinds,
      capability,
      ...(invocation ? { invocation: true } : {}),
      ...(failureDetailsNegotiated(cap) ? { failureDetails: true } : {}),
    };
  } catch {
    return { kinds: [], capability: false };
  }
}
const JOURNAL_TOOLS = ["coach_open_task_action", "coach_settle_task_action"];
export const FAILURE_DETAILS_PROTOCOL = "coach.task-failure-details.v1";
export const OUTPUT_FAILURE_DETAILS = [
  "TASK_OUTPUT_JSON",
  "TASK_OUTPUT_SCHEMA",
  "TASK_OUTPUT_SEMANTIC",
  "TASK_OUTPUT_SECURITY",
  "TASK_OUTPUT_SIZE",
] as const;
export const PROVIDER_FAILURE_DETAILS = [
  "PROVIDER_MODEL_DEADLINE",
  "PROVIDER_UPSTREAM_TIMEOUT",
  "PROVIDER_TOOL_ABORTED",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_CONNECTION_FAILED",
  "PROVIDER_UNKNOWN",
] as const;
export type ProviderFailureDetail = (typeof PROVIDER_FAILURE_DETAILS)[number];
export const FAILURE_TIMING_MAX_MS = 900000;
// Output subtypes predate negotiation; provider subtypes never do.
const detailAllowed = (code: unknown, detail: unknown) =>
  (code === "TASK_INVALID_OUTPUT" &&
    (OUTPUT_FAILURE_DETAILS as readonly unknown[]).includes(detail)) ||
  (code === "TASK_PROVIDER_FAILED" &&
    (PROVIDER_FAILURE_DETAILS as readonly unknown[]).includes(detail));
/** Exact additive capability; anything else keeps the legacy failure shape. */
function failureDetailsNegotiated(cap: any) {
  const advertised = cap?.failure_details;
  const codes = advertised?.detail_codes?.TASK_PROVIDER_FAILED;
  // The advertised vocabulary must be exactly this closed set, as an array.
  return (
    advertised?.protocol === FAILURE_DETAILS_PROTOCOL &&
    Array.isArray(codes) &&
    codes.every((code: unknown) => typeof code === "string") &&
    new Set(codes).size === codes.length &&
    codes.length === PROVIDER_FAILURE_DETAILS.length &&
    PROVIDER_FAILURE_DETAILS.every((detail) => codes.includes(detail)) &&
    isDeepStrictEqual(advertised.timing_fields, ["elapsed_ms", "budget_ms"]) &&
    advertised.timing_max_ms === FAILURE_TIMING_MAX_MS
  );
}
export function validateTask(task: any, kinds: string[]) {
  const keys = [
    "id",
    "kind",
    "protocol",
    "schema_id",
    "requester_id",
    "owner_type",
    "owner_id",
    "scope_generation",
    "requester_generation",
    "conversation_generation",
    "status",
    "lease_generation",
    "created_at",
    "timeout_at",
    "lease_expires_at",
  ];
  if (
    !exactKeys(task, keys) ||
    !kinds.includes(task.kind) ||
    task.protocol !== TASK_PROTOCOL ||
    task.schema_id !== `${TASK_PROTOCOL}/${task.kind}` ||
    ![task.id, task.requester_id, task.owner_id].every(
      (id) => typeof id === "string" && /^[a-f0-9]{24}$/i.test(id),
    ) ||
    !["personal", "dojo"].includes(task.owner_type) ||
    task.status !== "claimed" ||
    ![
      task.scope_generation,
      task.requester_generation,
      task.conversation_generation,
    ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    !Number.isSafeInteger(task.lease_generation) ||
    task.lease_generation < 1 ||
    ![task.created_at, task.timeout_at, task.lease_expires_at].every(iso)
  )
    throw new Error("CONTEXT_REJECTED");
}
export function taskSchema(kind: string) {
  return catalog.get(kind)?.result_schema;
}
export interface TaskAdmission {
  negotiated: boolean;
  actions: CapabilityAction[];
  occurrences: Occurrence[];
  /** The requester, the only member-message recipient of a Dojo task. */
  recipient?: string;
  subjectIsPrincipal: boolean;
  ordinary?: ReturnType<typeof invocationAdmission>;
}
/**
 * Legacy contexts (allowed_tools [], direct_mutations_forbidden) still get the
 * shared read/memory/discovery capability but no actions. A negotiated
 * coach.capability.v1 context adds its supported, journaled actions.
 */
export function taskAdmission(task: any, context: any): TaskAdmission {
  if (!context.capability)
    return {
      negotiated: false,
      actions: [],
      occurrences: [],
      subjectIsPrincipal: task.owner_type === "personal",
    };
  const cap = context.capability;
  const supported = cap.rest?.available === true ? cap.actions.supported : [];
  return {
    negotiated: true,
    actions: supported,
    occurrences: context.occurrences,
    ...(supported.includes("member_message")
      ? { recipient: String(task.requester_id).toLowerCase() }
      : {}),
    subjectIsPrincipal: cap.rest.subject_is_principal === true,
    ...(invocationAdmission(cap, {
      plane: "task",
      id: task.id,
      lease_generation: task.lease_generation,
      requester_id: task.requester_id,
    })
      ? {
          ordinary: invocationAdmission(cap, {
            plane: "task",
            id: task.id,
            lease_generation: task.lease_generation,
            requester_id: task.requester_id,
          }),
        }
      : {}),
  };
}
function validAdmission(task: any, context: any) {
  const cap = context.capability;
  const ordinary = invocationAdmission(cap, {
    plane: "task",
    id: task.id,
    lease_generation: task.lease_generation,
    requester_id: task.requester_id,
  });
  return (
    exactKeys(context, [
      "task",
      "instructions",
      "evidence",
      "result_schema",
      "allowed_tools",
      "direct_mutations_forbidden",
      "capability",
      "occurrences",
    ]) &&
    Array.isArray(context.allowed_tools) &&
    context.allowed_tools.length <= 16 &&
    context.allowed_tools.every(
      (t: any) => typeof t === "string" && /^[a-z_]{1,40}$/.test(t),
    ) &&
    typeof context.direct_mutations_forbidden === "boolean" &&
    cap &&
    typeof cap === "object" &&
    cap.protocol === CAPABILITY_PROTOCOL &&
    cap.plane === "task" &&
    cap.kind === task.kind &&
    cap.tools_during_generation === true &&
    cap.final_result === "structured_result" &&
    cap.structured_result_correction?.replay_actions === false &&
    typeof cap.rest?.available === "boolean" &&
    typeof cap.rest?.subject_is_principal === "boolean" &&
    cap.rest?.subject_user_id === task.requester_id &&
    Array.isArray(cap.actions?.supported) &&
    cap.actions.supported.length <= (ordinary ? 3 : 2) &&
    cap.actions.supported.every((a: any) =>
      [
        "rest_mutation",
        "member_message",
        ...(ordinary ? ["proposal_approval"] : []),
      ].includes(a),
    ) &&
    // A Dojo task never writes as the chief; a personal task never messages.
    (task.owner_type === "dojo"
      ? ordinary || !cap.actions.supported.includes("rest_mutation")
      : !cap.actions.supported.includes("member_message")) &&
    context.direct_mutations_forbidden ===
      (cap.actions.supported.length === 0) &&
    Array.isArray(context.occurrences) &&
    context.occurrences.length <= 50 &&
    context.occurrences.every(validOccurrence) &&
    Buffer.byteLength(JSON.stringify(cap)) <= 16384
  );
}
export function taskContext(task: any, context: any, secrets: string[]) {
  const negotiated = context && Object.hasOwn(context, "capability");
  if (
    !isDeepStrictEqual(context.task, task) ||
    !isDeepStrictEqual(context.result_schema, taskSchema(task.kind)) ||
    (!negotiated &&
      (context.direct_mutations_forbidden !== true ||
        !isDeepStrictEqual(context.allowed_tools, []))) ||
    (negotiated && !validAdmission(task, context)) ||
    typeof context.instructions !== "string"
  )
    throw new Error("CONTEXT_REJECTED");
  if (
    (!negotiated &&
      !exactKeys(context, [
        "task",
        "instructions",
        "evidence",
        "result_schema",
        "allowed_tools",
        "direct_mutations_forbidden",
      ])) ||
    context.instructions.length > 8000 ||
    !validEvidence(context.evidence)
  )
    throw new Error("CONTEXT_REJECTED");
  assertNoSecrets(context, secrets);
  return JSON.stringify({
    generation_task: { kind: task.kind, schema_id: task.schema_id },
    evidence: context.evidence,
  });
}
function exactKeys(value: any, keys: string[]) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
  );
}
function textBound(value: any, min: number, max: number) {
  return (
    typeof value === "string" && value.length >= min && value.length <= max
  );
}
function iso(value: any) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  )
    return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function validEvidence(e: any) {
  return (
    exactKeys(e, ["timezone", "observations", "conversation"]) &&
    textBound(e.timezone, 1, 80) &&
    Array.isArray(e.observations) &&
    e.observations.length <= 30 &&
    e.observations.every(
      (o: any) =>
        exactKeys(o, ["label", "text"]) &&
        textBound(o.label, 1, 120) &&
        textBound(o.text, 0, 4000),
    ) &&
    Array.isArray(e.conversation) &&
    e.conversation.length <= 20 &&
    e.conversation.every(
      (m: any) =>
        exactKeys(m, ["role", "text", "created_at"]) &&
        ["user", "coach"].includes(m.role) &&
        textBound(m.text, 0, 4000) &&
        iso(m.created_at),
    ) &&
    Buffer.byteLength(JSON.stringify(e)) <= limits.evidence_bytes
  );
}
// Mirror schema parse order and only the backend's explicit .trim() strings.
function normalize(value: any, schema: any): any {
  if (value === null) return null;
  if (schema.anyOf)
    return normalize(
      value,
      schema.anyOf.find((s: any) => s.type !== "null"),
    );
  if (typeof value === "string")
    return [1000, 8000].includes(schema.maxLength) ? value.trim() : value;
  if (Array.isArray(value)) return value.map((v) => normalize(v, schema.items));
  if (value && typeof value === "object")
    return Object.fromEntries(
      (schema.properties
        ? Object.keys(schema.properties).filter((k) => Object.hasOwn(value, k))
        : Object.keys(value)
      ).map((k) => [
        k,
        normalize(
          value[k],
          schema.properties?.[k] ?? schema.additionalProperties,
        ),
      ]),
    );
  return value;
}
export type TaskOutputCategory =
  | "JSON"
  | "SCHEMA"
  | "SEMANTIC"
  | "SECURITY"
  | "SIZE";
export class TaskOutputError extends Error {
  constructor(
    readonly category: TaskOutputCategory,
    readonly reason: string,
    readonly repairHint: string = "Return one JSON object matching the local schema and semantic constraints.",
  ) {
    super("OUTPUT_REJECTED");
  }
}
// Only local catalog field names and fixed instructions may cross the repair
// boundary. Ajv instancePath, message, data and params can contain model text.
function schemaRepairHint(kind: string, errors: any[] = []): string {
  const messages: Record<string, string> = {
    type: "must match the allowed types",
    anyOf: "must match one allowed schema alternative",
    required: "must include all required fields",
    additionalProperties: "must not contain extra fields",
    pattern: "must match the schema format",
    propertyNames: "must use keys matching the schema format",
    enum: "must use an allowed enum value",
    minimum: "must meet the schema minimum",
    maximum: "must not exceed the schema maximum",
    minLength: "must meet the schema minimum length after trimming",
    maxLength: "must not exceed the schema maximum length",
    maxItems: "must not exceed the schema item limit",
  };
  const hints = errors.slice(0, 6).map((error) => {
    let schema = taskSchema(kind);
    const path: string[] = [];
    // Resolve the schema path against the immutable local catalog, never emit
    // a rejected object's dynamic keys (including otherwise valid workout IDs).
    const parts = String(error.schemaPath).split("/").slice(1, -1);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === "properties" && schema?.properties) {
        const key = parts[++i];
        if (!Object.hasOwn(schema.properties, key)) break;
        path.push(key);
        schema = schema.properties[key];
      } else if (part === "additionalProperties" || part === "items") {
        path.push("*");
        schema = schema?.[part];
      } else if (part === "anyOf" && Array.isArray(schema?.anyOf)) {
        schema = schema.anyOf[Number(parts[++i])];
      } else break;
    }
    return `/${path.join("/")}: ${messages[error.keyword] ?? "must match the local schema"}`;
  });
  return [...new Set(hints)].join("; ").slice(0, 1200);
}
const credentialPattern =
  /(?:(?:kcoach_|rgn_coach_)[a-z0-9_\-]+|Bearer\s+\S+|-----BEGIN[^-]*PRIVATE KEY|sk-[a-z0-9_-]{12,}|redacted:sk-)/i;
export function parseTaskResult(kind: string, text: string, secrets: string[]) {
  if (typeof text !== "string" || Buffer.byteLength(text) > limits.result_bytes)
    throw new TaskOutputError(
      "SIZE",
      `Output exceeded ${limits.result_bytes} UTF-8 bytes`,
    );
  // Scan the raw response first: malformed JSON must not turn a leaked secret
  // into a repairable parse error or send it back to the provider.
  if (credentialPattern.test(text))
    throw new TaskOutputError(
      "SECURITY",
      "Credential-shaped text in raw output",
    );
  try {
    assertNoSecrets(text, secrets);
  } catch {
    throw new TaskOutputError("SECURITY", "Known credential in raw output");
  }
  let value: any;
  try {
    const trimmed = text.trim();
    // Accept only one complete JSON Markdown block, never a preamble, suffix,
    // or embedded block. The raw response was screened and size-bounded above;
    // the parsed value is screened again below before it can be published.
    const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
    value = JSON.parse(fenced ? fenced[1] : trimmed);
  } catch (error) {
    throw new TaskOutputError(
      "JSON",
      error instanceof Error ? error.message : "JSON parser rejected output",
      "Use valid JSON syntax: one object, double-quoted keys and strings, no trailing commas or surrounding prose.",
    );
  }
  // JSON escapes can conceal credentials from the raw-text scan. Recheck the
  // decoded tree before validation, diagnostics, correction or publication.
  try {
    const decoded = JSON.stringify(value);
    if (credentialPattern.test(decoded))
      throw new Error("Credential-shaped decoded output");
    assertNoSecrets(value, secrets);
  } catch {
    throw new TaskOutputError("SECURITY", "Credential in decoded JSON output");
  }
  const validator = validators.get(kind);
  if (!validator?.(value))
    throw new TaskOutputError(
      "SCHEMA",
      JSON.stringify(validator?.errors ?? [{ message: "Unknown task kind" }]),
      schemaRepairHint(kind, validator?.errors ?? []),
    );
  value = normalize(value, taskSchema(kind));
  if (kind === "day_closure") {
    const emptyField = ["general_advice", "day_closeout_meal_assessment"].find(
      // Match the backend's semantic guard, including non-Latin written prose.
      (field) => !/[\p{L}\p{N}]/u.test(value[field]),
    );
    if (emptyField)
      throw new TaskOutputError(
        "SEMANTIC",
        `${emptyField} must be nonempty after trimming`,
        `Return nonempty ${emptyField} grounded only in the supplied day evidence.`,
      );
  }
  if (!validator(value))
    throw new TaskOutputError(
      "SCHEMA",
      JSON.stringify(validator.errors ?? []),
      schemaRepairHint(kind, validator.errors ?? []),
    );
  // Ordinary activity reactions are not day closeouts. Keep the shared catalog
  // compatible, but mirror the consumer's truthy guard after normalization.
  if (
    kind === "activity_reaction" &&
    "day_closeout_meal_assessment" in value &&
    value.day_closeout_meal_assessment
  )
    throw new TaskOutputError(
      "SEMANTIC",
      "day_closeout_meal_assessment is not allowed for an individual activity reaction",
      "Omit day_closeout_meal_assessment for an individual activity reaction; return feedback only for the triggering activity.",
    );
  if (
    (kind === "activity_reaction" &&
      value.activity_feedback.reply_worthwhile !==
        Boolean(value.general_advice)) ||
    (kind === "workout_suggestions" &&
      (Object.keys(value.recommendations).length < 1 ||
        Object.keys(value.recommendations).length > 40))
  )
    throw new TaskOutputError(
      "SEMANTIC",
      kind === "activity_reaction"
        ? "activity_feedback.reply_worthwhile must equal Boolean(general_advice)"
        : "recommendations must have between 1 and 40 entries",
      kind === "activity_reaction"
        ? "activity_feedback.reply_worthwhile must equal Boolean(general_advice)"
        : "recommendations must have between 1 and 40 entries",
    );
  return value;
}
export function verifyTaskResolution(task: any, response: any, digest: string) {
  if (
    !exactKeys(response, [
      "task",
      "status",
      "result_sha256",
      "completed_at",
      "consumed_at",
      "failure_code",
      "resolution",
      ...(Object.hasOwn(response ?? {}, "failure_detail_code")
        ? ["failure_detail_code"]
        : []),
    ])
  )
    throw new Error("DELIVERY_UNVERIFIED");
  const { resolution, ...receipt } = response;
  if (
    Object.hasOwn(receipt, "failure_detail_code") &&
    (receipt.status !== "failed" ||
      !detailAllowed(receipt.failure_code, receipt.failure_detail_code))
  )
    throw new Error("DELIVERY_UNVERIFIED");
  if (["completed", "consumed"].includes(receipt.status)) {
    if (resolution !== "observed") throw new Error("DELIVERY_UNVERIFIED");
    return verifyTaskReceipt(task, receipt, digest);
  }
  if (
    !exactKeys(receipt.task, Object.keys(task)) ||
    Object.keys(task).some(
      (k) => k !== "status" && receipt.task[k] !== task[k],
    ) ||
    receipt.task.status !== receipt.status ||
    receipt.result_sha256 !== null ||
    receipt.completed_at !== null ||
    receipt.consumed_at !== null ||
    !(
      (["failed", "cancelled", "invalidated"].includes(receipt.status) &&
        resolution === "observed") ||
      (receipt.status === "expired" && resolution === "reclaimable") ||
      (receipt.status === "claimed" && resolution === "observed")
    ) ||
    !(
      receipt.failure_code === null ||
      (receipt.status === "failed" &&
        typeof receipt.failure_code === "string" &&
        receipt.failure_code.length > 0)
    )
  )
    throw new Error("DELIVERY_UNVERIFIED");
  return receipt.status;
}
export function verifyTaskFailure(
  task: any,
  receipt: any,
  code: string,
  detailCode?: string,
) {
  if (
    !exactKeys(receipt, [
      "task",
      "status",
      "result_sha256",
      "completed_at",
      "consumed_at",
      "failure_code",
      ...(detailCode ? ["failure_detail_code"] : []),
    ]) ||
    !isDeepStrictEqual(receipt.task, { ...task, status: "failed" }) ||
    receipt.status !== "failed" ||
    receipt.failure_code !== code ||
    (detailCode &&
      (!detailAllowed(code, detailCode) ||
        receipt.failure_detail_code !== detailCode)) ||
    receipt.result_sha256 !== null ||
    receipt.completed_at !== null ||
    receipt.consumed_at !== null
  )
    throw new Error("DELIVERY_UNVERIFIED");
}
export function verifyTaskReceipt(task: any, receipt: any, digest?: string) {
  const keys = [
    "task",
    "status",
    "result_sha256",
    "completed_at",
    "consumed_at",
    "failure_code",
    ...(Object.hasOwn(receipt ?? {}, "idempotent") ? ["idempotent"] : []),
  ];
  if (
    !exactKeys(receipt, keys) ||
    (Object.hasOwn(receipt, "idempotent") &&
      typeof receipt.idempotent !== "boolean") ||
    !exactKeys(receipt.task, Object.keys(task)) ||
    !iso(receipt.completed_at) ||
    receipt.failure_code !== null ||
    (receipt.status === "completed"
      ? receipt.consumed_at !== null
      : !iso(receipt.consumed_at))
  )
    throw new Error("DELIVERY_UNVERIFIED");
  if (
    !receipt?.task ||
    Object.keys(task).some(
      (k) => k !== "status" && receipt.task[k] !== task[k],
    ) ||
    receipt.task.status !== receipt.status ||
    !["completed", "consumed"].includes(receipt.status) ||
    !/^[a-f0-9]{64}$/.test(receipt.result_sha256) ||
    (digest && receipt.result_sha256 !== digest)
  )
    throw new Error("DELIVERY_UNVERIFIED");
  return receipt.status;
}

export function verifyTaskInvalidation(task: any, receipt: any) {
  if (
    !exactKeys(receipt, [
      "task",
      "status",
      "result_sha256",
      "completed_at",
      "consumed_at",
      "failure_code",
      "invalidation_code",
      "invalidated_at",
    ]) ||
    !exactKeys(receipt.task, Object.keys(task)) ||
    !receipt.task ||
    Object.keys(task).some(
      (key) => key !== "status" && receipt.task[key] !== task[key],
    ) ||
    receipt.task.status !== "invalidated" ||
    receipt.status !== "invalidated" ||
    receipt.result_sha256 !== null ||
    receipt.completed_at !== null ||
    receipt.consumed_at !== null ||
    receipt.failure_code !== null ||
    receipt.invalidation_code !== "TASK_SOURCE_CHANGED" ||
    !iso(receipt.invalidated_at)
  )
    throw new Error("DELIVERY_UNVERIFIED");
  return receipt;
}
