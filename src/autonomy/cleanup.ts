import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { managedFile } from "../update/managed.js";
import {
  cleanupNativeProbe,
  dockerProbeEngine,
  type NativeProbeEngine,
} from "../sandbox/runtime.js";
import {
  durableDirectory,
  LEDGER_DIR,
  syncDirectory,
  type SyncDirectory,
} from "./ledger.js";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { HEADLESS_NAME, HEADLESS_OWNER_LABEL } from "./headless.js";

const IMAGE = /^sha256:[a-f0-9]{64}$/;
const CONTAINER = /^[a-f0-9]{64}$/;
const OWNER = /^[a-f0-9]{32}$/;
const LABEL = /^[a-z0-9.-]{1,64}$/;
const DIR = "cleanup";
/** Bound on durable records: a broken daemon cannot fill the home. */
export const CLEANUP_MAX_RECORDS = 16;

/** Exactly what `cleanupNativeProbe` matches and removes; nothing else. */
export interface OwnedContainer {
  name: string;
  image: string;
  labels: Record<string, string>;
  containerId: string | null;
}

function valid(value: unknown, owner: string): value is OwnedContainer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const labels = v.labels as Record<string, unknown> | undefined;
  return (
    Object.keys(v).sort().join(",") === "containerId,image,labels,name" &&
    typeof v.name === "string" &&
    HEADLESS_NAME.test(v.name) &&
    typeof v.image === "string" &&
    IMAGE.test(v.image) &&
    (v.containerId === null ||
      (typeof v.containerId === "string" && CONTAINER.test(v.containerId))) &&
    !!labels &&
    typeof labels === "object" &&
    Object.keys(labels).length <= 4 &&
    Object.entries(labels).every(
      ([k, l]) => LABEL.test(k) && typeof l === "string" && l.length <= 64,
    ) &&
    labels[HEADLESS_OWNER_LABEL] === owner
  );
}

/**
 * C5 F4/F5: durable, installation-owned identity of every headless autonomy
 * container, written (fsynced) before `docker create` and removed only once
 * the exact container is confirmed absent. A retained record keeps the host
 * unsafe to replace and blocks further cycles until a scoped retry
 * (`drain`) removes exactly that container. Never touches anything else.
 */
export class CleanupRegistry {
  private readonly records = new Map<string, OwnedContainer>();
  /** Names whose container belongs to a cycle running in this process. */
  private readonly active = new Set<string>();
  private draining?: Promise<number>;
  /** False when a stored record is unreadable: fail closed (unsafe). */
  healthy = true;

  private constructor(
    private readonly folder: string,
    readonly owner: string,
    private readonly sync: SyncDirectory,
    readonly probe: NativeProbeEngine,
  ) {}

  static async open(
    home: string,
    owner: string,
    options: { sync?: SyncDirectory; probe?: NativeProbeEngine } = {},
  ): Promise<CleanupRegistry> {
    if (!OWNER.test(owner)) throw new Error("AUTONOMY_OWNER_INVALID");
    const registry = new CleanupRegistry(
      join(home, LEDGER_DIR, DIR),
      owner,
      options.sync ?? syncDirectory,
      options.probe ??
        dockerProbeEngine(
          promisify(execFile) as unknown as Parameters<
            typeof dockerProbeEngine
          >[0],
          "/var/run/docker.sock",
        ),
    );
    await registry.load();
    return registry;
  }

  private async load() {
    try {
      await durableDirectory(this.folder, this.sync, true);
      const names = (await readdir(this.folder)).filter((n) =>
        n.endsWith(".json"),
      );
      if (names.length > CLEANUP_MAX_RECORDS)
        throw new Error("CLEANUP_INVALID");
      for (const file of names) {
        const value = JSON.parse(
          (await managedFile(join(this.folder, file), 4096)).toString("utf8"),
        );
        if (!valid(value, this.owner) || file !== value.name + ".json")
          throw new Error("CLEANUP_INVALID");
        this.records.set(value.name, value);
      }
    } catch {
      this.healthy = false;
    }
  }

  /** Retained teardowns not owned by a cycle running now. */
  get pending(): number {
    return [...this.records.keys()].filter((n) => !this.active.has(n)).length;
  }

  /** Durable before create; the returned object is the runtime ownership. */
  async begin(entry: Omit<OwnedContainer, "containerId">) {
    if (!this.healthy) throw new Error("HEADLESS_CLEANUP_PENDING");
    if (this.records.size >= CLEANUP_MAX_RECORDS)
      throw new Error("HEADLESS_CLEANUP_PENDING");
    const record: OwnedContainer = { ...entry, containerId: null };
    if (!valid(record, this.owner)) throw new Error("HEADLESS_OWNER_INVALID");
    await this.write(record);
    this.records.set(record.name, record);
    this.active.add(record.name);
    return record;
  }

  /** The cycle has ended: confirmed absent drops the record, else retains. */
  async end(name: string, absent: boolean) {
    this.active.delete(name);
    if (absent) await this.forget(name);
  }

  isOwnedActive(name: string) {
    return this.active.has(name);
  }

  /**
   * Scoped retry: exact inspect + remove of every retained record not active
   * here; a record goes only after confirmed absence. Single-flight.
   * Returns the number still pending.
   */
  drain(probe: NativeProbeEngine = this.probe): Promise<number> {
    this.draining ??= (async () => {
      for (const [name, record] of [...this.records]) {
        if (this.active.has(name)) continue;
        try {
          await cleanupNativeProbe(record, probe);
          await this.forget(name);
        } catch {
          // Retained: still unconfirmed.
        }
      }
      return this.pending;
    })().finally(() => (this.draining = undefined));
    return this.draining;
  }

  private async forget(name: string) {
    await rm(join(this.folder, name + ".json"), { force: true });
    await this.sync(this.folder);
    this.records.delete(name);
  }

  private async write(record: OwnedContainer) {
    await durableDirectory(this.folder, this.sync);
    const target = join(this.folder, record.name + ".json");
    const temporary = join(
      this.folder,
      "." + randomBytes(8).toString("hex") + ".tmp",
    );
    const handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, target);
      await this.sync(this.folder);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
