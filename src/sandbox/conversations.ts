import { randomBytes, randomUUID, createHash } from "node:crypto";
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
          await this.authority.delete(row.archiveId);
          await this.storage.confirmDelete(row.id);
        } catch {
          /* retry on next inventory */
        }
      }),
    );
    const sessions = await this.storage.list();
    return {
      sessions: sessions.map((row) => ({
        ...row,
        title: `Conversation · ${row.createdAt}`,
      })),
      selected: this.selected ?? sessions[0]?.id ?? null,
    };
  }
  private check(record: NativeHistoryRecord) {
    if (record.blocked === "authority_revoked")
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
      const value = await this.authority.call(ARCHIVE_CONTROLS[0], {
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
        if (row.pendingSeal?.digest !== pending.digest)
          throw new Error("NATIVE_ARCHIVE_STALE");
        row.entries = pending.entries;
        row.archive = archive;
        row.archiveSession = pending.sessionId;
        delete row.pendingSeal;
      });
      record = await this.storage.loadForHost(id);
    }
    return record;
  }
  async read(id: string): Promise<any> {
    // Capture only scope, never cache an allow. No prose in failure envelopes.
    const config = this.store.publicConfig().revision;
    const token = this.store.secrets.token;
    try {
      const record = await this.recover(id);
      this.check(record);
      await this.authority.authorize(record.archive!);
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
          (record.snapshot.personaRevision !== config ||
          record.snapshot.skillsRevision !==
            this.store.skills.runtime().revision
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
  async prepare(): Promise<{
    record?: NativeHistoryRecord;
    resume?: ArchiveResume;
    seed?: FileEntry[];
  }> {
    const id =
      this.selected === null
        ? undefined
        : (this.selected ?? (await this.storage.list())[0]?.id);
    if (!id) return {};
    let record = await this.recover(id);
    this.check(record);
    await this.authority.authorize(record.archive!);
    if (
      record.blocked ||
      nativeResumeBlocker(record.entries) ||
      record.snapshot.personaRevision !== this.store.publicConfig().revision ||
      record.snapshot.skillsRevision !== this.store.skills.runtime().revision
    )
      throw new Error("NATIVE_HISTORY_READ_ONLY");
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
    await actions.reconcile();
    if (
      actions.snapshot().some((a) => ["pending", "unknown"].includes(a.status))
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
            a.status === "delivered",
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
      const config = this.store.publicConfig();
      const skills = this.store.skills.runtime();
      record = await this.storage.create({
        personaRevision: config.revision,
        skillsRevision: skills.revision,
        model: config.provider.model,
        prompt: compileOperator(config, Object.values(this.store.secrets)),
        skills: skills.skills.map((skill) => ({
          name: skill.name,
          body: skill.instructions,
        })),
      });
    }
    const writer = randomBytes(32).toString("hex");
    this.active = { id: record.id, writer };
    this.selected = record.id;
    await this.storage.change(record.id, (row) => {
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
    const record = await this.storage.loadForHost(owner.id);
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
        row.execution?.writer !== owner.writer ||
        row.pendingSeal?.digest !== digest
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
    if (id !== null) await this.storage.select(id);
    this.selected = id;
  }
  async rename(id: string, title: string) {
    const view = await this.read(id);
    if (view.status !== "authorized") throw new Error("NATIVE_ARCHIVE_LOCKED");
    await this.storage.rename(id, title);
  }
  async delete(id: string) {
    const record = await this.storage.loadForHost(id);
    if (this.active?.id === id) throw new Error("NATIVE_HISTORY_BUSY");
    await this.storage.delete(id); // Local fence/erasure precedes network.
    if (this.selected === id) this.selected = undefined;
    if (record.archive) {
      try {
        await this.authority.delete(record.archive.archive_id);
        await this.storage.confirmDelete(id);
      } catch {
        /* durable retry on next inventory */
      }
    }
  }
}
