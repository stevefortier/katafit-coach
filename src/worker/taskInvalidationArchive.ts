import { constants } from "node:fs";
import { link, open, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { directory } from "../update/managed.js";

export interface TaskInvalidationRecord {
  protocol: "coach.tasks.v1";
  attempted_result_sha256: string;
  receipt: unknown;
}

export interface TaskInvalidationArchiveBoundary {
  /** Code-only durability seam used by deterministic filesystem tests. */
  sync?: (handle: FileHandle, path: string) => Promise<void>;
}

const directoryFlags =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

async function syncDirectory(
  path: string,
  sync: (handle: FileHandle, path: string) => Promise<void>,
  protectedHome = false,
) {
  const handle = await open(path, directoryFlags);
  try {
    const info = await handle.stat();
    if (
      !info.isDirectory() ||
      (protectedHome &&
        ((info.mode & 0o077) !== 0 ||
          (typeof process.geteuid === "function" &&
            info.uid !== process.geteuid())))
    )
      throw new Error("UNSAFE_STORAGE");
    await sync(handle, path);
  } finally {
    await handle.close();
  }
}

async function durableRecord(
  path: string,
  limit: number,
  sync: (handle: FileHandle, path: string) => Promise<void>,
) {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error("UNSAFE_STORAGE");
    const bytes = Buffer.alloc(limit + 1);
    const result = await handle.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead > limit) throw new Error("UNSAFE_STORAGE");
    await sync(handle, path);
    return bytes.subarray(0, result.bytesRead);
  } catch (error: any) {
    if (["ELOOP", "ENXIO"].includes(error.code))
      throw new Error("UNSAFE_STORAGE");
    throw error;
  } finally {
    await handle?.close();
  }
}

/** Immutable, content-free evidence required before a retained identity clears. */
export async function archiveTaskInvalidation(
  home: string,
  record: TaskInvalidationRecord,
  boundary: TaskInvalidationArchiveBoundary = {},
) {
  const task = (record.receipt as any)?.task;
  if (
    record.protocol !== "coach.tasks.v1" ||
    !/^[a-f0-9]{64}$/.test(record.attempted_result_sha256) ||
    !/^[a-f0-9]{24}$/i.test(task?.id) ||
    !Number.isSafeInteger(task?.lease_generation) ||
    task.lease_generation < 1
  )
    throw new Error("INVALID_TASK_INVALIDATION_ARCHIVE");
  const sync = boundary.sync ?? ((handle: FileHandle) => handle.sync());
  const protectedHome = resolve(home);
  await directory(protectedHome);
  await syncDirectory(protectedHome, sync, true);
  const archive = join(protectedHome, "task-terminal-receipts");
  await directory(archive, true);
  // Persist creation of the archive itself before relying on any child entry.
  await syncDirectory(protectedHome, sync, true);
  const final = join(archive, `${task.id}-${task.lease_generation}.json`);
  const bytes = Buffer.from(JSON.stringify(record));
  if (bytes.length > 8192) throw new Error("INVALID_TASK_INVALIDATION_ARCHIVE");
  try {
    const prior = await durableRecord(final, 8192, sync);
    if (!prior.equals(bytes)) throw new Error("TASK_INVALIDATION_CONFLICT");
    // A matching record can be the result of an earlier link whose directory
    // sync failed. Never clear the retained task identity until this succeeds.
    await syncDirectory(archive, sync);
    return;
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  const temp = join(archive, `.task-invalidation-${randomUUID()}.tmp`);
  try {
    const handle = await open(
      temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await sync(handle, temp);
    } finally {
      await handle.close();
    }
    try {
      await link(temp, final);
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      const prior = await durableRecord(final, 8192, sync);
      if (!prior.equals(bytes)) throw new Error("TASK_INVALIDATION_CONFLICT");
    }
    // Remove the temporary name before the directory sync so success proves
    // both the immutable final link and the cleanup are durable.
    await rm(temp);
    await syncDirectory(archive, sync);
  } finally {
    await rm(temp, { force: true });
  }
}
