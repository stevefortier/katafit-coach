import {
  open,
  mkdtemp,
  lstat,
  chmod,
  unlink,
  rmdir,
  readdir,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { Manifest } from "./manifest.js";
import type { NativeArchiveReadOptions } from "./native-identity.js";
import { NativeOwnershipUncertain } from "./native-ownership.js";

/** Under the actual operator lock only: leftovers are garbage, never proof.
 * A surviving import child holds a duplicate flock and prevents this recovery. */
export async function recoverNativeSnapshots(parent: string) {
  for (const name of await readdir(parent)) {
    if (!name.startsWith(".native-import-")) continue;
    if (!/^\.native-import-[A-Za-z0-9]{6}$/.test(name))
      throw Error("RELEASE_SNAPSHOT_RECOVERY_REJECTED");
    const folder = join(parent, name),
      stat = await lstat(folder);
    if (
      !stat.isDirectory() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700
    )
      throw Error("RELEASE_SNAPSHOT_RECOVERY_REJECTED");
    const entries = await readdir(folder);
    if (entries.length > 1 || entries.some((name) => name !== "image.tar.gz"))
      throw Error("RELEASE_SNAPSHOT_RECOVERY_REJECTED");
    if (entries.length) {
      const path = join(folder, "image.tar.gz"),
        file = await lstat(path);
      if (
        !file.isFile() ||
        file.uid !== process.getuid?.() ||
        file.nlink !== 1 ||
        ![0o400, 0o600].includes(file.mode & 0o777)
      )
        throw Error("RELEASE_SNAPSHOT_RECOVERY_REJECTED");
      try {
        await unlink(path);
      } catch (error) {
        throw new NativeOwnershipUncertain(path, error);
      }
    }
    try {
      await rmdir(folder);
    } catch (error) {
      throw new NativeOwnershipUncertain(folder, error);
    }
  }
}

/** A private copy, never a link to the downloaded pathname. All filesystem
 * promises stay owned until settlement; the supervisor bounds the caller. */
export async function withNativeSnapshot<T>(
  archive: string,
  m: Manifest,
  options: NativeArchiveReadOptions,
  work: (snapshot: string, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = options.timeoutMs ?? 60000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 180000)
    throw Error("RELEASE_IMAGE_IDENTITY_REJECTED");
  const controller = new AbortController();
  const abort = () =>
    controller.abort(Error("RELEASE_IMAGE_IDENTITY_CANCELLED"));
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(
    () => controller.abort(Error("RELEASE_IMAGE_IDENTITY_TIMEOUT")),
    timeout,
  );
  const signal = controller.signal;
  let folder: string | undefined, snapshot: string | undefined;
  let input: Awaited<ReturnType<typeof open>> | undefined;
  let output: Awaited<ReturnType<typeof open>> | undefined;
  let uncertain = false;
  try {
    signal.throwIfAborted();
    const parent = options.snapshotParent ?? dirname(archive);
    const stat = await lstat(parent);
    if (
      !stat.isDirectory() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o022
    )
      throw Error("RELEASE_SNAPSHOT_PARENT_REJECTED");
    folder = await mkdtemp(join(parent, ".native-import-"));
    snapshot = join(folder, "image.tar.gz");
    signal.throwIfAborted();
    input = await open(
      archive,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    signal.throwIfAborted();
    const sourceStat = await input.stat();
    const expected = m.artifacts[1];
    if (!sourceStat.isFile() || sourceStat.size !== expected.size)
      throw Error("RELEASE_IMAGE_IDENTITY_REJECTED");
    output = await open(
      snapshot,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const buffer = Buffer.alloc(65536),
      hash = createHash("sha256");
    let total = 0;
    for (;;) {
      signal.throwIfAborted();
      const { bytesRead } = await input.read(
        buffer,
        0,
        Math.min(buffer.length, expected.size - total + 1),
      );
      signal.throwIfAborted();
      if (!bytesRead) break;
      total += bytesRead;
      if (total > expected.size) throw Error("RELEASE_IMAGE_IDENTITY_REJECTED");
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let written = 0;
      while (written < chunk.length) {
        signal.throwIfAborted();
        const result = await output.write(
          chunk,
          written,
          chunk.length - written,
        );
        if (!result.bytesWritten) throw Error("RELEASE_SNAPSHOT_WRITE_FAILED");
        written += result.bytesWritten;
      }
    }
    if (total !== expected.size || hash.digest("hex") !== expected.sha256)
      throw Error("RELEASE_IMAGE_IDENTITY_REJECTED");
    try {
      await output.close();
      output = undefined;
      await input.close();
      input = undefined;
    } catch (error) {
      uncertain = true;
      throw new NativeOwnershipUncertain({ input, output, folder }, error);
    }
    await chmod(snapshot, 0o400);
    signal.throwIfAborted();
    return await work(snapshot, signal);
  } catch (error) {
    uncertain ||= error instanceof NativeOwnershipUncertain;
    throw error;
  } finally {
    try {
      // Never retry a failed close: descriptor number reuse makes that unsafe.
      if (!uncertain) {
        try {
          await output?.close();
          await input?.close();
          if (snapshot)
            await unlink(snapshot).catch((error) => {
              if (error.code !== "ENOENT") throw error;
            });
          if (folder) await rmdir(folder);
        } catch (error) {
          throw new NativeOwnershipUncertain({ input, output, folder }, error);
        }
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
}
