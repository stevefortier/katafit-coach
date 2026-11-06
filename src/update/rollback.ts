// The bootstrap (src/boot.ts) writes boot-rollback.json when a handed-over
// version never became healthy and it restored the previous one. The
// supervisor owns the marker from then on: it reads it once at startup and
// removes it only when Studio dismisses exactly the notice it was shown.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
  type BigIntStats,
} from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { validSha } from "./updates.js";

export type BootRollback = {
  /** The version that never became healthy. */
  revision: string;
  /** The version restored; null for the bootstrap's own package. */
  restored: string | null;
  at: number;
};
/** The marker as read, with the file it came from. */
export type RollbackMarker = {
  notice: BootRollback;
  dev: bigint;
  ino: bigint;
};

// The bootstrap's marker is about 110 bytes.
const LIMIT = 256;
const FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const markerPath = (home: string) => join(home, "boot-rollback.json");

export function validBootRollback(value: unknown): value is BootRollback {
  const notice = value as BootRollback;
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === "at,restored,revision" &&
    validSha(notice.revision) &&
    (notice.restored === null || validSha(notice.restored)) &&
    Number.isSafeInteger(notice.at) &&
    notice.at > 0 &&
    Number.isFinite(new Date(notice.at).getTime())
  );
}
export const sameBootRollback = (a: BootRollback, b: BootRollback) =>
  a.revision === b.revision && a.restored === b.restored && a.at === b.at;

function parse(info: BigIntStats, bytes: Buffer, length: number) {
  if (!info.isFile() || info.size > LIMIT || length > LIMIT) return undefined;
  try {
    const value = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    return validBootRollback(value)
      ? { revision: value.revision, restored: value.restored, at: value.at }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The bootstrap's rollback marker, when it is a small regular file with
 * exactly the bootstrap's fields. Anything else is ignored and left in place:
 * a notice must never stop Coach from starting.
 */
export async function readBootRollback(
  home: string,
): Promise<RollbackMarker | undefined> {
  let handle;
  try {
    // O_NOFOLLOW is unavailable on Windows. Reject links explicitly there
    // too, and bind the opened handle to the observed regular path.
    const pathInfo = await lstat(markerPath(home), { bigint: true });
    if (!pathInfo.isFile() || pathInfo.size > LIMIT) return undefined;
    handle = await open(markerPath(home), FLAGS);
    const info = await handle.stat({ bigint: true });
    if (info.dev !== pathInfo.dev || info.ino !== pathInfo.ino)
      return undefined;
    const bytes = Buffer.alloc(LIMIT + 1);
    const { bytesRead } = info.isFile()
      ? await handle.read(bytes, 0, bytes.length, 0)
      : { bytesRead: 0 };
    const notice = parse(info, bytes, bytesRead);
    return notice && { notice, dev: info.dev, ino: info.ino };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Removes the marker if it is still the very file `marker` was read from and
 * still holds the same notice. Synchronous from check to unlink, so nothing
 * else in this process runs in between; the bootstrap writes a marker only
 * after the supervisor has exited. Throws ROLLBACK_NOTICE_STALE when the file
 * changed, ROLLBACK_NOTICE_DISMISS_FAILED when it could not be removed.
 * A marker already gone counts as removed.
 */
export function removeBootRollback(home: string, marker: RollbackMarker) {
  const path = markerPath(home);
  const same = (info: BigIntStats) =>
    info.isFile() && info.dev === marker.dev && info.ino === marker.ino;
  let fd: number | undefined;
  try {
    fd = openSync(path, FLAGS);
    const info = fstatSync(fd, { bigint: true });
    const bytes = Buffer.alloc(LIMIT + 1);
    const length = info.isFile() ? readSync(fd, bytes, 0, bytes.length, 0) : 0;
    const notice = parse(info, bytes, length);
    if (!same(info) || !notice || !sameBootRollback(notice, marker.notice))
      throw new Error("ROLLBACK_NOTICE_STALE");
    closeSync(fd);
    fd = undefined;
    // The path still names that file.
    if (!same(lstatSync(path, { bigint: true })))
      throw new Error("ROLLBACK_NOTICE_STALE");
    unlinkSync(path);
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    if (error?.message === "ROLLBACK_NOTICE_STALE" || error?.code === "ELOOP")
      throw new Error("ROLLBACK_NOTICE_STALE");
    throw new Error("ROLLBACK_NOTICE_DISMISS_FAILED");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
