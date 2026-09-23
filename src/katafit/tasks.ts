import { isDeepStrictEqual } from "node:util";
import { Ajv } from "ajv";
import { taskCatalog } from "./taskCatalog.js";
import { Client } from "./client.js";
import { assertNoSecrets } from "../config/store.js";

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
  // Capability absence/mismatch never grants task authority or breaks legacy chat.
  try {
    const listed = await c.rpc("tools/list");
    if (!TASK_TOOLS.every((n) => listed.tools?.some((t: any) => t.name === n)))
      return [];
    const cap = await c.call("coach_task_capabilities", {});
    if (
      cap.protocol !== TASK_PROTOCOL ||
      cap.direct_mutations_forbidden !== true ||
      cap.completion_is_publication !== false ||
      !isDeepStrictEqual(cap.limits, limits) ||
      !Array.isArray(cap.kinds) ||
      !Array.isArray(cap.contracts)
    )
      return [];
    return [...catalog.keys()].filter(
      (kind) =>
        cap.kinds.includes(kind) &&
        cap.contracts.filter((x: any) => x.kind === kind).length === 1 &&
        isDeepStrictEqual(
          cap.contracts.find((x: any) => x.kind === kind),
          catalog.get(kind),
        ),
    );
  } catch {
    return [];
  }
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
export function taskContext(task: any, context: any, secrets: string[]) {
  if (
    !isDeepStrictEqual(context.task, task) ||
    !isDeepStrictEqual(context.result_schema, taskSchema(task.kind)) ||
    context.direct_mutations_forbidden !== true ||
    !isDeepStrictEqual(context.allowed_tools, []) ||
    typeof context.instructions !== "string"
  )
    throw new Error("CONTEXT_REJECTED");
  if (
    !exactKeys(context, [
      "task",
      "instructions",
      "evidence",
      "result_schema",
      "allowed_tools",
      "direct_mutations_forbidden",
    ]) ||
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
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
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
  constructor(readonly category: TaskOutputCategory) {
    super("OUTPUT_REJECTED");
  }
}
const credentialPattern =
  /(?:(?:kcoach_|rgn_coach_)[a-z0-9_\-]+|Bearer\s+\S+|-----BEGIN[^-]*PRIVATE KEY|sk-[a-z0-9_-]{12,}|redacted:sk-)/i;
export function parseTaskResult(kind: string, text: string, secrets: string[]) {
  if (typeof text !== "string" || Buffer.byteLength(text) > limits.result_bytes)
    throw new TaskOutputError("SIZE");
  // Scan the raw response first: malformed JSON must not turn a leaked secret
  // into a repairable parse error or send it back to the provider.
  if (credentialPattern.test(text)) throw new TaskOutputError("SECURITY");
  try {
    assertNoSecrets(text, secrets);
  } catch {
    throw new TaskOutputError("SECURITY");
  }
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TaskOutputError("JSON");
  }
  if (!validators.get(kind)?.(value)) throw new TaskOutputError("SCHEMA");
  value = normalize(value, taskSchema(kind));
  if (!validators.get(kind)?.(value)) throw new TaskOutputError("SCHEMA");
  if (
    (kind === "activity_reaction" &&
      value.activity_feedback.reply_worthwhile !==
        Boolean(value.general_advice)) ||
    (kind === "workout_suggestions" &&
      (Object.keys(value.recommendations).length < 1 ||
        Object.keys(value.recommendations).length > 40))
  )
    throw new TaskOutputError("SEMANTIC");
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
    ])
  )
    throw new Error("DELIVERY_UNVERIFIED");
  const { resolution, ...receipt } = response;
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
export function verifyTaskFailure(task: any, receipt: any, code: string) {
  if (
    !exactKeys(receipt, [
      "task",
      "status",
      "result_sha256",
      "completed_at",
      "consumed_at",
      "failure_code",
    ]) ||
    !isDeepStrictEqual(receipt.task, { ...task, status: "failed" }) ||
    receipt.status !== "failed" ||
    receipt.failure_code !== code ||
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
