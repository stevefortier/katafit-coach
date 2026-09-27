import { randomBytes, createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { assertNoSecrets } from "../config/store.js";
import {
  archiveIdentity,
  type ArchiveIdentity,
  type ArchiveResume,
} from "../katafit/operatorArchive.js";

/** Private host storage only. NOT an authorization or archive disclosure API.
 * Not wired into NativeTerminal until the backend has durable archive authority.
 * No model, browser or sandbox may call loadForHost or select the storage path.
 */
export interface NativeHistorySnapshot {
  personaRevision: number;
  skillsRevision: number;
  model: string;
  prompt: string;
  skills: { name: string; body: string }[];
}
export interface NativeHistoryRecord {
  id: string;
  revision: number;
  state: "open" | "stopped";
  title: string;
  createdAt: string;
  updatedAt: string;
  snapshot: NativeHistorySnapshot;
  entries: FileEntry[];
  archive?: ArchiveIdentity;
  archiveSession?: string;
  execution?: { sessionId: string; generation: number; writer: string };
  resume?: ArchiveResume;
  blocked?: string;
  pendingSeal?: {
    entries: FileEntry[];
    digest: string;
    revision: number;
    sessionId: string;
    generation: number;
  };
}
interface Manifest {
  version: 1;
  sessions: NativeHistoryRecord[];
  tombstones?: { id: string; archiveId?: string }[];
}
export const historyDigest = (
  entries: FileEntry[],
  snapshot: NativeHistorySnapshot,
) =>
  createHash("sha256")
    .update(JSON.stringify({ entries, snapshot }))
    .digest("hex");
const limit = 16 * 1024 * 1024;
const identity = /^[a-f0-9]{64}$/;
// The appliance has one externally supervised owner process. Within that
// process all instances share a queue; delete/checkpoint can't race a reload.
const writers = new Map<string, Promise<unknown>>();
async function openDirectory(path: string) {
  let held = await open("/", constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const part of resolve(path).split("/").filter(Boolean)) {
      const next = await open(
        `/proc/self/fd/${held.fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await held.close();
      held = next;
    }
    const info = await held.stat();
    if (info.uid !== process.getuid?.() || info.mode & 0o077)
      throw new Error("NATIVE_HISTORY_STORAGE");
    return held;
  } catch (error) {
    await held.close();
    throw error;
  }
}
const exact = (value: unknown, keys: string[]) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === keys.sort().join(",");
const bounded = (value: unknown, size: number) =>
  typeof value === "string" && Buffer.byteLength(value) <= size;
function validateSnapshot(value: NativeHistorySnapshot) {
  if (
    !exact(value, [
      "personaRevision",
      "skillsRevision",
      "model",
      "prompt",
      "skills",
    ]) ||
    !Number.isSafeInteger(value.personaRevision) ||
    value.personaRevision < 1 ||
    !Number.isSafeInteger(value.skillsRevision) ||
    value.skillsRevision < 1 ||
    !bounded(value.model, 256) ||
    !bounded(value.prompt, 256 * 1024) ||
    !Array.isArray(value.skills) ||
    value.skills.length > 32 ||
    value.skills.some(
      (skill) =>
        !exact(skill, ["name", "body"]) ||
        !bounded(skill.name, 128) ||
        !bounded(skill.body, 64 * 1024),
    )
  )
    throw new Error("NATIVE_HISTORY_SNAPSHOT");
}
function validateTitle(title: string) {
  if (
    !bounded(title, 120) ||
    !title.trim() ||
    /[\u0000-\u001f\u007f]/.test(title)
  )
    throw new Error("NATIVE_HISTORY_TITLE");
}
function containsImage(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if ((value as { type?: string }).type === "image") return true;
  return Object.values(value).some(containsImage);
}
/** Necessary native-format checks ONLY; null is never a permission or an action
 * reconciliation receipt. The host still needs fresh durable backend authority
 * and a reconciled action journal before either rendering or resuming. Unknown
 * extensions/compactions are deliberately archive-only in this foundation. */
export function nativeResumeBlocker(
  entries: unknown[],
):
  | "malformed_history"
  | "unsupported_format"
  | "unsupported_entry"
  | "interrupted_turn"
  | "image_content"
  | null {
  if (!Array.isArray(entries) || !entries.length || entries.length > 10000)
    return "malformed_history";
  const [header, ...rest] = entries as any[];
  if (
    !header ||
    header.type !== "session" ||
    typeof header.id !== "string" ||
    header.cwd !== "/workspace" ||
    !Number.isFinite(Date.parse(header.timestamp))
  )
    return "malformed_history";
  if (header.version !== 3) return "unsupported_format";
  const ids = new Set<string>();
  const calls = new Set<string>();
  let lastMessage: any;
  for (const entry of rest) {
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !/^[a-f0-9]{8}$/.test(entry.id) ||
      ids.has(entry.id) ||
      (entry.parentId !== null && !ids.has(entry.parentId)) ||
      !Number.isFinite(Date.parse(entry.timestamp))
    )
      return "malformed_history";
    ids.add(entry.id);
    if (
      ![
        "message",
        "model_change",
        "thinking_level_change",
        "session_info",
        "label",
        "usage",
      ].includes(entry.type)
    )
      return "unsupported_entry";
    if (containsImage(entry)) return "image_content";
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (
      !message ||
      !["user", "assistant", "toolResult"].includes(message.role) ||
      !(typeof message.content === "string" || Array.isArray(message.content))
    )
      return "unsupported_entry";
    if (message.role === "assistant") {
      if (!["stop", "toolUse"].includes(message.stopReason))
        return "interrupted_turn";
      if (!Array.isArray(message.content)) return "malformed_history";
      for (const part of message.content) {
        if (part?.type === "toolCall") {
          if (typeof part.id !== "string" || calls.has(part.id))
            return "malformed_history";
          calls.add(part.id);
        }
      }
    }
    if (message.role === "toolResult") {
      if (!calls.delete(message.toolCallId)) return "malformed_history";
    }
    lastMessage = message;
  }
  if (
    calls.size ||
    (lastMessage &&
      (lastMessage.role !== "assistant" || lastMessage.stopReason !== "stop"))
  )
    return "interrupted_turn";
  return null;
}
function validateManifest(value: any): asserts value is Manifest {
  const fail = () => {
    throw new Error("NATIVE_HISTORY_STORAGE");
  };
  const instant = (v: unknown) =>
    typeof v === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
    Number.isFinite(Date.parse(v));
  const entries = (v: unknown) =>
    Array.isArray(v) &&
    v.length <= 10000 &&
    Buffer.byteLength(JSON.stringify(v)) <= 2 * 1024 * 1024 &&
    !containsImage(v);
  if (
    !value ||
    value.version !== 1 ||
    Object.keys(value).some(
      (k) => !["version", "sessions", "tombstones"].includes(k),
    ) ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > 64 ||
    (value.tombstones !== undefined &&
      (!Array.isArray(value.tombstones) || value.tombstones.length > 4096))
  )
    fail();
  const ids = new Set<string>();
  for (const row of value.sessions) {
    if (
      !row ||
      Object.keys(row).some(
        (k) =>
          ![
            "id",
            "revision",
            "state",
            "title",
            "createdAt",
            "updatedAt",
            "snapshot",
            "entries",
            "archive",
            "archiveSession",
            "execution",
            "resume",
            "blocked",
            "pendingSeal",
          ].includes(k),
      ) ||
      !identity.test(row.id) ||
      ids.has(row.id) ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      !["open", "stopped"].includes(row.state) ||
      !instant(row.createdAt) ||
      !instant(row.updatedAt) ||
      !entries(row.entries)
    )
      fail();
    ids.add(row.id);
    try {
      validateSnapshot(row.snapshot);
      validateTitle(row.title);
    } catch {
      fail();
    }
    if (row.archiveSession !== undefined && !identity.test(row.archiveSession))
      fail();
    if (
      row.blocked !== undefined &&
      ![
        "authority_revoked",
        "images_not_retained",
        "interrupted_turn",
        "resume_unavailable",
      ].includes(row.blocked)
    )
      fail();
    if (row.archive !== undefined) {
      try {
        archiveIdentity(row.archive);
      } catch {
        fail();
      }
      if (
        !exact(row.archive, [
          "archive_id",
          "archive_revision",
          "transcript_digest",
        ]) ||
        row.archive.transcript_digest !==
          historyDigest(row.entries, row.snapshot)
      )
        fail();
    }
    if (
      row.execution !== undefined &&
      (!exact(row.execution, ["sessionId", "generation", "writer"]) ||
        !identity.test(row.execution.sessionId) ||
        !identity.test(row.execution.writer) ||
        !Number.isSafeInteger(row.execution.generation) ||
        row.execution.generation < 0 ||
        row.execution.generation > 63)
    )
      fail();
    if (row.resume !== undefined) {
      try {
        archiveIdentity(row.resume);
      } catch {
        fail();
      }
      if (
        Object.keys(row.resume).some(
          (k) =>
            ![
              "archive_id",
              "archive_revision",
              "transcript_digest",
              "idempotency_key",
              "resolved_action_id",
            ].includes(k),
        ) ||
        typeof row.resume.idempotency_key !== "string" ||
        !/^[a-f0-9-]{36}$/.test(row.resume.idempotency_key) ||
        (row.resume.resolved_action_id !== undefined &&
          !identity.test(row.resume.resolved_action_id))
      )
        fail();
    }
    if (row.pendingSeal !== undefined) {
      const p = row.pendingSeal;
      if (
        !exact(p, [
          "entries",
          "digest",
          "revision",
          "sessionId",
          "generation",
        ]) ||
        !entries(p.entries) ||
        !identity.test(p.digest) ||
        !identity.test(p.sessionId) ||
        !Number.isSafeInteger(p.revision) ||
        p.revision < 1 ||
        !Number.isSafeInteger(p.generation) ||
        p.generation < 0 ||
        p.generation > 63 ||
        p.digest !== historyDigest(p.entries, row.snapshot)
      )
        fail();
    }
  }
  for (const row of value.tombstones ?? []) {
    if (
      !row ||
      Object.keys(row).some((k) => !["id", "archiveId"].includes(k)) ||
      !identity.test(row.id) ||
      ids.has(row.id) ||
      (row.archiveId !== undefined && !identity.test(row.archiveId))
    )
      fail();
    ids.add(row.id);
  }
}
export class NativeSessionHistory {
  private readonly name: string;
  constructor(
    private readonly home: string,
    scope: string,
    private readonly secrets: () => string[] = () => [],
  ) {
    if (!identity.test(scope)) throw new Error("NATIVE_HISTORY_SCOPE");
    this.name = `native-history-${scope}.json`;
  }
  private operation<T>(fn: (root: string) => Promise<T>): Promise<T> {
    const key = resolve(this.home) + "/" + this.name;
    const pending = (writers.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const dir = await openDirectory(this.home);
        try {
          const path = `/proc/self/fd/${dir.fd}/operator-sessions`;
          await mkdir(path, { mode: 0o700 }).catch((error) => {
            if (error.code !== "EEXIST") throw error;
          });
          const history = await open(
            path,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          try {
            const info = await history.stat();
            if (info.uid !== process.getuid?.() || info.mode & 0o077)
              throw new Error("NATIVE_HISTORY_STORAGE");
            return await fn(`/proc/self/fd/${history.fd}`);
          } finally {
            await history.close();
          }
        } finally {
          await dir.close();
        }
      });
    writers.set(key, pending);
    void pending
      .finally(() => {
        if (writers.get(key) === pending) writers.delete(key);
      })
      .catch(() => {});
    return pending;
  }
  private async read(root: string): Promise<Manifest> {
    let file;
    try {
      file = await open(
        `${root}/${this.name}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, sessions: [] };
      throw error;
    }
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.uid !== process.getuid?.() ||
        info.mode & 0o077 ||
        info.size > limit
      )
        throw new Error("NATIVE_HISTORY_STORAGE");
      const bytes = Buffer.alloc(info.size + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== info.size) throw new Error("NATIVE_HISTORY_STORAGE");
      const value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
      validateManifest(value);
      return value;
    } finally {
      await file.close();
    }
  }
  private async write(root: string, value: Manifest) {
    validateManifest(value);
    try {
      assertNoSecrets(value, this.secrets());
    } catch {
      throw new Error("NATIVE_HISTORY_SECRET");
    }
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > limit || value.sessions.length > 64)
      throw new Error("NATIVE_HISTORY_LIMIT");
    const temp = `${root}/.${this.name}.${randomBytes(16).toString("hex")}.tmp`;
    const file = await open(
      temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      await rename(temp, `${root}/${this.name}`);
      const dir = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } finally {
      await file.close().catch(() => {});
      await unlink(temp).catch(() => {});
    }
  }
  create(snapshot: NativeHistorySnapshot): Promise<NativeHistoryRecord> {
    const frozen = structuredClone(snapshot);
    return this.operation(async (root) => {
      validateSnapshot(frozen);
      const value = await this.read(root);
      const at = new Date().toISOString();
      const record: NativeHistoryRecord = {
        id: randomBytes(32).toString("hex"),
        revision: 1,
        state: "open",
        title: "New conversation",
        createdAt: at,
        updatedAt: at,
        snapshot: frozen,
        entries: [],
      };
      value.sessions.unshift(record);
      await this.write(root, value);
      return structuredClone(record);
    });
  }
  checkpoint(id: string, entries: FileEntry[]): Promise<void> {
    const frozen = structuredClone(entries);
    return this.operation(async (root) => {
      if (containsImage(frozen))
        throw new Error("NATIVE_HISTORY_IMAGE_UNSUPPORTED");
      const value = await this.read(root);
      const record = value.sessions.find((record) => record.id === id);
      if (!record) throw new Error("NATIVE_HISTORY_NOT_FOUND");
      if (record.state === "stopped") throw new Error("NATIVE_HISTORY_STOPPED");
      record.entries = frozen;
      record.updatedAt = new Date().toISOString();
      record.revision++;
      await this.write(root, value);
    });
  }
  /** Host-internal hydration; callers MUST establish fresh backend authority
   * before any browser/provider disclosure, including titles and snapshots. */
  loadForHost(id: string): Promise<NativeHistoryRecord> {
    return this.operation(async (root) => {
      const value = await this.read(root);
      const record = value.sessions.find((record) => record.id === id);
      if (!record) throw new Error("NATIVE_HISTORY_NOT_FOUND");
      return record;
    });
  }
  /** Host-only atomic state transition; functions never cross RPC boundaries. */
  change(id: string, update: (record: NativeHistoryRecord) => void) {
    return this.operation(async (root) => {
      const value = await this.read(root);
      const record = value.sessions.find((record) => record.id === id);
      if (!record) throw new Error("NATIVE_HISTORY_NOT_FOUND");
      update(record);
      record.revision++;
      record.updatedAt = new Date().toISOString();
      await this.write(root, value);
    });
  }
  stop(id: string) {
    return this.change(id, (record) => {
      record.state = "stopped";
    });
  }
  rename(id: string, title: string) {
    return this.change(id, (record) => {
      validateTitle(title);
      record.title = title;
    });
  }
  delete(id: string) {
    return this.operation(async (root) => {
      const value = await this.read(root);
      if (!value.sessions.some((record) => record.id === id))
        throw new Error("NATIVE_HISTORY_NOT_FOUND");
      const record = value.sessions.find((record) => record.id === id)!;
      (value.tombstones ??= []).push({
        id,
        ...(record.archive ? { archiveId: record.archive.archive_id } : {}),
      });
      value.sessions = value.sessions.filter((record) => record.id !== id);
      await this.write(root, value);
    });
  }
  /** Content-free inventory: no title, prompt, model, skill or message text. */
  select(id: string) {
    return this.operation(async (root) => {
      const value = await this.read(root);
      const record = value.sessions.find((record) => record.id === id);
      if (!record) throw new Error("NATIVE_HISTORY_NOT_FOUND");
      value.sessions = [
        record,
        ...value.sessions.filter((record) => record.id !== id),
      ];
      await this.write(root, value);
    });
  }
  list() {
    return this.inventory();
  }
  pendingDeletes() {
    return this.operation(
      async (root) =>
        (await this.read(root)).tombstones
          ?.filter((row) => row.archiveId)
          .map((row) => ({ id: row.id, archiveId: row.archiveId! })) ?? [],
    );
  }
  confirmDelete(id: string) {
    return this.operation(async (root) => {
      const value = await this.read(root);
      const row = value.tombstones?.find((row) => row.id === id);
      if (row) {
        delete row.archiveId;
        await this.write(root, value);
      }
    });
  }
  private inventory() {
    return this.operation(async (root) =>
      (await this.read(root)).sessions.map(
        ({ id, revision, createdAt, updatedAt }) => ({
          id,
          revision,
          createdAt,
          updatedAt,
        }),
      ),
    );
  }
}
