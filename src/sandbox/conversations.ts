import { randomBytes, randomUUID, createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { compileOperator, type Store } from "../config/store.js";
import {
  NativeSessionHistory,
  historyDigest,
  nativeResumeBlocker,
  type NativeHistoryRecord,
} from "./sessionHistory.js";
import {
  OperatorArchive,
  ARCHIVE_CONTROLS,
  archiveReceipt,
  type ArchiveResume,
} from "../katafit/operatorArchive.js";
import { Actions } from "../chat/actions.js";
import type { NativeGateway } from "./gateway.js";
import type { captureNativeExchange } from "./sessionCapture.js";
import type { FileEntry } from "@earendil-works/pi-coding-agent";

/** Installation-owned controller. Browser gets content only through read(),
 * whose backend authorization begins after this request and is never cached. */
export class NativeConversations {
  readonly storage: NativeSessionHistory;
  readonly authority: OperatorArchive;
  selected?: string | null;
  active?: { id: string; writer: string };
  constructor(private store: Store) {
    this.storage = new NativeSessionHistory(
      store.dir,
      createHash("sha256").update("native-operator-history-v1").digest("hex"),
      () => Object.values(store.secrets),
    );
    this.authority = new OperatorArchive(store);
  }
  async list() {
    // Local erasure is immediate; lost backend acknowledgements are retried
    // from content-free tombstones, never from a restored transcript.
    await Promise.all(
      (await this.storage.pendingDeletes()).slice(0, 4).map(async (row) => {
        try {
          let archiveId = row.archiveId;
          if (!archiveId && row.seal) {
            const result = await this.authority.call(
              ARCHIVE_CONTROLS[0],
              row.seal,
            );
            archiveId = archiveReceipt(
              result,
              {
                archive_revision: row.seal.archive_revision,
                transcript_digest: row.seal.transcript_digest,
              },
              "sealed",
            ).archive_id;
          }
          if (archiveId) await this.authority.delete(archiveId);
          await this.storage.confirmDelete(row.id);
        } catch {
          /* retry on next inventory */
        }
      }),
    );
    const sessions = await this.visibleSessions();
    return {
      sessions: sessions.map((row) => ({
        ...row,
        title: `Conversation · ${row.createdAt}`,
      })),
      selected: sessions.some((row) => row.id === this.selected)
        ? this.selected
        : (sessions[0]?.id ?? null),
    };
  }
  private localScope() {
    // The private installation directory/admin owns acquired history, not a
    // rotating backend credential. Separate tenants require separate homes.
    return createHash("sha256").update(this.store.dir).digest("hex");
  }
  private async visibleSessions() {
    const rows = await this.storage.list();
    const scope = this.localScope();
    const visible = [];
    for (const row of rows) {
      const record = await this.storage.loadForHost(row.id);
      if (!record.localScope || record.localScope === scope) visible.push(row);
    }
    return visible;
  }
  private currentSnapshot(revision?: number) {
    const config = { ...this.store.publicConfig() };
    if (revision !== undefined) config.revision = revision;
    const skills = this.store.skills.runtime();
    return {
      personaRevision: config.revision,
      skillsRevision: skills.revision,
      model: config.provider.model,
      prompt: compileOperator(config, Object.values(this.store.secrets)),
      skills: skills.skills.map((skill) => ({
        name: skill.name,
        body: skill.instructions,
      })),
    };
  }
  private check(record: NativeHistoryRecord) {
    if (record.localScope && record.localScope !== this.localScope())
      throw new Error("NATIVE_ARCHIVE_REVOKED");

    if (
      !record.archive ||
      record.archive.transcript_digest !==
        historyDigest(record.entries, record.snapshot)
    )
      throw new Error("NATIVE_ARCHIVE_UNSEALED");
  }
  private async recover(id: string) {
    let record = await this.storage.loadForHost(id);
    if (record.pendingSeal) {
      const pending = record.pendingSeal;
      if (pending.digest !== historyDigest(pending.entries, record.snapshot))
        throw new Error("NATIVE_ARCHIVE_CORRUPT");
      if (record.localScope && record.localScope !== this.localScope())
        throw new Error("NATIVE_ARCHIVE_REVOKED");
      const value = record.localScope
        ? {
            schema_version: 1,
            status: "sealed",
            archive_id: pending.sessionId,
            archive_revision: pending.revision,
            transcript_digest: pending.digest,
          }
        : await this.authority.call(ARCHIVE_CONTROLS[0], {
            session_id: pending.sessionId,
            turn_generation: pending.generation,
            archive_revision: pending.revision,
            transcript_digest: pending.digest,
          });
      const archive = archiveReceipt(
        value,
        {
          archive_revision: pending.revision,
          transcript_digest: pending.digest,
        },
        "sealed",
      );
      await this.storage.change(id, (row) => {
        if (
          row.archiveSession === pending.sessionId &&
          row.archive?.archive_revision === pending.revision &&
          row.archive.transcript_digest === pending.digest
        )
          return;
        if (
          row.pendingSeal?.digest !== pending.digest ||
          row.pendingSeal.revision !== pending.revision ||
          row.pendingSeal.sessionId !== pending.sessionId
        )
          throw new Error("NATIVE_ARCHIVE_STALE");
        // Only a successor checkpoint retires a predecessor's resume input.
        if (row.resume && row.archiveSession !== pending.sessionId)
          delete row.resume;
        row.entries = pending.entries;
        row.archive = archive;
        row.archiveSession = pending.sessionId;
        delete row.pendingSeal;
      });
      record = await this.storage.loadForHost(id);
    }
    return record;
  }
  async flush() {
    if (this.active) await this.recover(this.active.id);
  }
  async read(id: string): Promise<any> {
    // Capture only scope, never cache an allow. No prose in failure envelopes.
    const config = this.store.publicConfig().revision;
    const token = this.store.secrets.token;
    try {
      const record = await this.recover(id);
      this.check(record);
      // The authenticated installation already holds these sealed entries.
      // Backend authorization applies to new fetches, not local archive display.
      const latest = await this.storage.loadForHost(id);
      if (
        latest.revision !== record.revision ||
        config !== this.store.publicConfig().revision ||
        token !== this.store.secrets.token
      )
        throw new Error("NATIVE_ARCHIVE_STALE");
      return {
        id,
        status: "authorized",
        title: record.title,
        snapshot: record.snapshot,
        entries: record.entries,
        reason:
          record.blocked ??
          nativeResumeBlocker(record.entries) ??
          (!isDeepStrictEqual(
            record.localScope
              ? { ...record.snapshot, personaRevision: 0 }
              : record.snapshot,
            record.localScope
              ? {
                  ...this.currentSnapshot(record.snapshot.personaRevision),
                  personaRevision: 0,
                }
              : this.currentSnapshot(),
          )
            ? "settings_changed"
            : null),
        attachments: "Workspace files and attachments are not retained.",
        refreshAfterMs: 10000,
        expiresAfterMs: 20000,
      };
    } catch (error) {
      if ((error as any)?.contextRevoked || (error as any)?.context_revoked)
        await this.lock(id);
      return {
        id,
        status: "locked",
        reason:
          "Current source or credential authority could not be verified. History is withheld; retry or start a new conversation.",
      };
    }
  }
  async lock(id: string) {
    await this.storage
      .change(id, (row) => {
        row.blocked = "authority_revoked";
      })
      .catch(() => {});
  }
  async resumeFailed(record: NativeHistoryRecord | undefined, error: unknown) {
    if (!record) return;
    if ((error as any)?.contextRevoked) return this.lock(record.id);
    const code = (error as any)?.code ?? (error as Error)?.message;
    if (["OPERATOR_BUDGET_EXHAUSTED", "OPERATOR_CONFLICT"].includes(code))
      await this.storage.change(record.id, (row) => {
        row.blocked = "resume_unavailable";
      });
  }
  async prepare(signal?: AbortSignal): Promise<{
    record?: NativeHistoryRecord;
    resume?: ArchiveResume;
    seed?: FileEntry[];
  }> {
    // Preserve the existing no-network uncertain-action fence when there is
    // no durable predecessor to reconcile. Archive resume itself scopes its
    // receipts below and the backend validates the inherited chain ledger.
    if (
      new Actions(this.store)
        .snapshot()
        .some((a) => ["pending", "unknown"].includes(a.status)) &&
      (this.selected === null || !(await this.storage.list()).length)
    )
      throw new Error("DELIVERY_UNVERIFIED");
    const id =
      this.selected === null
        ? undefined
        : (this.selected ?? (await this.visibleSessions())[0]?.id);
    if (!id) return {};
    let record: NativeHistoryRecord;
    try {
      record = await this.recover(id);
      this.check(record);
      if (!record.localScope) await this.authority.authorize(record.archive!);
    } catch (error) {
      if ((error as any)?.contextRevoked || (error as any)?.context_revoked)
        await this.lock(id);
      throw error;
    }
    if (
      record.blocked ||
      nativeResumeBlocker(record.entries) ||
      !isDeepStrictEqual(
        record.localScope
          ? { ...record.snapshot, personaRevision: 0 }
          : record.snapshot,
        record.localScope
          ? {
              ...this.currentSnapshot(record.snapshot.personaRevision),
              personaRevision: 0,
            }
          : this.currentSnapshot(),
      )
    )
      throw new Error("NATIVE_HISTORY_READ_ONLY");
    if (record.localScope) {
      if (
        new Actions(this.store)
          .snapshot()
          .some((a) => ["pending", "unknown"].includes(a.status))
      )
        throw new Error("DELIVERY_UNVERIFIED");
      this.selected = id;
      return { record, seed: record.entries };
    }
    if (record.execution) {
      const closed = await this.authority.call(
        "studio_operator_close_session",
        { session_id: record.execution.sessionId },
      );
      if (
        closed?.schema_version !== 1 ||
        closed.session_id !== record.execution.sessionId ||
        closed.status !== "closed"
      )
        throw new Error("NATIVE_HISTORY_CLOSE_UNCONFIRMED");
    }
    const actions = new Actions(this.store);
    if (!record.execution) throw new Error("NATIVE_HISTORY_READ_ONLY");
    await actions.reconcile(record.execution.sessionId);
    if (
      actions
        .snapshot()
        .some(
          (a) =>
            a.session_id === record.execution?.sessionId &&
            ["pending", "unknown"].includes(a.status),
        )
    )
      throw new Error("DELIVERY_UNVERIFIED");
    if (!record.resume) {
      // A last provider checkpoint can precede a committed tool whose ACK was
      // lost. After confirmed close + receipt reconciliation, seal the same
      // canonical safe prefix against the final backend execution checkpoint.
      // Never invent the missing tool result. Interrupted prefixes were refused
      // above; a journaled resume must retry identically, never reseal a parent
      // that may already have an accepted successor.
      if (!record.execution) throw new Error("NATIVE_HISTORY_READ_ONLY");
      const execution = record.execution;
      await this.storage.change(id, (row) => {
        row.pendingSeal = {
          entries: record.entries,
          digest: historyDigest(record.entries, record.snapshot),
          revision: record.archive!.archive_revision + 1,
          sessionId: execution.sessionId,
          generation: execution.generation,
        };
      });
      record = await this.recover(id);
      const delivered = actions
        .snapshot()
        .filter(
          (a) =>
            a.session_id === record.execution?.sessionId &&
            a.status === "delivered" &&
            a.turn_generation === record.execution?.generation,
        )
        .at(-1);
      const resume: ArchiveResume = {
        ...record.archive!,
        idempotency_key: randomUUID(),
        ...(delivered ? { resolved_action_id: delivered.action_id } : {}),
      };
      await this.storage.change(id, (row) => {
        row.resume = resume;
      });
      record.resume = resume;
    }
    this.selected = id;
    return { record, resume: record.resume, seed: record.entries };
  }
  async bind(
    gateway: NativeGateway,
    prepared: { record?: NativeHistoryRecord },
  ) {
    const state = gateway.historyState?.();
    if (!state?.supported) return;
    let record = prepared.record;
    if (!record) {
      record = await this.storage.create(this.currentSnapshot());
    }
    const writer = randomBytes(32).toString("hex");
    this.active = { id: record.id, writer };
    this.selected = record.id;
    await this.storage.change(record.id, (row) => {
      if (state.local) row.localScope = this.localScope();
      row.execution = {
        sessionId: state.sessionId,
        generation: state.generation,
        writer,
      };
      row.state = "open";
    });
    // A successor starts with a sealed copy, before any provider work can occur.
    if (record.entries.length)
      await this.capture(gateway, {
        entries: record.entries,
        complete: true,
        imagesOmitted: false,
      });
  }
  async capture(
    gateway: NativeGateway,
    capture: NonNullable<ReturnType<typeof captureNativeExchange>>,
  ) {
    const owner = this.active,
      state = gateway.historyState?.();
    if (!owner || !state?.supported || !gateway.sealHistory) return;
    // A lost acknowledgement must be reconciled with its exact journaled
    // input before a later capture can choose a revision or replace the tail.
    const record = await this.recover(owner.id);
    const digest = historyDigest(capture.entries, record.snapshot);
    const revision =
      record.archive && record.archiveSession === state.sessionId
        ? record.archive.archive_revision + 1
        : 1;
    await this.storage.change(owner.id, (row) => {
      if (row.execution?.writer !== owner.writer)
        throw new Error("NATIVE_HISTORY_STALE_WRITER");
      row.execution.generation = state.generation;
      row.pendingSeal = {
        entries: capture.entries,
        digest,
        revision,
        sessionId: state.sessionId,
        generation: state.generation,
      };
      if (capture.imagesOmitted) row.blocked = "images_not_retained";
      else if (!capture.complete) row.blocked = "interrupted_turn";
      else if (row.blocked === "interrupted_turn") delete row.blocked;
    });
    const archive = await gateway.sealHistory(revision, digest);
    await this.storage.change(owner.id, (row) => {
      if (
        row.execution?.writer === owner.writer &&
        row.archiveSession === state.sessionId &&
        row.archive?.archive_revision === revision &&
        row.archive.transcript_digest === digest
      )
        return;
      if (
        row.execution?.writer !== owner.writer ||
        row.pendingSeal?.digest !== digest ||
        row.pendingSeal.revision !== revision ||
        row.pendingSeal.sessionId !== state.sessionId
      )
        throw new Error("NATIVE_HISTORY_STALE_WRITER");
      row.entries = capture.entries;
      row.archive = archive;
      row.archiveSession = state.sessionId;
      delete row.pendingSeal;
      delete row.resume;
    });
  }
  async finish(gateway?: NativeGateway) {
    const owner = this.active;
    this.active = undefined;
    if (!owner) return;
    await this.storage.stop(owner.id);
  }
  async select(id: string | null) {
    if (id !== null) {
      const record = await this.storage.loadForHost(id);
      if (record.localScope && record.localScope !== this.localScope())
        throw new Error("NATIVE_ARCHIVE_REVOKED");
      await this.storage.select(id);
    }
    this.selected = id;
  }
  async rename(id: string, title: string) {
    const view = await this.read(id);
    if (view.status !== "authorized") throw new Error("NATIVE_ARCHIVE_LOCKED");
    await this.storage.rename(id, title);
  }
  async delete(id: string) {
    const record = await this.storage.loadForHost(id);
    if (record.localScope && record.localScope !== this.localScope())
      throw new Error("NATIVE_ARCHIVE_REVOKED");
    if (this.active?.id === id) throw new Error("NATIVE_HISTORY_BUSY");
    await this.storage.delete(id); // Local fence/erasure precedes network.
    if (this.selected === id) this.selected = undefined;
    // Content-free pending seal inputs survive local erasure, allowing exact
    // lost-ACK recovery followed by chain deletion even after restart.
    await this.list();
  }
}
