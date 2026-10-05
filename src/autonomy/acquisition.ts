import type {
  ActionReceipt,
  FollowUp,
  Intent,
  PublicProjection,
  WorkItem,
} from "./types.js";

// [AC1] contracts §21.3: typed per-cycle records of backend responses with
// provenance. Evidence refs resolve only against what this cycle acquired,
// for the intent's own audience, and project through fixed allowlists. The
// composer input is assembled from these records alone, never from planner
// strings. Nothing is re-fetched to re-authorize (acquisition-time authority).

const HEX = /^[0-9a-f]{24}$/;
const CONVERSATION = /^\/api\/coach\/member-conversations\/([0-9a-f]{24})$/;
const MEMORY = /^\/api\/coach\/memory([/?]|$)/;
const ACTIVITY_SUMMARY = [
  "duration",
  "duration_seconds",
  "distance",
  "distance_meters",
  "calories",
] as const;
const WALK_LIMIT = 4000;

export type EvidenceProjection =
  | {
      kind: "event";
      event_type: string;
      occurred_at: string;
      subject_type: string;
    }
  | ({ kind: "activity" } & Record<string, unknown>)
  | { kind: "member_message"; role: string; text: string; created_at: string }
  | {
      kind: "follow_up";
      basis: string;
      due_at: string;
      status: string;
      quote?: string;
    }
  | { kind: "delivered_message"; text?: string; committed_at: string }
  | ({ kind: "public_activity" } & PublicProjection);

export interface ComposerInput {
  audience: "member" | "public";
  intent: Pick<Intent, "type" | "purpose" | "tone">;
  evidence: EvidenceProjection[];
  limits: { max_chars: number; plain_text: true };
}

const str = (v: unknown, max: number) =>
  typeof v === "string" ? v.slice(0, max) : undefined;
const idOf = (v: any): string | undefined => {
  const raw = v?._id ?? v?.id;
  const id = typeof raw === "string" ? raw : raw?.$oid;
  return typeof id === "string" && HEX.test(id) ? id : undefined;
};
const ownerOf = (v: any): string | undefined => {
  const raw = v?.user_id;
  const id = typeof raw === "string" ? raw : (raw?._id ?? raw?.$oid);
  return typeof id === "string" && HEX.test(id) ? id : undefined;
};

export class AcquisitionLedger {
  private readonly events = new Map<
    string,
    {
      event_type: string;
      occurred_at: string;
      subject: { type: string; id: string };
    }
  >();
  private readonly subjects: Set<string>;
  private readonly activities = new Map<
    string,
    { owner: string; projection: Record<string, unknown> } | null
  >();
  private readonly messages = new Map<
    string,
    { member: string; role: string; text: string; created_at: string }
  >();
  private readonly followUps = new Map<string, FollowUp>();
  private readonly receipts = new Map<
    string,
    { recipient: string; text?: string; committed_at: string }
  >();
  /** Manager-private material, for the defense-in-depth literal check only. */
  readonly privateText: string[] = [];

  constructor(private readonly work: WorkItem) {
    for (const e of work.source.events ?? []) this.events.set(e.ledger_id, e);
    this.subjects = new Set(work.subject_ids);
    for (const r of work.actions)
      if (r.type !== "rest_mutation") this.receipt(r);
  }

  receipt(r: ActionReceipt, text?: string) {
    if (
      r.type === "member_message" &&
      r.status === "delivered" &&
      r.recipient_id
    )
      this.receipts.set(`${this.work.id}/${r.slot}`, {
        recipient: r.recipient_id,
        ...(text !== undefined ? { text } : {}),
        committed_at: r.committed_at,
      });
  }

  followUp(f: FollowUp) {
    this.followUps.set(f.id, f);
  }

  /** One successful planner REST read and its parsed body. */
  read(path: string, body: unknown) {
    let pathname: string;
    try {
      pathname = new URL(path, "http://ledger").pathname;
    } catch {
      return;
    }
    if (MEMORY.test(pathname)) {
      this.strings(body, (s) => this.privateText.push(s));
      return;
    }
    const conversation = CONVERSATION.exec(pathname);
    if (conversation) {
      const member = conversation[1];
      const page = body as any;
      if (page?.member_id !== member || !Array.isArray(page.items)) return;
      for (const item of page.items) {
        const ref = str(item?.message_ref, 600);
        const text = str(item?.text, 8000);
        const created_at = str(item?.created_at, 64);
        if (!ref || text === undefined || !created_at) continue;
        this.messages.set(ref, {
          member,
          role: item.role === "user" ? "member" : "coach",
          text,
          created_at,
        });
      }
      return;
    }
    let budget = WALK_LIMIT;
    const walk = (v: unknown, depth: number) => {
      if (!v || typeof v !== "object" || depth > 6 || --budget < 0) return;
      if (Array.isArray(v)) {
        for (const x of v) walk(x, depth + 1);
        return;
      }
      const o = v as any;
      const id = idOf(o);
      const owner = ownerOf(o);
      if (
        id &&
        owner &&
        typeof o.type === "string" &&
        (typeof o.status === "string" || typeof o.completed_at === "string")
      )
        this.activity(id, owner, o);
      for (const x of Object.values(o)) walk(x, depth + 1);
    };
    walk(body, 0);
  }

  private activity(id: string, owner: string, o: any) {
    const prior = this.activities.get(id);
    // Contradictory provenance for one id is never resolvable host-side.
    if (prior === null || (prior && prior.owner !== owner)) {
      this.activities.set(id, null);
      return;
    }
    const projection: Record<string, unknown> = {};
    for (const [key, max] of [
      ["type", 64],
      ["name", 200],
      ["status", 32],
      ["completed_at", 64],
    ] as const) {
      const v = str(o[key], max);
      if (v !== undefined) projection[key] = v;
    }
    for (const key of ACTIVITY_SUMMARY)
      if (typeof o[key] === "number" && Number.isFinite(o[key]))
        projection[key] = o[key];
    const exercises = Array.isArray(o.data?.exercises) ? o.data.exercises : [];
    const names = exercises
      .map((e: any) => str(e?.name, 80))
      .filter(Boolean)
      .slice(0, 10);
    if (names.length) projection.exercise_names = names;
    if (exercises.some((e: any) => e?.isPR || e?.is_pr || e?.volume_pr))
      projection.personal_record = true;
    this.activities.set(id, { owner, projection });
  }

  private strings(v: unknown, sink: (s: string) => void, depth = 0) {
    if (depth > 8) return;
    if (typeof v === "string") sink(v);
    else if (Array.isArray(v))
      for (const x of v) this.strings(x, sink, depth + 1);
    else if (v && typeof v === "object")
      for (const x of Object.values(v)) this.strings(x, sink, depth + 1);
  }

  /**
   * Resolve every ref for this intent's audience, or refuse. Member messages
   * cite only facts about the recipient; public praise only the attested
   * event and the backend public projection of the praised activity.
   */
  resolve(
    intent: Intent,
    projection?: PublicProjection,
  ): EvidenceProjection[] | "INTENT_EVIDENCE_NOT_AUTHORIZED" {
    const out: EvidenceProjection[] = [];
    const praise = intent.type === "public_praise";
    const recipient = intent.recipient_id;
    for (const ref of intent.evidence_refs) {
      const split = ref.indexOf(":");
      const kind = ref.slice(0, split);
      const value = ref.slice(split + 1);
      let item: EvidenceProjection | undefined;
      if (kind === "ev") {
        const e = this.events.get(value);
        const fits = praise
          ? e?.subject.id === intent.activity_id
          : !!recipient &&
            this.subjects.has(recipient) &&
            (e?.subject.type !== "user" || e.subject.id === recipient);
        if (e && fits)
          item = {
            kind: "event",
            event_type: e.event_type,
            occurred_at: e.occurred_at,
            subject_type: e.subject.type,
          };
      } else if (kind === "pub") {
        if (praise && value === intent.activity_id)
          item = projection
            ? { kind: "public_activity", ...projection }
            : undefined;
        // The projection only exists after the backend accepted the intent.
        if (praise && value === intent.activity_id && !projection) continue;
      } else if (!praise && recipient) {
        if (kind === "act") {
          const a = this.activities.get(value);
          if (a && a.owner === recipient)
            item = { kind: "activity", ...a.projection };
        } else if (kind === "msg") {
          const m = this.messages.get(value);
          if (m && m.member === recipient)
            item = {
              kind: "member_message",
              role: m.role,
              text: m.text,
              created_at: m.created_at,
            };
        } else if (kind === "fu") {
          const f = this.followUps.get(value);
          if (f && f.subject_id === recipient)
            item = {
              kind: "follow_up",
              basis: f.basis,
              due_at: f.due_at,
              status: f.status,
              ...(f.basis === "member_commitment" && f.evidence?.quote
                ? { quote: f.evidence.quote }
                : {}),
            };
        } else if (kind === "rcpt") {
          const r = this.receipts.get(value);
          if (r && r.recipient === recipient)
            item = {
              kind: "delivered_message",
              ...(r.text !== undefined ? { text: r.text } : {}),
              committed_at: r.committed_at,
            };
        }
      }
      if (!item) return "INTENT_EVIDENCE_NOT_AUTHORIZED";
      out.push(item);
    }
    return out;
  }
}

export function composerInput(
  intent: Intent,
  evidence: EvidenceProjection[],
  maxChars: number,
): ComposerInput {
  return {
    audience: intent.type === "public_praise" ? "public" : "member",
    intent: {
      type: intent.type,
      purpose: intent.purpose,
      ...(intent.tone ? { tone: intent.tone } : {}),
    },
    evidence: evidence.slice(0, 8),
    limits: { max_chars: maxChars, plain_text: true },
  };
}

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const WINDOW = 5;

/**
 * Defense in depth only (contracts §21.4 step 2): does the composed text
 * reproduce a literal span of manager-private material that the composer's
 * own (audience-approved) input does not contain?
 */
export function privateLiteral(
  text: string,
  sources: readonly string[],
  allowed: string,
): boolean {
  const output = ` ${normalize(text)} `;
  const raw = text.toLowerCase();
  const input = ` ${normalize(allowed)} `;
  const rawInput = allowed.toLowerCase();
  for (const source of sources) {
    for (const token of source.split(/\s+/)) {
      const t = token
        .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
        .toLowerCase();
      // Distinctive identifier-like tokens: digits, or joined segments.
      if (
        ((t.length >= 6 && /\d/.test(t)) ||
          (t.length >= 12 && /[-_.]/.test(t))) &&
        raw.includes(t) &&
        !rawInput.includes(t)
      )
        return true;
    }
    const words = normalize(source).split(" ").filter(Boolean);
    for (let i = 0; i + WINDOW <= words.length; i++) {
      const span = ` ${words.slice(i, i + WINDOW).join(" ")} `;
      if (output.includes(span) && !input.includes(span)) return true;
    }
  }
  return false;
}

/** Assistant text and tool-call arguments in one provider response. */
export function responseText(body: string, type: string): string[] {
  const out: string[] = [];
  const stream = type === "text/event-stream";
  const take = (choice: any) => {
    const m = choice?.message ?? choice?.delta;
    if (typeof m?.content === "string") out.push(m.content);
    for (const call of Array.isArray(m?.tool_calls) ? m.tool_calls : [])
      if (typeof call?.function?.arguments === "string")
        out.push(call.function.arguments);
  };
  try {
    if (stream) {
      for (const line of body.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        for (const c of JSON.parse(data)?.choices ?? []) take(c);
      }
    } else for (const c of JSON.parse(body)?.choices ?? []) take(c);
  } catch {}
  // Stream deltas split words; whole messages stay separate spans.
  return stream && out.length ? [out.join("")] : out;
}
