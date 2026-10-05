import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import contract from "./work-action-contract.json" with { type: "json" };
import successor from "./invocation-action-contract.json" with { type: "json" };
import { Actions } from "../chat/actions.js";
import type { WorkItem } from "../autonomy/types.js";
import { AutonomyBackend, AutonomyFailure } from "../autonomy/backend.js";
import { restRequest } from "../katafit/restGet.js";

export const WORK_ACTION_PROTOCOL = "coach.work-actions.v1";
const ajv = new Ajv2020({ strict: false });
const legacyOccurrence = ajv.compile(contract.schemas.occurrence);
const successorOccurrence = ajv.compile(successor.schemas.work_occurrence);
const validOccurrence = (value: any) =>
  legacyOccurrence(value) || successorOccurrence(value);
const inputs = {
  open: ajv.compile(contract.schemas.open),
  settle: ajv.compile(contract.schemas.settle),
};
export const validWorkInput = (kind: keyof typeof inputs, value: unknown) =>
  inputs[kind](value);
export function workActionDescriptor(value: any) {
  if (
    !value ||
    typeof value.available !== "boolean" ||
    ![contract.descriptor, successor.work_descriptor].some((d) =>
      isDeepStrictEqual({ ...value, available: true }, d),
    )
  )
    return null;
  return structuredClone(value) as typeof contract.descriptor;
}
/** RFC8785: ECMAScript finite number formatting, UTF16 key order, valid Unicode. */
export function canonicalWorkJson(value: unknown): string {
  const text = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const n = s.charCodeAt(++i);
        if (!(n >= 0xdc00 && n <= 0xdfff))
          throw new Error("WORK_ACTION_INVALID");
      } else if (c >= 0xdc00 && c <= 0xdfff)
        throw new Error("WORK_ACTION_INVALID");
    }
    return JSON.stringify(s);
  };
  if (value === null) return "null";
  if (typeof value === "string") return text(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map(canonicalWorkJson).join(",") + "]";
  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => text(k) + ":" + canonicalWorkJson((value as any)[k]))
        .join(",") +
      "}"
    );
  throw new Error("WORK_ACTION_INVALID");
}
export function immutableWorkRequest(raw: any) {
  const json = canonicalWorkJson({
    method: raw.method,
    path: raw.path,
    body: Object.hasOwn(raw, "body") ? raw.body : {},
  });
  if (Buffer.byteLength(json) > contract.descriptor.limits.request_bytes)
    throw new Error("WORK_ACTION_INVALID");
  return {
    request: JSON.parse(json),
    request_sha256: createHash("sha256").update(json).digest("hex"),
  };
}
const output = (value: any) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: {},
});
const refusal = (error: string) =>
  output({
    error,
    protocol: WORK_ACTION_PROTOCOL,
    effect_receipt: false,
    replay_allowed: false,
  });
export class WorkActions {
  private uncertain = false;
  constructor(
    private o: {
      backend: AutonomyBackend;
      origin: string;
      token: string;
      secrets: string[];
      directory: string;
      work: WorkItem;
      actions: Actions;
      descriptor: typeof contract.descriptor;
      dispatch: boolean;
      proposalApproval: boolean;
      current: () => boolean;
      held: () => boolean;
      onUnknown: () => void;
      onObserved: (slot: string) => void;
    },
  ) {}
  private hold(except?: string) {
    return this.uncertain || this.o.held() || this.o.actions.unresolved(except);
  }
  /** Received bytes survive an ambiguous seal; they never become effect authority. */
  private async persistResponse(
    key: string,
    request_sha256: string,
    response: unknown,
  ) {
    const directory = join(this.o.directory, "work-responses");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, key + ".json");
    const temp = target + "." + randomUUID();
    try {
      const file = await open(temp, "wx", 0o600);
      try {
        await file.writeFile(
          JSON.stringify({
            protocol: WORK_ACTION_PROTOCOL,
            work_id: this.o.work.id,
            request_sha256,
            response,
            observation: "response_received",
            effect_receipt: false,
            settlement: "unconfirmed",
            replay_allowed: false,
          }),
        );
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, target);
      const dir = await open(directory, "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } finally {
      await rm(temp, { force: true });
    }
  }
  async execute(raw: any, signal?: AbortSignal) {
    if (!this.o.dispatch || !this.o.descriptor.available)
      return refusal("WORK_ACTION_NOT_DELEGATED");
    const proposal = /^\/api\/strategy\/proposals\/[a-f0-9]{24}\/approve$/.test(
      raw.path,
    );
    if (proposal && !this.o.proposalApproval)
      return refusal("WORK_ACTION_NOT_DELEGATED");
    if (
      !this.o.descriptor.supported_operations.some(
        (op) =>
          op.method === raw.method &&
          (op.path === raw.path ||
            (op.path === "/api/plans/:id" &&
              /^\/api\/plans\/[a-f0-9]{24}$/.test(raw.path)) ||
            (op.path === "/api/strategy/proposals/:proposalId/approve" &&
              proposal) ||
            (op.path === "/api/strategy/:id/review" &&
              /^\/api\/strategy\/[a-f0-9]{24}\/review$/.test(raw.path))),
      )
    )
      return refusal("WORK_ACTION_UNSUPPORTED");
    const { request, request_sha256 } = immutableWorkRequest(raw);
    const work = this.o.work,
      slot = "r" + request_sha256.slice(0, 63),
      key = `work_${work.id}_${slot}`;
    const record = {
      session_id: "autonomy:" + work.id,
      idempotency_key: key,
      tool_name: "katafit_rest_request",
      action_id: slot,
    };
    const prior = this.o.actions
      .snapshot()
      .find((a) => a.idempotency_key === key);
    if (prior) {
      // This metadata read never renews or consumes an outstanding backend grant.
      const value = await this.o.backend
        .readWorkOccurrence(work.id, slot)
        .catch(() => undefined);
      const observation = value?.occurrence;
      if (
        ((observation?.status === "response_received" &&
          observation.resolution === "settled") ||
          (["not_dispatched", "not_applied"].includes(observation?.status) &&
            observation.resolution === observation.status)) &&
        observation.request_sha256 === request_sha256 &&
        observation.method === request.method &&
        observation.path === request.path
      ) {
        this.o.actions.save({ ...record, status: "completed" });
        return output({
          observation,
          recovered: true,
          note: "Prior transport observation; no request was repeated. Read canonical state separately.",
        });
      }
      this.uncertain = true;
      this.o.onUnknown();
      this.o.actions.save({ ...record, status: "unknown" });
      return refusal("WORK_ACTION_UNRESOLVED");
    }
    if (this.hold()) return refusal("WORK_ACTION_UNRESOLVED");
    if (!this.o.current() || signal?.aborted)
      return refusal("WORK_ACTION_LEASE_LOST");
    this.o.actions.save({ ...record, status: "pending" });
    const fence = {
      lease_generation: work.lease_generation,
      mandate_revision: work.mandate_revision,
    };
    let observed: any;
    const unknown = () => {
      this.uncertain = true;
      this.o.onUnknown();
      this.o.actions.save({ ...record, status: "unknown" });
    };
    try {
      const opened = await this.o.backend.openWorkOccurrence(work.id, slot, {
        ...fence,
        action: "rest_mutation",
        method: request.method,
        path: request.path,
        request_sha256,
      });
      const matches = (v: any) =>
        validOccurrence(v) &&
        v.work_id === work.id &&
        v.slot === slot &&
        v.method === request.method &&
        v.path === request.path &&
        v.request_sha256 === request_sha256;
      if (
        !matches(opened.occurrence) ||
        opened.idempotent !== false ||
        opened.occurrence.status !== "pending" ||
        opened.occurrence.resolution !== "execute_once" ||
        opened.occurrence.dispatch_lease_generation !== null ||
        opened.occurrence.opened_lease_generation !== work.lease_generation
      )
        throw new Error("WORK_ACTION_UNRESOLVED");
      // The only first-attempt grant is consumed by this caller; never reacquired.
      if (this.hold(key)) throw new Error("WORK_ACTION_UNRESOLVED");
      if (!this.o.current() || signal?.aborted)
        throw new Error("WORK_ACTION_LEASE_LOST");
      const binding = { ...fence, work_id: work.id, slot, request_sha256 };
      const result: any = await restRequest(
        this.o.origin,
        this.o.token,
        request,
        signal || new AbortController().signal,
        this.o.secrets,
        binding,
      );
      observed = JSON.parse(result.content[0].text);
      await this.persistResponse(key, request_sha256, observed);
      const settled = await this.o.backend.settleWorkOccurrence(work.id, slot, {
        ...fence,
        request_sha256,
        status: "response_received",
      });
      if (
        !matches(settled.occurrence) ||
        settled.occurrence.status !== "response_received" ||
        settled.occurrence.resolution !== "settled" ||
        settled.occurrence.dispatch_lease_generation !== work.lease_generation
      )
        throw new Error("WORK_ACTION_UNRESOLVED");
      this.o.actions.save({ ...record, status: "completed" });
      this.o.onObserved(slot);
      return output({ response: observed, observation: settled.occurrence });
    } catch (error) {
      // Observe ambiguity BEFORE the first persistence/network await. No replay.
      unknown();
      await this.o.backend
        .settleWorkOccurrence(work.id, slot, {
          ...fence,
          request_sha256,
          status: "unknown",
        })
        .catch(() => undefined);
      // Retirement can conflict with a terminal settle. Exact read-only service
      // evidence is the only clearance; never repeat the dispatch or infer from HTTP.
      const retired = await this.o.backend
        .readWorkOccurrence(work.id, slot)
        .catch(() => undefined);
      if (
        retired?.occurrence?.request_sha256 === request_sha256 &&
        retired.occurrence.method === request.method &&
        retired.occurrence.path === request.path &&
        ((["not_dispatched", "not_applied"].includes(
          retired.occurrence.status,
        ) &&
          retired.occurrence.resolution === retired.occurrence.status) ||
          (retired.occurrence.status === "response_received" &&
            retired.occurrence.resolution === "settled"))
      ) {
        this.uncertain = false;
        this.o.actions.save({ ...record, status: "completed" });
        return output({
          observation: retired.occurrence,
          recovered: true,
          replay_allowed: false,
          effect_receipt: false,
        });
      }
      return output({
        error: "WORK_ACTION_UNRESOLVED",
        protocol: WORK_ACTION_PROTOCOL,
        effect_receipt: false,
        replay_allowed: false,
        ...(observed !== undefined
          ? {
              response: observed,
              observation: {
                status: "response_received",
                effect_receipt: false,
                settlement: "unknown",
              },
            }
          : {}),
      });
    }
  }
}
export function workOccurrenceEnvelope(
  value: any,
  expected: { work_id: string; slot: string },
  idempotent = false,
) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (k) =>
        ![
          "protocol",
          "occurrence",
          ...(idempotent ? ["idempotent"] : []),
        ].includes(k),
    ) ||
    value?.protocol !== WORK_ACTION_PROTOCOL ||
    !validOccurrence(value?.occurrence) ||
    value.occurrence.work_id !== expected.work_id ||
    value.occurrence.slot !== expected.slot ||
    (idempotent && typeof value.idempotent !== "boolean")
  )
    throw new AutonomyFailure("AUTONOMY_OUTCOME_UNKNOWN");
  return value;
}
