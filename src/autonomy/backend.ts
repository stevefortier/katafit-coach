import { createHash } from "node:crypto";
import { assertNoSecrets } from "../config/store.js";
import {
  AUTONOMY_CAPABILITY_PROTOCOL,
  autonomyCapability,
  type AutonomyCapability,
} from "../capability/autonomy.js";
import {
  ACTION_TEXT_LIMIT,
  AUTONOMY_PROTOCOL,
  AUTONOMY_ROOT,
  BACKEND_CODES,
  CHECKPOINT_LIMIT,
  FOLLOW_UP_STATUSES,
  ID,
  LIMITS,
  PRAISE_TEXT_LIMIT,
  SLOT_PATTERN,
  WORK_FILTERS,
  WORK_KINDS,
  followUpCoherent,
  intentCoherent,
  mandateCoherent,
  outcomeCoherent,
  pageCoherent,
  validate,
  type ActionIntent,
  type ActionReceipt,
  type AutonomyCode,
  type AutonomyStatus,
  type CompositionInput,
  type CycleOutcome,
  type FollowUp,
  type FollowUpInput,
  type FollowUpPatch,
  type IntentInput,
  type IntentRecord,
  type IntentState,
  type Limit,
  type Mandate,
  type MandateView,
  type Page,
  type PublicProjection,
  type PutMandate,
  type Report,
  type WorkFilter,
  type WorkItem,
  type WorkKind,
} from "./types.js";

/** Fixed code only; never carries backend text, member prose or credentials. */
export class AutonomyFailure extends Error {
  constructor(
    readonly code: AutonomyCode,
    readonly status?: number,
    readonly limit?: Limit,
  ) {
    super(code);
  }
}
const fail = (code: AutonomyCode, status?: number, limit?: Limit): never => {
  throw new AutonomyFailure(code, status, limit);
};
const write = (method: string) => method !== "GET";
const isId = (value: unknown): value is string =>
  typeof value === "string" && new RegExp(ID).test(value);
const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const isSlot = (value: unknown): value is string =>
  typeof value === "string" && SLOT_PATTERN.test(value);
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
/** Only a receipt naming exactly the intended audience proves the action. */
const receiptFits = (r: ActionReceipt, input: ActionIntent) => {
  switch (input.type) {
    case "member_message":
      return (
        r.status === "delivered" &&
        r.recipient_id === input.recipient_id &&
        !!r.message_id
      );
    case "manager_report":
      return r.status === "delivered" && !!r.message_id;
    case "public_praise":
      return (
        (r.status === "published" || r.status === "already_published") &&
        r.activity_id === input.activity_id &&
        !!r.comment_id &&
        !!r.subject_user_id &&
        r.recipient_id === undefined
      );
  }
};
/** Page bounds shared by every listing: 1..50 items, opaque cursor. */
const pageBounds = ({ cursor, limit }: { cursor?: string; limit?: number }) =>
  (limit === undefined ||
    (Number.isInteger(limit) && limit >= 1 && limit <= 50)) &&
  (cursor === undefined ||
    (typeof cursor === "string" && !!cursor && cursor.length <= 2048));
const query = (entries: [string, string | number | undefined][]) => {
  const params = new URLSearchParams();
  for (const [key, value] of entries)
    if (value !== undefined) params.set(key, String(value));
  return params.size ? `?${params}` : "";
};
const isIso = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) &&
  !Number.isNaN(Date.parse(value));
const REQUEST_LIMIT = 64 * 1024;
const RESPONSE_LIMIT = 512 * 1024;

/**
 * Ordinary REST client for the backend-owned continuous Coach control plane,
 * bound to one exact origin and bearer. Every call is one request: writes are
 * never retried here, so a changed body can never be resent under an old
 * identity. Recovery (identical re-PUT or exact receipt read) is the caller's
 * explicit decision. A write whose outcome cannot be proven is
 * AUTONOMY_OUTCOME_UNKNOWN, never a guessed success or failure.
 */
function claimInput(input: { lease_seconds?: number; kinds?: WorkKind[] }) {
  const { lease_seconds, kinds, ...rest } = input;
  if (
    Object.keys(rest).length ||
    (lease_seconds !== undefined &&
      (!Number.isInteger(lease_seconds) ||
        lease_seconds < 15 ||
        lease_seconds > 300)) ||
    (kinds !== undefined &&
      (!Array.isArray(kinds) ||
        !kinds.length ||
        new Set(kinds).size !== kinds.length ||
        kinds.some((k) => !WORK_KINDS.includes(k))))
  )
    fail("AUTONOMY_INVALID");
}

/** A claimed lease we cannot verify is never run; it simply expires. */
function negotiatedClaim(
  value: any,
): { work: WorkItem; capability: AutonomyCapability | null } | null {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("AUTONOMY_RESULT_REJECTED");
  const { capability, allowed_tools, capability_guidance, ...envelope } = value;
  const negotiated = Object.hasOwn(value, "capability");
  if (
    !validate.claimResult(envelope) ||
    (negotiated
      ? !envelope.work ||
        !Object.hasOwn(value, "allowed_tools") ||
        !Object.hasOwn(value, "capability_guidance")
      : allowed_tools !== undefined || capability_guidance !== undefined)
  )
    fail("AUTONOMY_RESULT_REJECTED");
  const work = (envelope as { work: WorkItem | null }).work;
  if (!work) return null;
  if (!negotiated) return { work, capability: null };
  try {
    return { work, capability: autonomyCapability(value, work) };
  } catch {
    return fail("AUTONOMY_RESULT_REJECTED");
  }
}

export class AutonomyBackend {
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
      return fail("AUTONOMY_UNAVAILABLE");
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
      fail("AUTONOMY_UNAVAILABLE");
    if (
      !path.startsWith(AUTONOMY_ROOT + "/") ||
      /[\\#\u0000-\u001f\u007f]/.test(path) ||
      path.length > 2048
    )
      fail("AUTONOMY_INVALID");
    let payload: string | undefined;
    if (body !== undefined) {
      try {
        assertNoSecrets(body, [...this.secrets, this.bearer]);
      } catch {
        fail("AUTONOMY_INVALID");
      }
      payload = JSON.stringify(body);
      if (Buffer.byteLength(payload) > REQUEST_LIMIT) fail("AUTONOMY_INVALID");
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
      // A write may have committed before the connection failed.
      return fail(
        write(method) ? "AUTONOMY_OUTCOME_UNKNOWN" : "AUTONOMY_UNAVAILABLE",
      );
    }
    try {
      if (response.status >= 300 && response.status < 400)
        fail("AUTONOMY_RESULT_REJECTED");
      if (response.status === 401) fail("AUTONOMY_AUTH_EXPIRED", 401);
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
            if (size > RESPONSE_LIMIT) throw new Error("RESULT_TOO_LARGE");
            chunks.push(Buffer.from(chunk));
          }
          value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          value = undefined;
        }
      }
      if (!response.ok) {
        // A 5xx write may have committed whatever its body claims.
        if (write(method) && response.status >= 500)
          fail("AUTONOMY_OUTCOME_UNKNOWN", response.status);
        const code = value?.code;
        if (json && (BACKEND_CODES as readonly string[]).includes(code))
          fail(
            code,
            response.status,
            code === "ACTION_LIMITED" &&
              (LIMITS as readonly string[]).includes(value.limit)
              ? value.limit
              : undefined,
          );
        // A framework 404 is an older backend, not an empty resource.
        if (response.status === 404) fail("AUTONOMY_UNSUPPORTED", 404);
        if (response.status === 403) fail("AUTONOMY_NOT_AUTHORIZED", 403);
        fail("AUTONOMY_UNAVAILABLE", response.status);
      }
      if (!json || value === undefined) fail("AUTONOMY_RESULT_REJECTED");
      try {
        assertNoSecrets(value, [...this.secrets, this.bearer]);
      } catch {
        fail("AUTONOMY_RESULT_REJECTED");
      }
      return value;
    } catch (error) {
      // An accepted write whose answer cannot be verified is unknown.
      if (
        response.ok &&
        write(method) &&
        !(
          error instanceof AutonomyFailure &&
          error.code === "AUTONOMY_OUTCOME_UNKNOWN"
        )
      )
        fail("AUTONOMY_OUTCOME_UNKNOWN", response.status);
      throw error;
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  }

  /** Validate an accepted result; a write's unverifiable answer is unknown. */
  private accept<T>(
    method: string,
    value: any,
    check: (value: any) => boolean,
  ): T {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !check(value)
    )
      fail(
        write(method) ? "AUTONOMY_OUTCOME_UNKNOWN" : "AUTONOMY_RESULT_REJECTED",
      );
    return value as T;
  }

  async mandate(): Promise<MandateView> {
    const value = await this.request("GET", `${AUTONOMY_ROOT}/mandate`);
    return this.accept(
      "GET",
      value,
      (v) => v.protocol === AUTONOMY_PROTOCOL && validate.mandateView(v),
    );
  }

  /** CAS update; the same key + body is the only safe replay. */
  async putMandate(
    input: PutMandate,
  ): Promise<{ mandate: Mandate; idempotent: boolean }> {
    if (!validate.putMandate(input) || !mandateCoherent(input.mandate))
      fail("AUTONOMY_INVALID");
    const value = await this.request("PUT", `${AUTONOMY_ROOT}/mandate`, input);
    return this.accept("PUT", value, (v) => validate.putMandateResult(v));
  }

  /** One fenced lease step on an exact work item. */
  private async leased(
    id: string,
    step: "start" | "checkpoint",
    body: { lease_generation: number } & Record<string, unknown>,
  ): Promise<WorkItem> {
    const value = await this.request(
      "POST",
      `${AUTONOMY_ROOT}/work/${id}/${step}`,
      body,
    );
    return this.accept<{ work: WorkItem }>(
      "POST",
      value,
      (v) =>
        validate.workResult(v) &&
        v.work.id === id &&
        v.work.lease_generation === body.lease_generation,
    ).work;
  }

  async listWork(
    input: { status?: WorkFilter; cursor?: string; limit?: number } = {},
  ): Promise<Page<WorkItem>> {
    const { status, cursor, limit } = input;
    if (
      (status !== undefined && !WORK_FILTERS.includes(status)) ||
      !pageBounds(input)
    )
      fail("AUTONOMY_INVALID");
    const value = await this.request(
      "GET",
      `${AUTONOMY_ROOT}/work${query([
        ["status", status],
        ["limit", limit],
        ["cursor", cursor],
      ])}`,
    );
    return this.accept(
      "GET",
      value,
      (v) => validate.workPage(v) && pageCoherent(v),
    );
  }

  /** Claim at most one due item; claims are only for a Coach bearer. */
  async claim(
    input: { lease_seconds?: number; kinds?: WorkKind[] } = {},
  ): Promise<WorkItem | null> {
    claimInput(input);
    const value = await this.request(
      "POST",
      `${AUTONOMY_ROOT}/work/claim`,
      input,
    );
    return this.accept<{ work: WorkItem | null }>("POST", value, (v) =>
      validate.claimResult(v),
    ).work;
  }

  private negotiation: "unknown" | "supported" | "unsupported" = "unknown";
  /**
   * Claim with coach.capability.v1 negotiation. The claim body is strictly
   * validated before any state change, so an older backend's AUTONOMY_INVALID
   * is a safe signal to claim once more without negotiating (cached).
   */
  async claimCycle(
    input: { lease_seconds?: number; kinds?: WorkKind[] } = {},
  ): Promise<{ work: WorkItem; capability: AutonomyCapability | null } | null> {
    claimInput(input);
    if (this.negotiation !== "unsupported") {
      let value: any;
      try {
        value = await this.request("POST", `${AUTONOMY_ROOT}/work/claim`, {
          ...input,
          capability_protocols: [AUTONOMY_CAPABILITY_PROTOCOL],
        });
      } catch (error) {
        if (
          this.negotiation === "unknown" &&
          error instanceof AutonomyFailure &&
          error.code === "AUTONOMY_INVALID"
        )
          this.negotiation = "unsupported";
        else throw error;
      }
      if (this.negotiation !== "unsupported") {
        this.negotiation = "supported";
        return negotiatedClaim(value);
      }
    }
    const work = await this.claim(input);
    return work ? { work, capability: null } : null;
  }

  async start(id: string, lease_generation: number): Promise<WorkItem> {
    if (!isId(id) || !isCount(lease_generation)) fail("AUTONOMY_INVALID");
    return this.leased(id, "start", { lease_generation });
  }

  /** Extend the lease (never past timeout_at) and save the opaque checkpoint. */
  async checkpoint(
    id: string,
    input: {
      lease_generation: number;
      checkpoint: string;
      lease_seconds?: number;
    },
  ): Promise<WorkItem> {
    const { lease_generation, checkpoint, lease_seconds, ...rest } = input;
    if (
      !isId(id) ||
      Object.keys(rest).length ||
      !isCount(lease_generation) ||
      typeof checkpoint !== "string" ||
      checkpoint.length > CHECKPOINT_LIMIT ||
      (lease_seconds !== undefined &&
        (!Number.isInteger(lease_seconds) ||
          lease_seconds < 15 ||
          lease_seconds > 300))
    )
      fail("AUTONOMY_INVALID");
    return this.leased(id, "checkpoint", input);
  }

  /** Terminal or deferred outcome; the backend re-verifies cited slots. */
  async complete(
    id: string,
    input: {
      lease_generation: number;
      mandate_revision: number;
      outcome: CycleOutcome;
    },
  ): Promise<{ work: WorkItem; report_id: string }> {
    const { lease_generation, mandate_revision, outcome, ...rest } = input;
    if (
      !isId(id) ||
      Object.keys(rest).length ||
      !isCount(lease_generation) ||
      !isCount(mandate_revision) ||
      !validate.hostOutcome(outcome) ||
      !outcomeCoherent(outcome)
    )
      fail("AUTONOMY_INVALID");
    const value = await this.request(
      "POST",
      `${AUTONOMY_ROOT}/work/${id}/complete`,
      input,
    );
    return this.accept(
      "POST",
      value,
      (v) => validate.completeResult(v) && v.work.id === id,
    );
  }

  /**
   * Atomic intent + canonical send + receipt, idempotent per (work, slot).
   * The backend derives the delivery key; the host never chooses one. Only a
   * receipt for exactly this slot, type, recipient and payload proves it.
   */
  async act(
    id: string,
    slot: string,
    input: ActionIntent,
  ): Promise<{ receipt: ActionReceipt; idempotent: boolean }> {
    const { lease_generation, mandate_revision, type, text } =
      input ?? ({} as ActionIntent);
    const recipient_id = (input as { recipient_id?: unknown })?.recipient_id;
    const praise = input as Extract<ActionIntent, { type: "public_praise" }>;
    const keys = Object.keys(input ?? {})
      .sort()
      .join();
    if (
      !isId(id) ||
      !isSlot(slot) ||
      !isCount(lease_generation) ||
      !isCount(mandate_revision) ||
      typeof text !== "string" ||
      !text.trim() ||
      text.length > ACTION_TEXT_LIMIT ||
      !(
        (type === "member_message" &&
          isId(recipient_id) &&
          keys ===
            "lease_generation,mandate_revision,recipient_id,text,type") ||
        (type === "manager_report" &&
          keys === "lease_generation,mandate_revision,text,type") ||
        (type === "public_praise" &&
          isId(praise.activity_id) &&
          isIso(praise.completed_at) &&
          text.length <= PRAISE_TEXT_LIMIT &&
          keys ===
            "activity_id,completed_at,lease_generation,mandate_revision,text,type")
      )
    )
      fail("AUTONOMY_INVALID");
    const value = await this.request(
      "PUT",
      `${AUTONOMY_ROOT}/work/${id}/actions/${slot}`,
      input,
    );
    const digest = sha256(text);
    return this.accept(
      "PUT",
      value,
      (v) =>
        validate.actResult(v) &&
        v.receipt.slot === slot &&
        v.receipt.type === type &&
        v.receipt.text_sha256 === digest &&
        receiptFits(v.receipt, input),
    );
  }

  /**
   * [AC1] Record one finite intent under the lease. The intent has no text;
   * refs are checked here for grammar only, the backend checks authority.
   */
  async putIntent(
    id: string,
    slot: string,
    input: IntentInput,
  ): Promise<{
    intent: IntentRecord;
    idempotent: boolean;
    public_projection?: PublicProjection;
  }> {
    if (
      !isId(id) ||
      !isSlot(slot) ||
      !validate.intentInput(input) ||
      !intentCoherent(input.intent)
    )
      fail("AUTONOMY_INVALID");
    const { intent } = input;
    const value = await this.request(
      "PUT",
      `${AUTONOMY_ROOT}/work/${id}/intents/${slot}`,
      input,
    );
    return this.accept("PUT", value, (v) => {
      if (!validate.intentResult(v)) return false;
      const saved = v.intent;
      return (
        saved.slot === slot &&
        saved.type === intent.type &&
        saved.purpose === intent.purpose &&
        saved.recipient_id === intent.recipient_id &&
        saved.activity_id === intent.activity_id &&
        saved.completed_at === intent.completed_at &&
        (intent.type === "public_praise") ===
          (v.public_projection !== undefined)
      );
    });
  }

  /**
   * [AC1] Store composed text once per intent slot (first write wins). The
   * returned text is the only text the host may dispatch: when another
   * composition is already stored, that stored text replaces this one.
   */
  async putComposition(
    id: string,
    slot: string,
    input: CompositionInput,
  ): Promise<{ text: string; stored: boolean }> {
    if (
      !isId(id) ||
      !isSlot(slot) ||
      !validate.compositionInput(input) ||
      !input.text.trim()
    )
      fail("AUTONOMY_INVALID");
    const value = await this.request(
      "PUT",
      `${AUTONOMY_ROOT}/work/${id}/intents/${slot}/composition`,
      input,
    );
    const saved = this.accept<{
      composition: { slot: string; text?: string; text_sha256: string };
      stored: boolean;
    }>("PUT", value, (v) => {
      if (!validate.compositionResult(v) || v.composition.slot !== slot)
        return false;
      const { text, text_sha256 } = v.composition;
      return v.stored
        ? text !== undefined && sha256(text) === text_sha256
        : text === undefined && text_sha256 === sha256(input.text);
    });
    return {
      text: saved.stored ? saved.composition.text! : input.text,
      stored: saved.stored,
    };
  }

  /** [AC1] Exact recovery read: intent, stored composition and receipt. */
  async getIntent(id: string, slot: string): Promise<IntentState> {
    if (!isId(id) || !isSlot(slot)) fail("AUTONOMY_INVALID");
    const value = await this.request(
      "GET",
      `${AUTONOMY_ROOT}/work/${id}/intents/${slot}`,
    );
    return this.accept("GET", value, (v) => {
      if (!validate.intentState(v) || v.intent.slot !== slot) return false;
      const { composition, receipt } = v;
      return (
        (composition === null ||
          sha256(composition.text) === composition.text_sha256) &&
        (receipt === null ||
          (receipt.slot === slot && receipt.type === v.intent.type))
      );
    });
  }

  /** Read-only proof of one committed slot; no lease needed. */
  async actionReceipt(id: string, slot: string): Promise<ActionReceipt> {
    if (!isId(id) || !isSlot(slot)) fail("AUTONOMY_INVALID");
    const value = await this.request(
      "GET",
      `${AUTONOMY_ROOT}/work/${id}/actions/${slot}`,
    );
    return this.accept<{ receipt: ActionReceipt }>(
      "GET",
      value,
      (v) => validate.receiptResult(v) && v.receipt.slot === slot,
    ).receipt;
  }

  /** Create a follow-up under the lease; idempotent per (work, slot). */
  async followUp(
    id: string,
    slot: string,
    input: FollowUpInput,
  ): Promise<{ follow_up: FollowUp; idempotent: boolean }> {
    if (
      !isId(id) ||
      !isSlot(slot) ||
      !validate.followUpInput(input) ||
      !followUpCoherent(input)
    )
      fail("AUTONOMY_INVALID");
    const value = await this.request(
      "PUT",
      `${AUTONOMY_ROOT}/work/${id}/follow-ups/${slot}`,
      input,
    );
    return this.accept(
      "PUT",
      value,
      (v) =>
        validate.followUpResult(v) &&
        v.follow_up.source.work_id === id &&
        v.follow_up.source.slot === slot &&
        v.follow_up.subject_id === input.subject_id &&
        v.follow_up.basis === input.basis,
    );
  }

  /** Close or cancel with CAS on the follow-up revision. */
  async patchFollowUp(id: string, input: FollowUpPatch): Promise<FollowUp> {
    if (!isId(id) || !validate.followUpPatch(input)) fail("AUTONOMY_INVALID");
    const value = await this.request(
      "PATCH",
      `${AUTONOMY_ROOT}/follow-ups/${id}`,
      input,
    );
    return this.accept<{ follow_up: FollowUp }>(
      "PATCH",
      value,
      (v) =>
        validate.followUpPatchResult(v) &&
        v.follow_up.id === id &&
        v.follow_up.status === input.status,
    ).follow_up;
  }

  async listFollowUps(
    input: {
      status?: FollowUp["status"];
      subject_id?: string;
      cursor?: string;
      limit?: number;
    } = {},
  ): Promise<Page<FollowUp>> {
    const { status, subject_id, cursor, limit } = input;
    if (
      (status !== undefined && !FOLLOW_UP_STATUSES.includes(status)) ||
      (subject_id !== undefined && !isId(subject_id)) ||
      !pageBounds(input)
    )
      fail("AUTONOMY_INVALID");
    const value = await this.request(
      "GET",
      `${AUTONOMY_ROOT}/follow-ups${query([
        ["status", status],
        ["subject_id", subject_id],
        ["limit", limit],
        ["cursor", cursor],
      ])}`,
    );
    return this.accept(
      "GET",
      value,
      (v) => validate.followUpPage(v) && pageCoherent(v),
    );
  }

  async status(): Promise<AutonomyStatus> {
    const value = await this.request("GET", `${AUTONOMY_ROOT}/status`);
    return this.accept("GET", value, (v) => validate.status(v));
  }

  async reports(
    input: { cursor?: string; limit?: number } = {},
  ): Promise<Page<Report>> {
    if (!pageBounds(input)) fail("AUTONOMY_INVALID");
    const value = await this.request(
      "GET",
      `${AUTONOMY_ROOT}/reports${query([
        ["limit", input.limit],
        ["cursor", input.cursor],
      ])}`,
    );
    return this.accept(
      "GET",
      value,
      (v) => validate.reportPage(v) && pageCoherent(v),
    );
  }
}
