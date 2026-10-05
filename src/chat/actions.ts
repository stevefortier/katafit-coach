import { createHash, randomBytes } from "node:crypto";
import { History, type Message } from "./history.js";
import { Store, assertNoSecrets } from "../config/store.js";
type RecordedAction = {
  session_id: string;
  idempotency_key: string;
  status: "pending" | "delivered" | "completed" | "unknown" | "not_found";
  tool_name?: string;
  recipient_id?: string;
  member_ref?: string; // retained only for private historical receipts
  turn_generation?: number;
  action_id?: string;
  message_id?: string;
};

/** Backend-attested account binding of one installation and backend origin. */
export type MemberBinding = {
  installation_id: string;
  origin: string;
  account_owner_id: string;
};
/** One intended member delivery: identity is the occurrence, not the words. */
export type MemberDeliveryIntent = {
  occurrence_id: string;
  recipient_id: string;
  payload_sha256: string;
};
/**
 * Content-free durable record of one member delivery occurrence. Legacy sends
 * attested to a binding keep their original key and have no occurrence.
 */
export type MemberDelivery = MemberBinding & {
  format: "member-delivery-v2";
  occurrence_id?: string;
  legacy?: true;
  idempotency_key: string;
  recipient_id: string;
  payload_sha256?: string;
  status: "pending" | "unknown" | "delivered";
  message_id?: string;
};

// Row-pair markers. Legacy rows carry a 64-hex credential scope instead.
const MEMBER_ROW = "member-delivery-v2";
const RETIRED_ROW = "member-delivery-retired-v1";
const LEGACY_RETIRED_FORMAT = "member-delivery-retired-v1";
const RETIRED_FORMAT = "member-delivery-retired-v2";
// Installation lineage: retired digests are only meaningful inside it, so it
// lives in this journal and is never evicted.
const INSTALLATION_ROW = "member-installation-v1";
const META_ROWS = [MEMBER_ROW, RETIRED_ROW, INSTALLATION_ROW];
// Preserve every retired occurrence within the bounded row; saturation rejects
// admission instead of turning old intended actions into new deliveries.
const RETIRED_LIMIT = 900;
const ROW_LIMIT = 40;
export const OCCURRENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MEMBER_FIELDS = [
  "format",
  "installation_id",
  "origin",
  "account_owner_id",
  "occurrence_id",
  "legacy",
  "idempotency_key",
  "recipient_id",
  "payload_sha256",
  "status",
  "message_id",
];
const STATE_ORDER = { pending: 0, unknown: 1, delivered: 2 } as const;

function unsafe(): never {
  throw new Error("UNSAFE_STORAGE");
}
export function validBinding(value: unknown): boolean {
  const v = value as MemberBinding;
  return (
    !!v &&
    typeof v === "object" &&
    typeof v.installation_id === "string" &&
    /^[0-9a-f]{32}$/.test(v.installation_id) &&
    typeof v.origin === "string" &&
    !!v.origin &&
    v.origin.length <= 2048 &&
    typeof v.account_owner_id === "string" &&
    ID_PATTERN.test(v.account_owner_id)
  );
}
/**
 * The origin a supported backend URL resolves to in the REST transport:
 * scheme/host case, a default port and the root slash are not identity.
 */
export function canonicalOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return;
    return url.origin;
  } catch {
    return;
  }
}
const originKey = (origin: string) => canonicalOrigin(origin) ?? origin;
const sameBinding = (a: MemberBinding, b: MemberBinding) =>
  a.installation_id === b.installation_id &&
  originKey(a.origin) === originKey(b.origin) &&
  a.account_owner_id === b.account_owner_id;
const retiredDigest = (
  binding: MemberBinding,
  occurrence: string,
  origin = originKey(binding.origin),
) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        binding.installation_id,
        origin,
        binding.account_owner_id,
        occurrence,
      ]),
    )
    .digest("hex")
    .slice(0, 32);

/** Legacy credential scope: the exact configured origin spelling and secrets. */
export const legacyScope = (origin: string, secrets: object) =>
  createHash("sha256")
    .update(JSON.stringify([origin, secrets]))
    .digest("hex");

export class Actions {
  private storage: History;
  private rows: Message[];
  constructor(
    private store: Store,
    private onDiagnostic?: import("../katafit/client.js").BackendLogger,
  ) {
    this.storage = new History(store.dir, "operator-actions.json");
    this.rows = this.storage.load();
    this.validate(this.rows);
  }
  private scope() {
    return legacyScope(this.store.publicConfig().origin, this.store.secrets);
  }
  // Every row is read explicitly as one known format; anything else fails closed.
  private validate(rows: Message[]) {
    let retired = 0;
    const installations = new Set<string>();
    let lineage: string | undefined;
    for (let i = 1; i < rows.length; i += 2) {
      if (rows[i - 1].text === MEMBER_ROW)
        installations.add(this.decodeMember(rows[i].text).installation_id);
      else if (rows[i - 1].text === RETIRED_ROW) {
        this.decodeRetired(rows[i].text);
        if (++retired > 1) unsafe();
      } else if (rows[i - 1].text === INSTALLATION_ROW) {
        if (lineage) unsafe();
        lineage = this.decodeInstallation(rows[i].text);
      } else this.decode(rows[i].text);
    }
    if (lineage && [...installations].some((id) => id !== lineage)) unsafe();
  }
  private decodeInstallation(text: string): string {
    const v = JSON.parse(text);
    if (
      !v ||
      typeof v !== "object" ||
      Object.keys(v).sort().join() !== "format,installation_id" ||
      v.format !== INSTALLATION_ROW ||
      typeof v.installation_id !== "string" ||
      !/^[0-9a-f]{32}$/.test(v.installation_id)
    )
      unsafe();
    return v.installation_id;
  }
  private decode(text: string): RecordedAction {
    const v = JSON.parse(text);
    if (
      !v ||
      Object.keys(v).some(
        (k) =>
          ![
            "session_id",
            "idempotency_key",
            "status",
            "action_id",
            "message_id",
            "member_ref",
            "recipient_id",
            "tool_name",
            "turn_generation",
          ].includes(k),
      ) ||
      !["pending", "unknown", "not_found", "delivered", "completed"].includes(
        v.status,
      )
    )
      throw new Error("UNSAFE_STORAGE");
    if (
      v.turn_generation !== undefined &&
      (!Number.isInteger(v.turn_generation) ||
        v.turn_generation < 0 ||
        v.turn_generation > 63)
    )
      throw new Error("UNSAFE_STORAGE");
    for (const key of ["session_id", "idempotency_key"])
      if (typeof v[key] !== "string" || !v[key] || v[key].length > 8192)
        throw new Error("UNSAFE_STORAGE");
    if (
      v.tool_name !== undefined &&
      (typeof v.tool_name !== "string" ||
        !/^[a-z][a-z0-9_]{0,127}$/.test(v.tool_name))
    )
      throw new Error("UNSAFE_STORAGE");
    for (const key of ["action_id", "message_id"])
      if (
        v[key] !== undefined &&
        (typeof v[key] !== "string" || !v[key] || v[key].length > 8192)
      )
        throw new Error("UNSAFE_STORAGE");
    if (
      v.member_ref !== undefined &&
      (typeof v.member_ref !== "string" ||
        !v.member_ref ||
        v.member_ref.length > 256)
    )
      throw new Error("UNSAFE_STORAGE");
    if (
      v.recipient_id !== undefined &&
      (typeof v.recipient_id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(v.recipient_id))
    )
      throw new Error("UNSAFE_STORAGE");
    return v;
  }
  private decodeMember(text: string): MemberDelivery {
    const v = JSON.parse(text);
    if (
      !v ||
      typeof v !== "object" ||
      Array.isArray(v) ||
      v.format !== "member-delivery-v2" ||
      Object.keys(v).some((k) => !MEMBER_FIELDS.includes(k)) ||
      !validBinding(v) ||
      !Object.hasOwn(STATE_ORDER, v.status) ||
      typeof v.idempotency_key !== "string" ||
      !ID_PATTERN.test(v.idempotency_key) ||
      typeof v.recipient_id !== "string" ||
      !ID_PATTERN.test(v.recipient_id) ||
      (v.legacy !== undefined && v.legacy !== true) ||
      // A legacy send has no occurrence; a new one has occurrence and digest.
      (v.legacy
        ? v.occurrence_id !== undefined || v.payload_sha256 !== undefined
        : typeof v.occurrence_id !== "string" ||
          !OCCURRENCE_PATTERN.test(v.occurrence_id) ||
          typeof v.payload_sha256 !== "string" ||
          !/^[0-9a-f]{64}$/.test(v.payload_sha256)) ||
      (v.status === "delivered") !== (v.message_id !== undefined) ||
      (v.message_id !== undefined &&
        (typeof v.message_id !== "string" ||
          !v.message_id ||
          v.message_id.length > 256))
    )
      unsafe();
    return v;
  }
  private decodeRetired(text: string): string[] {
    const v = JSON.parse(text);
    if (
      !v ||
      typeof v !== "object" ||
      Object.keys(v).sort().join() !== "format,occurrences" ||
      ![RETIRED_FORMAT, LEGACY_RETIRED_FORMAT].includes(v.format) ||
      !Array.isArray(v.occurrences) ||
      v.occurrences.length > RETIRED_LIMIT ||
      v.occurrences.some(
        (o: unknown) => typeof o !== "string" || !/^[0-9a-f]{32}$/.test(o),
      )
    )
      unsafe();
    return v.occurrences;
  }
  private load() {
    this.rows = this.storage.load();
    this.validate(this.rows);
    return structuredClone(this.rows);
  }
  private commit(next: Message[]) {
    this.validate(next);
    assertNoSecrets(
      next.filter((_, i) => i % 2 === 1),
      Object.values(this.store.secrets),
    );
    this.storage.save(next);
    this.rows = next;
  }
  private resolved(rows: Message[], i: number) {
    if ([RETIRED_ROW, INSTALLATION_ROW].includes(rows[i - 1].text))
      return false;
    if (rows[i - 1].text === MEMBER_ROW)
      return this.decodeMember(rows[i].text).status === "delivered";
    return ["delivered", "completed", "not_found"].includes(
      this.decode(rows[i].text).status,
    );
  }
  // Retain the latest bounded receipts, but never discard an uncertain outcome:
  // that could invite a duplicate send after a transport failure. A retired
  // member occurrence leaves a content-free digest so it can never send again.
  private append(next: Message[], scope: string, text: string) {
    while (next.length + 2 > ROW_LIMIT) {
      const index = next.findIndex(
        (_, i) => i % 2 === 1 && this.resolved(next, i),
      );
      if (index < 0) unsafe();
      const [row, evicted] = next.splice(index - 1, 2);
      if (row.text === MEMBER_ROW) {
        const record = this.decodeMember(evicted.text);
        if (record.occurrence_id) this.retire(next, record);
      }
    }
    next.push({ role: "user", text: scope }, { role: "assistant", text });
  }
  private retire(next: Message[], record: MemberDelivery) {
    let index = next.findIndex((m, i) => i % 2 === 0 && m.text === RETIRED_ROW);
    if (index < 0) {
      next.push(
        { role: "user", text: RETIRED_ROW },
        {
          role: "assistant",
          text: JSON.stringify({ format: RETIRED_FORMAT, occurrences: [] }),
        },
      );
      index = next.length - 2;
    }
    const occurrences = this.decodeRetired(next[index + 1].text);
    const hadOpaqueMarkers = occurrences.length > 0;
    const digest = retiredDigest(record, record.occurrence_id!);
    if (!occurrences.includes(digest)) {
      if (occurrences.length >= RETIRED_LIMIT)
        throw new Error("MEMBER_DELIVERY_LEDGER_FULL");
      occurrences.push(digest);
    }
    const previousFormat = JSON.parse(next[index + 1].text).format;
    next[index + 1].text = JSON.stringify({
      // Never relabel opaque pre-canonical markers as canonical provenance.
      format:
        previousFormat === LEGACY_RETIRED_FORMAT && hadOpaqueMarkers
          ? LEGACY_RETIRED_FORMAT
          : RETIRED_FORMAT,
      occurrences,
    });
  }
  save(action: RecordedAction, scope = this.scope()) {
    this.decode(JSON.stringify(action));
    assertNoSecrets(action, Object.values(this.store.secrets));
    // Writers share one installation process; reload synchronously before a write.
    const next = this.load();
    let index = next.findIndex(
      (m, i) =>
        i % 2 === 1 &&
        next[i - 1].text === scope &&
        this.decode(m.text).idempotency_key === action.idempotency_key &&
        this.decode(m.text).session_id === action.session_id,
    );
    if (index < 0) {
      this.append(next, scope, JSON.stringify(action));
    } else {
      if (
        this.decode(next[index].text).member_ref !== action.member_ref ||
        this.decode(next[index].text).recipient_id !== action.recipient_id
      )
        throw new Error("UNSAFE_STORAGE");
      if (
        ["delivered", "completed"].includes(
          this.decode(next[index].text).status,
        )
      )
        return;
      next[index].text = JSON.stringify(action);
    }
    this.commit(next);
  }
  // Receipts from every authority scope, not only the current one.
  assertSecrets(secrets: string[]) {
    assertNoSecrets(
      this.storage.load().filter((_, i) => i % 2 === 1),
      secrets,
    );
  }
  recorder() {
    const scope = this.scope();
    return (action: RecordedAction) => this.save(action, scope);
  }
  /**
   * Legacy same-credential-scope receipt recovery (no binding available).
   * `scopes` must be spellings of the scope whose credentials `lookup` uses.
   */
  async reconcileMemberReceipts(
    lookup: (recipient: string, key: string) => Promise<string>,
    scopes = [this.scope()],
  ) {
    this.load();
    const pending = this.rows.flatMap((row, index) => {
      const scope = this.rows[index - 1]?.text;
      if (index % 2 !== 1 || !scopes.includes(scope)) return [];
      const action = this.decode(row.text);
      return action.tool_name === "katafit_rest_request" &&
        action.recipient_id &&
        ["pending", "unknown"].includes(action.status)
        ? [{ action, scope }]
        : [];
    });
    for (const { action, scope } of pending) {
      try {
        const message_id = await lookup(
          action.recipient_id!,
          action.idempotency_key,
        );
        if (typeof message_id !== "string" || !message_id) continue;
        this.save({ ...action, status: "delivered", message_id }, scope);
      } catch {
        // A denial, absent receipt or transport fault is not proof of failure.
        // Preserve the original durable fence; never replay the POST.
      }
    }
  }
  private legacyRows(rows: Message[], scope: string) {
    return rows.flatMap((m, i) => {
      if (i % 2 !== 1 || META_ROWS.includes(rows[i - 1].text)) return [];
      const action = this.decode(m.text);
      // An HTTP write has no transferable backend receipt. Changing any
      // credential must not make an unresolved side effect disappear.
      return rows[i - 1].text === scope ||
        (["katafit_rest_request", "coach_call_integration"].includes(
          action.tool_name ?? "",
        ) &&
          ["pending", "unknown"].includes(action.status))
        ? [{ action, scope: rows[i - 1].text }]
        : [];
    });
  }
  /** Content-free view of every visible record, member deliveries included. */
  snapshot(): (RecordedAction | MemberDelivery)[] {
    const rows = this.load();
    const scope = this.scope();
    const actions = [
      ...this.legacyRows(rows, scope).map((entry) => entry.action),
      ...this.memberDeliveries(),
    ];
    assertNoSecrets(actions, Object.values(this.store.secrets));
    return actions;
  }
  /** Any uncertain mutation or delivery fences new side effects. */
  unresolved(exceptKey?: string) {
    return this.snapshot().some(
      (a) =>
        a.status === "unknown" ||
        (a.status === "pending" && a.idempotency_key !== exceptKey),
    );
  }
  memberDeliveries(): MemberDelivery[] {
    const rows = this.load();
    return rows.flatMap((m, i) =>
      i % 2 === 1 && rows[i - 1].text === MEMBER_ROW
        ? [this.decodeMember(m.text)]
        : [],
    );
  }
  /**
   * This installation's durable delivery namespace. `cached` is the ID held by
   * the protected binding cache. An existing lineage must match it; without
   * one, the journal's own member rows (or else the cache) establish it. If
   * retired occurrences survive with no provable lineage, fail closed rather
   * than mint a namespace in which they could be sent again.
   */
  memberInstallation(cached?: string) {
    const next = this.load();
    const row = next.findIndex(
      (m, i) => i % 2 === 0 && m.text === INSTALLATION_ROW,
    );
    if (row >= 0) {
      const lineage = this.decodeInstallation(next[row + 1].text);
      if (cached && cached !== lineage) throw new Error("BINDING_UNAVAILABLE");
      return lineage;
    }
    const recorded = new Set(
      this.memberDeliveries().map((r) => r.installation_id),
    );
    if (recorded.size > 1 || (cached && recorded.size && !recorded.has(cached)))
      throw new Error("BINDING_UNAVAILABLE");
    const retired = next.some((m, i) => i % 2 === 0 && m.text === RETIRED_ROW);
    const installation_id =
      [...recorded][0] ??
      cached ??
      (retired ? undefined : randomBytes(16).toString("hex"));
    if (!installation_id) throw new Error("BINDING_UNAVAILABLE");
    try {
      this.append(
        next,
        INSTALLATION_ROW,
        JSON.stringify({ format: INSTALLATION_ROW, installation_id }),
      );
      this.commit(next);
    } catch {
      throw new Error("BINDING_UNAVAILABLE");
    }
    return installation_id;
  }
  /** Unresolved deliveries this exact installation/origin/account may recover. */
  recoverableMemberDeliveries(binding: MemberBinding) {
    if (!validBinding(binding)) unsafe();
    return this.memberDeliveries().filter(
      (r) => sameBinding(r, binding) && r.status !== "delivered",
    );
  }
  /**
   * Admit one occurrence. The host key is minted and durably saved before the
   * caller may dispatch; reuse never mints another key or permits a new POST.
   * `spellings` are configured spellings of the binding's origin under which
   * older tombstones may have been digested.
   */
  admitMemberDelivery(
    binding: MemberBinding,
    intent: MemberDeliveryIntent,
    spellings: string[] = [],
  ): { mode: "send" | "recover" | "delivered"; record: MemberDelivery } {
    if (
      !validBinding(binding) ||
      !intent ||
      typeof intent.occurrence_id !== "string" ||
      !OCCURRENCE_PATTERN.test(intent.occurrence_id) ||
      typeof intent.recipient_id !== "string" ||
      !ID_PATTERN.test(intent.recipient_id) ||
      typeof intent.payload_sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(intent.payload_sha256)
    )
      throw new Error("DELIVERY_REJECTED");
    // A binding from another (or an unprovable) namespace admits nothing.
    this.memberInstallation(binding.installation_id);
    const next = this.load();
    const existing = this.memberDeliveries().find(
      (r) =>
        sameBinding(r, binding) && r.occurrence_id === intent.occurrence_id,
    );
    if (existing) {
      if (
        existing.recipient_id !== intent.recipient_id ||
        existing.payload_sha256 !== intent.payload_sha256
      )
        throw new Error("OCCURRENCE_CONFLICT");
      return {
        mode: existing.status === "delivered" ? "delivered" : "recover",
        record: existing,
      };
    }
    const retired = next.findIndex(
      (m, i) => i % 2 === 0 && m.text === RETIRED_ROW,
    );
    if (retired >= 0) {
      const ledger = this.decodeRetired(next[retired + 1].text);
      const origin = originKey(binding.origin);
      const aliases = new Set(
        [
          origin,
          binding.origin,
          ...spellings,
          ...this.memberDeliveries().map((r) => r.origin),
        ].filter((spelling) => originKey(spelling) === origin),
      );
      if (
        [...aliases].some((spelling) =>
          ledger.includes(
            retiredDigest(binding, intent.occurrence_id, spelling),
          ),
        )
      )
        throw new Error("OCCURRENCE_CONSUMED");
      // A v1 marker could belong to an origin spelling no longer retained in
      // cache/live records. A missed hash is not proof of a fresh occurrence.
      if (
        ledger.length &&
        JSON.parse(next[retired + 1].text).format === LEGACY_RETIRED_FORMAT
      )
        throw new Error("BINDING_UNAVAILABLE");
    }
    if (this.unresolved()) throw new Error("DELIVERY_UNVERIFIED");
    const record: MemberDelivery = {
      format: "member-delivery-v2",
      installation_id: binding.installation_id,
      origin: binding.origin,
      account_owner_id: binding.account_owner_id,
      occurrence_id: intent.occurrence_id,
      idempotency_key: randomBytes(32).toString("base64url"),
      recipient_id: intent.recipient_id,
      payload_sha256: intent.payload_sha256,
      status: "pending",
    };
    this.append(next, MEMBER_ROW, JSON.stringify(record));
    this.commit(next);
    return { mode: "send", record };
  }
  /** Monotonic: pending -> unknown -> delivered; delivered is terminal. */
  settleMemberDelivery(
    idempotency_key: string,
    update: { status: MemberDelivery["status"]; message_id?: string },
  ) {
    const next = this.load();
    const index = next.findIndex(
      (m, i) =>
        i % 2 === 1 &&
        next[i - 1].text === MEMBER_ROW &&
        this.decodeMember(m.text).idempotency_key === idempotency_key,
    );
    if (index < 0) unsafe();
    const current = this.decodeMember(next[index].text);
    if (STATE_ORDER[update.status] <= STATE_ORDER[current.status]) return;
    const settled: MemberDelivery = { ...current, status: update.status };
    if (update.status === "delivered") settled.message_id = update.message_id;
    next[index].text = JSON.stringify(
      this.decodeMember(JSON.stringify(settled)),
    );
    this.commit(next);
  }
  /**
   * Bind unresolved legacy sends written under `scopes` (default: the current
   * credential scope) to the binding the backend attested for that same
   * credential. Keys, recipients and uncertainty are preserved; no
   * occurrence is invented.
   */
  attestLegacyMemberSends(binding: MemberBinding, scopes = [this.scope()]) {
    if (!validBinding(binding)) unsafe();
    const next = this.load();
    let count = 0;
    for (let i = 1; i < next.length; i += 2) {
      if (!scopes.includes(next[i - 1].text)) continue;
      const action = this.decode(next[i].text);
      if (
        action.tool_name !== "katafit_rest_request" ||
        !action.recipient_id ||
        !["pending", "unknown"].includes(action.status) ||
        !ID_PATTERN.test(action.idempotency_key)
      )
        continue;
      next[i - 1] = { role: "user", text: MEMBER_ROW };
      next[i] = {
        role: "assistant",
        text: JSON.stringify({
          format: "member-delivery-v2",
          ...binding,
          legacy: true,
          idempotency_key: action.idempotency_key,
          recipient_id: action.recipient_id,
          status: action.status,
        }),
      };
      count++;
    }
    if (count) this.commit(next);
    return count;
  }
  /** Content-free counts for visible recovery limitations. */
  memberDeliverySummary(binding?: MemberBinding) {
    const rows = this.load();
    const member = this.memberDeliveries().filter(
      (r) => r.status !== "delivered",
    );
    const legacy = rows.flatMap((m, i) => {
      if (i % 2 !== 1 || META_ROWS.includes(rows[i - 1].text)) return [];
      const action = this.decode(m.text);
      return ["pending", "unknown"].includes(action.status) ? [action] : [];
    });
    return {
      current_unresolved: binding
        ? member.filter((r) => sameBinding(r, binding)).length
        : 0,
      other_binding_unresolved: member.filter(
        (r) => !binding || !sameBinding(r, binding),
      ).length,
      legacy_unbound: legacy.filter(
        (a) => a.tool_name === "katafit_rest_request" && a.recipient_id,
      ).length,
      other_unresolved: legacy.filter(
        (a) => a.tool_name !== "katafit_rest_request" || !a.recipient_id,
      ).length,
    };
  }
}
