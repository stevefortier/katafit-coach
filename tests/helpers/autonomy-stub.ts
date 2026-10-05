import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";

export const TOKEN = "rgn_coach_synthetic-autonomy-credential";
export const DOJO = "64b7f0c2a1b2c3d4e5f60701";
export const CHIEF = "64b7f0c2a1b2c3d4e5f60702";
export const MEMBER = "64b7f0c2a1b2c3d4e5f60703";
export const WORK = "64b7f0c2a1b2c3d4e5f60704";
export const MANDATE = "64b7f0c2a1b2c3d4e5f60705";

export type StubCall = {
  method: string;
  path: string;
  auth?: string;
  headers: IncomingHttpHeaders;
  body?: any;
  raw: string;
};
export type StubReply = {
  status?: number;
  type?: string;
  body?: unknown;
  /** Destroy the socket instead of answering (lost response). */
  drop?: boolean;
  /** Send the body as is (no protocol envelope field added). */
  raw?: boolean;
  location?: string;
};

/** Scripted loopback backend: records every request, answers per route. */
export async function autonomyStub(
  reply: (call: StubCall) => StubReply | undefined = () => undefined,
) {
  const calls: StubCall[] = [];
  let handler = reply;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const call: StubCall = {
      method: req.method!,
      path: req.url!,
      auth: req.headers.authorization,
      headers: req.headers,
      raw,
      body: raw ? JSON.parse(raw) : undefined,
    };
    calls.push(call);
    const answer = handler(call) ?? { status: 404, body: "Cannot route" };
    if (answer.drop) {
      req.socket.destroy();
      return;
    }
    res.writeHead(answer.status ?? 200, {
      "content-type":
        answer.type ??
        (typeof answer.body === "string" ? "text/html" : "application/json"),
      ...(answer.location ? { location: answer.location } : {}),
    });
    // Every coach.autonomy.v1 response carries the protocol (§2).
    const body =
      !answer.raw &&
      answer.body &&
      typeof answer.body === "object" &&
      !Array.isArray(answer.body)
        ? { protocol: "coach.autonomy.v1", ...answer.body }
        : answer.body;
    res.end(typeof body === "string" ? body : JSON.stringify(body ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    origin: `http://127.0.0.1:${(server.address() as any).port}`,
    calls,
    set reply(fn: typeof reply) {
      handler = fn;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export const defaultMandate = (overrides: Record<string, unknown> = {}) => ({
  protocol: "coach.autonomy.v1",
  mandate_id: null,
  dojo_id: DOJO,
  chief_id: CHIEF,
  revision: 0,
  mode: "off",
  paused: false,
  status: "active",
  suspended_reason: null,
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
  updated_at: null,
  updated_by: null,
  ...overrides,
});
export const capabilities = {
  action_types: ["manager_report", "follow_up"],
  scopes: ["dojo"],
  max_lease_seconds: 300,
};
export const error = (status: number, code: string, extra = {}) => ({
  status,
  body: { protocol: "coach.autonomy.v1", code, error: "synthetic", ...extra },
});

export const workItem = (overrides: Record<string, unknown> = {}) => ({
  id: WORK,
  kind: "event",
  mandate_id: MANDATE,
  mandate_revision: 1,
  status: "claimed",
  due_at: "2026-10-03T07:00:00.000Z",
  attempts: 0,
  subject_ids: [MEMBER],
  source: { event_ids: ["64b7f0c2a1b2c3d4e5f607aa"] },
  checkpoint: null,
  lease_generation: 1,
  lease_expires_at: "2026-10-03T07:02:00.000Z",
  timeout_at: "2026-10-03T07:10:00.000Z",
  actions: [],
  follow_ups: [],
  blocked_reason: null,
  created_at: "2026-10-03T06:59:00.000Z",
  updated_at: "2026-10-03T07:00:00.000Z",
  ...overrides,
});
export const outcome = (overrides: Record<string, unknown> = {}) => ({
  result: "completed",
  coverage: {
    members_considered: 1,
    members_read: 1,
    partial: false,
    unobserved: [],
  },
  decisions: [
    {
      subject_id: MEMBER,
      decision: "no_action",
      action_slots: [],
      follow_up_ids: [],
    },
  ],
  uncertainty: [],
  budget: { provider_tokens: 1200, tool_calls: 2, elapsed_ms: 3400 },
  ...overrides,
});

export const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const receipt = (overrides: Record<string, unknown> = {}) => ({
  slot: "praise-1",
  type: "member_message",
  status: "delivered",
  recipient_id: MEMBER,
  message_id: "64b7f0c2a1b2c3d4e5f607bb",
  idempotency_key: "ca1_" + "A".repeat(43),
  text_sha256: sha256("Great squat session today."),
  committed_at: "2026-10-03T07:01:00.000Z",
  ...overrides,
});

export const FOLLOW_UP = "64b7f0c2a1b2c3d4e5f60707";
export const followUp = (overrides: Record<string, unknown> = {}) => ({
  id: FOLLOW_UP,
  subject_id: MEMBER,
  status: "open",
  basis: "member_commitment",
  summary: "Committed to a Thursday mobility session.",
  due_at: "2026-10-09T18:00:00.000Z",
  timezone: "Europe/Paris",
  next_condition: "Mobility activity logged by Thursday evening.",
  last_evidence_at: null,
  source: { work_id: WORK, slot: "commitment-1" },
  evidence: {
    message_ref: "sealed.ref-1",
    quote: "I will do mobility on Thursday",
  },
  closure_reason: null,
  revision: 1,
  created_at: "2026-10-03T07:01:00.000Z",
  updated_at: "2026-10-03T07:01:00.000Z",
  ...overrides,
});
