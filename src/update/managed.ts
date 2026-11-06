import { syncDirectory, windows } from "../runtime/platform.js";
import { CandidateOwnership } from "./candidate.js";
import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  rm,
  rename,
  statfs,
  readdir,
  lstat,
  open,
  chmod,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname, resolve, parse, delimiter } from "node:path";
import { repository, validSha } from "./updates.js";
import {
  verifyProvenanceFile,
  type Artifact,
  type Platform,
} from "../release/manifest.js";

// Code-only injection for deterministic tests. Never read a URL/ref from HTTP or env.
export interface SourceBoundary {
  source?: string;
  candidateToken?: string;
}
export async function directory(path: string, create = false): Promise<void> {
  const full = resolve(path),
    parent = dirname(full);
  if (parent !== full) await directory(parent, create);
  try {
    const info = await lstat(full);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("UNSAFE_PATH");
  } catch (e: any) {
    if (e.code !== "ENOENT" || !create) throw e;
    await mkdir(full, { mode: 0o700 });
  }
}
export async function managedFile(
  path: string,
  limit = 65536,
): Promise<Buffer> {
  await directory(dirname(path));
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error("UNSAFE_PATH");
    const buffer = Buffer.alloc(limit + 1);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    if (result.bytesRead > limit) throw new Error("UNSAFE_PATH");
    return buffer.subarray(0, result.bytesRead);
  } catch (e: any) {
    if (e.code === "ELOOP") throw new Error("UNSAFE_PATH");
    throw e;
  } finally {
    await handle?.close();
  }
}
export function buildEnvironment(home: string): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  return {
    PATH: windows
      ? [
          dirname(process.execPath),
          join(systemRoot, "System32"),
          systemRoot,
        ].join(delimiter)
      : `${dirname(process.execPath)}:/usr/bin:/bin`,
    ...(windows
      ? {
          SystemRoot: systemRoot,
          USERPROFILE: home,
          TEMP: home,
          TMP: home,
        }
      : {}),
    HOME: home,
    LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: windows ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_cache: join(home, ".npm"),
    npm_config_globalconfig: join(home, ".npm-global-empty"),
    npm_config_userconfig: windows
      ? join(home, ".npm-user-empty")
      : "/dev/null",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
}
async function bytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const p = join(path, entry.name);
    try {
      if (entry.isDirectory()) total += await bytes(p);
      else total += (await lstat(p)).size;
    } catch (error: any) {
      // Installers legitimately rename/remove entries after enumeration. The
      // next scan counts their replacements; other IO failures remain fatal.
      if (error.code !== "ENOENT") throw error;
    }
  }
  return total;
}
export async function command(
  file: string,
  args: string[],
  cwd: string,
  home: string,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new Error("BUILD_CANCELLED");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: buildEnvironment(home),
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    let failed = false,
      cancelled = false,
      finished = false;
    const stop = () => {
      // An in-flight scan may settle after exit; never signal a stale PID.
      if (finished) return;
      if (failed) return;
      failed = true;
      try {
        if (windows) child.kill("SIGKILL");
        else process.kill(-child.pid!, "SIGKILL");
      } catch {}
    };
    const timer = setTimeout(stop, 180000);
    let checking = false;
    const disk = setInterval(() => {
      if (checking) return;
      checking = true;
      void bytes(home)
        .then((n) => {
          if (n > 1024 * 1024 * 1024) stop();
        })
        .catch(stop)
        .finally(() => {
          checking = false;
        });
    }, 1000);
    const abort = () => {
      if (
        !finished &&
        !failed &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        cancelled = true;
        stop();
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const clear = () => {
      finished = true;
      clearTimeout(timer);
      clearInterval(disk);
      signal?.removeEventListener("abort", abort);
    };
    child.once("error", () => {
      clear();
      reject(new Error("BUILD_TOOL_UNAVAILABLE"));
    });
    child.once("exit", (code) => {
      clear();
      if (code === 0 && !failed) resolve();
      else reject(new Error(cancelled ? "BUILD_CANCELLED" : "BUILD_FAILED"));
    });
  });
}
export async function metadata(root: string) {
  const data = JSON.parse(
    (await managedFile(join(root, "dist/build.json"), 1024)).toString("utf8"),
  );
  if (
    !validSha(data.revision) ||
    ![1, 2].includes(data.protocol) ||
    (data.protocol === 2 && !/^[a-f0-9]{64}$/.test(data.fingerprint))
  )
    throw new Error("INCOMPATIBLE_BUILD");
  if (
    data.capabilities !== undefined &&
    (!Array.isArray(data.capabilities) ||
      data.capabilities.length > 16 ||
      !data.capabilities.every(
        (c: unknown) => typeof c === "string" && /^[a-z0-9-]{1,64}$/.test(c),
      ))
  )
    throw new Error("INCOMPATIBLE_BUILD");
  return data as {
    revision: string;
    protocol: 1 | 2;
    fingerprint?: string;
    capabilities?: string[];
  };
}
export async function stage(
  home: string,
  sha: string,
  boundary: SourceBoundary = {},
  signal?: AbortSignal,
) {
  if (!validSha(sha)) throw new Error("TARGET_REJECTED");
  const versions = join(home, "versions"),
    staging = join(home, "update-staging");
  await directory(home);
  await directory(versions, true);
  try {
    await directory(staging);
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  const space = await statfs(home);
  if (space.bavail * space.bsize < 1536 * 1024 * 1024)
    throw new Error("INSUFFICIENT_DISK");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { mode: 0o700 });
  const checkout = join(staging, "source");
  await mkdir(checkout, { mode: 0o700 });
  const run = (file: string, args: string[]) =>
    command(file, args, checkout, staging, signal);
  try {
    await run("git", ["init", "-q"]);
    await run("git", [
      "-c",
      "protocol.file.allow=always",
      "fetch",
      "--depth=1",
      "--no-tags",
      boundary.source ?? repository,
      sha,
    ]);
    await run("git", ["checkout", "--detach", "FETCH_HEAD"]);
    // Git resolves the exact SHA, never a moving branch.
    const head = (await managedFile(join(checkout, ".git/HEAD")))
      .toString("utf8")
      .trim();
    if (head !== sha) throw new Error("SOURCE_MISMATCH");
    const pkg = JSON.parse(
      (await managedFile(join(checkout, "package.json"))).toString("utf8"),
    );
    if (pkg.name !== "@katafit/coach") throw new Error("PACKAGE_REJECTED");
    await managedFile(join(checkout, "package-lock.json"), 4 * 1024 * 1024);
    await run("npm", [
      "ci",
      "--include=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
    await run("npm", ["run", "build"]);
    if ((await metadata(checkout)).revision !== sha)
      throw new Error("SOURCE_MISMATCH");
    await managedFile(join(checkout, "dist/server/admin.js"), 1024 * 1024);
    await rm(join(checkout, ".git"), { recursive: true, force: true });
    return await publishCandidate(home, sha, checkout, boundary.candidateToken);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** This machine's self-contained archive platform, if releases build one. */
export function hostPlatform(): Platform | undefined {
  if (process.platform === "linux" && process.arch === "x64")
    return "linux-x64";
  if (process.platform === "linux" && process.arch === "arm64")
    return "linux-arm64";
  if (process.platform === "win32" && process.arch === "x64") return "win-x64";
  return undefined;
}

/**
 * Checks the Node runtime an archive carries before it is kept: plain
 * directories and singly-linked regular files only, within bounds, with the
 * platform's executable where the bootstrap looks for it.
 */
async function archiveRuntime(root: string, platform: Platform) {
  let entries = 0,
    total = 0;
  const walk = async (path: string, depth: number) => {
    for (const name of await readdir(path)) {
      const entry = join(path, name),
        info = await lstat(entry);
      if (++entries > 256 || depth > 8) throw new Error("PACKAGE_REJECTED");
      if (info.isDirectory()) await walk(entry, depth + 1);
      else if (!info.isFile() || info.nlink !== 1)
        throw new Error("UNSAFE_PATH");
      else if ((total += info.size) > 512 * 1024 * 1024)
        throw new Error("PACKAGE_REJECTED");
    }
  };
  let info;
  try {
    info = await lstat(root);
  } catch (e: any) {
    if (e.code === "ENOENT") throw new Error("PACKAGE_REJECTED");
    throw e;
  }
  if (!info.isDirectory()) throw new Error("UNSAFE_PATH");
  await walk(root, 0);
  const win = platform.startsWith("win-"),
    node = await lstat(
      win ? join(root, "node.exe") : join(root, "bin", "node"),
    ).catch(() => undefined);
  if (!node?.isFile() || (!win && !(node.mode & 0o100)))
    throw new Error("PACKAGE_REJECTED");
}

/**
 * Stages a release from its self-contained platform archive instead of
 * building source: no git, npm or build tools. The archive must match its
 * published size and digest and carry a valid attestation for exactly `sha`;
 * its application directory becomes the candidate, like a source build's, and
 * its whole Node runtime is kept beside it as `versions/<SHA>.node`.
 */
export async function stageArchive(
  home: string,
  sha: string,
  archive: Artifact & { url: string },
  boundary: {
    candidateToken?: string;
    download: (
      url: string,
      target: string,
      size: number,
      sha256: string,
    ) => Promise<void>;
    verify?: (path: string, revision: string) => Promise<void>;
    /** Test seam: the platform whose archive this is. */
    platform?: Platform;
  },
  signal?: AbortSignal,
) {
  const platform = boundary.platform ?? hostPlatform();
  if (
    !validSha(sha) ||
    !platform ||
    archive.name !==
      `coach-${sha}-${platform}.${platform.startsWith("win-") ? "zip" : "tar.gz"}`
  )
    throw new Error("TARGET_REJECTED");
  const versions = join(home, "versions"),
    staging = join(home, "update-staging");
  await directory(home);
  await directory(versions, true);
  const space = await statfs(home);
  if (space.bavail * space.bsize < 1536 * 1024 * 1024)
    throw new Error("INSUFFICIENT_DISK");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { mode: 0o700 });
  try {
    const file = join(staging, archive.name);
    await boundary.download(archive.url, file, archive.size, archive.sha256);
    if (signal?.aborted) throw new Error("BUILD_CANCELLED");
    await (boundary.verify ?? verifyProvenanceFile)(file, sha);
    const extracted = join(staging, "extract");
    await mkdir(extracted, { mode: 0o700 });
    // bsdtar (Windows) reads zip too; the archive is attested, not user data.
    await command(
      windows
        ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
        : "tar",
      ["-xf", file, "-C", extracted],
      staging,
      staging,
      signal,
    );
    const root = join(extracted, "katafit-coach"),
      app = join(root, "app"),
      node = join(root, "node");
    if ((await metadata(app)).revision !== sha)
      throw new Error("SOURCE_MISMATCH");
    await managedFile(join(app, "dist/server/admin.js"), 1024 * 1024);
    await archiveRuntime(node, platform);
    // Extraction applies the umask; ownership marks need private directories.
    for (const path of [root, app, node]) await chmod(path, 0o700);
    return await publishCandidate(
      home,
      sha,
      app,
      boundary.candidateToken,
      node,
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Marker moves atomically with staged code; a crash cannot publish unowned
 * code. A runtime is published after its application, with the same marker,
 * so it never exists without owned code its cleanup can find.
 */
export async function publishCandidate(
  home: string,
  sha: string,
  checkout: string,
  token?: string,
  runtime?: string,
) {
  const destination = join(home, "versions", sha),
    node = `${destination}.node`;
  // Never replace anything already at either name: not even an empty
  // directory or a dangling link, and never a runtime for source code.
  for (const path of [destination, node]) {
    const existing = await lstat(path).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
    if (existing) throw new Error("UNSAFE_PATH");
  }
  if (token) {
    const ownership = new CandidateOwnership(home);
    await ownership.mark(checkout, sha, token);
    if (runtime) await ownership.mark(runtime, sha, token);
  }
  await rename(checkout, destination);
  if (runtime) await rename(runtime, node);
  await syncDirectory(join(home, "versions"));
  return destination;
}
