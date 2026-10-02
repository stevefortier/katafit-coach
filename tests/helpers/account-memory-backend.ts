import { createServer, type IncomingMessage, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";

// Contract-faithful synthetic fake of the Slice1 account-private memory REST
// (task-evidence contract.md). It is a deterministic wiring fixture only; the
// real Express/Mongo backend is exercised by the opt-in paired tests.
export type FakeItem = {
  id: string;
  revision: number;
  /** Semantic version: only text or kind changes bump it. */
  content_revision: number;
  kind: string;
  text?: string;
  availability: "available" | "unavailable";
  status: "active" | "archived";
  audience: "account_private";
  subject: null;
  confidence: number;
  importance: number;
  goal_relevance: number | null;
  review_at: string | null;
  needs_review: boolean;
  pinned: boolean;
  protected: boolean;
  provenance: Record<string, unknown>;
  sources: { family: string; label: string }[];
  observed_at: string;
  created_at: string;
  updated_at: string;
};
type Request = {
  method: string;
  path: string;
  auth?: string;
  body?: any;
};
const hex = () => randomBytes(12).toString("hex");
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function startAccountMemoryBackend(
  options: {
    token?: string;
    producer?: string;
  } = {},
) {
  const token = options.token ?? "synthetic-account-bearer";
  const producer = options.producer ?? "external_coach";
  const requests: Request[] = [];
  const items = new Map<string, FakeItem>();
  const history = new Map<string, any[]>();
  const operations = new Map<string, any>();
  const captures = new Map<string, any>();
  // Persisted fragment ancestry: cited (based_on) + superseded rows only.
  const ancestry = new Map<string, string[]>();
  const pendingErasure = new Set<string>();
  const settings = {
    learning_paused: false,
    revision: 0,
    updated_at: null as string | null,
  };
  let epoch = 0;
  const hooks: {
    // Return a status/body to override, "drop" to commit and then lose the
    // response, "hang" to never answer, or undefined for normal handling.
    before?: (
      request: Request,
    ) =>
      | { status: number; body?: unknown; type?: string }
      | "drop"
      | "hang"
      | void;
    afterCommit?: (request: Request) => "drop" | void;
    // Rewrites a successful response body (e.g. a substituted receipt).
    after?: (request: Request, body: any) => any;
    // Awaited before routing: lets a test hold a response in flight.
    wait?: (request: Request) => Promise<void> | void;
    // Related descendants erased synchronously on Forget; more are queued.
    syncErasureLimit?: number;
  } = {};
  const related = (id: string) => {
    const found: string[] = [];
    const queue = [id];
    while (queue.length) {
      const parent = queue.shift()!;
      for (const [child, parents] of ancestry)
        if (
          parents.includes(parent) &&
          !found.includes(child) &&
          child !== id &&
          items.has(child)
        ) {
          found.push(child);
          queue.push(child);
        }
    }
    return found;
  };
  const now = () => new Date().toISOString();
  const item = (
    input: Partial<FakeItem> & { kind: string; text: string },
    provenance: Record<string, unknown>,
  ): FakeItem => {
    const at = now();
    const review = input.review_at ?? null;
    return {
      id: hex(),
      revision: 1,
      content_revision: 1,
      kind: input.kind,
      text: input.text,
      availability: "available",
      status: "active",
      audience: "account_private",
      subject: null,
      confidence: input.confidence ?? 1,
      importance: input.importance ?? 0.8,
      goal_relevance: input.goal_relevance ?? null,
      review_at: review,
      needs_review: !!review && Date.parse(review) <= Date.now(),
      pinned: false,
      protected: provenance.type === "manual_assertion",
      provenance,
      sources:
        provenance.type === "manual_assertion"
          ? [{ family: "manual", label: "Account owner assertion" }]
          : [
              {
                family: "acquired_conversation",
                label: "Owner-reported Coach conversation",
              },
            ],
      observed_at: at,
      created_at: at,
      updated_at: at,
    };
  };
  const manual = () => ({
    type: "manual_assertion",
    origin: "studio",
    created_by: "account_owner",
    producer,
    on_behalf_of: "account_owner",
    corrected: false,
    persona_revision: null,
  });
  const fail = (status: number, code: string) => ({
    status,
    body: { code, message: "Coach memory operation is unavailable" },
  });
  const keyed = (body: any) =>
    typeof body?.idempotency_key === "string" &&
    /^[A-Za-z0-9._:-]{8,128}$/.test(body.idempotency_key);
  const replay = (body: any, kind: string, target: string | null) => {
    const prior = operations.get(body.idempotency_key);
    if (!prior) return undefined;
    if (prior.digest !== digest([kind, target, body]))
      return fail(409, "MEMORY_IDEMPOTENCY_CONFLICT");
    return { status: 200, body: { ...prior.response, idempotent: true } };
  };
  const record = (
    body: any,
    kind: string,
    target: string | null,
    response: any,
    revision: number,
    target_status: string | null,
    extra: Record<string, unknown> = {},
  ) => {
    const operation = {
      ...extra,
      idempotency_key: body.idempotency_key,
      kind,
      status: "committed",
      memory_id: target,
      revision,
      committed_at: now(),
      producer,
      target_status,
    };
    operations.set(body.idempotency_key, {
      digest: digest([kind, target, body]),
      operation,
      response: { ...response, operation },
    });
    return { status: 200, body: { ...response, operation, idempotent: false } };
  };
  function route(request: Request): { status: number; body?: unknown } {
    const url = new URL(request.path, "http://fake");
    const path = url.pathname;
    const body = request.body;
    const base = "/api/coach/memory";
    if (!path.startsWith(base)) return { status: 404 };
    const rest = path.slice(base.length);
    if (rest === "/settings") {
      if (request.method === "GET")
        return { status: 200, body: { protocol: "coach.memory.v1", settings } };
      if (request.method === "PATCH") {
        if (!keyed(body) || typeof body.learning_paused !== "boolean")
          return fail(400, "MEMORY_INVALID");
        const prior = replay(body, "settings", null);
        if (prior) return prior;
        if (body.expected_revision !== settings.revision)
          return fail(409, "MEMORY_CONFLICT");
        settings.learning_paused = body.learning_paused;
        settings.revision++;
        settings.updated_at = now();
        let discarded = 0;
        if (settings.learning_paused)
          for (const capture of captures.values())
            if (capture.status === "open") {
              capture.status = "discarded";
              capture.evidence = null;
              discarded++;
            }
        return record(
          body,
          "settings",
          null,
          {
            protocol: "coach.memory.v1",
            settings: { ...settings },
            discarded_captures: discarded,
          },
          settings.revision,
          null,
        );
      }
    }
    const operation = /^\/operations\/([^/]+)$/.exec(rest);
    if (operation && request.method === "GET") {
      const prior = operations.get(decodeURIComponent(operation[1]));
      if (!prior) return fail(404, "MEMORY_OPERATION_NOT_FOUND");
      const current = prior.operation.memory_id
        ? items.get(prior.operation.memory_id)
        : null;
      return {
        status: 200,
        body: {
          protocol: "coach.memory.v1",
          operation: prior.operation,
          item: current ?? null,
          ...(prior.operation.kind === "settings"
            ? { settings: { ...settings } }
            : {}),
        },
      };
    }
    if (rest === "/interactions" && request.method === "POST") {
      if (settings.learning_paused) return fail(409, "MEMORY_LEARNING_PAUSED");
      if (
        typeof body?.idempotency_key !== "string" ||
        typeof body.human_text !== "string" ||
        typeof body.assistant_text !== "string"
      )
        return fail(400, "MEMORY_INVALID");
      if (Buffer.byteLength(JSON.stringify(body)) > 65536 + 4096)
        return fail(413, "MEMORY_LIMIT");
      for (const recalled of body.recalled ?? []) {
        const current = items.get(recalled.id);
        // With content_revision the semantic version and active state decide;
        // without it the raw revision stays strict.
        if (
          recalled.content_revision !== undefined &&
          (!Number.isSafeInteger(recalled.content_revision) ||
            recalled.content_revision < 1)
        )
          return fail(400, "MEMORY_INVALID");
        if (
          !current ||
          (recalled.content_revision === undefined
            ? current.revision !== recalled.revision
            : current.content_revision !== recalled.content_revision ||
              current.status !== "active")
        )
          return fail(409, "MEMORY_CHANGED");
      }
      const existing = [...captures.values()].find(
        (c) => c.key === body.idempotency_key,
      );
      if (existing) return { status: 200, body: existing.dto };
      const capture_id = hex();
      const dto = {
        protocol: "coach.memory.v1",
        capture_id,
        audience: "account_private",
        memory_epoch: epoch,
        extraction_expires_at: new Date(Date.now() + 1800000).toISOString(),
        status: "open",
      };
      captures.set(capture_id, {
        key: body.idempotency_key,
        dto,
        status: "open",
        evidence: {
          human_text: body.human_text,
          assistant_text: body.assistant_text,
          tool_results: body.tool_results ?? [],
        },
        recalled: (body.recalled ?? []).map((r: any) => items.get(r.id)),
        epoch,
        receipt: null,
      });
      return { status: 200, body: dto };
    }
    if (rest === "/interactions/pending" && request.method === "GET") {
      const open = [...captures.entries()]
        .filter(([, c]) => c.status === "open")
        .map(([capture_id]) => ({ capture_id, origin: "operator_turn" }));
      const cursor = Number(url.searchParams.get("cursor") ?? 0);
      // Deterministic pagination: the first page is always an empty
      // continuation so clients must keep scanning.
      if (!cursor && open.length)
        return {
          status: 200,
          body: {
            protocol: "coach.memory.v1",
            captures: [],
            has_more: true,
            next_cursor: "1",
            learning_paused: settings.learning_paused,
          },
        };
      return {
        status: 200,
        body: {
          protocol: "coach.memory.v1",
          captures: settings.learning_paused ? [] : open.slice(0, 8),
          has_more: false,
          next_cursor: null,
          learning_paused: settings.learning_paused,
        },
      };
    }
    const interaction =
      /^\/interactions\/([a-f0-9]{24})(\/commit|\/receipt)?$/.exec(rest);
    if (interaction) {
      const capture = captures.get(interaction[1]);
      if (!capture) return fail(403, "MEMORY_NOT_AUTHORIZED");
      if (interaction[2] === "/receipt" && request.method === "GET")
        return {
          status: 200,
          body: {
            protocol: "coach.memory.v1",
            capture_id: interaction[1],
            status: capture.status,
            receipt: capture.receipt,
          },
        };
      if (!interaction[2] && request.method === "GET") {
        if (settings.learning_paused)
          return fail(409, "MEMORY_LEARNING_PAUSED");
        if (capture.status !== "open") return fail(409, "MEMORY_CONFLICT");
        if (capture.epoch !== epoch) return fail(409, "MEMORY_EPOCH_CHANGED");
        return {
          status: 200,
          body: {
            protocol: "coach.memory.v1",
            origin: "operator_turn",
            publication: "published",
            capture: capture.dto,
            recalled: capture.recalled.filter(Boolean),
            evidence: capture.evidence,
          },
        };
      }
      if (interaction[2] === "/commit" && request.method === "POST") {
        if (capture.receipt && capture.commitKey === body.idempotency_key)
          return {
            status: 200,
            body: { ...capture.receipt, idempotent: true },
          };
        if (settings.learning_paused)
          return fail(409, "MEMORY_LEARNING_PAUSED");
        if (capture.status !== "open") return fail(409, "MEMORY_CONFLICT");
        if (capture.epoch !== epoch || body.expected_memory_epoch !== epoch)
          return fail(409, "MEMORY_EPOCH_CHANGED");
        const recalledIds = new Set(
          capture.recalled.filter(Boolean).map((i: FakeItem) => i.id),
        );
        const cited = (list: unknown, max: number) =>
          list === undefined ||
          (Array.isArray(list) &&
            list.length <= max &&
            new Set(list).size === list.length &&
            list.every(
              (id) =>
                typeof id === "string" &&
                /^[a-f0-9]{24}$/.test(id) &&
                recalledIds.has(id),
            ));
        if (
          !Array.isArray(body.proposals) ||
          body.proposals.some(
            (p: any) => !cited(p.based_on, 20) || !cited(p.supersedes, 4),
          )
        )
          return fail(400, "MEMORY_INVALID");
        const created: { id: string; revision: number }[] = [];
        const skipped: {
          index: number;
          reason: string;
          memory_ids?: string[];
          count?: number;
        }[] = [];
        const superseded: { id: string; revision: number }[] = [];
        (body.proposals ?? []).forEach((proposal: any, index: number) => {
          // Account-only: automatic replacement of protected (manual or
          // corrected) memories is skipped with content-free owned ids.
          const guarded = (proposal.supersedes ?? []).filter(
            (id: string) =>
              items.get(id)?.protected && items.get(id)?.status === "active",
          );
          if (guarded.length) {
            skipped.push({
              index,
              reason: "protected_memory",
              memory_ids: guarded,
              count: guarded.length,
            });
            return;
          }
          if (
            [...items.values()].some(
              (i) => i.text === proposal.text && i.status === "active",
            )
          ) {
            skipped.push({ index, reason: "duplicate" });
            return;
          }
          const { based_on, supersedes, ...content } = proposal;
          const created_item = item(
            {
              ...content,
              review_at: proposal.review_after_days
                ? new Date(
                    Date.now() + proposal.review_after_days * 86400000,
                  ).toISOString()
                : null,
            },
            {
              type: "derived",
              origin: "operator_turn",
              created_by: "model_extraction",
              producer,
              on_behalf_of: "account_owner",
              corrected: false,
              persona_revision: body.persona_revision ?? null,
              evidence_mode: "acquired_conversation_v1",
              attestation: "authenticated_owner_reported_interaction",
            },
          );
          items.set(created_item.id, created_item);
          ancestry.set(created_item.id, [
            ...(based_on ?? []),
            ...(supersedes ?? []),
          ]);
          history.set(created_item.id, [
            {
              revision: 1,
              at: created_item.created_at,
              actor: "model_extraction",
              producer,
              change: "created",
              text: created_item.text,
            },
          ]);
          created.push({ id: created_item.id, revision: 1 });
        });
        capture.status = "committed";
        capture.evidence = null;
        capture.commitKey = body.idempotency_key;
        capture.receipt = {
          protocol: "coach.memory.v1",
          capture_id: interaction[1],
          status: "committed",
          publication: "published",
          memory_epoch: epoch,
          created,
          superseded,
          skipped,
          idempotent: false,
        };
        return { status: 200, body: capture.receipt };
      }
    }
    if (rest === "" || rest === "/") {
      if (request.method === "GET") {
        const allowed = [
          "status",
          "kind",
          "query",
          "limit",
          "cursor",
          "pinned",
        ];
        if ([...url.searchParams.keys()].some((k) => !allowed.includes(k)))
          return fail(400, "MEMORY_INVALID");
        const status = url.searchParams.get("status") ?? "active";
        const query = url.searchParams.get("query");
        // Backend semantics (core/coachMemory.js terms/rank 'search'): query
        // is at most 2000 chars and keeps rows sharing at least one exact
        // NFKC-lowercased letter/number token of 3+ characters. No stemming.
        if (query !== null && query.length > 2000)
          return fail(400, "MEMORY_INVALID");
        const terms = (text: string) =>
          new Set(
            text
              .toLowerCase()
              .normalize("NFKC")
              .match(/[\p{L}\p{N}]{3,}/gu) ?? [],
          );
        const wanted = terms(query ?? "");
        const kind = url.searchParams.get("kind");
        const pinned = url.searchParams.get("pinned");
        const limit = Number(url.searchParams.get("limit") ?? 25);
        const offset = Number(url.searchParams.get("cursor") ?? 0);
        const matched = [...items.values()]
          .filter(
            (i) =>
              (status === "all" || i.status === status) &&
              (!kind || i.kind === kind) &&
              (pinned === null || i.pinned === (pinned === "true")) &&
              (!wanted.size ||
                [...terms(i.text ?? "")].some((t) => wanted.has(t))),
          )
          .sort(
            (a, b) =>
              Number(b.pinned) - Number(a.pinned) ||
              b.updated_at.localeCompare(a.updated_at),
          );
        const page = matched.slice(offset, offset + limit);
        const more = offset + limit < matched.length;
        return {
          status: 200,
          body: {
            protocol: "coach.memory.v1",
            items: page,
            has_more: more,
            next_cursor: more ? String(offset + limit) : null,
            members: [],
          },
        };
      }
      if (request.method === "POST") {
        if (!keyed(body) || typeof body.text !== "string" || !body.text)
          return fail(400, "MEMORY_INVALID");
        const prior = replay(body, "create", null);
        if (prior) return prior;
        const created = item(body, manual());
        items.set(created.id, created);
        history.set(created.id, [
          {
            revision: 1,
            at: created.created_at,
            actor: "account_owner",
            producer,
            change: "created",
            text: created.text,
          },
        ]);
        return record(
          body,
          "create",
          created.id,
          { protocol: "coach.memory.v1", item: created },
          1,
          "active",
        );
      }
    }
    const impact = /^\/([a-f0-9]{24})\/forget-impact$/.exec(rest);
    if (impact && request.method === "GET") {
      if ([...url.searchParams.keys()].length)
        return fail(400, "MEMORY_INVALID");
      const current = items.get(impact[1]);
      if (!current) return fail(403, "MEMORY_NOT_AUTHORIZED");
      const ids = related(impact[1]);
      return {
        status: 200,
        body: {
          protocol: "coach.memory.v1",
          id: current.id,
          revision: current.revision,
          related_count: ids.length,
          examples: ids.slice(0, 20).map((id) => ({
            id,
            kind: items.get(id)!.kind,
            status: items.get(id)!.status,
          })),
          has_more: ids.length > 20,
          snapshot: true,
          erasure_may_be_async: true,
        },
      };
    }
    const single = /^\/([a-f0-9]{24})$/.exec(rest);
    if (single) {
      const id = single[1];
      const current = items.get(id);
      if (request.method === "GET") {
        if (!current) return fail(403, "MEMORY_NOT_AUTHORIZED");
        return {
          status: 200,
          body: {
            protocol: "coach.memory.v1",
            item: current,
            history: history.get(id) ?? [],
          },
        };
      }
      if (request.method === "PATCH") {
        if (!keyed(body) || !Number.isInteger(body.expected_revision))
          return fail(400, "MEMORY_INVALID");
        if ("protected" in body) return fail(400, "MEMORY_INVALID");
        const prior = replay(body, "update", id);
        if (prior) return prior;
        if (!current) return fail(403, "MEMORY_NOT_AUTHORIZED");
        if (current.revision !== body.expected_revision)
          return fail(409, "MEMORY_CONFLICT");
        const changed = { ...current };
        for (const key of [
          "text",
          "kind",
          "confidence",
          "importance",
          "goal_relevance",
          "review_at",
          "pinned",
          "status",
        ])
          if (key in body) (changed as any)[key] = body[key];
        if ("text" in body && body.text !== current.text) {
          changed.protected = true;
          changed.provenance = { ...changed.provenance, corrected: true };
        }
        if (
          ("text" in body && body.text !== current.text) ||
          ("kind" in body && body.kind !== current.kind)
        )
          changed.content_revision++;
        changed.revision++;
        changed.updated_at = now();
        changed.needs_review =
          !!changed.review_at && Date.parse(changed.review_at) <= Date.now();
        items.set(id, changed);
        history.get(id)?.push({
          revision: changed.revision,
          at: changed.updated_at,
          actor: "account_owner",
          producer,
          change: "text" in body ? "corrected" : "updated",
          text: changed.text,
        });
        return record(
          body,
          "update",
          id,
          { protocol: "coach.memory.v1", item: changed },
          changed.revision,
          changed.status,
        );
      }
      if (request.method === "DELETE") {
        if (!keyed(body) || !Number.isInteger(body.expected_revision))
          return fail(400, "MEMORY_INVALID");
        const prior = replay(body, "forget", id);
        if (prior) return prior;
        if (!current) return fail(403, "MEMORY_NOT_AUTHORIZED");
        if (current.revision !== body.expected_revision)
          return fail(409, "MEMORY_CONFLICT");
        const relatedIds = related(id).sort();
        const syncLimit = hooks.syncErasureLimit ?? 100;
        const queued = relatedIds.length > syncLimit;
        // Target and every related descendant are unreadable immediately;
        // queued only means related stored prose is swept later.
        for (const child of relatedIds) {
          items.delete(child);
          if (relatedIds.indexOf(child) >= syncLimit) pendingErasure.add(child);
          else history.delete(child);
        }
        const erasure = {
          status: queued ? "queued" : "complete",
          related_count: relatedIds.length,
        };
        items.delete(id);
        history.delete(id);
        epoch++;
        for (const capture of captures.values())
          if (capture.status === "open") {
            capture.status = "invalidated";
            capture.evidence = null;
          }
        return record(
          body,
          "forget",
          id,
          {
            protocol: "coach.memory.v1",
            id,
            status: "forgotten",
            revision: current.revision + 1,
            memory_epoch: epoch,
            cascaded: relatedIds.slice(0, syncLimit),
            erasure,
          },
          current.revision + 1,
          "forgotten",
          { erasure },
        );
      }
    }
    return { status: 404 };
  }
  const read = async (req: IncomingMessage) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return raw ? JSON.parse(raw) : undefined;
  };
  const server: Server = createServer(async (req, res) => {
    const request: Request = {
      method: req.method!,
      path: req.url!,
      auth: req.headers.authorization,
      body: await read(req),
    };
    requests.push(request);
    await hooks.wait?.(request);
    res.setHeader("Cache-Control", "no-store");
    const override = hooks.before?.(request);
    if (override === "hang") return;
    if (override === "drop") {
      route(request);
      res.destroy();
      return;
    }
    if (override) {
      res.writeHead(override.status, {
        "content-type": override.type ?? "application/json",
      });
      res.end(
        override.body === undefined
          ? ""
          : typeof override.body === "string"
            ? override.body
            : JSON.stringify(override.body),
      );
      return;
    }
    if (request.auth !== "Bearer " + token) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const result = route(request);
    if (result.status === 200 && hooks.afterCommit?.(request) === "drop") {
      res.destroy();
      return;
    }
    if (result.body === undefined) {
      res.writeHead(result.status, { "content-type": "text/html" });
      res.end("<pre>Cannot " + request.method + "</pre>");
      return;
    }
    const body =
      result.status === 200 && hooks.after
        ? (hooks.after(request, structuredClone(result.body)) ?? result.body)
        : result.body;
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  return {
    origin,
    token,
    requests,
    items,
    operations,
    captures,
    ancestry,
    pendingErasure,
    settings,
    hooks,
    seed(input: Partial<FakeItem> & { kind: string; text: string }) {
      const created = item(input, manual());
      Object.assign(created, input, { id: created.id });
      items.set(created.id, created);
      history.set(created.id, []);
      return created;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
export type AccountMemoryBackend = Awaited<
  ReturnType<typeof startAccountMemoryBackend>
>;
