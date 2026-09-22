import { createHash } from "node:crypto";
import { History, type Message } from "./history.js";
import { Store, assertNoSecrets } from "../config/store.js";
import type { OperatorAction } from "../katafit/operatorTools.js";
import { Client } from "../katafit/client.js";

export class Actions {
  private storage: History;
  private rows: Message[];
  constructor(private store: Store) {
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
  private decode(text: string): OperatorAction {
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
          ].includes(k),
      ) ||
      !["pending", "unknown", "not_found", "delivered"].includes(v.status)
    )
      throw new Error("UNSAFE_STORAGE");
    for (const key of ["session_id", "idempotency_key"])
      if (typeof v[key] !== "string" || !v[key] || v[key].length > 8192)
        throw new Error("UNSAFE_STORAGE");
    for (const key of ["action_id", "message_id"])
      if (
        v[key] !== undefined &&
        (typeof v[key] !== "string" || !v[key] || v[key].length > 8192)
      )
        throw new Error("UNSAFE_STORAGE");
    return v;
  }
  save(action: OperatorAction, scope = this.scope()) {
    assertNoSecrets(action, Object.values(this.store.secrets));
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
            ["delivered", "not_found"].includes(this.decode(m.text).status),
        );
        if (resolved < 0) throw new Error("UNSAFE_STORAGE");
        next.splice(resolved - 1, 2);
      }
      next.push(
        { role: "user", text: scope },
        { role: "assistant", text: JSON.stringify(action) },
      );
    } else {
      if (this.decode(next[index].text).status === "delivered") return;
      next[index].text = JSON.stringify(action);
    }
    this.storage.save(next);
    this.rows = next;
  }
  recorder() {
    const scope = this.scope();
    return (action: OperatorAction) => this.save(action, scope);
  }
  snapshot() {
    const scope = this.scope();
    const actions = this.rows.flatMap((m, i) =>
      i % 2 === 1 && this.rows[i - 1].text === scope
        ? [this.decode(m.text)]
        : [],
    );
    assertNoSecrets(actions, Object.values(this.store.secrets));
    return actions;
  }
  async reconcile() {
    const record = this.recorder();
    const client = new Client(
      this.store.publicConfig().origin,
      this.store.secrets.token,
      AbortSignal.timeout(10000),
    );
    for (const action of this.snapshot().filter(
      (a) => a.status === "pending" || a.status === "unknown",
    )) {
      try {
        // Close serializes with any in-flight delivery before readback.
        const closed = await client.call("studio_operator_close_session", {
          session_id: action.session_id,
        });
        if (
          closed.schema_version !== 1 ||
          closed.session_id !== action.session_id ||
          closed.status !== "closed"
        )
          throw new Error("RESULT_REJECTED");
        const v = await client.call("studio_operator_get_action", {
          session_id: action.session_id,
          idempotency_key: action.idempotency_key,
        });
        assertNoSecrets(v, Object.values(this.store.secrets));
        if (v.schema_version !== 1 || v.session_id !== action.session_id)
          throw new Error("RESULT_REJECTED");
        if (v.status === "not_found")
          record({ ...action, status: "not_found" });
        else if (
          v.status === "delivered" &&
          typeof v.action_id === "string" &&
          v.action_id &&
          typeof v.message_id === "string" &&
          v.message_id
        )
          record(
            this.decode(
              JSON.stringify({
                ...action,
                status: "delivered",
                action_id: v.action_id,
                message_id: v.message_id,
              }),
            ),
          );
        else throw new Error("RESULT_REJECTED");
      } catch {
        record({ ...action, status: "unknown" });
      }
    }
  }
}
