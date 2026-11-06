import { constants, type Stats } from "node:fs";
import { open } from "node:fs/promises";

/**
 * POSIX file hardening, with its Windows counterpart. On Linux, Coach's
 * private files are checked by owner uid and mode bits, and directories are
 * fsynced after renames. Windows has neither uids nor POSIX modes; a per-user
 * installation lives in the user's profile, whose access list admits only the
 * user, SYSTEM and administrators, and NTFS journals directory changes itself
 * (Windows refuses fsync on a directory handle). So those checks hold there
 * by construction and the directory sync is skipped. Nothing else changes.
 */
export const windows = process.platform === "win32";

/** The file belongs to this process's user. */
export const ownedByUser = (stat: Pick<Stats, "uid">) =>
  windows || stat.uid === process.getuid?.();

/** The file belongs to this process's user or to root. */
export const ownedByUserOrRoot = (stat: Pick<Stats, "uid">) =>
  windows || stat.uid === 0 || stat.uid === process.getuid?.();

/** Group or others may write it. */
export const sharedWritable = (stat: Pick<Stats, "mode">) =>
  !windows && (stat.mode & 0o022) !== 0;

/** Flags that refuse a symlink at the last component, where supported. */
export const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Makes a directory's entries durable (renames, creations, removals). */
export async function syncDirectory(path: string) {
  if (windows) return;
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

/**
 * Stops a child process gracefully, then forcibly after `graceMs`. On
 * Windows a signal is a hard termination that skips cleanup, so a child with
 * an IPC channel is asked by closing the channel instead (Coach's processes
 * shut down cleanly on disconnect).
 */
export function stopChild(
  child: import("node:child_process").ChildProcess,
  graceMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    if (windows && child.connected) child.disconnect();
    else child.kill("SIGTERM");
  });
}
