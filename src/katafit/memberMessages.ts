import { createHash } from "node:crypto";
import { History } from "../chat/history.js";
import {
  Actions,
  OCCURRENCE_PATTERN,
  canonicalOrigin,
  legacyScope,
  validBinding,
  type MemberBinding,
  type MemberDelivery,
} from "../chat/actions.js";
import { Store, assertNoSecrets } from "../config/store.js";
import type { BackendLogger } from "./client.js";
import { restRequest } from "./restGet.js";

/**
 * Reusable owner-directed member delivery, independent of Pi, the browser and
 * worker leases. Callers supply a trusted occurrence identity; the host owns
 * the backend key, its durable fence and read-only recovery. Recipient
 * authorization stays entirely in the backend.
 */
export const MEMBER_MESSAGE_TEXT_LIMIT = 8000;
const RESULT_LIMIT = 2048;
const CONTEXT_PATH = "/api/coach/member-messages/context";
export const memberSendPath = (recipient: string) =>
  `/api/coach/member-messages/${recipient}`;
const receiptPath = (recipient: string, key: string) =>
  `${memberSendPath(recipient)}/receipts/${key}`;

export type MemberFailureCode =
  | "DELIVERY_REJECTED"
  | "DELIVERY_CANCELLED"
  | "OCCURRENCE_CONFLICT"
  | "OCCURRENCE_CONSUMED"
  | "MEMBER_DELIVERY_LEDGER_FULL"
  | "DELIVERY_UNVERIFIED"
  | "BINDING_UNAVAILABLE";
export class MemberMessageFailure extends Error {
  constructor(readonly code: MemberFailureCode) {
    super(code);
  }
}
export type MemberMessageIntent = {
  /** Trusted host occurrence, e.g. persisted event + action slot. */
  occurrenceId: string;
  recipientId: string;
  text: string;
};
export type VerifiedDelivery = {
  status: "delivered";
  recipient_id: string;
  occurrence_id: string;
  message_id: string;
};

/** Exact 24-hex ObjectId validation BEFORE canonical lowercasing. */
export function canonicalRecipient(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-fA-F]{24}$/.test(value)
    ? value.toLowerCase()
    : undefined;
}

/**
 * Classify a validated REST request by its decoded pathname, independent of
 * the query. Express routes static segments case-insensitively on the RAW
 * path, ignores one trailing slash and decodes parameters, so those aliases
 * canonicalize to one send. Every other mutation in the send namespace
 * (encoded static segments, extra/empty segments, other methods, invalid
 * IDs) is rejected before dispatch; it never falls through to a generic write.
 * Reads stay ordinary. This is a delivery adapter, not an endpoint allowlist.
 */
export function classifyMemberMessageRequest(
  method: string,
  path: string,
):
  | { kind: "send"; recipient: string }
  | { kind: "reject" }
  | { kind: "other" } {
  const segments = path.split("?", 1)[0].split("/").slice(1);
  const decoded = segments.map((segment) => {
    try {
      return decodeURIComponent(segment).toLowerCase();
    } catch {
      return undefined;
    }
  });
  if (decoded.includes(undefined))
    return method === "GET" ? { kind: "other" } : { kind: "reject" };
  const meaningful = decoded.filter((segment) => segment !== "");
  if (
    meaningful[0] !== "api" ||
    meaningful[1] !== "coach" ||
    meaningful[2] !== "member-messages"
  )
    return { kind: "other" };
  if (method === "GET") return { kind: "other" };
  const raw = segments.at(-1) === "" ? segments.slice(0, -1) : segments;
  if (
    method === "POST" &&
    raw.length === 4 &&
    raw[0].toLowerCase() === "api" &&
    raw[1].toLowerCase() === "coach" &&
    raw[2].toLowerCase() === "member-messages"
  ) {
    const recipient = canonicalRecipient(decodeURIComponent(raw[3]));
    if (recipient) return { kind: "send", recipient };
  }
  return { kind: "reject" };
}

/**
 * Protected cache of backend-attested account bindings, keyed by a digest of
 * the backend credential and origin only: model/provider secrets never define
 * delivery ownership. Content: installation ID, origin and account ID.
 */
class BindingCache {
  private storage: History;
  constructor(dir: string) {
    this.storage = new History(dir, "member-message-binding.json");
  }
  private static credential(origin: string, token: string) {
    return createHash("sha256")
      .update(JSON.stringify(["coach-member-binding-v1", origin, token]))
      .digest("hex");
  }
  private read() {
    const rows = this.storage.load();
    let installation: string | undefined;
    const bindings = new Map<string, MemberBinding>();
    for (let i = 1; i < rows.length; i += 2) {
      const value = JSON.parse(rows[i].text);
      if (rows[i - 1].text === "installation") {
        if (
          installation ||
          Object.keys(value ?? {}).join() !== "installation_id" ||
          !/^[0-9a-f]{32}$/.test(value.installation_id)
        )
          throw new Error("UNSAFE_STORAGE");
        installation = value.installation_id;
      } else if (/^[0-9a-f]{64}$/.test(rows[i - 1].text)) {
        if (
          Object.keys(value ?? {})
            .sort()
            .join() !== "account_owner_id,installation_id,origin" ||
          !validBinding(value)
        )
          throw new Error("UNSAFE_STORAGE");
        bindings.set(rows[i - 1].text, value);
      } else throw new Error("UNSAFE_STORAGE");
    }
    if ([...bindings.values()].some((b) => b.installation_id !== installation))
      throw new Error("UNSAFE_STORAGE");
    return { rows, installation, bindings };
  }
  /** The installation ID mirrored in this cache, if any (read-only). */
  installation() {
    return this.read().installation;
  }
  get(origin: string, token: string) {
    return this.read().bindings.get(BindingCache.credential(origin, token));
  }
  put(origin: string, token: string, binding: MemberBinding) {
    const key = BindingCache.credential(origin, token);
    const { rows, installation } = this.read();
    if (installation && installation !== binding.installation_id)
      throw new Error("UNSAFE_STORAGE");
    const next = rows.filter((_, i) => rows[i - (i % 2)].text !== key);
    if (!installation)
      next.unshift(
        { role: "user", text: "installation" },
        {
          role: "assistant",
          text: JSON.stringify({ installation_id: binding.installation_id }),
        },
      );
    next.push(
      { role: "user", text: key },
      { role: "assistant", text: JSON.stringify(binding) },
    );
    // Bounded: drop the oldest binding (never the installation row).
    while (next.length > 40) next.splice(2, 2);
    this.storage.save(next);
  }
}

// Serializes one occurrence across every service instance in this process.
const occurrenceLocks = new Map<string, Promise<unknown>>();
async function serialized<T>(key: string, work: () => Promise<T>) {
  const prior = occurrenceLocks.get(key) ?? Promise.resolve();
  const run = prior.then(work, work);
  const tail = run.catch(() => {});
  occurrenceLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (occurrenceLocks.get(key) === tail) occurrenceLocks.delete(key);
  }
}

export type MemberMessagesOptions = {
  /** Lifetime of this credential/session; cancels every network step. */
  signal?: AbortSignal;
  /** Optional caller fence (e.g. native credential revision is current). */
  current?: () => boolean;
  onDiagnostic?: BackendLogger;
  /** Pre-captured origin/credentials; defaults to the store's current ones. */
  origin?: string;
  secrets?: Record<string, string>;
};

/**
 * Open the shared delivery service bound to one backend credential and origin.
 * The account binding is acquired lazily, at most once per token and origin,
 * and cached durably; there is no per-delivery identity polling.
 */
export function openMemberMessages(
  store: Store,
  options: MemberMessagesOptions = {},
) {
  const configured = options.origin ?? store.publicConfig().origin;
  // One spelling-independent namespace for transport, cache, records and
  // tombstones; an unsupported URL stays as is and the transport rejects it.
  const origin = canonicalOrigin(configured) ?? configured;
  const secrets = { ...(options.secrets ?? store.secrets) };
  const token = secrets.token;
  // Legacy records are selected by the transport's own captured scope, never
  // by what the mutable store holds later. The store saves the configured
  // spelling minus one root slash; both spellings name this same backend.
  const scopes = [...new Set([configured, configured.replace(/\/$/, "")])].map(
    (spelling) => legacyScope(spelling, secrets),
  );
  const values = () => Object.values(secrets).filter((v): v is string => !!v);
  const lifetime = options.signal ?? new AbortController().signal;
  const actions = new Actions(store, options.onDiagnostic);
  const cache = new BindingCache(store.dir);
  let acquiring: Promise<MemberBinding> | undefined;

  const fence = () => {
    if (options.current && !options.current())
      throw new MemberMessageFailure("DELIVERY_CANCELLED");
  };
  const request = (
    args: { method: "GET" | "POST"; path: string; body?: unknown },
    signal: AbortSignal,
  ) => restRequest(origin, token, args, signal, values());
  const json = (result: Awaited<ReturnType<typeof request>>) => {
    if (!result || !("content" in result) || !result.content) return undefined;
    try {
      return JSON.parse(result.content[0]?.text ?? "null");
    } catch {
      return undefined;
    }
  };

  // An unreadable cache is never overwritten or re-attested over: member
  // sends fail closed while ordinary reads keep working.
  const cachedBinding = () => {
    try {
      return cache.get(origin, token);
    } catch {
      throw new MemberMessageFailure("BINDING_UNAVAILABLE");
    }
  };
  async function binding(): Promise<MemberBinding> {
    const cached = cachedBinding();
    if (cached) return cached;
    acquiring ??= (async () => {
      try {
        fence();
        if (!token) throw new Error("BINDING_UNAVAILABLE");
        const value = json(
          await request({ method: "GET", path: CONTEXT_PATH }, lifetime),
        );
        fence();
        if (
          !value ||
          Object.keys(value).sort().join() !==
            "account_owner_id,schema_version" ||
          value.schema_version !== 1 ||
          typeof value.account_owner_id !== "string"
        )
          throw new Error("BINDING_UNAVAILABLE");
        const attested: MemberBinding = {
          // The journal owns the lineage; the cache only mirrors it.
          installation_id: actions.memberInstallation(cache.installation()),
          origin,
          account_owner_id: value.account_owner_id,
        };
        if (!validBinding(attested)) throw new Error("BINDING_UNAVAILABLE");
        cache.put(origin, token, attested);
        return attested;
      } catch (error) {
        if (error instanceof MemberMessageFailure) throw error;
        throw new MemberMessageFailure("BINDING_UNAVAILABLE");
      } finally {
        acquiring = undefined;
      }
    })();
    return acquiring;
  }

  // Exact recipient/key and a nonempty message ID; anything else is unverified.
  async function receipt(
    { recipient_id, idempotency_key }: MemberDelivery,
    signal: AbortSignal,
  ) {
    const value = json(
      await request(
        { method: "GET", path: receiptPath(recipient_id, idempotency_key) },
        signal,
      ),
    );
    if (
      value?.status !== "delivered" ||
      typeof value.recipient_id !== "string" ||
      // Legacy records kept the recipient as supplied; the backend answers
      // with its canonical lowercase ObjectId.
      value.recipient_id.toLowerCase() !== recipient_id.toLowerCase() ||
      value.idempotency_key !== idempotency_key ||
      typeof value.message_id !== "string" ||
      !value.message_id ||
      value.message_id.length > 256
    )
      throw new Error("REST_RECEIPT_UNVERIFIED");
    return value.message_id as string;
  }
  // The normalized result fits its return budget before anything resolves.
  function verified(record: MemberDelivery, message_id: string) {
    const result: VerifiedDelivery = {
      status: "delivered",
      recipient_id: record.recipient_id,
      occurrence_id: record.occurrence_id!,
      message_id,
    };
    assertNoSecrets(result, values());
    if (Buffer.byteLength(JSON.stringify(result)) > RESULT_LIMIT)
      throw new Error("RESULT_TOO_LARGE");
    return result;
  }
  function resolve(record: MemberDelivery, message_id: string) {
    const result = verified(record, message_id);
    // A completion-store failure leaves the durable record pending: the
    // caller sees an unverified outcome and a reopen recovers by receipt.
    try {
      actions.settleMemberDelivery(record.idempotency_key, {
        status: "delivered",
        message_id,
      });
    } catch {
      throw new MemberMessageFailure("DELIVERY_UNVERIFIED");
    }
    return result;
  }
  const unknown = (record: MemberDelivery) => {
    try {
      actions.settleMemberDelivery(record.idempotency_key, {
        status: "unknown",
      });
    } catch {
      /* A pending record is equally unresolved; never erase it. */
    }
    return new MemberMessageFailure("DELIVERY_UNVERIFIED");
  };

  async function deliver(
    intent: MemberMessageIntent,
    signal?: AbortSignal,
  ): Promise<VerifiedDelivery> {
    // Validate size and identifiers before any binding, fence or network.
    const recipient = canonicalRecipient(intent?.recipientId);
    const text = intent?.text;
    if (
      !recipient ||
      typeof intent.occurrenceId !== "string" ||
      !OCCURRENCE_PATTERN.test(intent.occurrenceId) ||
      typeof text !== "string" ||
      !text.trim() ||
      text.length > MEMBER_MESSAGE_TEXT_LIMIT
    )
      throw new MemberMessageFailure("DELIVERY_REJECTED");
    try {
      assertNoSecrets([intent.occurrenceId, text], values());
    } catch {
      throw new MemberMessageFailure("DELIVERY_REJECTED");
    }
    const operation = signal ? AbortSignal.any([lifetime, signal]) : lifetime;
    if (operation.aborted) throw new MemberMessageFailure("DELIVERY_CANCELLED");
    return serialized(store.dir + "\n" + intent.occurrenceId, async () => {
      const bound = await binding();
      fence();
      if (operation.aborted)
        throw new MemberMessageFailure("DELIVERY_CANCELLED");
      let admitted: ReturnType<Actions["admitMemberDelivery"]>;
      try {
        admitted = actions.admitMemberDelivery(
          bound,
          {
            occurrence_id: intent.occurrenceId,
            recipient_id: recipient,
            payload_sha256: createHash("sha256").update(text).digest("hex"),
          },
          [configured],
        );
      } catch (error) {
        const message = (error as Error).message;
        if (message === "BINDING_UNAVAILABLE")
          options.onDiagnostic?.({
            source: "studio",
            stage: "operation-failed",
            level: "warn",
            ref: "MEMBER_DELIVERY_NAMESPACE_UNVERIFIED",
          });
        if (message === "MEMBER_DELIVERY_LEDGER_FULL")
          options.onDiagnostic?.({
            source: "studio",
            stage: "operation-failed",
            level: "warn",
            ref: "MEMBER_DELIVERY_LEDGER_FULL",
          });
        if (
          [
            "OCCURRENCE_CONFLICT",
            "OCCURRENCE_CONSUMED",
            "MEMBER_DELIVERY_LEDGER_FULL",
            "DELIVERY_UNVERIFIED",
            "DELIVERY_REJECTED",
            "BINDING_UNAVAILABLE",
          ].includes(message)
        )
          throw new MemberMessageFailure(message as MemberFailureCode);
        // Journal full of unresolved outcomes or unreadable: fail closed.
        throw new MemberMessageFailure("DELIVERY_UNVERIFIED");
      }
      const { record } = admitted;
      if (admitted.mode === "delivered")
        return verified(record, record.message_id!);
      if (admitted.mode === "recover") {
        // Retransmission of an uncertain occurrence: receipt read only.
        try {
          return resolve(record, await receipt(record, lifetime));
        } catch (error) {
          if (error instanceof MemberMessageFailure) throw error;
          throw unknown(record);
        }
      }
      let posted: unknown;
      try {
        posted = json(
          await request(
            {
              method: "POST",
              path: memberSendPath(record.recipient_id),
              body: { text, idempotency_key: record.idempotency_key },
            },
            operation,
          ),
        );
      } catch {
        // A committed POST may lose its acknowledgement. Read only the exact
        // host key; absence never proves noncommit and is never a retry.
        if (!operation.aborted && (!options.current || options.current()))
          try {
            return resolve(record, await receipt(record, lifetime));
          } catch (error) {
            if (error instanceof MemberMessageFailure) throw error;
          }
        throw unknown(record);
      }
      try {
        fence();
        const message_id = await receipt(record, lifetime);
        if ((posted as any)?.message_id !== message_id)
          throw new Error("REST_RECEIPT_UNVERIFIED");
        return resolve(record, message_id);
      } catch (error) {
        if (error instanceof MemberMessageFailure) throw error;
        throw unknown(record);
      }
    });
  }

  /**
   * Read-only recovery for this binding. Legacy sends of the current exact
   * credential scope are attested first; anything not provably ours stays
   * fenced. Acquires the binding only when there is something to recover.
   */
  async function reconcile() {
    let cached: MemberBinding | undefined;
    let readable = true;
    try {
      cached = cachedBinding();
    } catch {
      readable = false;
    }
    const visible = actions
      .memberDeliveries()
      .filter(
        (r) =>
          r.status !== "delivered" &&
          (canonicalOrigin(r.origin) ?? r.origin) === origin,
      );
    const legacy = actions.memberDeliverySummary().legacy_unbound;
    if (!visible.length && !legacy && !cached) return summary(undefined);
    let bound: MemberBinding | undefined = cached;
    try {
      if (!readable) throw new MemberMessageFailure("BINDING_UNAVAILABLE");
      bound ??= await binding();
    } catch (error) {
      // Cancelled or stale credentials are never "an older backend".
      if (
        lifetime.aborted ||
        (error instanceof MemberMessageFailure &&
          error.code === "DELIVERY_CANCELLED")
      )
        throw new MemberMessageFailure("DELIVERY_CANCELLED");
      fence();
      // Older backend or unavailable: keep the same-scope legacy behavior.
      await actions.reconcileMemberReceipts(
        async (recipient_id, idempotency_key) => {
          const message_id = await receipt(
            { recipient_id, idempotency_key } as MemberDelivery,
            lifetime,
          );
          fence();
          return message_id;
        },
        scopes,
      );
      fence();
      return summary(undefined);
    }
    fence();
    actions.attestLegacyMemberSends(bound, scopes);
    for (const record of actions.recoverableMemberDeliveries(bound)) {
      let message_id: string;
      try {
        message_id = await receipt(record, lifetime);
      } catch {
        // Denied/absent receipts or transport faults keep the fence.
        continue;
      }
      fence();
      try {
        actions.settleMemberDelivery(record.idempotency_key, {
          status: "delivered",
          message_id,
        });
      } catch {
        /* A pending record is equally unresolved; never erase it. */
      }
    }
    return summary(bound);
  }
  function summary(bound: MemberBinding | undefined) {
    const counts = actions.memberDeliverySummary(bound);
    if (counts.other_binding_unresolved || counts.legacy_unbound)
      options.onDiagnostic?.({
        source: "studio",
        stage: "operation-failed",
        level: "warn",
        error: new Error("MEMBER_DELIVERY_RECOVERY_LIMITED"),
        metadata: {
          unresolved: counts.other_binding_unresolved + counts.legacy_unbound,
          legacyUnbound: counts.legacy_unbound,
        },
      });
    return counts;
  }
  return { deliver, reconcile, binding };
}
export type MemberMessages = ReturnType<typeof openMemberMessages>;
