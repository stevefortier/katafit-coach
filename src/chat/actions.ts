import { createHash } from "node:crypto";
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

export class Actions {
  private storage: History;
  private rows: Message[];
  constructor(
    private store: Store,
    private onDiagnostic?: import("../katafit/client.js").BackendLogger,
  ) {
    this.storage = new History(store.dir, "operator-actions.json");
    this.rows = this.storage.load();
    for (let i = 1; i < this.rows.length; i += 2)
      this.decode(this.rows[i].text);
  }
  private scope() {
    return createHash("sha256")
      .update(
        JSON.stringify([this.store.publicConfig().origin, this.store.secrets]),
      )
      .digest("hex");
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
  save(action: RecordedAction, scope = this.scope()) {
    this.decode(JSON.stringify(action));
    assertNoSecrets(action, Object.values(this.store.secrets));
    // Writers share one installation process; reload synchronously before a write.
    this.rows = this.storage.load();
    const next = structuredClone(this.rows);
    let index = next.findIndex(
      (m, i) =>
        i % 2 === 1 &&
        next[i - 1].text === scope &&
        this.decode(m.text).idempotency_key === action.idempotency_key &&
        this.decode(m.text).session_id === action.session_id,
    );
    if (index < 0) {
      // Retain the latest bounded receipts, but never discard an uncertain
      // outcome: that could invite a duplicate send after a transport failure.
      if (next.length >= 40) {
        const resolved = next.findIndex(
          (m, i) =>
            i % 2 === 1 &&
            ["delivered", "completed", "not_found"].includes(
              this.decode(m.text).status,
            ),
        );
        if (resolved < 0) throw new Error("UNSAFE_STORAGE");
        next.splice(resolved - 1, 2);
      }
      next.push(
        { role: "user", text: scope },
        { role: "assistant", text: JSON.stringify(action) },
      );
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
    this.storage.save(next);
    this.rows = next;
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
  async reconcileMemberReceipts(
    lookup: (recipient: string, key: string) => Promise<string>,
  ) {
    this.rows = this.storage.load();
    const scope = this.scope();
    const pending = this.rows.flatMap((row, index) => {
      if (index % 2 !== 1 || this.rows[index - 1].text !== scope) return [];
      const action = this.decode(row.text);
      return action.tool_name === "katafit_rest_request" &&
        action.recipient_id &&
        ["pending", "unknown"].includes(action.status)
        ? [action]
        : [];
    });
    for (const action of pending) {
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
  snapshot() {
    this.rows = this.storage.load();
    const scope = this.scope();
    const actions = this.rows.flatMap((m, i) => {
      if (i % 2 !== 1) return [];
      const action = this.decode(m.text);
      // An HTTP write has no transferable backend receipt. Changing any
      // credential must not make an unresolved side effect disappear.
      return this.rows[i - 1].text === scope ||
        (action.tool_name === "katafit_rest_request" &&
          ["pending", "unknown"].includes(action.status))
        ? [action]
        : [];
    });
    assertNoSecrets(actions, Object.values(this.store.secrets));
    return actions;
  }
}
