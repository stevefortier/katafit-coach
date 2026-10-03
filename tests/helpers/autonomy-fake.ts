import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { AutonomyBackend } from "../../src/autonomy/backend.js";

// In-memory fake of the coach.autonomy.v1 contract (work-packages.md §2) for
// fixture tests of the scheduler, runner and actions. It models claims,
// leases, mandate fences, slot idempotency and content-free reports. It is
// NOT integration evidence: paired tests run the real backend and Mongo.
export const DOJO = "64b7f0c2a1b2c3d4e5f60801";
export const CHIEF = "64b7f0c2a1b2c3d4e5f60802";
export const MEMBER = "64b7f0c2a1b2c3d4e5f60803";
export const OTHER_MEMBER = "64b7f0c2a1b2c3d4e5f60804";
/** Client name of the interactive human session (configures, never claims). */
export const HUMAN = "human-session";
const PROTOCOL = "coach.autonomy.v1";

const iso = (ms: number) => new Date(ms).toISOString();
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
let counter = 0;
const objectId = () =>
  ("64b7f0c2" + (0x10000000 + ++counter).toString(16).padStart(16, "0")).slice(
    0,
    24,
  );

class Fail extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly limit?: string,
  ) {
    super(code);
  }
}

export async function autonomyFake(
  start = Date.parse("2026-10-03T07:00:00.000Z"),
) {
  let now = start;
  const tokens = new Map<string, { credential: string | null }>();
  const defaults = {
    mode: "off",
    paused: false,
    timezone: null,
    quiet_hours: { start: "21:00", end: "08:00" },
    contact_limits: {
      member_daily: 1,
      member_cooldown_minutes: 240,
      dojo_daily: 20,
      praise_daily: 10,
    },
    cadence: {
      client_tick_seconds: 60,
      reconcile_minutes: 360,
      event_debounce_minutes: 10,
    },
    digest: {
      enabled: true,
      local_time: "18:00",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      suppress_empty: true,
    },
    budgets: {
      cycle_seconds: 120,
      tool_calls: 24,
      provider_tokens: 60000,
      images_per_cycle: 0,
      max_attempts: 3,
    },
    delegated_actions: ["manager_report", "follow_up"],
    instructions: "",
  };
  const state = {
    mandate: {
      protocol: PROTOCOL,
      mandate_id: null as string | null,
      dojo_id: DOJO,
      chief_id: CHIEF,
      revision: 0,
      ...structuredClone(defaults),
      status: "active",
      suspended_reason: null,
      updated_at: null as string | null,
      updated_by: null as string | null,
    } as any,
    operations: new Map<string, { body: string; result: any }>(),
    work: new Map<string, any>(),
    claimedBy: new Map<string, string>(),
    actions: new Map<string, any>(),
    followUps: new Map<string, any>(),
    reports: [] as any[],
    members: new Set([MEMBER, OTHER_MEMBER, CHIEF]),
  };
  const messages: {
    recipient_id: string;
    text: string;
    key: string;
    message_id: string;
  }[] = [];
  const calls: { method: string; path: string; credential: string | null }[] =
    [];
  let dropNextWrite = false;

  const leaseLive = (w: any) =>
    ["claimed", "running"].includes(w.status) &&
    Date.parse(w.lease_expires_at) > now;
  const expire = () => {
    for (const w of state.work.values())
      if (["claimed", "running"].includes(w.status) && !leaseLive(w)) {
        w.status = "queued";
        w.lease_expires_at = null;
        state.claimedBy.delete(w.id);
      }
  };
  const held = (id: string, generation: unknown, credential: string | null) => {
    expire();
    const w = state.work.get(id);
    if (!w) throw new Fail(404, "AUTONOMY_NOT_FOUND");
    if (
      !credential ||
      w.lease_generation !== generation ||
      !leaseLive(w) ||
      state.claimedBy.get(id) !== credential
    )
      throw new Fail(409, "LEASE_LOST");
    return w;
  };
  const fenceMandate = (w: any, revision: unknown) => {
    if (
      revision !== w.mandate_revision ||
      state.mandate.revision !== w.mandate_revision
    )
      throw new Fail(409, "AUTONOMY_MANDATE_CHANGED");
  };
  const view = (w: any) => structuredClone(w);
  const page = (items: any[], url: URL) => {
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const offset = Number(url.searchParams.get("cursor") ?? 0);
    const slice = items.slice(offset, offset + limit);
    const more = offset + limit < items.length;
    return {
      items: slice,
      next_cursor: more ? String(offset + limit) : null,
      has_more: more,
    };
  };

  function route(
    method: string,
    url: URL,
    body: any,
    credential: string | null,
  ) {
    const p = url.pathname.replace(/^\/api\/coach\/autonomy/, "");
    let m: RegExpMatchArray | null;
    if (method === "GET" && p === "/mandate")
      return {
        ...state.mandate,
        capabilities: {
          action_types: ["member_message", "manager_report", "follow_up"],
          scopes: ["dojo"],
          max_lease_seconds: 300,
        },
      };
    if (method === "PUT" && p === "/mandate") {
      const raw = JSON.stringify(body);
      const prior = state.operations.get(body.idempotency_key);
      if (prior) {
        if (prior.body !== raw)
          throw new Fail(409, "AUTONOMY_IDEMPOTENCY_CONFLICT");
        return { ...prior.result, idempotent: true };
      }
      if (body.expected_revision !== state.mandate.revision)
        throw new Fail(409, "AUTONOMY_CONFLICT");
      if (body.mandate.mode !== "off" && !body.mandate.timezone)
        throw new Fail(400, "AUTONOMY_INVALID");
      state.mandate = {
        ...state.mandate,
        ...body.mandate,
        mandate_id: state.mandate.mandate_id ?? objectId(),
        revision: state.mandate.revision + 1,
        updated_at: iso(now),
        updated_by: credential ? "external_coach" : "account_owner_session",
      };
      const result = {
        mandate: structuredClone(state.mandate),
        idempotent: false,
      };
      state.operations.set(body.idempotency_key, { body: raw, result });
      return result;
    }
    if (method === "GET" && p === "/status") {
      expire();
      const all = [...state.work.values()];
      const due = all
        .filter((w) => w.status === "queued")
        .map((w) => w.due_at)
        .sort();
      return {
        mandate: {
          mode: state.mandate.mode,
          paused: state.mandate.paused,
          status: state.mandate.status,
          revision: state.mandate.revision,
        },
        queue: {
          queued: all.filter((w) => w.status === "queued").length,
          running: all.filter((w) => ["claimed", "running"].includes(w.status))
            .length,
          blocked: all.filter((w) => w.status === "blocked").length,
        },
        last_completed_at: state.reports.at(-1)?.created_at ?? null,
        next_due_at: due[0] ?? null,
        blocked: all
          .filter((w) => w.status === "blocked")
          .slice(0, 10)
          .map((w) => ({ work_id: w.id, reason: w.blocked_reason })),
        ingest: {
          roster_pass_completed_at: null,
          members_pending_in_pass: 0,
          members_total: 0,
          lagging_members: 0,
        },
      };
    }
    if (method === "GET" && p === "/work") {
      expire();
      const status = url.searchParams.get("status");
      const items = [...state.work.values()].filter((w) =>
        status === "due"
          ? w.status === "queued" && Date.parse(w.due_at) <= now
          : status === "running"
            ? ["claimed", "running"].includes(w.status)
            : !status || status === "recent" || w.status === status,
      );
      return page(items.map(view), url);
    }
    if (method === "POST" && p === "/work/claim") {
      if (!credential) throw new Fail(403, "AUTONOMY_NOT_AUTHORIZED");
      if (
        state.mandate.mode === "off" ||
        state.mandate.paused ||
        state.mandate.status !== "active"
      )
        throw new Fail(409, "AUTONOMY_DISABLED");
      expire();
      const all = [...state.work.values()];
      if (all.some(leaseLive)) return { work: null };
      const rank = (w: any) =>
        ["follow_up", "digest"].includes(w.kind)
          ? 0
          : w.kind === "event"
            ? 1
            : 2;
      const due = all
        .filter(
          (w) =>
            w.status === "queued" &&
            Date.parse(w.due_at) <= now &&
            (!body.kinds || body.kinds.includes(w.kind)),
        )
        .sort((x, y) => rank(x) - rank(y) || x.due_at.localeCompare(y.due_at));
      const w = due[0];
      if (!w) return { work: null };
      w.status = "claimed";
      w.lease_generation += 1;
      w.mandate_revision = state.mandate.revision;
      w.lease_expires_at = iso(now + (body.lease_seconds ?? 60) * 1000);
      w.updated_at = iso(now);
      state.claimedBy.set(w.id, credential);
      return { work: view(w) };
    }
    if (
      (m = p.match(/^\/work\/([a-f0-9]{24})\/(start|checkpoint)$/)) &&
      method === "POST"
    ) {
      const w = held(m[1], body.lease_generation, credential);
      if (m[2] === "start") w.status = "running";
      else {
        w.checkpoint = body.checkpoint;
        w.lease_expires_at = iso(
          Math.min(
            Date.parse(w.timeout_at),
            now + (body.lease_seconds ?? 60) * 1000,
          ),
        );
      }
      w.updated_at = iso(now);
      return { work: view(w) };
    }
    if (
      (m = p.match(
        /^\/work\/([a-f0-9]{24})\/actions\/([a-z0-9][a-z0-9_-]{0,63})$/,
      ))
    ) {
      const [, id, slot] = m;
      const key = `${id}:${slot}`;
      if (method === "GET") {
        const receipt = state.actions.get(key);
        if (!receipt) throw new Fail(404, "ACTION_NOT_FOUND");
        return { receipt };
      }
      if (method !== "PUT") throw new Fail(404, "AUTONOMY_NOT_FOUND");
      const recipient =
        body.type === "manager_report" ? CHIEF : body.recipient_id;
      const prior = state.actions.get(key);
      if (prior) {
        if (
          prior.type !== body.type ||
          prior.recipient_id !== recipient ||
          prior.text_sha256 !== sha256(body.text)
        )
          throw new Fail(409, "ACTION_CONFLICT");
        return { receipt: prior, idempotent: true, http: 200 };
      }
      const w = held(id, body.lease_generation, credential);
      fenceMandate(w, body.mandate_revision);
      const allowed =
        state.mandate.delegated_actions.includes(body.type) &&
        (body.type === "manager_report" || state.mandate.mode === "message");
      if (!allowed) throw new Fail(400, "ACTION_UNSUPPORTED");
      if (!state.members.has(recipient))
        throw new Fail(403, "RECIPIENT_NOT_MEMBER");
      const idempotency_key =
        "ca1_" +
        createHash("sha256")
          .update(JSON.stringify([state.mandate.mandate_id, id, slot]))
          .digest("base64url")
          .slice(0, 43);
      const message_id = objectId();
      messages.push({
        recipient_id: recipient,
        text: body.text,
        key: idempotency_key,
        message_id,
      });
      const receipt = {
        slot,
        type: body.type,
        status: "delivered",
        recipient_id: recipient,
        message_id,
        idempotency_key,
        text_sha256: sha256(body.text),
        committed_at: iso(now),
      };
      state.actions.set(key, receipt);
      w.actions.push(receipt);
      return { receipt, idempotent: false, http: 201 };
    }
    if (
      (m = p.match(
        /^\/work\/([a-f0-9]{24})\/follow-ups\/([a-z0-9][a-z0-9_-]{0,63})$/,
      )) &&
      method === "PUT"
    ) {
      const [, id, slot] = m;
      const existing = [...state.followUps.values()].find(
        (f) => f.source.work_id === id && f.source.slot === slot,
      );
      if (existing) return { follow_up: existing, idempotent: true, http: 200 };
      const w = held(id, body.lease_generation, credential);
      fenceMandate(w, body.mandate_revision);
      const follow_up = {
        id: objectId(),
        subject_id: body.subject_id,
        status: "open",
        basis: body.basis,
        summary: body.summary,
        due_at: body.due_at,
        timezone: state.mandate.timezone,
        next_condition: body.next_condition,
        last_evidence_at: null,
        source: { work_id: id, slot },
        evidence: body.evidence ?? null,
        closure_reason: null,
        revision: 1,
        created_at: iso(now),
        updated_at: iso(now),
      };
      state.followUps.set(follow_up.id, follow_up);
      w.follow_ups.push(follow_up.id);
      return { follow_up, idempotent: false, http: 201 };
    }
    if ((m = p.match(/^\/follow-ups\/([a-f0-9]{24})$/)) && method === "PATCH") {
      const f = state.followUps.get(m[1]);
      if (!f) throw new Fail(404, "AUTONOMY_NOT_FOUND");
      if (body.lease)
        held(body.lease.work_id, body.lease.lease_generation, credential);
      if (f.revision !== body.expected_revision || f.status !== "open")
        throw new Fail(409, "AUTONOMY_CONFLICT");
      Object.assign(f, {
        status: body.status,
        closure_reason: body.closure_reason,
        revision: f.revision + 1,
        updated_at: iso(now),
      });
      return { follow_up: f };
    }
    if (method === "GET" && p === "/follow-ups") {
      const status = url.searchParams.get("status");
      const subject = url.searchParams.get("subject_id");
      return page(
        [...state.followUps.values()].filter(
          (f) =>
            (!status || f.status === status) &&
            (!subject || f.subject_id === subject),
        ),
        url,
      );
    }
    if (
      (m = p.match(/^\/work\/([a-f0-9]{24})\/complete$/)) &&
      method === "POST"
    ) {
      const w = held(m[1], body.lease_generation, credential);
      fenceMandate(w, body.mandate_revision);
      const o = body.outcome;
      const slots = new Set(w.actions.map((r: any) => r.slot));
      const followUps = new Set(w.follow_ups);
      if (
        o.decisions.some(
          (d: any) =>
            d.action_slots.some((s: string) => !slots.has(s)) ||
            d.follow_up_ids.some((f: string) => !followUps.has(f)),
        )
      )
        throw new Fail(400, "AUTONOMY_INVALID");
      if (o.result === "deferred") {
        w.status = "queued";
        w.due_at = o.next_due_at;
        w.attempts += 1;
      } else {
        w.status = o.result;
        w.blocked_reason = o.blocked_reason ?? null;
      }
      w.lease_expires_at = null;
      w.updated_at = iso(now);
      state.claimedBy.delete(w.id);
      const counts = {
        acted: 0,
        no_action: 0,
        deferred: 0,
        escalated: 0,
      } as any;
      for (const d of o.decisions) counts[d.decision] += 1;
      const report = {
        id: objectId(),
        work_id: w.id,
        kind: w.kind,
        result: o.result,
        coverage: o.coverage,
        counts,
        action_slots: o.decisions.flatMap((d: any) => d.action_slots),
        created_at: iso(now),
      };
      state.reports.unshift(report);
      return { work: view(w), report_id: report.id };
    }
    if (method === "GET" && p === "/reports") return page(state.reports, url);
    throw new Fail(404, "AUTONOMY_NOT_FOUND");
  }

  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const bearer = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const identity = tokens.get(bearer);
    const url = new URL(req.url!, "http://fake");
    calls.push({
      method: req.method!,
      path: req.url!,
      credential: identity?.credential ?? null,
    });
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ protocol: PROTOCOL, ...(value as object) }));
    };
    if (!identity)
      return send(401, { code: "UNAUTHENTICATED", error: "unauthenticated" });
    try {
      // `http` is the fake's private status channel; DTO fields (such as a
      // mandate's own `status`) pass through untouched.
      const { http, ...result } = route(
        req.method!,
        url,
        raw ? JSON.parse(raw) : undefined,
        identity.credential,
      ) as { http?: number } & Record<string, unknown>;
      if (dropNextWrite && req.method !== "GET") {
        dropNextWrite = false;
        req.socket.destroy();
        return;
      }
      send(http ?? 200, result);
    } catch (error) {
      if (!(error instanceof Fail)) throw error;
      send(error.status, {
        code: error.code,
        error: "synthetic",
        ...(error.limit ? { limit: error.limit } : {}),
      });
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const clients = new AbortController();

  return {
    origin,
    chief: CHIEF,
    messages,
    calls,
    state,
    /** A bearer for an installation credential (or the human session). */
    token(name: string) {
      const token = `rgn_coach_${sha256(name).slice(0, 24)}_${randomBytes(8).toString("hex")}`;
      tokens.set(token, {
        credential: name === HUMAN ? null : sha256(name).slice(0, 24),
      });
      return token;
    },
    client(name: string) {
      return new AutonomyBackend(origin, this.token(name), clients.signal, []);
    },
    enqueue(input: {
      kind: string;
      subject_ids?: string[];
      due_at?: string;
      source?: object;
    }) {
      const id = objectId();
      state.work.set(id, {
        id,
        kind: input.kind,
        mandate_id: state.mandate.mandate_id ?? objectId(),
        mandate_revision: state.mandate.revision,
        status: "queued",
        due_at: input.due_at ?? iso(now),
        attempts: 0,
        subject_ids: input.subject_ids ?? [],
        source: input.source ?? {},
        checkpoint: null,
        lease_generation: 0,
        lease_expires_at: null,
        timeout_at: iso(now + 600_000),
        actions: [],
        follow_ups: [],
        blocked_reason: null,
        created_at: iso(now),
        updated_at: iso(now),
      });
      return id;
    },
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
    dropNextWrite() {
      dropNextWrite = true;
    },
    async close() {
      clients.abort();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
export type AutonomyFake = Awaited<ReturnType<typeof autonomyFake>>;
