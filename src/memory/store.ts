import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { assertNoSecrets } from "../config/store.js";

export type MemoryScope = "coach" | "boss" | "member" | "dojo";
export type MemoryKind =
  | "fact"
  | "preference"
  | "commitment"
  | "goal"
  | "lesson"
  | "hypothesis";
export type MemoryStatus = "active" | "archived" | "forgotten";

export interface MemorySource {
  type:
    | "operator_correction"
    | "native_boss_turn"
    | "backend_authority"
    | "authority_unavailable";
  id: string;
  at: string;
  note?: string;
  authority?: DurableMemoryAuthority;
}

export interface MemoryEntry {
  id: string;
  host: string;
  subject: { scope: MemoryScope; ref?: string };
  kind: MemoryKind;
  text: string;
  confidence: number;
  importance: number;
  relevance: number;
  review_after: string | null;
  pinned: boolean;
  protected: boolean;
  status: MemoryStatus;
  created_at: string;
  updated_at: string;
  sources: MemorySource[];
  supersedes?: string;
  tombstone_key?: string;
}

export interface DurableMemoryAuthority {
  contract_version: 1;
  host_namespace: string;
  owner: { type: "personal" | "dojo"; id: string };
  audience: "member-private" | "operator-private" | "dojo";
  subject: { scope: MemoryScope; ref?: string };
  generation: number;
  source_proofs: Array<{ id: string; current: boolean }>;
}

interface MemoryRecord {
  version: 1;
  revision: number;
  savedAt: string;
  previous: string | null;
  action:
    | { type: "upsert"; entry: MemoryEntry }
    | { type: "archive"; id: string; at: string }
    | {
        type: "forget";
        id: string;
        at: string;
        tombstone_key: string;
      }
    | { type: "revoke-source"; source_id: string; at: string };
}

export interface MemoryRuntime {
  host: string;
  revision: number;
  active(ids: string[]): boolean;
  recall(input: {
    audience: "operator-private" | "member-private";
    query?: string;
    scopes?: MemoryScope[];
    subject_ref?: string;
  }): MemoryRecall;
  retainNativeBossTurn(input: {
    text: string;
    source_id: string;
    at?: string;
  }): Promise<void>;
  retainWorkerInteraction(input: {
    request: unknown;
    assistant: string;
  }): Promise<{ stored: number; status: "authority_unavailable" }>;
}

export interface MemoryRecall {
  status: "ok" | "authority_unavailable";
  reason?: string;
  revision: number;
  items: MemoryEntry[];
}

const manifestLimit = 16 * 1024;
const recordLimit = 128 * 1024;
const maxRecords = 10000;
const recordPattern = /^memory-[a-f0-9]{64}\.json$/;
const iso = (value: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  new Date(Date.parse(value)).toISOString() === value;
const hashName = (bytes: Buffer) =>
  "memory-" + createHash("sha256").update(bytes).digest("hex") + ".json";
const canonicalText = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
const tombstoneKey = (
  entry: Pick<MemoryEntry, "host" | "subject" | "kind" | "text">,
) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        entry.host,
        entry.subject.scope,
        entry.subject.ref ?? "",
        entry.kind,
        canonicalText(entry.text),
      ]),
    )
    .digest("hex");

async function syncDirectory(path: string) {
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function regularBytes(path: string, limit: number) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size >= limit) throw new Error("UNSAFE_STORAGE");
    const bytes = Buffer.alloc(Math.min(info.size + 1, limit));
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) return bytes.subarray(0, length);
      length += read.bytesRead;
    }
    throw new Error("UNSAFE_STORAGE");
  } finally {
    await file.close();
  }
}

function boundedText(value: unknown, max: number, empty = false) {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    value.length > max
  )
    throw new Error("INVALID_MEMORY");
  return value.trim();
}

function boundedNumber(value: unknown, fallback: number) {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  )
    throw new Error("INVALID_MEMORY");
  return Math.round(value * 100) / 100;
}

function validateEntry(entry: any): asserts entry is MemoryEntry {
  if (
    !entry ||
    typeof entry !== "object" ||
    Array.isArray(entry) ||
    typeof entry.id !== "string" ||
    !/^[a-f0-9]{32}$/.test(entry.id) ||
    typeof entry.host !== "string" ||
    !entry.host ||
    !entry.subject ||
    !["coach", "boss", "member", "dojo"].includes(entry.subject.scope) ||
    (entry.subject.ref !== undefined &&
      (typeof entry.subject.ref !== "string" ||
        !entry.subject.ref ||
        entry.subject.ref.length > 256)) ||
    ![
      "fact",
      "preference",
      "commitment",
      "goal",
      "lesson",
      "hypothesis",
    ].includes(entry.kind) ||
    typeof entry.text !== "string" ||
    !entry.text.trim() ||
    entry.text.length > 2000 ||
    ![entry.confidence, entry.importance, entry.relevance].every(
      (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1,
    ) ||
    (entry.review_after !== null &&
      (typeof entry.review_after !== "string" || !iso(entry.review_after))) ||
    typeof entry.pinned !== "boolean" ||
    typeof entry.protected !== "boolean" ||
    !["active", "archived", "forgotten"].includes(entry.status) ||
    typeof entry.created_at !== "string" ||
    !iso(entry.created_at) ||
    typeof entry.updated_at !== "string" ||
    !iso(entry.updated_at) ||
    !Array.isArray(entry.sources) ||
    !entry.sources.length ||
    entry.sources.length > 20
  )
    throw new Error("INVALID_MEMORY_STORAGE");
  for (const source of entry.sources) {
    if (
      !source ||
      typeof source !== "object" ||
      ![
        "operator_correction",
        "native_boss_turn",
        "backend_authority",
        "authority_unavailable",
      ].includes(source.type) ||
      typeof source.id !== "string" ||
      !source.id ||
      source.id.length > 256 ||
      typeof source.at !== "string" ||
      !iso(source.at) ||
      (source.note !== undefined &&
        (typeof source.note !== "string" || source.note.length > 500))
    )
      throw new Error("INVALID_MEMORY_STORAGE");
  }
}

function validateRecord(record: any): asserts record is MemoryRecord {
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    record.version !== 1 ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1 ||
    typeof record.savedAt !== "string" ||
    !iso(record.savedAt) ||
    (record.previous !== null &&
      (typeof record.previous !== "string" ||
        !recordPattern.test(record.previous))) ||
    !record.action ||
    typeof record.action !== "object"
  )
    throw new Error("INVALID_MEMORY_STORAGE");
  if (record.action.type === "upsert") validateEntry(record.action.entry);
  else if (record.action.type === "archive") {
    if (typeof record.action.id !== "string" || !iso(record.action.at))
      throw new Error("INVALID_MEMORY_STORAGE");
  } else if (record.action.type === "forget") {
    if (
      typeof record.action.id !== "string" ||
      typeof record.action.tombstone_key !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.action.tombstone_key) ||
      !iso(record.action.at)
    )
      throw new Error("INVALID_MEMORY_STORAGE");
  } else if (record.action.type === "revoke-source") {
    if (typeof record.action.source_id !== "string" || !iso(record.action.at))
      throw new Error("INVALID_MEMORY_STORAGE");
  } else throw new Error("INVALID_MEMORY_STORAGE");
}

function applyRecord(
  entries: Map<string, MemoryEntry>,
  tombstones: Set<string>,
  revokedSources: Set<string>,
  record: MemoryRecord,
) {
  if (record.action.type === "upsert") {
    const entry = structuredClone(record.action.entry);
    if (tombstones.has(tombstoneKey(entry))) return;
    entries.set(entry.id, entry);
  } else if (record.action.type === "archive") {
    const entry = entries.get(record.action.id);
    if (entry && entry.status === "active")
      entries.set(entry.id, {
        ...entry,
        status: "archived",
        updated_at: record.action.at,
      });
  } else if (record.action.type === "forget") {
    tombstones.add(record.action.tombstone_key);
    entries.delete(record.action.id);
  } else if (record.action.type === "revoke-source") {
    revokedSources.add(record.action.source_id);
  }
}

export class MemoryStore {
  private revision = 0;
  private head: string | null = null;
  private records: MemoryRecord[] = [];
  private entries = new Map<string, MemoryEntry>();
  private tombstones = new Set<string>();
  private revokedSources = new Set<string>();
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    readonly dir: string,
    private secrets: () => string[],
  ) {}
  private get historyDir() {
    return this.dir + "/memories-history";
  }
  private get manifestPath() {
    return this.dir + "/memories.json";
  }
  private get lockPath() {
    return this.dir + "/memories.lock";
  }
  private async prepare() {
    await mkdir(this.historyDir, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.historyDir)).isDirectory())
      throw new Error("UNSAFE_STORAGE");
    await chmod(this.historyDir, 0o700);
    await syncDirectory(this.dir);
  }
  async init() {
    await this.prepare();
    let manifest: any;
    try {
      manifest = JSON.parse(
        (await regularBytes(this.manifestPath, manifestLimit)).toString("utf8"),
      );
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      await this.writeManifest(null, 0);
      return;
    }
    if (
      !manifest ||
      Object.keys(manifest).sort().join() !== "head,revision,version" ||
      manifest.version !== 1 ||
      !Number.isSafeInteger(manifest.revision) ||
      manifest.revision < 0 ||
      (manifest.head !== null &&
        (typeof manifest.head !== "string" ||
          !recordPattern.test(manifest.head)))
    )
      throw new Error("INVALID_MEMORY_STORAGE");
    const records: MemoryRecord[] = [];
    const seen = new Set<string>();
    let name = manifest.head;
    let last = Infinity;
    while (name !== null) {
      if (seen.has(name) || seen.size >= maxRecords)
        throw new Error("INVALID_MEMORY_STORAGE");
      seen.add(name);
      const bytes = await regularBytes(
        this.historyDir + "/" + name,
        recordLimit,
      );
      if (hashName(bytes) !== name) throw new Error("INVALID_MEMORY_STORAGE");
      const record = JSON.parse(bytes.toString("utf8"));
      validateRecord(record);
      if (record.revision >= last) throw new Error("INVALID_MEMORY_STORAGE");
      last = record.revision;
      records.push(record);
      name = record.previous;
    }
    records.reverse();
    if ((records.at(-1)?.revision ?? 0) !== manifest.revision)
      throw new Error("INVALID_MEMORY_STORAGE");
    this.records = records;
    this.revision = manifest.revision;
    this.head = manifest.head;
    this.rebuild();
    this.assertSafe(this.secrets());
    await chmod(this.manifestPath, 0o600);
  }
  private rebuild() {
    const entries = new Map<string, MemoryEntry>();
    const tombstones = new Set<string>();
    const revokedSources = new Set<string>();
    for (const record of this.records)
      applyRecord(entries, tombstones, revokedSources, record);
    this.entries = entries;
    this.tombstones = tombstones;
    this.revokedSources = revokedSources;
  }
  private serial<T>(work: () => Promise<T>) {
    const result = this.pending.then(work);
    this.pending = result.catch(() => {});
    return result;
  }
  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 5000;
    let locked = false;
    for (;;) {
      try {
        const lock = await open(
          this.lockPath,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await lock.writeFile(
            JSON.stringify({
              pid: process.pid,
              created_at: new Date().toISOString(),
            }),
          );
          await lock.sync();
        } finally {
          await lock.close();
        }
        locked = true;
        break;
      } catch (error: any) {
        if (error.code !== "EEXIST" || Date.now() > deadline)
          throw new Error("MEMORY_LOCK_UNAVAILABLE");
        await this.recoverLock().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await work();
    } finally {
      if (locked) await unlink(this.lockPath).catch(() => {});
    }
  }
  private async recoverLock() {
    const info = await lstat(this.lockPath);
    if (info.isDirectory()) {
      if (Date.now() - info.mtimeMs > 30000)
        await rm(this.lockPath, { recursive: true, force: true });
      return;
    }
    if (!info.isFile()) throw new Error("MEMORY_LOCK_UNAVAILABLE");
    let pid: unknown;
    try {
      pid = JSON.parse(
        (await regularBytes(this.lockPath, 4096)).toString(),
      ).pid;
    } catch {
      if (Date.now() - info.mtimeMs > 30000) await unlink(this.lockPath);
      return;
    }
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0) {
      if (Date.now() - info.mtimeMs > 30000) await unlink(this.lockPath);
      return;
    }
    try {
      process.kill(pid as number, 0);
    } catch (error: any) {
      if (error.code === "ESRCH") await unlink(this.lockPath);
    }
  }
  private async snapshot(record: MemoryRecord) {
    const bytes = Buffer.from(JSON.stringify(record, null, 2));
    if (bytes.length >= recordLimit) throw new Error("MEMORY_TOO_LARGE");
    const name = hashName(bytes);
    const path = this.historyDir + "/" + name;
    const temp =
      this.historyDir + "/.memory-" + randomBytes(16).toString("hex") + ".tmp";
    const file = await open(
      temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temp, path);
      } catch (error: any) {
        if (error.code !== "EEXIST") throw error;
        if (!(await regularBytes(path, recordLimit)).equals(bytes))
          throw new Error("INVALID_MEMORY_STORAGE");
      }
      return name;
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
  private async writeManifest(head: string | null, revision: number) {
    const temp = this.manifestPath + "." + randomBytes(8).toString("hex");
    try {
      await writeFile(
        temp,
        JSON.stringify({ version: 1, revision, head }, null, 2),
        { flag: "wx", mode: 0o600 },
      );
      const file = await open(temp, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, this.manifestPath);
      await syncDirectory(this.dir);
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
  private async refreshLocked() {
    // Pick up records committed by another process before deciding or appending.
    const fresh = new MemoryStore(this.dir, this.secrets);
    await fresh.init();
    this.revision = fresh.revision;
    this.head = fresh.head;
    this.records = fresh.records;
    this.entries = fresh.entries;
    this.tombstones = fresh.tombstones;
    this.revokedSources = fresh.revokedSources;
  }
  private async appendLocked(action: MemoryRecord["action"]) {
    const record: MemoryRecord = {
      version: 1,
      revision: this.revision + 1,
      savedAt: new Date().toISOString(),
      previous: this.head,
      action,
    };
    const name = await this.snapshot(record);
    await syncDirectory(this.historyDir);
    await this.writeManifest(name, record.revision);
    this.records.push(record);
    this.revision = record.revision;
    this.head = name;
    applyRecord(this.entries, this.tombstones, this.revokedSources, record);
  }
  private async append(action: MemoryRecord["action"]) {
    await this.withLock(async () => {
      await this.refreshLocked();
      await this.appendLocked(action);
    });
  }
  private input(value: any, manual = true): MemoryEntry {
    const now = new Date().toISOString();
    const scope = value?.subject?.scope ?? value?.scope;
    const ref = value?.subject?.ref ?? value?.subject_ref;
    if (!["coach", "boss", "member", "dojo"].includes(scope))
      throw new Error("INVALID_MEMORY");
    // Human admin routes are not backend member/source authority. They may
    // create only operator-owned private notes unless a backend contract later
    // supplies a host-stamped backend_authority source.
    if (
      manual &&
      (scope === "member" || scope === "dojo") &&
      value?.source?.type !== "backend_authority"
    )
      throw new Error("MEMORY_AUTHORITY_UNAVAILABLE");
    const source = value?.source ?? {};
    const sourceType = source.type ?? "operator_correction";
    if (
      ![
        "operator_correction",
        "native_boss_turn",
        "backend_authority",
        "authority_unavailable",
      ].includes(sourceType)
    )
      throw new Error("INVALID_MEMORY");
    const entry: MemoryEntry = {
      id: randomBytes(16).toString("hex"),
      host: boundedText(value.host, 2048),
      subject: {
        scope,
        ...(ref !== undefined ? { ref: boundedText(ref, 256) } : {}),
      },
      kind: value.kind,
      text: boundedText(value.text, 2000),
      confidence: boundedNumber(value.confidence, manual ? 1 : 0.72),
      importance: boundedNumber(value.importance, manual ? 0.85 : 0.6),
      relevance: boundedNumber(value.relevance, manual ? 0.85 : 0.6),
      review_after:
        value.review_after === undefined || value.review_after === null
          ? null
          : boundedText(value.review_after, 40),
      pinned: value.pinned !== undefined ? value.pinned === true : manual,
      protected: manual || value.protected === true,
      status: "active",
      created_at: now,
      updated_at: now,
      sources: [
        {
          type: sourceType,
          id: boundedText(
            source.id ?? sourceType + ":" + entrylessHash(value),
            256,
          ),
          at: typeof source.at === "string" && iso(source.at) ? source.at : now,
          ...(source.note ? { note: boundedText(source.note, 500, true) } : {}),
          ...(source.authority ? { authority: source.authority } : {}),
        },
      ],
    };
    if (entry.review_after !== null && !iso(entry.review_after))
      throw new Error("INVALID_MEMORY");
    if (
      ![
        "fact",
        "preference",
        "commitment",
        "goal",
        "lesson",
        "hypothesis",
      ].includes(entry.kind)
    )
      throw new Error("INVALID_MEMORY");
    validateEntry(entry);
    return entry;
  }
  async add(value: any) {
    return this.serial(async () => {
      return this.withLock(async () => {
        await this.refreshLocked();
        const entry = this.input(value, true);
        assertNoSecrets(entry, this.secrets());
        if (!this.tombstones.has(tombstoneKey(entry)))
          await this.appendLocked({ type: "upsert", entry });
        return structuredClone(entry);
      });
    });
  }
  async update(id: string, patch: any, options: { host?: string } = {}) {
    return this.serial(async () => {
      return this.withLock(async () => {
        await this.refreshLocked();
        const current = this.entries.get(id);
        if (
          !current ||
          current.status !== "active" ||
          (options.host !== undefined && current.host !== options.host)
        )
          throw new Error("MEMORY_NOT_FOUND");
        const now = new Date().toISOString();
        const entry: MemoryEntry = {
          ...structuredClone(current),
          text:
            patch.text !== undefined
              ? boundedText(patch.text, 2000)
              : current.text,
          kind: patch.kind ?? current.kind,
          confidence: boundedNumber(patch.confidence, current.confidence),
          importance: boundedNumber(patch.importance, current.importance),
          relevance: boundedNumber(patch.relevance, current.relevance),
          review_after:
            patch.review_after === undefined
              ? current.review_after
              : patch.review_after === null
                ? null
                : boundedText(patch.review_after, 40),
          pinned: patch.pinned !== undefined ? patch.pinned === true : true,
          protected: true,
          updated_at: now,
          sources: [
            ...current.sources,
            {
              type: "operator_correction",
              id: "operator-correction:" + randomBytes(12).toString("hex"),
              at: now,
              ...(patch.operator_note
                ? { note: boundedText(patch.operator_note, 500, true) }
                : {}),
            },
          ],
        };
        if (entry.review_after !== null && !iso(entry.review_after))
          throw new Error("INVALID_MEMORY");
        validateEntry(entry);
        assertNoSecrets(entry, this.secrets());
        await this.appendLocked({ type: "upsert", entry });
        return structuredClone(entry);
      });
    });
  }
  async archive(id: string, options: { host?: string } = {}) {
    return this.serial(async () => {
      await this.withLock(async () => {
        await this.refreshLocked();
        const current = this.entries.get(id);
        if (
          !current ||
          (options.host !== undefined && current.host !== options.host)
        )
          throw new Error("MEMORY_NOT_FOUND");
        await this.appendLocked({
          type: "archive",
          id,
          at: new Date().toISOString(),
        });
      });
    });
  }
  async forget(id: string, options: { host?: string } = {}) {
    return this.serial(async () => {
      await this.withLock(async () => {
        await this.refreshLocked();
        const entry = this.entries.get(id);
        if (
          !entry ||
          (options.host !== undefined && entry.host !== options.host)
        )
          throw new Error("MEMORY_NOT_FOUND");
        await this.appendLocked({
          type: "forget",
          id,
          at: new Date().toISOString(),
          tombstone_key: tombstoneKey(entry),
        });
      });
    });
  }
  async revokeSource(source_id: string) {
    return this.serial(async () => {
      await this.append({
        type: "revoke-source",
        source_id: boundedText(source_id, 256),
        at: new Date().toISOString(),
      });
    });
  }
  list(
    filter: {
      scope?: MemoryScope;
      host?: string;
      subject_ref?: string;
      kind?: MemoryKind;
      q?: string;
      include_archived?: boolean;
    } = {},
  ) {
    const q = filter.q ? canonicalText(filter.q) : "";
    const items = [...this.entries.values()]
      .filter((entry) => filter.include_archived || entry.status === "active")
      .filter(
        (entry) => filter.host === undefined || entry.host === filter.host,
      )
      .filter((entry) => !filter.scope || entry.subject.scope === filter.scope)
      .filter(
        (entry) =>
          filter.subject_ref === undefined ||
          entry.subject.ref === filter.subject_ref,
      )
      .filter((entry) => !filter.kind || entry.kind === filter.kind)
      .filter((entry) => !q || canonicalText(entry.text).includes(q))
      .filter(
        (entry) =>
          !entry.sources.length ||
          entry.sources.some((source) => !this.revokedSources.has(source.id)),
      )
      .sort(
        (a, b) =>
          b.importance - a.importance ||
          Date.parse(b.updated_at) - Date.parse(a.updated_at),
      )
      .map((entry) => structuredClone(entry));
    return { revision: this.revision, items, total: items.length };
  }
  history(id: string, filter: { host?: string } = {}) {
    const items = this.records
      .filter(
        (record) =>
          (record.action.type === "upsert" && record.action.entry.id === id) ||
          (record.action.type !== "upsert" &&
            "id" in record.action &&
            record.action.id === id),
      )
      .map((record) => structuredClone(record));
    if (!items.length) throw new Error("MEMORY_NOT_FOUND");
    if (
      filter.host !== undefined &&
      !items.some(
        (record) =>
          record.action.type === "upsert" &&
          record.action.entry.host === filter.host,
      )
    )
      throw new Error("MEMORY_NOT_FOUND");
    return { revision: this.revision, items };
  }
  active(input: { host: string; ids: string[] }) {
    return input.ids.every((id) => {
      const entry = this.entries.get(id);
      return (
        !!entry &&
        entry.status === "active" &&
        entry.host === input.host &&
        entry.sources.some((source) => !this.revokedSources.has(source.id))
      );
    });
  }
  recall(input: {
    host: string;
    audience: "operator-private" | "member-private";
    query?: string;
    scopes?: MemoryScope[];
    subject_ref?: string;
  }): MemoryRecall {
    if (input.audience === "member-private")
      return {
        status: "authority_unavailable",
        reason:
          "No backend durable memory authority/proof contract is negotiated.",
        revision: this.revision,
        items: [],
      };
    const scopes = new Set(
      input.scopes?.length ? input.scopes : ["boss", "coach"],
    );
    const query = canonicalText(input.query ?? "");
    const tokens = new Set(
      query.split(" ").filter((token) => token.length > 2),
    );
    const score = (entry: MemoryEntry) => {
      const text = canonicalText(entry.text);
      let overlap = 0;
      for (const token of tokens) if (text.includes(token)) overlap++;
      return (
        (entry.pinned ? 2 : 0) +
        entry.importance +
        entry.relevance +
        overlap / Math.max(1, tokens.size)
      );
    };
    const items = [...this.entries.values()]
      .filter((entry) => entry.status === "active")
      .filter((entry) => entry.host === input.host)
      .filter((entry) => scopes.has(entry.subject.scope))
      .filter(
        (entry) =>
          input.subject_ref === undefined ||
          entry.subject.ref === input.subject_ref,
      )
      .filter((entry) =>
        entry.sources.some((source) => !this.revokedSources.has(source.id)),
      )
      .sort((a, b) => score(b) - score(a))
      .slice(0, 8)
      .map((entry) => structuredClone(entry));
    return { status: "ok", revision: this.revision, items };
  }
  async retainNativeBossTurn(input: {
    host: string;
    text: string;
    source_id: string;
    at?: string;
  }) {
    return this.serial(async () => {
      await this.withLock(async () => {
        await this.refreshLocked();
        const extracted = extractMemory(input.text);
        if (!extracted) return;
        const now =
          input.at && iso(input.at) ? input.at : new Date().toISOString();
        const candidate = this.input(
          {
            host: input.host,
            subject: { scope: "boss" },
            kind: extracted.kind,
            text: extracted.text,
            confidence: 0.72,
            importance: 0.6,
            relevance: 0.6,
            pinned: false,
            protected: false,
            source: { type: "native_boss_turn", id: input.source_id, at: now },
          },
          false,
        );
        if (this.tombstones.has(tombstoneKey(candidate))) return;
        const duplicate = [...this.entries.values()].find(
          (entry) =>
            entry.status === "active" &&
            entry.host === candidate.host &&
            entry.subject.scope === "boss" &&
            entry.kind === candidate.kind &&
            canonicalText(entry.text) === canonicalText(candidate.text),
        );
        if (duplicate) {
          if (duplicate.sources.some((source) => source.id === input.source_id))
            return;
          await this.appendLocked({
            type: "upsert",
            entry: {
              ...duplicate,
              updated_at: now,
              confidence: Math.max(duplicate.confidence, candidate.confidence),
              importance: Math.max(duplicate.importance, candidate.importance),
              relevance: Math.max(duplicate.relevance, candidate.relevance),
              sources: [...duplicate.sources, candidate.sources[0]],
            },
          });
          return;
        }
        assertNoSecrets(candidate, this.secrets());
        await this.appendLocked({ type: "upsert", entry: candidate });
      });
    });
  }
  async retainWorkerInteraction(_input: {
    host: string;
    request: unknown;
    assistant: string;
  }) {
    return { stored: 0, status: "authority_unavailable" as const };
  }
  runtime(options: { host: string }): MemoryRuntime {
    return {
      host: options.host,
      revision: this.revision,
      active: (ids) => this.active({ host: options.host, ids }),
      recall: (input) => this.recall({ host: options.host, ...input }),
      retainNativeBossTurn: (input) =>
        this.retainNativeBossTurn({ host: options.host, ...input }),
      retainWorkerInteraction: (input) =>
        this.retainWorkerInteraction({ host: options.host, ...input }),
    };
  }
  assertSafe(secrets: string[]) {
    assertNoSecrets([this.records, [...this.entries.values()]], secrets);
  }
}

function entrylessHash(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 24);
}

function extractMemory(
  text: string,
): { kind: MemoryKind; text: string } | undefined {
  const source = text.replace(/\s+/g, " ").trim();
  if (!source || source.length > 2000) return undefined;
  const match =
    /\bremember(?: that)? (?:i |my )?(?<value>[^.?!]{3,240})/i.exec(source) ??
    /\bi prefer (?<value>[^.?!]{3,240})/i.exec(source) ??
    /\bmy goal is (?<value>[^.?!]{3,240})/i.exec(source);
  const value = match?.groups?.value?.trim();
  if (!value) return undefined;
  const lower = value.toLowerCase();
  const kind: MemoryKind =
    /\bprefer|like|dislike|want|style|concise|detailed\b/.test(lower)
      ? "preference"
      : /\bgoal|target|aim\b/.test(lower)
        ? "goal"
        : /\bwill|commit|promise\b/.test(lower)
          ? "commitment"
          : "fact";
  const textValue =
    kind === "preference" && !/^prefers?\b/i.test(value)
      ? "Prefers " + value.replace(/^to /i, "")
      : value[0].toUpperCase() + value.slice(1);
  return { kind, text: textValue.endsWith(".") ? textValue : textValue + "." };
}
