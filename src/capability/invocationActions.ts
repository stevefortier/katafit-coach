import { isDeepStrictEqual } from "node:util";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import contract from "./invocation-action-contract.json" with { type: "json" };
import { immutableWorkRequest } from "./workActions.js";
import type { ActionLedger } from "./invocation.js";
import { restRequest } from "../katafit/restGet.js";
export const INVOCATION_ACTION_PROTOCOL = "coach.invocation-actions.v1";
const ajv = new Ajv2020({ strict: false });
const valid = ajv.compile(contract.schemas.occurrence);
const bindingValid = ajv.compile(contract.schemas.dispatch_header_json);
export const validInvocationBinding = (value: unknown) => bindingValid(value);
export function invocationActionDescriptor(value: any) {
  return value &&
    typeof value.available === "boolean" &&
    isDeepStrictEqual({ ...value, available: true }, contract.descriptor)
    ? (structuredClone(value) as typeof contract.descriptor)
    : null;
}
export interface InvocationBinding {
  plane: "request" | "task";
  invocation_id: string;
  lease_generation: number;
  delegation_revision: number;
  legacy_action_state: "drained" | "held";
}
export function invocationAdmission(
  cap: any,
  expected: {
    plane: string;
    id?: string;
    lease_generation?: number;
    requester_id: string;
  },
) {
  if (!cap?.actions?.ordinary_rest && !cap?.invocation_binding)
    return undefined;
  const ordinary = invocationActionDescriptor(cap.actions?.ordinary_rest),
    b = cap.invocation_binding;
  if (
    !Array.isArray(cap.actions?.supported) ||
    !ordinary ||
    !b ||
    !isDeepStrictEqual(
      Object.keys(b).sort(),
      [
        "plane",
        "invocation_id",
        "lease_generation",
        "delegation_revision",
        "legacy_action_state",
      ].sort(),
    ) ||
    !validInvocationBinding({
      plane: b.plane,
      invocation_id: b.invocation_id,
      slot: "validation",
      lease_generation: b.lease_generation,
      delegation_revision: b.delegation_revision,
      request_sha256: "0".repeat(64),
    }) ||
    b.plane !== expected.plane ||
    (expected.id !== undefined && b.invocation_id !== expected.id) ||
    (expected.lease_generation !== undefined &&
      b.lease_generation !== expected.lease_generation) ||
    !["drained", "held"].includes(b.legacy_action_state) ||
    !/^[a-f0-9]{24}$/.test(cap.rest?.principal_user_id) ||
    cap.rest?.subject_user_id !== expected.requester_id ||
    cap.rest.subject_is_principal !==
      (cap.rest.principal_user_id === expected.requester_id) ||
    (cap.actions.supported.includes("proposal_approval") &&
      !cap.actions.supported.includes("rest_mutation")) ||
    (b.legacy_action_state === "held" &&
      cap.actions.supported.some((x: string) =>
        ["rest_mutation", "proposal_approval"].includes(x),
      ))
  )
    throw new Error("CONTEXT_REJECTED");
  return {
    descriptor: ordinary,
    binding: b as InvocationBinding,
    principal: cap.rest.principal_user_id as string,
    subject: expected.requester_id,
    proposalApproval: cap.actions.supported.includes("proposal_approval"),
  };
}
export function invocationOccurrenceEnvelope(
  value: any,
  expected: { plane: string; invocation_id: string; slot: string },
  idempotent = false,
) {
  const o = value?.occurrence;
  if (
    !value ||
    Object.keys(value).some(
      (k) =>
        ![
          "protocol",
          "occurrence",
          ...(idempotent ? ["idempotent"] : []),
        ].includes(k),
    ) ||
    value.protocol !== INVOCATION_ACTION_PROTOCOL ||
    !valid(o) ||
    o.plane !== expected.plane ||
    o.invocation_id !== expected.invocation_id ||
    o.slot !== expected.slot ||
    (idempotent && typeof value.idempotent !== "boolean")
  )
    throw new Error("INVOCATION_ACTION_UNRESOLVED");
  return value;
}
const output = (value: any) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: {},
});
const refusal = (error: string) =>
  output({
    error,
    protocol: INVOCATION_ACTION_PROTOCOL,
    effect_receipt: false,
    replay_allowed: false,
  });
export class InvocationActions {
  private uncertain = false;
  constructor(
    private o: {
      origin: string;
      token: string;
      secrets: string[];
      directory: string;
      admission: NonNullable<ReturnType<typeof invocationAdmission>>;
      ledger: ActionLedger;
      current: () => boolean;
      held?: () => boolean;
      onUnknown?: () => void;
    },
  ) {}
  private async call(slot: string, method: string, body?: unknown) {
    const b = this.o.admission.binding;
    const url =
      this.o.origin +
      `/api/coach/invocations/${b.plane}/${b.invocation_id}/occurrences/${slot}` +
      (method === "POST" ? "/settle" : "");
    const response = await fetch(url, {
      method,
      headers: {
        authorization: "Bearer " + this.o.token,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    try {
      if (!response.ok || !response.body)
        throw new Error("INVOCATION_ACTION_UNRESOLVED");
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 65536) throw new Error("INVOCATION_ACTION_UNRESOLVED");
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const bytes = Buffer.concat(chunks);
      const value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      return invocationOccurrenceEnvelope(
        value,
        { ...b, slot },
        method !== "GET",
      );
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  }
  private async persist(key: string, digest: string, response: unknown) {
    const dir = join(this.o.directory, "invocation-responses");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, key + ".json"),
      temp = target + "." + randomUUID();
    try {
      const f = await open(temp, "wx", 0o600);
      try {
        await f.writeFile(
          JSON.stringify({
            protocol: INVOCATION_ACTION_PROTOCOL,
            request_sha256: digest,
            response,
            effect_receipt: false,
            replay_allowed: false,
          }),
        );
        await f.sync();
      } finally {
        await f.close();
      }
      await rename(temp, target);
      const d = await open(dir, "r");
      try {
        await d.sync();
      } finally {
        await d.close();
      }
    } finally {
      await rm(temp, { force: true });
    }
  }
  async execute(raw: any, signal?: AbortSignal) {
    const a = this.o.admission,
      b = a.binding;
    const approval = /^\/api\/strategy\/proposals\/[a-f0-9]{24}\/approve$/.test(
      raw.path,
    );
    if (!a.descriptor.available || b.legacy_action_state !== "drained")
      return refusal("INVOCATION_ACTION_NOT_DELEGATED");
    // Approval permission is separately supplied by the validated capability.
    if (approval && !a.proposalApproval)
      return refusal("INVOCATION_ACTION_NOT_DELEGATED");
    if (
      !a.descriptor.supported_operations.some(
        (op) =>
          op.method === raw.method &&
          (op.path === raw.path ||
            (op.path === "/api/plans/:id" &&
              /^\/api\/plans\/[a-f0-9]{24}$/.test(raw.path)) ||
            (op.path === "/api/strategy/:id/review" &&
              /^\/api\/strategy\/[a-f0-9]{24}\/review$/.test(raw.path)) ||
            (op.path === "/api/strategy/proposals/:proposalId/approve" &&
              approval)),
      )
    )
      return refusal("INVOCATION_ACTION_UNSUPPORTED");
    const { request, request_sha256 } = immutableWorkRequest(raw),
      slot = "r" + request_sha256.slice(0, 63),
      key = `invocation_${b.plane}_${b.invocation_id}_${slot}`;
    const row = {
      session_id: `invocation:${b.plane}:${b.invocation_id}`,
      idempotency_key: key,
      tool_name: "katafit_rest_request",
      status: "pending" as "pending" | "unknown" | "completed",
    };
    const matches = (v: any) =>
      v.request_sha256 === request_sha256 &&
      v.method === request.method &&
      v.path === request.path &&
      v.principal_user_id === a.principal &&
      v.subject_user_id === a.subject &&
      v.delegation_revision === b.delegation_revision;
    const unknown = () => {
      this.uncertain = true;
      this.o.onUnknown?.();
      this.o.ledger.save({ ...row, status: "unknown" });
    };
    const recovered = async () => {
      const value = await this.call(slot, "GET");
      const o = value.occurrence;
      if (!matches(o)) throw new Error("INVOCATION_ACTION_UNRESOLVED");
      const terminal =
        (o.status === "response_received" && o.resolution === "settled") ||
        (o.status === "not_dispatched" && o.resolution === "not_dispatched") ||
        (o.status === "not_applied" && o.resolution === "not_applied");
      if (terminal) this.o.ledger.save({ ...row, status: "completed" });
      else unknown();
      return output({
        observation: o,
        recovered: true,
        ...(!terminal ? { error: "INVOCATION_ACTION_UNRESOLVED" } : {}),
        note: o.accepted_receipt
          ? `Review accepted_pending only. GET /api/strategy/jobs/${o.accepted_receipt.job_id}; report a proposal only from canonical completed job. No POST was repeated.`
          : "Read canonical local_effect resource separately; transport is not a universal effect receipt. No POST was repeated.",
      });
    };
    if (!this.o.ledger.snapshot) return refusal("INVOCATION_ACTION_UNRESOLVED");
    const rows = this.o.ledger.snapshot();
    if (rows.some((r) => r.idempotency_key === key))
      try {
        return await recovered();
      } catch {
        unknown();
        return refusal("INVOCATION_ACTION_UNRESOLVED");
      }
    if (this.uncertain || this.o.held?.() || this.o.ledger.unresolved())
      return refusal("INVOCATION_ACTION_UNRESOLVED");
    if (
      rows.filter((r) => r.session_id === row.session_id).length >=
      a.descriptor.limits.occurrences_per_work
    )
      return refusal("INVOCATION_ACTION_LIMITED");
    if (!this.o.current() || signal?.aborted)
      return refusal("INVOCATION_ACTION_LEASE_LOST");
    this.o.ledger.save(row);
    const fence = {
      lease_generation: b.lease_generation,
      delegation_revision: b.delegation_revision,
    };
    let observed: any;
    try {
      const opened = await this.call(slot, "PUT", {
          ...fence,
          action: "rest_mutation",
          method: request.method,
          path: request.path,
          request_sha256,
        }),
        o = opened.occurrence;
      if (
        !matches(o) ||
        opened.idempotent !== false ||
        o.status !== "pending" ||
        o.resolution !== "execute_once" ||
        o.dispatch_lease_generation !== null ||
        o.opened_lease_generation !== b.lease_generation
      )
        throw new Error("INVOCATION_ACTION_UNRESOLVED");
      if (
        this.o.ledger.unresolved(key) ||
        this.o.held?.() ||
        !this.o.current() ||
        signal?.aborted
      )
        throw new Error("INVOCATION_ACTION_UNRESOLVED");
      const { legacy_action_state, ...identity } = b;
      const result: any = await restRequest(
        this.o.origin,
        this.o.token,
        request,
        signal ?? new AbortController().signal,
        this.o.secrets,
        undefined,
        { ...identity, slot, request_sha256 },
      );
      observed = JSON.parse(result.content[0].text);
      await this.persist(key, request_sha256, observed);
      const settled = await this.call(slot, "POST", {
        ...fence,
        request_sha256,
        status: "response_received",
      });
      if (
        !matches(settled.occurrence) ||
        settled.occurrence.status !== "response_received" ||
        settled.occurrence.resolution !== "settled" ||
        settled.occurrence.dispatch_lease_generation !== b.lease_generation
      )
        throw new Error("INVOCATION_ACTION_UNRESOLVED");
      this.o.ledger.save({ ...row, status: "completed" });
      return output({
        response: observed,
        observation: settled.occurrence,
        ...(settled.occurrence.accepted_receipt
          ? {
              review_status: "accepted_pending",
              note: "One job accepted, not a completed proposal. Read exact job with GET; never reenqueue.",
            }
          : {}),
      });
    } catch {
      unknown();
      await this.call(slot, "POST", {
        ...fence,
        request_sha256,
        status: "unknown",
      }).catch(() => undefined);
      // Authoritative terminal/local-effect evidence is read-only; never infer clearance from HTTP alone.
      try {
        return await recovered();
      } catch {
        return output({
          error: "INVOCATION_ACTION_UNRESOLVED",
          effect_receipt: false,
          replay_allowed: false,
          ...(observed === undefined ? {} : { response: observed }),
        });
      }
    }
  }
}
