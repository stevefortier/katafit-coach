import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { directory, managedFile } from "../update/managed.js";
import { validateTask, taskSchema } from "../katafit/tasks.js";

export const ISOLATION_REASONS = new Set([
  "TASK_SOURCE_CHANGED",
  "TASK_ROUTING_CHANGED",
  "CONVERSATION_CLEARED",
  "SCOPE_CHANGED",
  "REQUESTER_SCOPE_CHANGED",
  "EXTERNAL_COACH_AUTO_ACCEPTANCE_CONFLICT",
  "CREDENTIAL_REJECTED",
]);
export interface IsolatedTaskRecord {
  task: any;
  digest: string;
  reason: string;
  binding: string;
}
export function taskBinding(origin: string, token: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["isolated.tasks.v1", origin, token]))
    .digest("hex");
}
function validate(record: IsolatedTaskRecord): IsolatedTaskRecord {
  if (
    !record ||
    Object.keys(record).sort().join(",") !== "binding,digest,reason,task" ||
    typeof record.binding !== "string" ||
    typeof record.digest !== "string" ||
    typeof record.reason !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.binding) ||
    !/^[a-f0-9]{64}$/.test(record.digest) ||
    !ISOLATION_REASONS.has(record.reason) ||
    !taskSchema(record.task?.kind)
  )
    throw new Error("ISOLATED_TASK_JOURNAL_INVALID");
  validateTask(record.task, [record.task.kind]);
  return structuredClone(record);
}
function key(record: IsolatedTaskRecord) {
  return JSON.stringify([record.binding, record.task.id.toLowerCase()]);
}
export interface IsolationBoundary {
  sync?: (handle: FileHandle, path: string) => Promise<void>;
}
/** Installation singleton owns this bounded journal, outside root rollback JSON.
 * Only already isolated, fully validated metadata is importable. No task prose,
 * credentials, inferred timestamps, pending publications or replay payloads. */
export class IsolatedTaskJournal {
  private records: IsolatedTaskRecord[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  healthy = true;
  private constructor(
    readonly home: string,
    private boundary: IsolationBoundary,
  ) {}
  static async open(home: string, boundary: IsolationBoundary = {}) {
    const journal = new IsolatedTaskJournal(resolve(home), boundary);
    await journal.initialize();
    return journal;
  }
  private get dir() {
    return join(this.home, "isolated-tasks");
  }
  private async sync(path: string) {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (
        (!info.isDirectory() && !info.isFile()) ||
        info.mode & 0o077 ||
        (typeof process.geteuid === "function" &&
          info.uid !== process.geteuid())
      )
        throw new Error("UNSAFE_STORAGE");
      await (this.boundary.sync ?? ((h: FileHandle) => h.sync()))(handle, path);
    } finally {
      await handle.close();
    }
  }
  private async initialize() {
    await directory(this.home);
    await this.sync(this.home);
    let fresh = false;
    try {
      await lstat(this.dir);
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      fresh = true;
    }
    await directory(this.dir, true);
    await this.sync(this.dir);
    // Directory must survive before committing any child file.
    await this.sync(this.home);
    if (fresh) await this.write([]);
    const state = JSON.parse(
      (await managedFile(join(this.dir, "state.json"), 131072)).toString(
        "utf8",
      ),
    );
    if (
      Object.keys(state).sort().join(",") !== "protocol,records" ||
      state.protocol !== "isolated.tasks.v1" ||
      !Array.isArray(state.records) ||
      state.records.length > 32
    )
      throw new Error("ISOLATED_TASK_JOURNAL_INVALID");
    const records = state.records.map(validate);
    if (new Set(records.map(key)).size !== records.length)
      throw new Error("ISOLATED_TASK_JOURNAL_INVALID");
    await this.sync(join(this.dir, "state.json"));
    await this.sync(this.dir);
    this.records = records;
  }
  snapshot() {
    if (!this.healthy) throw new Error("ISOLATED_TASK_JOURNAL_UNCONFIRMED");
    return structuredClone(this.records);
  }
  private async write(records: IsolatedTaskRecord[]) {
    const bytes = JSON.stringify({ protocol: "isolated.tasks.v1", records });
    if (Buffer.byteLength(bytes) > 131072)
      throw new Error("ISOLATED_TASK_JOURNAL_INVALID");
    const temporary = join(this.dir, `.state-${randomUUID()}.tmp`);
    try {
      const h = await open(temporary, "wx", 0o600);
      try {
        await h.writeFile(bytes);
        await (this.boundary.sync ?? ((h: FileHandle) => h.sync()))(
          h,
          temporary,
        );
      } finally {
        await h.close();
      }
      await rename(temporary, join(this.dir, "state.json"));
      await this.sync(this.dir);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  private change(
    change: (records: IsolatedTaskRecord[]) => IsolatedTaskRecord[],
  ) {
    const operation = this.tail.then(async () => {
      const next = change(this.snapshot());
      try {
        await this.write(next);
        this.records = next;
      } catch (e) {
        this.healthy = false;
        throw e;
      }
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
  /** Validated local import seam. Caller must supply original full identity and
   * original binding from trusted private export; never synthesize missing fields. */
  preserve(input: IsolatedTaskRecord) {
    const record = validate(input);
    return this.change((records) => {
      const prior = records.find((r) => key(r) === key(record));
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(record))
          throw new Error("ISOLATED_TASK_CONFLICT");
        return records;
      }
      if (records.length >= 32) throw new Error("ISOLATED_TASK_CAPACITY");
      return [...records, record];
    });
  }
  /** Only call after exact accepted receipt or invalidation archive durability. */
  resolve(input: IsolatedTaskRecord) {
    const record = validate(input);
    return this.change((records) =>
      records.filter((r) => {
        if (key(r) !== key(record)) return true;
        if (JSON.stringify(r) !== JSON.stringify(record))
          throw new Error("ISOLATED_TASK_CONFLICT");
        return false;
      }),
    );
  }
}
