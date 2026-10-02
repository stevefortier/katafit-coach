import { MEMORY_KINDS } from "../memory/backend.js";
import {
  AccountMemory,
  AccountMemoryFailure,
  KEY_PATTERN,
  type AccountMemoryCode,
} from "../memory/account.js";
import type { Store } from "../config/store.js";
import { SafeError } from "../runtime/errors.js";

// Settings → Memories ("My memories"): the installation admin manages the
// connected account's memories through ordinary account REST with the saved
// host-held bearer. The host adds no permission policy of its own; it bounds
// arguments, fences stale configuration and maps outcomes to distinct states.
const hints: Record<AccountMemoryCode, [number, string]> = {
  MEMORY_AUTH_EXPIRED: [
    403,
    "Kata.fit rejected the saved Coach connection (expired or revoked). Reconnect in Settings → Connection with a current Coach token; your memories are unchanged and nothing was saved.",
  ],
  MEMORY_NOT_AUTHORIZED: [
    403,
    "Kata.fit denied this memory for the connected account. It may belong to another account or have been forgotten. Reconnecting the same account will not change this decision.",
  ],
  MEMORY_UNSUPPORTED: [
    501,
    "The connected Kata.fit backend does not offer account memories yet. Nothing was read or changed; this is not an empty memory list.",
  ],
  MEMORY_INVALID: [
    400,
    "Kata.fit rejected the memory request as invalid. Check the text, kind and review date; your draft is kept.",
  ],
  MEMORY_CONFLICT: [
    409,
    "This memory changed elsewhere since you opened it. Your draft is kept; reload the current version, then reapply your change.",
  ],
  MEMORY_EPOCH_CHANGED: [
    409,
    "Memories changed (for example a Forget) while this was in progress. Your draft is kept; reload and try again.",
  ],
  MEMORY_CHANGED: [
    409,
    "This memory or one it depends on was corrected or forgotten. Your draft is kept; reload before saving.",
  ],
  MEMORY_IDEMPOTENCY_CONFLICT: [
    409,
    "This save was already used for a different change. Start a new edit; nothing else was changed.",
  ],
  MEMORY_LEARNING_PAUSED: [
    409,
    "Automatic learning is paused for this account. Manual changes and recall still work.",
  ],
  MEMORY_LIMIT: [
    413,
    "The memory is over Kata.fit's size limit. Shorten it; your draft is kept.",
  ],
  MEMORY_UNAVAILABLE: [
    503,
    "Kata.fit memory is temporarily unavailable. Nothing was confirmed; your draft is kept. Try again shortly.",
  ],
  MEMORY_OUTCOME_UNKNOWN: [
    502,
    "The response was lost, so this change may or may not have been saved. Check status before doing anything else; it is never re-sent automatically.",
  ],
  MEMORY_RESULT_REJECTED: [
    502,
    "Kata.fit returned a memory response that failed local validation. Nothing is shown from it.",
  ],
  MEMORY_OPERATION_NOT_FOUND: [
    404,
    "No committed change with this key was found yet.",
  ],
};
export function accountMemoryError(error: unknown) {
  if (!(error instanceof AccountMemoryFailure)) return null;
  const [status, hint] = hints[error.code];
  return { status, body: { error: error.code, hint } };
}

const invalid = (): never => {
  throw new AccountMemoryFailure("MEMORY_INVALID");
};
const exact = (body: any, allowed: string[], required: string[]) => {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => !allowed.includes(k)) ||
    required.some((k) => !Object.hasOwn(body, k))
  )
    invalid();
  if (
    typeof body.idempotency_key !== "string" ||
    !KEY_PATTERN.test(body.idempotency_key)
  )
    invalid();
  return body;
};
const unit = (v: unknown) =>
  v === undefined ||
  (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1)
    ? v
    : invalid();
const content = (body: any) => {
  if (
    body.text !== undefined &&
    (typeof body.text !== "string" ||
      !body.text.trim() ||
      Buffer.byteLength(body.text) > 2048)
  )
    invalid();
  if (body.kind !== undefined && !MEMORY_KINDS.includes(body.kind)) invalid();
  unit(body.confidence);
  unit(body.importance);
  if (body.goal_relevance !== null) unit(body.goal_relevance);
  if (
    body.review_at !== undefined &&
    body.review_at !== null &&
    (typeof body.review_at !== "string" ||
      body.review_at.length > 64 ||
      !Number.isFinite(Date.parse(body.review_at)))
  )
    invalid();
  const out: Record<string, unknown> = {};
  for (const key of [
    "text",
    "kind",
    "confidence",
    "importance",
    "goal_relevance",
    "review_at",
  ])
    if (body[key] !== undefined) out[key] = body[key];
  if (typeof out.text === "string") out.text = (out.text as string).trim();
  return out;
};
const revision = (v: unknown, min = 1) =>
  Number.isSafeInteger(v) && (v as number) >= min ? (v as number) : invalid();

export function accountMemoryRoutes(store: Store, admissible: () => boolean) {
  // Responses for an older connection/configuration are discarded, never
  // shown under the new account.
  const client = () => {
    const config = store.publicConfig();
    const credentials = { ...store.secrets };
    const signal = AbortSignal.timeout(15000);
    const fence = () => {
      const current = store.publicConfig();
      if (
        current.revision !== config.revision ||
        current.origin !== config.origin ||
        JSON.stringify(store.secrets) !== JSON.stringify(credentials) ||
        !admissible()
      )
        throw new SafeError("CANCELLED");
    };
    if (!credentials.token) throw new SafeError("CREDENTIAL_REJECTED");
    fence();
    const memory = new AccountMemory(
      config.origin,
      credentials.token,
      signal,
      Object.values(credentials).filter((v): v is string => !!v),
    );
    return async <T>(work: (memory: AccountMemory) => Promise<T>) => {
      const result = await work(memory);
      fence();
      return result;
    };
  };
  return {
    async get(path: string) {
      const url = new URL(path, "http://admin");
      const route = url.pathname;
      if (route === "/api/memories") {
        const p = url.searchParams;
        const allowed = [
          "status",
          "kind",
          "query",
          "limit",
          "cursor",
          "pinned",
        ];
        if (
          [...p.keys()].some(
            (k) => !allowed.includes(k) || p.getAll(k).length !== 1,
          )
        )
          invalid();
        const status = p.get("status") ?? "active";
        if (!["active", "archived", "all"].includes(status)) invalid();
        const kind = p.get("kind") || undefined;
        if (kind && !MEMORY_KINDS.includes(kind as any)) invalid();
        const query = p.get("query") || undefined;
        if (query && query.length > 500) invalid();
        const limit = p.has("limit") ? Number(p.get("limit")) : 25;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) invalid();
        const cursor = p.get("cursor") || undefined;
        if (cursor && cursor.length > 4096) invalid();
        const pinned = p.get("pinned");
        if (pinned !== null && !["true", "false"].includes(pinned)) invalid();
        const page = await client()((m) =>
          m.list({
            status: status as any,
            kind,
            query,
            limit,
            cursor,
            ...(pinned !== null ? { pinned: pinned === "true" } : {}),
          }),
        );
        return {
          collection: "account",
          label: "My memories",
          ...page,
          // A filtered page is not an inventory: more can exist after an
          // empty page.
          partial: page.has_more,
        };
      }
      if (route === "/api/memories/settings")
        return { settings: await client()((m) => m.settings()) };
      const op = /^\/api\/memories\/operations\/([A-Za-z0-9._:-]{8,128})$/.exec(
        route,
      );
      if (op) {
        // The UI reconciles one exact occurrence: a receipt for another kind
        // or target is rejected rather than shown as committed.
        const p = url.searchParams;
        if ([...p.keys()].some((k) => !["kind", "memory_id"].includes(k)))
          invalid();
        const kind = p.get("kind");
        if (kind && !["create", "update", "forget", "settings"].includes(kind))
          invalid();
        const memoryId = p.get("memory_id");
        if (memoryId && (!kind || !/^[a-f0-9]{24}$/.test(memoryId))) invalid();
        const receipt = await client()((m) =>
          m.operation(
            op[1],
            kind
              ? {
                  kind: kind as any,
                  ...(memoryId
                    ? { memory_id: memoryId }
                    : kind === "settings"
                      ? { memory_id: null }
                      : {}),
                }
              : undefined,
          ),
        );
        return receipt ?? { operation: null, item: null };
      }
      const single = /^\/api\/memories\/([a-f0-9]{24})$/.exec(route);
      if (single) return client()((m) => m.get(single[1]));
      return undefined;
    },
    async post(path: string, body: any) {
      if (path === "/api/memories") {
        exact(
          body,
          [
            "idempotency_key",
            "kind",
            "text",
            "confidence",
            "importance",
            "goal_relevance",
            "review_at",
          ],
          ["idempotency_key", "kind", "text"],
        );
        const input = content(body) as any;
        return client()((m) => m.create(input, body.idempotency_key));
      }
      if (path === "/api/memories/settings") {
        exact(
          body,
          ["idempotency_key", "expected_revision", "learning_paused"],
          ["idempotency_key", "expected_revision", "learning_paused"],
        );
        if (typeof body.learning_paused !== "boolean") invalid();
        return client()((m) =>
          m.setLearning(
            body.learning_paused,
            revision(body.expected_revision, 0),
            body.idempotency_key,
          ),
        );
      }
      const forget = /^\/api\/memories\/([a-f0-9]{24})\/forget$/.exec(path);
      if (forget) {
        exact(
          body,
          ["idempotency_key", "expected_revision"],
          ["idempotency_key", "expected_revision"],
        );
        return client()((m) =>
          m.forget(
            forget[1],
            revision(body.expected_revision),
            body.idempotency_key,
          ),
        );
      }
      const update = /^\/api\/memories\/([a-f0-9]{24})$/.exec(path);
      if (update) {
        exact(
          body,
          [
            "idempotency_key",
            "expected_revision",
            "text",
            "kind",
            "confidence",
            "importance",
            "goal_relevance",
            "review_at",
            "pinned",
            "status",
          ],
          ["idempotency_key", "expected_revision"],
        );
        const patch: Record<string, unknown> = content(body);
        if (body.pinned !== undefined) {
          if (typeof body.pinned !== "boolean") invalid();
          patch.pinned = body.pinned;
        }
        if (body.status !== undefined) {
          if (!["active", "archived"].includes(body.status)) invalid();
          patch.status = body.status;
        }
        if (!Object.keys(patch).length) invalid();
        return client()((m) =>
          m.update(
            update[1],
            patch,
            revision(body.expected_revision),
            body.idempotency_key,
          ),
        );
      }
      return undefined;
    },
  };
}
