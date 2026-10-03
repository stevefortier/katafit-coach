import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { managedFile } from "../update/managed.js";

/**
 * C5 durable unknown-write ledger (client-c5-lifecycle-design.md §2).
 *
 * Every effectful typed autonomy write is recorded, fsynced, before dispatch
 * with its exact origin/account/installation/operation identity, and removed
 * only by an exact authoritative result or proven nonpublication. It lives
 * under `<home>/autonomy/`, outside the supervisor's root-JSON snapshot, so
 * an update rollback cannot restore an older (emptier) ledger.
 */

export const LEDGER_OPS = [
  "act",
  "intent",
  "composition",
  "follow_up",
  "follow_up_patch",
  "complete",
] as const;
export type LedgerOp = (typeof LEDGER_OPS)[number];
export interface LedgerEntry {
  id: string;
  op: LedgerOp;
  origin: string;
  chief_id: string;
  dojo_id: string;
  mandate_id: string | null;
  installation: string;
  work_id: string;
  lease_generation: number;
  slot: string | null;
  follow_up_id: string | null;
  digest: string;
  /** Exact-match facts only: ids, codes and hashes; never message text. */
  expect: Record<string, string | number | null>;
  state: "pending" | "unknown";
  created_at: string;
}
export type LedgerDraft = Omit<LedgerEntry, "id" | "state" | "created_at">;

export const LEDGER_DIR = "autonomy";

/** fsync one directory (its entries); never follows a symlink. */
export type SyncDirectory = (path: string) => Promise<void>;
export const syncDirectory: SyncDirectory = async (path) => {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/**
 * C5 R3: ensure `folder` exists as a private real directory (no symlinks)
 * whose own entry is durable: the parent of every directory created here is
 * fsynced, and with `anchor` the folder's parent and the folder are fsynced
 * even when it already existed (a prior process may have crashed between
 * mkdir and the parent sync). Throws on any failure: nothing may proceed.
 */
export async function durableDirectory(
  folder: string,
  sync: SyncDirectory = syncDirectory,
  anchor = false,
) {
  const full = resolve(folder);
  const chain: string[] = [];
  for (let p = full; ; p = dirname(p)) {
    chain.unshift(p);
    if (dirname(p) === p) break;
  }
  const created: string[] = [];
  for (const p of chain) {
    try {
      const info = await lstat(p);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("UNSAFE_PATH");
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(p, { mode: 0o700 });
      created.push(p);
    }
  }
  for (const p of created) await sync(dirname(p));
  if (anchor) {
    await sync(dirname(full));
    await sync(full);
  }
}
const FILE = "writes.json";
const LIMIT_BYTES = 65536;
export const LEDGER_MAX_ENTRIES = 32;
const HEX24 = /^[a-f0-9]{24}$/;
const HEX32 = /^[a-f0-9]{32}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const SLOT = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const ledgerDigest = (method: string, path: string, body: unknown) =>
  createHash("sha256")
    .update(JSON.stringify([method, path, body ?? null]))
    .digest("hex");

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const key = (e: LedgerDraft) =>
  [
    e.work_id,
    e.lease_generation,
    e.op,
    e.slot ?? "",
    e.follow_up_id ?? "",
    e.digest,
  ].join(":");

function parseLedger(raw: Buffer): LedgerEntry[] {
  const value = JSON.parse(raw.toString("utf8"));
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > LEDGER_MAX_ENTRIES ||
    !value.entries.every(valid)
  )
    throw new Error("LEDGER_INVALID");
  return value.entries;
}

/**
 * C5 R4 read-only readback for the stable owner: never creates, repairs or
 * clears anything. Unreadable counts as obligations (fail closed).
 */
export async function ledgerObligations(
  home: string,
): Promise<"none" | "unresolved" | "unreadable"> {
  try {
    const entries = parseLedger(
      await managedFile(join(home, LEDGER_DIR, FILE), LIMIT_BYTES),
    );
    return entries.length ? "unresolved" : "none";
  } catch (error: any) {
    return error?.code === "ENOENT" ? "none" : "unreadable";
  }
}

function valid(e: unknown): e is LedgerEntry {
  if (!isRecord(e)) return false;
  const keys = Object.keys(e).sort().join(",");
  return (
    keys ===
      "chief_id,created_at,digest,dojo_id,expect,follow_up_id,id,installation,lease_generation,mandate_id,op,origin,slot,state,work_id" &&
    HEX32.test(e.id as string) &&
    (LEDGER_OPS as readonly string[]).includes(e.op as string) &&
    typeof e.origin === "string" &&
    e.origin.length <= 2048 &&
    HEX24.test(e.chief_id as string) &&
    HEX24.test(e.dojo_id as string) &&
    (e.mandate_id === null || HEX24.test(e.mandate_id as string)) &&
    HEX32.test(e.installation as string) &&
    HEX24.test(e.work_id as string) &&
    Number.isSafeInteger(e.lease_generation) &&
    (e.lease_generation as number) >= 0 &&
    (e.slot === null || SLOT.test(e.slot as string)) &&
    (e.follow_up_id === null || HEX24.test(e.follow_up_id as string)) &&
    HEX64.test(e.digest as string) &&
    isRecord(e.expect) &&
    Object.keys(e.expect).length <= 8 &&
    Object.values(e.expect).every(
      (v) =>
        v === null ||
        Number.isSafeInteger(v) ||
        (typeof v === "string" && v.length <= 128),
    ) &&
    (e.state === "pending" || e.state === "unknown") &&
    typeof e.created_at === "string" &&
    !Number.isNaN(Date.parse(e.created_at as string))
  );
}

export class WriteLedger {
  private entries: LedgerEntry[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  /** False when the stored ledger is unreadable: fail closed (unsafe). */
  healthy = true;
  private constructor(
    private readonly folder: string,
    private readonly sync: SyncDirectory,
  ) {}

  static async open(
    home: string,
    sync: SyncDirectory = syncDirectory,
  ): Promise<WriteLedger> {
    const ledger = new WriteLedger(join(home, LEDGER_DIR), sync);
    await ledger.load();
    return ledger;
  }

  private async load() {
    try {
      // The ledger directory's own entry is durable before any record.
      await durableDirectory(this.folder, this.sync, true);
    } catch {
      this.entries = [];
      this.healthy = false;
      return;
    }
    try {
      const entries = parseLedger(
        await managedFile(join(this.folder, FILE), LIMIT_BYTES),
      );
      // A write found pending at load was interrupted mid-dispatch.
      this.entries = entries.map((e: LedgerEntry) => ({
        ...e,
        state: "unknown" as const,
      }));
      this.healthy = true;
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        this.entries = [];
        this.healthy = true;
      } else {
        this.entries = [];
        this.healthy = false;
      }
    }
  }

  get unresolved(): readonly LedgerEntry[] {
    return this.entries;
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => {});
    return next;
  }

  private async persist(entries: LedgerEntry[]) {
    if (!this.healthy) throw new Error("AUTONOMY_LEDGER_UNAVAILABLE");
    const body = JSON.stringify({ v: 1, entries }) + "\n";
    if (Buffer.byteLength(body) > LIMIT_BYTES)
      throw new Error("AUTONOMY_LEDGER_FULL");
    await durableDirectory(this.folder, this.sync);
    const target = join(this.folder, FILE);
    const temporary = join(
      this.folder,
      `${FILE}.${randomBytes(8).toString("hex")}.tmp`,
    );
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(body);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
      await this.sync(this.folder);
    } finally {
      await rm(temporary, { force: true });
    }
    this.entries = entries;
  }

  /**
   * Durably record a write before dispatch. An identical (same identity and
   * digest) write reuses its entry. Throws (and nothing may be sent) when the
   * record cannot be persisted or the ledger is full.
   */
  begin(draft: LedgerDraft): Promise<{ id: string; existing: boolean }> {
    return this.serialize(async () => {
      const existing = this.entries.find((e) => key(e) === key(draft));
      if (existing) return { id: existing.id, existing: true };
      if (this.entries.length >= LEDGER_MAX_ENTRIES)
        throw new Error("AUTONOMY_LEDGER_FULL");
      const entry: LedgerEntry = {
        ...draft,
        id: randomBytes(16).toString("hex"),
        state: "pending",
        created_at: new Date().toISOString(),
      };
      if (!valid(entry)) throw new Error("AUTONOMY_LEDGER_INVALID_ENTRY");
      await this.persist([...this.entries, entry]);
      return { id: entry.id, existing: false };
    });
  }

  /** The write's outcome is unknown: keep it (durably) for exact proof. */
  unknown(id: string): Promise<void> {
    return this.serialize(async () => {
      const entry = this.entries.find((e) => e.id === id);
      if (!entry || entry.state === "unknown") return;
      await this.persist(
        this.entries.map((e) =>
          e.id === id ? { ...e, state: "unknown" as const } : e,
        ),
      );
    });
  }

  /** Exact committed result or proven nonpublication: forget it. */
  resolve(id: string): Promise<void> {
    return this.serialize(async () => {
      if (!this.entries.some((e) => e.id === id)) return;
      await this.persist(this.entries.filter((e) => e.id !== id));
    });
  }
}
