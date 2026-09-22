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
} from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname, resolve, parse } from "node:path";
import { repository, validSha } from "./updates.js";

// Code-only injection for deterministic tests. Never read a URL/ref from HTTP or env.
export interface SourceBoundary {
  source?: string;
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
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_cache: join(home, ".npm"),
    npm_config_globalconfig: join(home, ".npm-global-empty"),
    npm_config_userconfig: "/dev/null",
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
      stdio: "ignore",
    });
    let failed = false,
      finished = false;
    const stop = () => {
      // An in-flight scan may settle after exit; never signal a stale PID.
      if (finished) return;
      failed = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
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
    signal?.addEventListener("abort", stop, { once: true });
    const clear = () => {
      finished = true;
      clearTimeout(timer);
      clearInterval(disk);
      signal?.removeEventListener("abort", stop);
    };
    child.once("error", () => {
      clear();
      reject(new Error("BUILD_TOOL_UNAVAILABLE"));
    });
    child.once("exit", (code) => {
      clear();
      if (code === 0 && !failed) resolve();
      else reject(new Error("BUILD_FAILED"));
    });
  });
}
export async function metadata(root: string) {
  const data = JSON.parse(
    (await managedFile(join(root, "dist/build.json"), 1024)).toString("utf8"),
  );
  if (!validSha(data.revision) || data.protocol !== 1)
    throw new Error("INCOMPATIBLE_BUILD");
  return data as { revision: string; protocol: 1 };
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
  await mkdir(checkout);
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
    const destination = join(versions, sha);
    // Existing versions are never overwritten (may be loaded by the live owner).
    await rename(checkout, destination);
    return destination;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
