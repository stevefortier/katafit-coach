import { assertNoSecrets } from "../config/store.js";
import {
  MEMORY_KINDS,
  MEMORY_PROTOCOL,
  memoryPage,
  type MemoryKind,
  type MemoryProposal,
} from "./backend.js";

// Ordinary account-private Coach memory REST (/api/coach/memory). The backend
// owns identity, ownership, provenance and authorization for every new read or
// write; this host holds the ordinary bearer, bounds wire shapes and never
// keeps a local copy of memory prose. Pi never receives the bearer.
export const ACCOUNT_MEMORY_ROOT = "/api/coach/memory";
export const ACCOUNT_MEMORY_CODES = [
  "MEMORY_AUTH_EXPIRED",
  "MEMORY_NOT_AUTHORIZED",
  "MEMORY_UNSUPPORTED",
  "MEMORY_INVALID",
  "MEMORY_CONFLICT",
  "MEMORY_EPOCH_CHANGED",
  "MEMORY_CHANGED",
  "MEMORY_IDEMPOTENCY_CONFLICT",
  "MEMORY_LEARNING_PAUSED",
  "MEMORY_LIMIT",
  "MEMORY_UNAVAILABLE",
  "MEMORY_OUTCOME_UNKNOWN",
  "MEMORY_RESULT_REJECTED",
  "MEMORY_OPERATION_NOT_FOUND",
] as const;
export type AccountMemoryCode = (typeof ACCOUNT_MEMORY_CODES)[number];
const BACKEND_CODES: AccountMemoryCode[] = [
  "MEMORY_NOT_AUTHORIZED",
  "MEMORY_INVALID",
  "MEMORY_CONFLICT",
  "MEMORY_EPOCH_CHANGED",
  "MEMORY_CHANGED",
  "MEMORY_IDEMPOTENCY_CONFLICT",
  "MEMORY_LEARNING_PAUSED",
  "MEMORY_LIMIT",
  "MEMORY_UNAVAILABLE",
  "MEMORY_OPERATION_NOT_FOUND",
];
/** Fixed code only; never carries backend text, memory prose or credentials. */
export class AccountMemoryFailure extends Error {
  constructor(
    readonly code: AccountMemoryCode,
    readonly status?: number,
  ) {
    super(code);
  }
}
const reject = (): never => {
  throw new AccountMemoryFailure("MEMORY_RESULT_REJECTED");
};
export const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const ID_PATTERN = /^[a-f0-9]{24}$/;
const PRODUCERS = ["account_owner_session", "external_coach", "hosted_coach"];
const MAX_TEXT_BYTES = 2048;

export interface AccountItem {
  id: string;
  revision: number;
  /** Semantic version (text/kind); absent from older backends. */
  content_revision?: number;
  kind: MemoryKind;
  text?: string;
  availability: "available" | "unavailable";
  unavailable_code?: string;
  status: "active" | "archived";
  audience: "account_private";
  confidence: number;
  importance: number;
  goal_relevance: number | null;
  review_at: string | null;
  needs_review: boolean;
  pinned: boolean;
  protected: boolean;
  provenance: {
    type: "manual_assertion" | "derived";
    origin: "studio" | "operator_turn";
    created_by: "account_owner" | "model_extraction";
    producer: string;
    on_behalf_of: "account_owner";
    corrected: boolean;
    persona_revision: string | null;
    evidence_mode?: string;
    attestation?: string;
  };
  sources: { family: string; label: string }[];
  observed_at: string;
  created_at: string;
  updated_at: string;
}
export interface AccountOperation {
  idempotency_key: string;
  kind: "create" | "update" | "forget" | "settings";
  status: "committed";
  memory_id: string | null;
  revision: number;
  committed_at: string;
  producer: string;
  target_status: "active" | "archived" | "forgotten" | null;
  /** Forget only. Absent from older backends: never presume it complete. */
  erasure?: AccountErasure;
}
/**
 * Queued = the target is forgotten and related memories are unavailable, but
 * their stored prose is still being cleaned up; only complete means erased.
 */
export interface AccountErasure {
  status: "queued" | "complete";
  related_count: number;
}
/** Authorized snapshot of what forgetting one memory would make unavailable. */
export interface AccountForgetImpact {
  id: string;
  revision: number;
  related_count: number;
  examples: { id: string; kind: string; status: string }[];
  has_more: boolean;
  snapshot: true;
  erasure_may_be_async: true;
}
export interface AccountSettings {
  learning_paused: boolean;
  revision: number;
  updated_at: string | null;
}
export interface AccountCapture {
  capture_id: string;
  memory_epoch: number;
  extraction_expires_at: string;
}

const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const iso = (v: unknown) =>
  typeof v === "string" && v.length <= 64 && Number.isFinite(Date.parse(v))
    ? v
    : reject();
const unit = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1
    ? v
    : reject();
const short = (v: unknown, max: number) =>
  typeof v === "string" && v.length <= max ? v : reject();

/**
 * Strict projection of one account item. Unknown additive fields are dropped,
 * never forwarded; unavailable rows never carry prose.
 */
export function accountItem(value: unknown, secrets: string[]): AccountItem {
  if (!record(value)) reject();
  const v = value as Record<string, any>;
  try {
    assertNoSecrets(v, secrets);
  } catch {
    reject();
  }
  if (typeof v.id !== "string" || !ID_PATTERN.test(v.id)) reject();
  if (!Number.isSafeInteger(v.revision) || v.revision < 1) reject();
  if (
    v.content_revision !== undefined &&
    (!Number.isSafeInteger(v.content_revision) || v.content_revision < 1)
  )
    reject();
  if (!MEMORY_KINDS.includes(v.kind)) reject();
  if (v.audience !== "account_private") reject();
  if (!["active", "archived"].includes(v.status)) reject();
  if (v.subject !== undefined && v.subject !== null) reject();
  if (v.availability === "available") {
    if (
      typeof v.text !== "string" ||
      !v.text ||
      Buffer.byteLength(v.text) > MAX_TEXT_BYTES ||
      v.unavailable_code !== undefined
    )
      reject();
  } else if (
    v.availability !== "unavailable" ||
    v.text !== undefined ||
    typeof v.unavailable_code !== "string" ||
    !/^MEMORY_[A-Z_]{1,56}$/.test(v.unavailable_code)
  )
    reject();
  unit(v.confidence);
  unit(v.importance);
  if (v.goal_relevance !== null) unit(v.goal_relevance);
  if (v.review_at !== null) iso(v.review_at);
  for (const flag of ["pinned", "protected"])
    if (typeof v[flag] !== "boolean") reject();
  if (v.needs_review !== undefined && typeof v.needs_review !== "boolean")
    reject();
  const p = v.provenance;
  if (!record(p)) reject();
  const manual = p.type === "manual_assertion";
  if (
    !["manual_assertion", "derived"].includes(p.type) ||
    p.origin !== (manual ? "studio" : "operator_turn") ||
    p.created_by !== (manual ? "account_owner" : "model_extraction") ||
    !PRODUCERS.includes(p.producer) ||
    p.on_behalf_of !== "account_owner" ||
    typeof p.corrected !== "boolean" ||
    (p.persona_revision !== null &&
      (typeof p.persona_revision !== "string" ||
        p.persona_revision.length > 128)) ||
    (p.evidence_mode !== undefined &&
      p.evidence_mode !== "acquired_conversation_v1") ||
    (p.attestation !== undefined &&
      p.attestation !== "authenticated_owner_reported_interaction")
  )
    reject();
  if (!Array.isArray(v.sources) || v.sources.length > 16) reject();
  const sources = v.sources.map((s: unknown) => {
    if (!record(s)) reject();
    return {
      family: short((s as any).family, 32),
      label: short((s as any).label, 120),
    };
  });
  const reviewDue =
    v.review_at !== null && Date.parse(v.review_at) <= Date.now();
  return {
    id: v.id,
    revision: v.revision,
    ...(v.content_revision !== undefined
      ? { content_revision: v.content_revision as number }
      : {}),
    kind: v.kind,
    ...(v.availability === "available"
      ? { text: v.text }
      : { unavailable_code: v.unavailable_code }),
    availability: v.availability,
    status: v.status,
    audience: "account_private",
    confidence: v.confidence,
    importance: v.importance,
    goal_relevance: v.goal_relevance,
    review_at: v.review_at,
    needs_review: v.needs_review ?? reviewDue,
    pinned: v.pinned,
    protected: v.protected,
    provenance: {
      type: p.type,
      origin: p.origin,
      created_by: p.created_by,
      producer: p.producer,
      on_behalf_of: "account_owner",
      corrected: p.corrected,
      persona_revision: p.persona_revision,
      ...(p.evidence_mode ? { evidence_mode: p.evidence_mode } : {}),
      ...(p.attestation ? { attestation: p.attestation } : {}),
    },
    sources,
    observed_at: iso(v.observed_at),
    created_at: iso(v.created_at),
    updated_at: iso(v.updated_at),
  };
}
function erasureOf(value: unknown): AccountErasure | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) reject();
  const v = value as Record<string, any>;
  if (
    !["queued", "complete"].includes(v.status) ||
    !Number.isSafeInteger(v.related_count) ||
    v.related_count < 0
  )
    reject();
  return { status: v.status, related_count: v.related_count };
}
function operation(value: unknown): AccountOperation {
  if (!record(value)) reject();
  const v = value as Record<string, any>;
  if (
    typeof v.idempotency_key !== "string" ||
    !KEY_PATTERN.test(v.idempotency_key) ||
    !["create", "update", "forget", "settings"].includes(v.kind) ||
    v.status !== "committed" ||
    (v.memory_id !== null &&
      (typeof v.memory_id !== "string" || !ID_PATTERN.test(v.memory_id))) ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 0 ||
    !PRODUCERS.includes(v.producer) ||
    ![null, "active", "archived", "forgotten"].includes(v.target_status ?? null)
  )
    reject();
  const erasure = v.kind === "forget" ? erasureOf(v.erasure) : undefined;
  return {
    idempotency_key: v.idempotency_key,
    kind: v.kind,
    status: "committed",
    memory_id: v.memory_id,
    revision: v.revision,
    committed_at: iso(v.committed_at),
    producer: v.producer,
    target_status: v.target_status ?? null,
    ...(erasure ? { erasure } : {}),
  };
}
const CREATE_FIELDS = [
  "kind",
  "text",
  "confidence",
  "importance",
  "goal_relevance",
  "review_at",
] as const;
const UPDATE_FIELDS = [
  "text",
  "kind",
  "confidence",
  "importance",
  "goal_relevance",
  "review_at",
  "pinned",
  "status",
] as const;
function settingsOf(value: unknown): AccountSettings {
  if (!record(value)) reject();
  const v = value as Record<string, any>;
  if (
    typeof v.learning_paused !== "boolean" ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 0 ||
    (v.updated_at !== null && v.updated_at !== undefined && !iso(v.updated_at))
  )
    reject();
  return {
    learning_paused: v.learning_paused,
    revision: v.revision,
    updated_at: v.updated_at ?? null,
  };
}
function captureOf(value: unknown): AccountCapture {
  if (!record(value)) reject();
  const v = value as Record<string, any>;
  if (
    v.protocol !== MEMORY_PROTOCOL ||
    typeof v.capture_id !== "string" ||
    !ID_PATTERN.test(v.capture_id) ||
    v.audience !== "account_private" ||
    !Number.isSafeInteger(v.memory_epoch) ||
    v.memory_epoch < 0
  )
    reject();
  return {
    capture_id: v.capture_id,
    memory_epoch: v.memory_epoch,
    extraction_expires_at: iso(v.extraction_expires_at),
  };
}
export interface CommitReceipt {
  capture_id: string;
  created: { id: string; revision: number }[];
  superseded: { id: string; revision: number }[];
  skipped: CommitSkip[];
  idempotent: boolean;
}
/**
 * Account-only `protected_memory` skips carry the content-free owned ids of
 * the protected memories an automatic replacement would have overwritten.
 */
export type CommitSkip = {
  index: number;
  reason: string;
  memory_ids?: string[];
  count?: number;
};
function skipOf(s: any): CommitSkip {
  if (!record(s) || !Number.isSafeInteger(s.index) || s.index < 0) reject();
  const reason = short(s.reason, 64);
  if (reason !== "protected_memory") return { index: s.index, reason };
  const ids = s.memory_ids;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 20 ||
    ids.some((id) => typeof id !== "string" || !ID_PATTERN.test(id)) ||
    new Set(ids).size !== ids.length ||
    !Number.isSafeInteger(s.count) ||
    s.count < ids.length
  )
    reject();
  return { index: s.index, reason, memory_ids: [...ids], count: s.count };
}
function receiptOf(value: unknown, captureId: string): CommitReceipt {
  if (!record(value)) reject();
  const v = value as Record<string, any>;
  const refs = (list: unknown) => {
    if (!Array.isArray(list) || list.length > 16) reject();
    return (list as any[]).map((r) => {
      if (
        !record(r) ||
        typeof r.id !== "string" ||
        !ID_PATTERN.test(r.id) ||
        !Number.isSafeInteger(r.revision)
      )
        reject();
      return { id: r.id, revision: r.revision };
    });
  };
  if (
    v.protocol !== MEMORY_PROTOCOL ||
    v.capture_id !== captureId ||
    v.status !== "committed" ||
    !Array.isArray(v.skipped) ||
    v.skipped.length > 16
  )
    reject();
  return {
    capture_id: captureId,
    created: refs(v.created),
    superseded: refs(v.superseded ?? []),
    skipped: v.skipped.map(skipOf),
    idempotent: v.idempotent === true,
  };
}
const write = (method: string) => method !== "GET";

/** One bounded, fenced transport bound to an exact origin and bearer. */
export class AccountMemory {
  constructor(
    readonly origin: string,
    private readonly bearer: string,
    readonly signal: AbortSignal,
    readonly secrets: string[],
    private readonly timeoutMs = 15000,
  ) {}
  async request(method: string, path: string, body?: unknown): Promise<any> {
    let base: URL;
    try {
      base = new URL(this.origin);
    } catch {
      throw new AccountMemoryFailure("MEMORY_UNAVAILABLE");
    }
    if (
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== "/" ||
      !(
        base.protocol === "https:" ||
        (base.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
      ) ||
      !this.bearer ||
      this.bearer.length > 4096 ||
      /[\u0000-\u001f\u007f]/.test(this.bearer)
    )
      throw new AccountMemoryFailure("MEMORY_UNAVAILABLE");
    if (
      !path.startsWith(ACCOUNT_MEMORY_ROOT) ||
      /[\\#\u0000-\u001f\u007f]/.test(path) ||
      path.length > 2048
    )
      throw new AccountMemoryFailure("MEMORY_INVALID");
    let payload: string | undefined;
    if (body !== undefined) {
      try {
        assertNoSecrets(body, [...this.secrets, this.bearer]);
      } catch {
        throw new AccountMemoryFailure("MEMORY_INVALID");
      }
      payload = JSON.stringify(body);
      if (Buffer.byteLength(payload) > 96 * 1024)
        throw new AccountMemoryFailure("MEMORY_LIMIT");
    }
    this.signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(new URL(path, base), {
        method,
        redirect: "manual",
        credentials: "omit",
        headers: {
          Authorization: `Bearer ${this.bearer}`,
          Accept: "application/json",
          ...(payload !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        body: payload,
        signal: AbortSignal.any([
          this.signal,
          AbortSignal.timeout(this.timeoutMs),
        ]),
      });
    } catch {
      // A write may have committed before the connection failed: unknown.
      throw new AccountMemoryFailure(
        write(method) ? "MEMORY_OUTCOME_UNKNOWN" : "MEMORY_UNAVAILABLE",
      );
    }
    try {
      if (response.status >= 300 && response.status < 400)
        throw new AccountMemoryFailure("MEMORY_RESULT_REJECTED");
      if (response.status === 401)
        throw new AccountMemoryFailure("MEMORY_AUTH_EXPIRED", 401);
      const json =
        response.headers.get("content-type")?.split(";")[0].trim() ===
        "application/json";
      let value: any;
      if (json) {
        const chunks: Buffer[] = [];
        let size = 0;
        try {
          for await (const chunk of response.body ?? []) {
            size += chunk.length;
            if (size > 768 * 1024)
              throw new AccountMemoryFailure("MEMORY_LIMIT");
            chunks.push(Buffer.from(chunk));
          }
          value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch (error) {
          if (error instanceof AccountMemoryFailure) throw error;
          // Unparseable: an error status is still classified below.
          if (response.ok)
            throw new AccountMemoryFailure(
              write(method) ? "MEMORY_OUTCOME_UNKNOWN" : "MEMORY_UNAVAILABLE",
            );
          value = undefined;
        }
      }
      if (!response.ok) {
        const code = value?.code;
        if (json && BACKEND_CODES.includes(code))
          throw new AccountMemoryFailure(code, response.status);
        // A missing route (framework 404) is an older backend, not an empty
        // collection; unknown 5xx bodies leave a write's outcome unknown.
        if (response.status === 404)
          throw new AccountMemoryFailure("MEMORY_UNSUPPORTED", 404);
        if (response.status === 403)
          throw new AccountMemoryFailure("MEMORY_NOT_AUTHORIZED", 403);
        throw new AccountMemoryFailure(
          write(method) && response.status >= 500
            ? "MEMORY_OUTCOME_UNKNOWN"
            : "MEMORY_UNAVAILABLE",
          response.status,
        );
      }
      if (!json || !record(value) || value.protocol !== MEMORY_PROTOCOL)
        throw new AccountMemoryFailure(
          write(method) ? "MEMORY_OUTCOME_UNKNOWN" : "MEMORY_RESULT_REJECTED",
        );
      try {
        assertNoSecrets(value, [...this.secrets, this.bearer]);
      } catch {
        throw new AccountMemoryFailure("MEMORY_RESULT_REJECTED");
      }
      return value;
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  }
  async list(
    input: {
      status?: "active" | "archived" | "all";
      kind?: string;
      query?: string;
      limit?: number;
      cursor?: string;
      pinned?: boolean;
    } = {},
  ) {
    const params = new URLSearchParams();
    if (input.status) params.set("status", input.status);
    if (input.kind) params.set("kind", input.kind);
    if (input.query) params.set("query", input.query.slice(0, 500));
    if (input.pinned !== undefined) params.set("pinned", String(input.pinned));
    if (input.limit) params.set("limit", String(input.limit));
    if (input.cursor) params.set("cursor", input.cursor);
    const value = await this.request(
      "GET",
      ACCOUNT_MEMORY_ROOT + (params.size ? "?" + params : ""),
    );
    if (!Array.isArray(value.items) || value.items.length > 50) reject();
    let page: { has_more: boolean; next_cursor: string | null };
    try {
      page = memoryPage(value);
    } catch {
      return reject();
    }
    return {
      items: value.items.map((i: unknown) => accountItem(i, this.secrets)),
      ...page,
    } as {
      items: AccountItem[];
      has_more: boolean;
      next_cursor: string | null;
    };
  }
  async get(id: string) {
    if (!ID_PATTERN.test(id)) throw new AccountMemoryFailure("MEMORY_INVALID");
    const value = await this.request("GET", `${ACCOUNT_MEMORY_ROOT}/${id}`);
    const item = accountItem(value.item, this.secrets);
    if (item.id !== id) reject();
    if (!Array.isArray(value.history) || value.history.length > 200) reject();
    const history = value.history.map((h: any) => {
      if (!record(h) || !Number.isSafeInteger(h.revision)) reject();
      return {
        revision: h.revision,
        at: iso(h.at),
        actor: short(h.actor, 64),
        ...(h.producer !== undefined
          ? { producer: short(h.producer, 64) }
          : {}),
        change: short(h.change, 64),
        ...(item.availability === "available" && typeof h.text === "string"
          ? { text: short(h.text, 4096) }
          : {}),
      };
    });
    return { item, history };
  }
  private keyed(key: string) {
    if (!KEY_PATTERN.test(key))
      throw new AccountMemoryFailure("MEMORY_INVALID");
    return key;
  }
  /**
   * A write response is committed only when its receipt names this exact
   * occurrence: our host key, the requested kind and the requested target.
   * Anything else is an unknown outcome to reconcile, never a success.
   */
  private mutation(
    value: any,
    key: string,
    kind: "create" | "update",
    id?: string,
  ) {
    const result = {
      item: accountItem(value.item, this.secrets),
      operation: operation(value.operation),
      idempotent: value.idempotent === true,
    };
    const op = result.operation;
    if (
      op.idempotency_key !== key ||
      op.kind !== kind ||
      op.memory_id !== result.item.id ||
      (id !== undefined && result.item.id !== id)
    )
      throw new AccountMemoryFailure("MEMORY_OUTCOME_UNKNOWN");
    return result;
  }
  /** Caller fields are picked by allow-list; host-owned fields are refused. */
  private body(input: object, allowed: readonly string[]) {
    const body: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(input)) {
      if (!allowed.includes(field))
        throw new AccountMemoryFailure("MEMORY_INVALID");
      if (value !== undefined) body[field] = value;
    }
    return body;
  }
  async create(
    input: {
      kind: string;
      text: string;
      confidence?: number;
      importance?: number;
      goal_relevance?: number | null;
      review_at?: string | null;
    },
    key: string,
  ) {
    const body = this.body(input, CREATE_FIELDS);
    return this.mutation(
      await this.request("POST", ACCOUNT_MEMORY_ROOT, {
        ...body,
        idempotency_key: this.keyed(key),
      }),
      key,
      "create",
    );
  }
  async update(
    id: string,
    patch: {
      text?: string;
      kind?: string;
      confidence?: number;
      importance?: number;
      goal_relevance?: number | null;
      review_at?: string | null;
      pinned?: boolean;
      status?: "active" | "archived";
    },
    expectedRevision: number,
    key: string,
  ) {
    if (!ID_PATTERN.test(id) || !Number.isSafeInteger(expectedRevision))
      throw new AccountMemoryFailure("MEMORY_INVALID");
    const body = this.body(patch, UPDATE_FIELDS);
    return this.mutation(
      await this.request("PATCH", `${ACCOUNT_MEMORY_ROOT}/${id}`, {
        ...body,
        idempotency_key: this.keyed(key),
        expected_revision: expectedRevision,
      }),
      key,
      "update",
      id,
    );
  }
  async forget(id: string, expectedRevision: number, key: string) {
    if (!ID_PATTERN.test(id) || !Number.isSafeInteger(expectedRevision))
      throw new AccountMemoryFailure("MEMORY_INVALID");
    const value = await this.request("DELETE", `${ACCOUNT_MEMORY_ROOT}/${id}`, {
      idempotency_key: this.keyed(key),
      expected_revision: expectedRevision,
    });
    if (value.id !== id || value.status !== "forgotten") reject();
    const op = operation(value.operation);
    if (
      op.idempotency_key !== key ||
      op.kind !== "forget" ||
      op.memory_id !== id
    )
      throw new AccountMemoryFailure("MEMORY_OUTCOME_UNKNOWN");
    const cascaded = Array.isArray(value.cascaded) ? value.cascaded : [];
    if (
      cascaded.length > 64 ||
      cascaded.some(
        (c: unknown) => typeof c !== "string" || !ID_PATTERN.test(c),
      )
    )
      reject();
    const erasure = erasureOf(value.erasure) ?? op.erasure;
    return {
      id,
      status: "forgotten" as const,
      // Only the synchronously erased ids; a queued erasure lists none.
      cascaded: cascaded as string[],
      ...(erasure ? { erasure } : {}),
      operation: op,
      idempotent: value.idempotent === true,
    };
  }
  /** Read-only preview of what forgetting `id` would make unavailable. */
  async forgetImpact(id: string): Promise<AccountForgetImpact> {
    if (!ID_PATTERN.test(id)) throw new AccountMemoryFailure("MEMORY_INVALID");
    const value = await this.request(
      "GET",
      `${ACCOUNT_MEMORY_ROOT}/${id}/forget-impact`,
    );
    if (!record(value)) reject();
    const examples = value.examples;
    if (
      value.id !== id ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      !Number.isSafeInteger(value.related_count) ||
      value.related_count < 0 ||
      !Array.isArray(examples) ||
      examples.length > 20 ||
      examples.length > value.related_count ||
      typeof value.has_more !== "boolean" ||
      value.snapshot !== true ||
      value.erasure_may_be_async !== true
    )
      reject();
    return {
      id,
      revision: value.revision,
      related_count: value.related_count,
      examples: examples.map((e: unknown) => {
        const x = e as Record<string, any>;
        if (
          !record(e) ||
          typeof x.id !== "string" ||
          !ID_PATTERN.test(x.id) ||
          !MEMORY_KINDS.includes(x.kind) ||
          !["active", "archived"].includes(x.status)
        )
          reject();
        return { id: x.id, kind: x.kind, status: x.status };
      }),
      has_more: value.has_more,
      snapshot: true,
      erasure_may_be_async: true,
    };
  }
  /**
   * Read-only reconciliation of one exact write; null = not committed (yet).
   * With `expect`, a receipt for another kind or target is rejected.
   */
  async operation(
    key: string,
    expect?: { kind: AccountOperation["kind"]; memory_id?: string | null },
  ) {
    let value;
    try {
      value = await this.request(
        "GET",
        `${ACCOUNT_MEMORY_ROOT}/operations/${encodeURIComponent(this.keyed(key))}`,
      );
    } catch (error) {
      if (
        error instanceof AccountMemoryFailure &&
        error.code === "MEMORY_OPERATION_NOT_FOUND"
      )
        return null;
      throw error;
    }
    const op = operation(value.operation);
    if (op.idempotency_key !== key) reject();
    if (
      expect &&
      (op.kind !== expect.kind ||
        (expect.memory_id !== undefined && op.memory_id !== expect.memory_id))
    )
      reject();
    if (value.item && accountItem(value.item, this.secrets).id !== op.memory_id)
      reject();
    return {
      operation: op,
      item:
        value.item === null || value.item === undefined
          ? null
          : accountItem(value.item, this.secrets),
      ...(value.settings ? { settings: settingsOf(value.settings) } : {}),
    };
  }
  async settings() {
    const value = await this.request("GET", `${ACCOUNT_MEMORY_ROOT}/settings`);
    return settingsOf(value.settings);
  }
  async setLearning(paused: boolean, expectedRevision: number, key: string) {
    const value = await this.request(
      "PATCH",
      `${ACCOUNT_MEMORY_ROOT}/settings`,
      {
        idempotency_key: this.keyed(key),
        expected_revision: expectedRevision,
        learning_paused: paused,
      },
    );
    const op = operation(value.operation);
    if (
      op.idempotency_key !== key ||
      op.kind !== "settings" ||
      op.memory_id !== null
    )
      throw new AccountMemoryFailure("MEMORY_OUTCOME_UNKNOWN");
    return {
      settings: settingsOf(value.settings),
      discarded_captures: Number.isSafeInteger(value.discarded_captures)
        ? (value.discarded_captures as number)
        : 0,
      operation: op,
      idempotent: value.idempotent === true,
    };
  }
  /** Bounded new acquisition for one turn: pinned core plus query matches. */
  async recall(query: string, limits = { pinned: 8, matches: 12 }) {
    const pinned = await this.list({
      status: "active",
      pinned: true,
      limit: limits.pinned,
    });
    const text = query.trim();
    const matched = text
      ? await this.list({
          status: "active",
          query: text,
          limit: limits.matches,
        })
      : { items: [] as AccountItem[] };
    const seen = new Set<string>();
    const items = [...pinned.items, ...matched.items].filter(
      (item) =>
        item.availability === "available" &&
        item.status === "active" &&
        !seen.has(item.id) &&
        !!seen.add(item.id),
    );
    if (Buffer.byteLength(JSON.stringify(items)) > 64 * 1024) reject();
    return items;
  }
  async capture(input: {
    idempotency_key: string;
    human_text: string;
    assistant_text: string;
    tool_results: { name: string; result: string }[];
    recalled: { id: string; revision: number; content_revision?: number }[];
  }) {
    if (
      input.tool_results.length > 64 ||
      input.recalled.length > 20 ||
      input.tool_results.some(
        (t) => t.name.length > 128 || t.result.length > 8192,
      ) ||
      input.human_text.length > 65536 ||
      input.assistant_text.length > 65536 ||
      Buffer.byteLength(
        JSON.stringify({
          human_text: input.human_text,
          assistant_text: input.assistant_text,
          tool_results: input.tool_results,
        }),
      ) > 65536
    )
      throw new AccountMemoryFailure("MEMORY_LIMIT");
    return captureOf(
      await this.request("POST", `${ACCOUNT_MEMORY_ROOT}/interactions`, input),
    );
  }
  async commit(
    capture: AccountCapture,
    proposals: MemoryProposal[],
    personaRevision?: string,
  ) {
    return receiptOf(
      await this.request(
        "POST",
        `${ACCOUNT_MEMORY_ROOT}/interactions/${capture.capture_id}/commit`,
        {
          idempotency_key: "extract:" + capture.capture_id,
          expected_memory_epoch: capture.memory_epoch,
          ...(personaRevision ? { persona_revision: personaRevision } : {}),
          proposals,
        },
      ),
      capture.capture_id,
    );
  }
  /** Exact commit state after a lost commit acknowledgement. */
  async commitReceipt(captureId: string) {
    if (!ID_PATTERN.test(captureId))
      throw new AccountMemoryFailure("MEMORY_INVALID");
    const value = await this.request(
      "GET",
      `${ACCOUNT_MEMORY_ROOT}/interactions/${captureId}/receipt`,
    );
    if (value.capture_id !== captureId || typeof value.status !== "string")
      reject();
    return {
      status: short(value.status, 32),
      receipt:
        value.receipt === null || value.receipt === undefined
          ? null
          : receiptOf(value.receipt, captureId),
    };
  }
  /** Scans continuation pages, including empty ones, within a fixed bound. */
  async pending() {
    let cursor: string | null = null;
    const captures: { capture_id: string }[] = [];
    let paused = false;
    for (let page = 0; page < 8; page++) {
      const value = await this.request(
        "GET",
        `${ACCOUNT_MEMORY_ROOT}/interactions/pending` +
          (cursor ? "?" + new URLSearchParams({ cursor }) : ""),
      );
      if (!Array.isArray(value.captures) || value.captures.length > 50)
        reject();
      for (const c of value.captures) {
        if (
          !record(c) ||
          typeof c.capture_id !== "string" ||
          !ID_PATTERN.test(c.capture_id)
        )
          reject();
        captures.push({ capture_id: c.capture_id });
      }
      paused ||= value.learning_paused === true;
      let next: { has_more: boolean; next_cursor: string | null };
      try {
        next = memoryPage(value);
      } catch {
        return reject();
      }
      if (captures.length || !next.has_more) return { captures, paused };
      if (next.next_cursor === cursor) reject();
      cursor = next.next_cursor;
    }
    return { captures, paused, partial: true };
  }
  async resume(captureId: string) {
    if (!ID_PATTERN.test(captureId))
      throw new AccountMemoryFailure("MEMORY_INVALID");
    const value = await this.request(
      "GET",
      `${ACCOUNT_MEMORY_ROOT}/interactions/${captureId}`,
    );
    const capture = captureOf(value.capture);
    if (capture.capture_id !== captureId || !record(value.evidence)) reject();
    if (!Array.isArray(value.recalled) || value.recalled.length > 20) reject();
    const evidence = value.evidence as Record<string, any>;
    if (
      typeof evidence.human_text !== "string" ||
      typeof evidence.assistant_text !== "string" ||
      !Array.isArray(evidence.tool_results ?? [])
    )
      reject();
    return {
      capture,
      recalled: (value.recalled as unknown[]).map((i) =>
        accountItem(i, this.secrets),
      ),
      evidence: {
        human_text: evidence.human_text as string,
        assistant_text: evidence.assistant_text as string,
        tool_results: (evidence.tool_results ?? []) as {
          name: string;
          result: string;
        }[],
      },
    };
  }
}
