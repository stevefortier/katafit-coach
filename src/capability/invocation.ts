import { createHash, randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { assertNoSecrets } from "../config/store.js";
import { classifyAutonomyRequest } from "../katafit/autonomyNamespace.js";
import {
  canonicalRecipient,
  classifyMemberMessageRequest,
  memberSendPath,
} from "../katafit/memberMessages.js";
import {
  restRequest,
  restRequestArgs,
  restRequestTool,
} from "../katafit/restGet.js";
import { classifyMemoryWrite } from "../memory/native.js";

/**
 * Shared invocation capability (Steve's full-capability addendum). Every
 * in-process Pi invocation (typed tasks, worker chat requests) gets the same
 * real tools: API discovery and ordinary REST under the configured credential,
 * plus supported actions behind durable no-replay fences. Availability never
 * grants authority: the backend authorizes every request, and host-only,
 * secret-producing and memory-write routes never reach the network.
 */
export const CAPABILITY_PROTOCOL = "coach.capability.v1";

export type CapabilityAction = "rest_mutation" | "member_message";
export interface Occurrence {
  slot: string;
  action: CapabilityAction;
  status: "pending" | "succeeded" | "failed" | "unknown";
  idempotency_key: string;
  request_sha256: string;
  opened_lease_generation: number;
  receipt: { message_id?: string } | null;
  replay_allowed: false;
  resolution:
    | "settled"
    | "execute_once"
    | "send_with_key"
    | "reconcile_by_receipt"
    | "unknown_no_replay";
}
/** Backend task-plane occurrence journal (coach.tasks.v1/occurrences). */
export interface ActionJournal {
  open(input: {
    slot: string;
    action: CapabilityAction;
    request_sha256: string;
    method?: string;
    path?: string;
    recipient_id?: string;
  }): Promise<Occurrence>;
  settle(
    slot: string,
    status: "succeeded" | "failed" | "unknown",
  ): Promise<Occurrence | undefined>;
}
/** Host-durable fence for planes without a backend journal (Actions-shaped). */
export interface ActionLedger {
  unresolved(): boolean;
  save(action: {
    session_id: string;
    idempotency_key: string;
    tool_name: string;
    status: "pending" | "unknown" | "completed";
  }): void;
}
export interface InvocationOptions {
  plane: "task" | "request";
  origin: string;
  token: string;
  secrets: string[];
  vision: boolean;
  /** Lease/cancellation fence checked before every mutation. */
  current: () => boolean;
  /** Supported action types under the current admission. */
  actions: CapabilityAction[];
  journal?: ActionJournal;
  occurrences?: Occurrence[];
  ledger?: ActionLedger;
  ledgerSession?: string;
  /** The only recipient a member message may reach (the requester). */
  recipient?: string;
}

const OCCURRENCE_KEYS = [
  "slot",
  "action",
  "status",
  "idempotency_key",
  "request_sha256",
  "opened_lease_generation",
  "receipt",
  "replay_allowed",
  "resolution",
];
export function validOccurrence(value: any): value is Occurrence {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((k) => OCCURRENCE_KEYS.includes(k)) &&
    typeof value.slot === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(value.slot) &&
    ["rest_mutation", "member_message"].includes(value.action) &&
    ["pending", "succeeded", "failed", "unknown"].includes(value.status) &&
    typeof value.idempotency_key === "string" &&
    /^[A-Za-z0-9_:.-]{1,200}$/.test(value.idempotency_key) &&
    typeof value.request_sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.request_sha256) &&
    Number.isSafeInteger(value.opened_lease_generation) &&
    value.opened_lease_generation >= 1 &&
    value.replay_allowed === false &&
    [
      "settled",
      "execute_once",
      "send_with_key",
      "reconcile_by_receipt",
      "unknown_no_replay",
    ].includes(value.resolution) &&
    (value.receipt === null ||
      value.receipt === undefined ||
      (typeof value.receipt === "object" && !Array.isArray(value.receipt)))
  );
}

/**
 * Secret-producing or interactive-only account endpoints. Undecodable paths
 * fail closed. Reads are blocked too: they can disclose credentials.
 */
export function classifySecretRequest(_method: string, path: string) {
  const segments = path
    .split("?", 1)[0]
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment).toLowerCase();
      } catch {
        return undefined;
      }
    });
  if (segments.includes(undefined)) return true;
  const s = segments.filter((segment) => segment !== "") as string[];
  if (s[0] !== "api") return false;
  return (
    (s[1] === "coach" && s[2] === "rest-credentials") ||
    s[1] === "mcp" ||
    s[1] === "auth" ||
    ["login", "register", "logout", "invite", "email-verification"].includes(
      s[1],
    )
  );
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
};
// The wrapper's key order is fixed by each call site; only nested payloads
// are canonicalized so equal requests always produce equal digests.
const digest = (value: Record<string, unknown>) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, canonical(v)]),
        ),
      ),
    )
    .digest("hex");
const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: {},
});
const refusal = (error: string, note: string) => text({ error, note });
const settled = (o: Occurrence) =>
  o.status === "succeeded" || o.status === "failed";

export const CAPABILITY_GUIDANCE =
  "\nInvocation capability: the seed evidence is a partial, untrusted starting point, not the limit of what you may know. Use katafit_rest_request during generation: first GET /api/docs/coach, then GET the documented domain paths that this answer needs (for example nutrition targets, meals, plans, activities). Search Coach memory with coach_memory_search when offered (or GET /api/coach/memory?query=...). Acquired results stay usable for the whole invocation; do not refetch them. If a read is denied, missing or times out, say so plainly and do not invent the value; never claim calorie, protein or target adequacy without fetched targets. Only perform a write when it is a supported action; never replay an uncertain write, and claim only actions whose result confirmed them. Your final answer is still the required result.\n";

/** Appended when REST authenticates as someone other than the requester. */
export const PRINCIPAL_REST_NOTE =
  "REST calls authenticate as the principal account (the Dojo chief), not the requester. Account-scoped endpoints such as /api/user/targets describe the principal account; read requester facts only through documented Dojo/member surfaces and never attribute principal-account data to the requester. Principal-private memory is planning context and must never be copied into requester-visible text.\n";

export class InvocationCapability {
  private readonly known: Occurrence[];
  constructor(private readonly o: InvocationOptions) {
    this.known = [...(o.occurrences ?? [])];
  }
  private get values() {
    return [this.o.token, ...this.o.secrets].filter(Boolean);
  }
  tools(): AgentTool[] {
    return [
      {
        ...restRequestTool,
        label: "Kata.fit REST",
        parameters: restRequestTool.parameters as any,
        prepareArguments: (args: any) => args,
        execute: async (_id: string, args: any, signal?: AbortSignal) =>
          this.execute(args, signal),
      } as AgentTool,
    ];
  }
  private async execute(raw: any, signal?: AbortSignal) {
    let args: ReturnType<typeof restRequestArgs>;
    try {
      args = restRequestArgs(raw);
      assertNoSecrets(raw, this.values);
    } catch {
      return refusal(
        "ARGUMENTS_REJECTED",
        "Use {method, path, body?} with a relative /api/ path and no credentials.",
      );
    }
    if (classifySecretRequest(args.method, args.path))
      return refusal(
        "SECRET_ENDPOINT_DENIED",
        "Credential and account-security endpoints are interactive-only and never available to Coach invocations.",
      );
    if (
      classifyAutonomyRequest(args.method, args.path).kind === "reject" ||
      (args.method !== "GET" &&
        classifyMemoryWrite(args.method, args.path, raw.body) !== undefined)
    )
      return refusal(
        "HOST_ONLY_ROUTE",
        "This route is host-only (continuous Coach control plane or memory writes). Do not retry.",
      );
    const target = classifyMemberMessageRequest(args.method, args.path);
    if (target.kind === "reject")
      return refusal("ARGUMENTS_REJECTED", "Malformed member-message path.");
    if (target.kind === "send")
      return this.message(target.recipient, raw, signal);
    if (args.method === "GET") return this.read(raw, signal);
    return this.mutate(raw, args, signal);
  }
  private async read(raw: any, signal?: AbortSignal) {
    try {
      const result: any = await restRequest(
        this.o.origin,
        this.o.token,
        raw,
        signal ?? new AbortController().signal,
        this.values,
      );
      if (result.restReadError) {
        const status = result.restReadError.status;
        return text({
          error:
            status === 401 || status === 403
              ? "REST_READ_DENIED"
              : status === 404
                ? "REST_READ_MISSING"
                : "REST_READ_UNAVAILABLE",
          status,
          note: "This fact is unavailable to this invocation. State that plainly; do not invent it.",
        });
      }
      const image = result.content?.find((p: any) => p.type === "image");
      if (image && !this.o.vision)
        return text({
          error: "IMAGE_UNSUPPORTED",
          note: "The configured provider cannot view images; do not describe it.",
        });
      return { content: result.content, details: {} };
    } catch (error) {
      const code = (error as Error).message;
      if (code === "CANCELLED") throw error;
      return text({
        error: /^[A-Z_]{3,64}$/.test(code) ? code : "REST_READ_UNAVAILABLE",
        note: "This read did not complete. Report the fact as unavailable; do not invent it.",
      });
    }
  }
  private unsupported() {
    return refusal(
      "ACTION_UNSUPPORTED",
      "This action is not supported for this invocation under the current admission. Do not retry or claim it.",
    );
  }
  private uncertain(): never {
    throw new Error("DELIVERY_UNVERIFIED");
  }
  /** Prior identical action: report its outcome, never perform it again. */
  private async prior(match: Occurrence, signal?: AbortSignal) {
    if (match.action === "member_message" && !settled(match)) {
      const recovered = await this.reconcileMessage(match, signal);
      if (!recovered) this.uncertain();
      match = recovered;
    }
    if (!settled(match)) this.uncertain();
    return text({
      status: "ALREADY_PERFORMED",
      outcome:
        match.action === "member_message" && match.status === "succeeded"
          ? "delivered"
          : match.status,
      ...(match.receipt?.message_id
        ? { message_id: match.receipt.message_id }
        : {}),
      note: "An earlier attempt of this invocation already performed this exact action. It was not repeated.",
    });
  }
  private async reconcileMessage(o: Occurrence, signal?: AbortSignal) {
    const recipient = this.o.recipient!;
    try {
      const result: any = await restRequest(
        this.o.origin,
        this.o.token,
        {
          method: "GET",
          path: `${memberSendPath(recipient)}/receipts/${encodeURIComponent(o.idempotency_key)}`,
        },
        signal ?? new AbortController().signal,
        this.values,
      );
      const value = result.content
        ? JSON.parse(result.content[0].text)
        : undefined;
      if (
        value?.status !== "delivered" ||
        value.idempotency_key !== o.idempotency_key ||
        value.recipient_id !== recipient
      )
        return undefined;
      return this.record(
        await this.o.journal!.settle(o.slot, "succeeded"),
        o,
        "succeeded",
      );
    } catch {
      return undefined;
    }
  }
  private record(
    next: Occurrence | undefined,
    fallback: Occurrence,
    status: Occurrence["status"],
  ): Occurrence {
    const value =
      next && validOccurrence(next)
        ? next
        : ({
            ...fallback,
            status,
            resolution: status === "unknown" ? "unknown_no_replay" : "settled",
          } as Occurrence);
    const index = this.known.findIndex((k) => k.slot === value.slot);
    if (index >= 0) this.known[index] = value;
    else this.known.push(value);
    return value;
  }
  private async open(
    action: CapabilityAction,
    request: Parameters<ActionJournal["open"]>[0],
  ): Promise<Occurrence | ReturnType<typeof refusal>> {
    try {
      const occurrence = await this.o.journal!.open(request);
      if (!validOccurrence(occurrence) || occurrence.slot !== request.slot)
        this.uncertain();
      this.record(occurrence, occurrence, occurrence.status);
      return occurrence;
    } catch (error) {
      const code =
        (error as Error & { code?: string }).code ?? (error as Error).message;
      if (code === "LEASE_LOST" || code === "TASK_UNAVAILABLE")
        return refusal(
          "LEASE_LOST",
          "This invocation no longer holds its lease; no action was performed.",
        );
      if (code === "ACTION_UNSUPPORTED") return this.unsupported();
      // The occurrence may exist; nothing was sent. A later identical attempt
      // reopens it idempotently.
      return refusal(
        "ACTION_NOT_STARTED",
        "The action was not started. Nothing was sent.",
      );
    }
  }
  private async message(recipient: string, raw: any, signal?: AbortSignal) {
    const body = raw.body;
    if (
      !this.o.actions.includes("member_message") ||
      !this.o.journal ||
      !this.o.recipient ||
      canonicalRecipient(recipient) !== this.o.recipient
    )
      return this.unsupported();
    if (
      !body ||
      typeof body !== "object" ||
      Object.keys(body).join() !== "text" ||
      typeof body.text !== "string" ||
      !body.text.trim() ||
      body.text.length > 8000
    )
      return refusal(
        "ARGUMENTS_REJECTED",
        "Send exactly {text}; the host supplies the delivery key.",
      );
    const request_sha256 = digest({
      recipient_id: this.o.recipient,
      text: body.text,
    });
    const match = this.known.find(
      (o) =>
        o.action === "member_message" && o.request_sha256 === request_sha256,
    );
    if (match) return this.prior(match, signal);
    if (this.known.some((o) => !settled(o))) this.uncertain();
    if (this.known.some((o) => o.action === "member_message"))
      return refusal(
        "MESSAGE_ALREADY_SENT",
        "This invocation already sent its one requester message. It was not repeated.",
      );
    if (!this.o.current())
      return refusal(
        "LEASE_LOST",
        "This invocation no longer holds its lease; nothing was sent.",
      );
    const opened = await this.open("member_message", {
      slot: "m1",
      action: "member_message",
      request_sha256,
      recipient_id: this.o.recipient,
    });
    if (!("slot" in opened)) return opened;
    if (opened.resolution !== "send_with_key")
      return this.prior(opened, signal);
    if (!this.o.current())
      return refusal(
        "LEASE_LOST",
        "This invocation no longer holds its lease; nothing was sent.",
      );
    let value: any;
    try {
      const result: any = await restRequest(
        this.o.origin,
        this.o.token,
        {
          method: "POST",
          path: memberSendPath(this.o.recipient),
          body: { text: body.text, idempotency_key: opened.idempotency_key },
        },
        signal ?? new AbortController().signal,
        this.values,
      );
      value = JSON.parse(result.content[0].text);
      if (
        value?.status !== "delivered" ||
        value.idempotency_key !== opened.idempotency_key ||
        value.recipient_id !== this.o.recipient
      )
        throw new Error("DELIVERY_UNVERIFIED");
    } catch {
      this.record(
        await this.o
          .journal!.settle(opened.slot, "unknown")
          .catch(() => undefined),
        opened,
        "unknown",
      );
      this.uncertain();
    }
    const done = this.record(
      await this.o
        .journal!.settle(opened.slot, "succeeded")
        .catch(() => undefined),
      opened,
      "succeeded",
    );
    return text({
      status: "delivered",
      recipient_id: this.o.recipient,
      message_id: value.message_id,
      settled: done.status === "succeeded",
      note: "Appended to the requester's canonical Coach chat. This does not confirm they saw it.",
    });
  }
  private async mutate(
    raw: any,
    args: ReturnType<typeof restRequestArgs>,
    signal?: AbortSignal,
  ) {
    if (!this.o.actions.includes("rest_mutation")) return this.unsupported();
    const body = Object.hasOwn(raw, "body") ? raw.body : undefined;
    if (this.o.journal) {
      const request_sha256 = digest({
        method: args.method,
        path: args.path,
        body,
      });
      const match = this.known.find(
        (o) =>
          o.action === "rest_mutation" && o.request_sha256 === request_sha256,
      );
      if (match) return this.prior(match, signal);
      if (this.known.some((o) => !settled(o))) this.uncertain();
      if (!this.o.current())
        return refusal(
          "LEASE_LOST",
          "This invocation no longer holds its lease; no action was performed.",
        );
      const ordinal =
        this.known.filter((o) => o.action === "rest_mutation").length + 1;
      const opened = await this.open("rest_mutation", {
        slot: `r${ordinal}`,
        action: "rest_mutation",
        request_sha256,
        method: args.method,
        path: args.path,
      });
      if (!("slot" in opened)) return opened;
      if (opened.resolution !== "execute_once")
        return this.prior(opened, signal);
      if (!this.o.current())
        return refusal(
          "LEASE_LOST",
          "This invocation no longer holds its lease; no action was performed.",
        );
      let result: any;
      try {
        result = await restRequest(
          this.o.origin,
          this.o.token,
          raw,
          signal ?? new AbortController().signal,
          this.values,
        );
      } catch {
        this.record(
          await this.o.journal
            .settle(opened.slot, "unknown")
            .catch(() => undefined),
          opened,
          "unknown",
        );
        this.uncertain();
      }
      this.record(
        await this.o.journal
          .settle(opened.slot, "succeeded")
          .catch(() => undefined),
        opened,
        "succeeded",
      );
      return { content: result.content, details: {} };
    }
    if (!this.o.ledger || !this.o.ledgerSession) return this.unsupported();
    if (this.o.ledger.unresolved()) this.uncertain();
    if (!this.o.current())
      return refusal(
        "LEASE_LOST",
        "This invocation no longer holds its lease; no action was performed.",
      );
    const pending = {
      session_id: this.o.ledgerSession,
      idempotency_key: randomUUID(),
      tool_name: restRequestTool.name,
      status: "pending" as const,
    };
    this.o.ledger.save(pending);
    let result: any;
    try {
      result = await restRequest(
        this.o.origin,
        this.o.token,
        raw,
        signal ?? new AbortController().signal,
        this.values,
      );
    } catch {
      this.o.ledger.save({ ...pending, status: "unknown" });
      this.uncertain();
    }
    this.o.ledger.save({ ...pending, status: "completed" });
    return { content: result.content, details: {} };
  }
}
