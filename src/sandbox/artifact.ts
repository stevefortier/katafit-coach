import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { lstat, open, rm, opendir } from "node:fs/promises";
import { constants } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { directory, managedFile } from "../update/managed.js";
import { atomicWrite } from "../update/journal.js";
import {
  cleanupNativeProbe,
  type NativeProbeEngine,
  type NativeProbeOwnership,
} from "./runtime.js";
export type { NativeProbeEngine, NativeProbeOwnership } from "./runtime.js";
const exec = promisify(execFile);
type PreflightRuntime = {
  containerId?: string;
  onOutput: (chunk: string) => void;
  start(session: {
    handle(request: any): Promise<any>;
    close(): Promise<void>;
  }): Promise<void>;
  attach(): Promise<void>;
  inspect(): Promise<any>;
  stop(): Promise<void>;
};
const pendingCleanup = new Map<string, Set<PreflightRuntime>>();
const cleanupRecord = "native-probe-cleanup.json";
const cleanupLockRecord = "native-probe.lock";
const cleanupLockWaitMs = 120_000;
const cleanupLockContext = new AsyncLocalStorage<ReadonlySet<string>>();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const containerId = /^[a-f0-9]{64}$/;

function validateOwnership(value: unknown): NativeProbeOwnership {
  const ownership = value as NativeProbeOwnership;
  const keys =
    value && typeof value === "object"
      ? Object.keys(value).sort().join(",")
      : "";
  const labels = ownership?.labels;
  if (
    keys !==
      "containerId,fingerprint,image,labels,name,protocol,revision,token" ||
    ownership.protocol !== 1 ||
    !uuid.test(ownership.token) ||
    ownership.name !== "katafit-pi-probe-" + ownership.token ||
    !/^[a-f0-9]{40}$/.test(ownership.revision) ||
    !/^[a-f0-9]{64}$/.test(ownership.fingerprint) ||
    !/^sha256:[a-f0-9]{64}$/.test(ownership.image) ||
    (ownership.containerId !== null &&
      !containerId.test(ownership.containerId)) ||
    !labels ||
    typeof labels !== "object" ||
    Array.isArray(labels) ||
    Object.keys(labels).sort().join(",") !==
      "fit.kata.native.fingerprint,fit.kata.native.probe,fit.kata.native.probe-owner,fit.kata.native.revision" ||
    labels["fit.kata.native.probe"] !== "1" ||
    labels["fit.kata.native.probe-owner"] !== ownership.token ||
    labels["fit.kata.native.revision"] !== ownership.revision ||
    labels["fit.kata.native.fingerprint"] !== ownership.fingerprint
  )
    throw new Error("NATIVE_CLEANUP_RECORD_INVALID");
  return structuredClone(ownership);
}

async function readOwnership(home: string) {
  try {
    return validateOwnership(
      JSON.parse(
        (await managedFile(join(home, cleanupRecord), 4096)).toString("utf8"),
      ),
    );
  } catch (error: any) {
    if (error.code === "ENOENT") return undefined;
    if (error.message === "NATIVE_CLEANUP_RECORD_INVALID") throw error;
    throw new Error("NATIVE_CLEANUP_RECORD_INVALID");
  }
}

async function removeOwnership(home: string, expected: NativeProbeOwnership) {
  const current = await readOwnership(home);
  if (!current || JSON.stringify(current) !== JSON.stringify(expected))
    throw new Error("NATIVE_CLEANUP_RECORD_INVALID");
  await rm(join(home, cleanupRecord));
  const parent = await open(
    home,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

async function drainDurableCleanup(home: string, engine?: NativeProbeEngine) {
  const ownership = await readOwnership(home);
  if (!ownership) return;
  await cleanupNativeProbe(ownership, engine);
  await removeOwnership(home, ownership);
}

async function acquireCleanupLock(home: string, signal?: AbortSignal) {
  if (process.platform !== "linux")
    throw new Error("NATIVE_PROBE_LOCK_UNAVAILABLE");
  if (signal?.aborted) throw new Error("BUILD_CANCELLED");
  await directory(home);
  const path = join(home, cleanupLockRecord);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    const [opened, linked] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      !opened.isFile() ||
      !linked.isFile() ||
      linked.isSymbolicLink() ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino ||
      opened.nlink !== 1 ||
      opened.size !== 0 ||
      (opened.mode & 0o777) !== 0o600 ||
      (process.getuid !== undefined && opened.uid !== process.getuid())
    )
      throw new Error("NATIVE_PROBE_LOCK_INVALID");
  } catch (error: any) {
    await handle?.close().catch(() => {});
    if (error.message === "NATIVE_PROBE_LOCK_INVALID") throw error;
    throw new Error("NATIVE_PROBE_LOCK_INVALID");
  }

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn("/usr/bin/flock", ["--exclusive", "3"], {
      env: {},
      stdio: ["ignore", "ignore", "ignore", handle.fd],
    });
  } catch {
    await handle.close();
    throw new Error("NATIVE_PROBE_LOCK_UNAVAILABLE");
  }
  try {
    await new Promise<void>((resolveAcquired, rejectAcquired) => {
      let settled = false;
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        settle(new Error("NATIVE_PROBE_LOCK_TIMEOUT"));
      }, cleanupLockWaitMs);
      timer.unref();
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        child.removeListener("error", failed);
        child.removeListener("close", closed);
        if (error) rejectAcquired(error);
        else resolveAcquired();
      };
      const abort = () => {
        child.kill("SIGTERM");
        settle(new Error("BUILD_CANCELLED"));
      };
      const failed = () => settle(new Error("NATIVE_PROBE_LOCK_UNAVAILABLE"));
      const closed = (code: number | null) =>
        settle(
          code === 0 ? undefined : new Error("NATIVE_PROBE_LOCK_UNAVAILABLE"),
        );
      child.once("error", failed);
      child.once("close", closed);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    const linked = await lstat(path);
    const opened = await handle.stat();
    if (
      !linked.isFile() ||
      linked.isSymbolicLink() ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino
    )
      throw new Error("NATIVE_PROBE_LOCK_INVALID");
  } catch (error) {
    child.kill("SIGTERM");
    await handle.close();
    throw error;
  }

  let released: Promise<void> | undefined;
  return {
    release() {
      return (released ??= handle.close());
    },
  };
}

async function withCleanupLock<T>(
  home: string,
  work: () => Promise<T>,
  signal?: AbortSignal,
) {
  const key = resolve(home);
  const inherited = cleanupLockContext.getStore();
  if (inherited?.has(key)) return work();
  const lock = await acquireCleanupLock(key, signal);
  try {
    return await cleanupLockContext.run(
      new Set([...(inherited ?? []), key]),
      work,
    );
  } finally {
    await lock.release();
  }
}

async function drainOwnedCleanup(key: string) {
  const owned = pendingCleanup.get(key);
  if (!owned) return;
  let failed = false;
  for (const runtime of [...owned]) {
    try {
      await runtime.stop();
      owned.delete(runtime);
    } catch {
      failed = true;
    }
  }
  if (!owned.size) pendingCleanup.delete(key);
  if (failed) throw new Error("NATIVE_CLEANUP_PENDING");
}

/** Retry process-local and restart-durable native probe ownership for one home. */
export async function drainNativePreflightCleanup(
  home: string,
  boundary: { engine?: NativeProbeEngine; signal?: AbortSignal } = {},
) {
  const key = resolve(home);
  await withCleanupLock(
    home,
    async () => {
      await drainOwnedCleanup(key);
      await drainDurableCleanup(home, boundary.engine);
    },
    boundary.signal,
  );
}
import {
  artifactFailure,
  artifactReason,
  type ArtifactReason,
} from "../update/preparation.js";
export const artifactRequired = "EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED";
export async function provisionArtifact(
  home: string,
  root: string,
  image: string,
  boundary: {
    inspect?: (
      file: string,
      args: string[],
      options: any,
    ) => Promise<{ stdout: string }>;
    probe?: typeof nativePreflight;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  boundary.signal?.throwIfAborted();
  await directory(home, true);
  return withCleanupLock(
    home,
    async () => {
      const { metadata } = await import("../update/managed.js");
      const { writeFile, rm } = await import("node:fs/promises");
      const build = await metadata(root);
      if (build.protocol !== 2 || !/^sha256:[a-f0-9]{64}$/.test(image))
        throw new Error(artifactRequired);
      const inspect = boundary.inspect ?? exec;
      const result = await inspect(
        "docker",
        ["--host=unix:///var/run/docker.sock", "image", "inspect", image],
        { timeout: 10000, maxBuffer: 65536 },
      );
      const [found] = JSON.parse(result.stdout);
      const folder = join(home, "native-artifacts");
      await directory(folder, true);
      const path = join(folder, build.revision + ".json");
      let created = false;
      try {
        try {
          await writeFile(
            path,
            JSON.stringify({
              revision: build.revision,
              fingerprint: build.fingerprint,
              image,
              platform: `${found.Os}/${found.Architecture}`,
            }) + "\n",
            { mode: 0o600, flag: "wx" },
          );
          created = true;
        } catch (error: any) {
          if (error.code !== "EEXIST") throw error;
        }
        if ((await nativeImage(home, root, inspect)) !== image)
          throw new Error(artifactRequired);
        await (boundary.probe ?? nativePreflight)(root, home);
      } catch (error) {
        if (created) await rm(path);
        throw error;
      }
    },
    boundary.signal,
  );
}
/** Native authority belongs to the service, unlike immutable package metadata.
 * Do not chmod/chown or repair evidence while observing it. Root-owned sticky
 * temporary ancestors are safe anchors; the home and receipt directory are not
 * allowed that exception. All other ancestors must exclude foreign writers. */
async function nativeAuthorityDirectory(path: string, privatePath: boolean) {
  await directory(path);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("UNSAFE_NATIVE_AUTHORITY");
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat(),
      linked = await lstat(path);
    for (const info of [opened, linked]) {
      const stickyRoot =
        !privatePath && info.uid === 0 && (info.mode & 0o1000) !== 0;
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (privatePath ? info.uid !== uid : info.uid !== uid && info.uid !== 0) ||
        ((info.mode & 0o022) !== 0 && !stickyRoot)
      )
        throw new Error("UNSAFE_NATIVE_AUTHORITY");
    }
    if (opened.dev !== linked.dev || opened.ino !== linked.ino)
      throw new Error("UNSAFE_NATIVE_AUTHORITY");
  } finally {
    await handle.close();
  }
}
async function nativeAuthorityFile(
  home: string,
  path: string,
): Promise<Buffer> {
  const root = resolve(home);
  for (let parent = root; ; parent = dirname(parent)) {
    await nativeAuthorityDirectory(parent, parent === root);
    if (dirname(parent) === parent) break;
  }
  if (dirname(path) !== root)
    await nativeAuthorityDirectory(dirname(path), true);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const check = (info: import("node:fs").Stats) => {
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        info.nlink !== 1 ||
        (info.mode & 0o022) !== 0 ||
        info.size > 2048
      )
        throw new Error("UNSAFE_NATIVE_AUTHORITY");
    };
    const opened = await handle.stat();
    check(opened);
    const linked = await lstat(path);
    check(linked);
    if (opened.dev !== linked.dev || opened.ino !== linked.ino)
      throw new Error("UNSAFE_NATIVE_AUTHORITY");
    const bytes = Buffer.alloc(2049);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    check(await handle.stat());
    if (bytesRead > 2048) throw new Error("UNSAFE_NATIVE_AUTHORITY");
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
/**
 * Exact-revision receipt first. Otherwise reuse a protected receipt with the
 * same native fingerprint: identical fingerprinted inputs build an identical
 * image, so source-only commits need no new out-of-band provisioning.
 */
async function nativeReceipt(
  home: string,
  build: { revision: string; fingerprint: string },
): Promise<any> {
  const folder = join(home, "native-artifacts");
  const read = async (name: string) =>
    JSON.parse(
      (await nativeAuthorityFile(home, join(folder, name))).toString(),
    );
  try {
    const exact = await read(build.revision + ".json");
    if (exact.revision !== build.revision) throw new Error();
    return exact;
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  // Finite metadata scan. Never enumerate an unbounded artifact history.
  const names: string[] = [];
  const entries = await opendir(folder);
  for await (const entry of entries) {
    if (names.length >= 1024) throw new Error("NATIVE_RECEIPT_LIMIT");
    names.push(entry.name);
  }
  for (const name of names.sort()) {
    if (!/^[a-f0-9]{40}\.json$/.test(name)) continue;
    const candidate = await read(name);
    if (
      candidate.revision + ".json" === name &&
      candidate.fingerprint === build.fingerprint
    )
      return candidate;
  }
  throw artifactFailure("MISSING_MATCHING_ARTIFACT");
}
/** Protected host provisioning receipt, never a caller-selected tag or pull. */
export async function nativeImage(
  home: string,
  root = fileURLToPath(new URL("../../", import.meta.url)),
  inspect: (
    file: string,
    args: string[],
    options: any,
  ) => Promise<{ stdout: string }> = exec,
): Promise<string> {
  try {
    const build = JSON.parse(
      (await managedFile(join(root, "dist/build.json"), 2048)).toString(),
    );
    return await nativeImageForBuild(home, build, inspect);
  } catch (error) {
    throw artifactFailure(artifactReason(error) ?? "INVALID_BINDING");
  }
}
/** Bounded read-only receipt/image observation; no staging, probe or receipt write. */
export async function nativeImageForBuild(
  home: string,
  build: { protocol: number; revision: string; fingerprint: string },
  inspect: Parameters<typeof nativeImage>[2] = exec,
): Promise<string> {
  try {
    if (
      build.protocol !== 2 ||
      typeof build.revision !== "string" ||
      !/^[a-f0-9]{40}$/.test(build.revision) ||
      typeof build.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(build.fingerprint)
    )
      throw new Error();
    let binding: any;
    try {
      binding = await nativeReceipt(home, build);
    } catch (error: any) {
      throw artifactFailure(
        error.code === "ENOENT" ||
          artifactReason(error) === "MISSING_MATCHING_ARTIFACT"
          ? "MISSING_MATCHING_ARTIFACT"
          : "INVALID_BINDING",
      );
    }
    if (
      !/^[a-f0-9]{40}$/.test(binding.revision) ||
      binding.fingerprint !== build.fingerprint ||
      !/^sha256:[a-f0-9]{64}$/.test(binding.image)
    )
      throw new Error();
    try {
      const active = JSON.parse(
        (await nativeAuthorityFile(home, join(home, "active.json"))).toString(),
      );
      if (active.revision === build.revision && active.image !== binding.image)
        throw new Error();
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    let result: { stdout: string };
    try {
      result = await inspect(
        "docker",
        [
          "--host=unix:///var/run/docker.sock",
          "image",
          "inspect",
          binding.image,
        ],
        { timeout: 10000, maxBuffer: 65536 },
      );
    } catch (error: any) {
      const absent =
        error?.code === 1 &&
        typeof error.stderr === "string" &&
        error.stderr.trim() ===
          `Error response from daemon: No such image: ${binding.image}`;
      throw artifactFailure(
        absent ? "MISSING_MATCHING_ARTIFACT" : "DOCKER_UNAVAILABLE",
      );
    }
    const [image] = JSON.parse(result.stdout);
    const architecture =
      process.arch === "x64"
        ? "amd64"
        : process.arch === "arm64"
          ? "arm64"
          : "unsupported";
    if (image.Architecture !== architecture) throw new Error();
    if (
      image.Id !== binding.image ||
      binding.platform !== `${image.Os}/${image.Architecture}` ||
      image.Os !== "linux" ||
      image.Config?.Labels?.["fit.kata.native.revision"] !== binding.revision ||
      image.Config?.Labels?.["fit.kata.native.fingerprint"] !==
        build.fingerprint
    )
      throw new Error();
    return binding.image;
  } catch (error) {
    throw artifactFailure(artifactReason(error) ?? "INVALID_BINDING");
  }
}
export async function nativePreflight(
  root: string,
  home: string,
  boundary: {
    inspect?: Parameters<typeof nativeImage>[2];
    signal?: AbortSignal;
    runtime?: (
      image: string,
      ownership: NativeProbeOwnership,
    ) => PreflightRuntime;
    engine?: NativeProbeEngine;
  } = {},
): Promise<string | undefined> {
  const { metadata } = await import("../update/managed.js");
  const key = resolve(home);
  return withCleanupLock(
    home,
    async () => {
      try {
        await drainDurableCleanup(home, boundary.engine);
      } catch {
        throw artifactFailure("CLEANUP_PENDING");
      }
      const build = await metadata(root);
      if (build.protocol === 1) return undefined;
      try {
        await drainOwnedCleanup(key);
      } catch {
        throw artifactFailure("CLEANUP_PENDING");
      }
      boundary.signal?.throwIfAborted();
      const image = await nativeImage(home, root, boundary.inspect);
      const { NativeRuntime } = await import("./runtime.js");
      const token = randomUUID();
      const ownership: NativeProbeOwnership = {
        protocol: 1,
        name: "katafit-pi-probe-" + token,
        token,
        revision: build.revision,
        fingerprint: build.fingerprint!,
        image,
        labels: {
          "fit.kata.native.probe": "1",
          "fit.kata.native.probe-owner": token,
          "fit.kata.native.revision": build.revision,
          "fit.kata.native.fingerprint": build.fingerprint!,
        },
        containerId: null,
      };
      const durable =
        boundary.runtime === undefined || boundary.engine !== undefined;
      if (durable) await atomicWrite(home, cleanupRecord, ownership);
      const runtime =
        boundary.runtime?.(image, ownership) ??
        new NativeRuntime(image, { ownership, probeEngine: boundary.engine });
      let catalog = false,
        output = "";
      runtime.onOutput = (chunk) => {
        output = (output + chunk).slice(-65536);
      };
      try {
        await runtime.start({
          async handle(request: any) {
            if (request.kind !== "catalog")
              throw new Error("PREFLIGHT_NO_EXTERNAL_REQUESTS");
            catalog = true;
            return {
              model: "katafit-preflight",
              vision: false,
              prompt: "Synthetic readiness probe. Do not call tools.",
              tools: [],
            };
          },
          async close() {},
        });
        if (durable && runtime.containerId !== undefined) {
          if (!containerId.test(runtime.containerId))
            throw new Error("NATIVE_PREFLIGHT_FAILED");
          const current = await readOwnership(home);
          if (
            !current ||
            current.token !== ownership.token ||
            current.containerId !== null
          )
            throw new Error("NATIVE_CLEANUP_RECORD_INVALID");
          ownership.containerId = runtime.containerId;
          await atomicWrite(home, cleanupRecord, ownership);
        }
        await runtime.attach();
        const deadline = Date.now() + 15000;
        while (!catalog || !output.includes("katafit-preflight")) {
          boundary.signal?.throwIfAborted();
          if (Date.now() > deadline) throw new Error("NATIVE_PREFLIGHT_FAILED");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const state = await runtime.inspect();
        if (
          state.Image !== image ||
          state.HostConfig.NetworkMode !== "none" ||
          !state.HostConfig.ReadonlyRootfs ||
          state.Config.User !== "1000:1000" ||
          state.Mounts.some(
            (mount: any) => mount.Type === "bind" || mount.Type === "volume",
          )
        )
          throw new Error("NATIVE_PREFLIGHT_FAILED");
        return image;
      } catch (error) {
        if (boundary.signal?.aborted && error === boundary.signal.reason)
          throw new Error("BUILD_CANCELLED");
        throw artifactFailure("PROBE_FAILED");
      } finally {
        try {
          await runtime.stop();
          if (durable) await removeOwnership(home, ownership);
        } catch {
          const owned = pendingCleanup.get(key) ?? new Set<PreflightRuntime>();
          owned.add(runtime);
          pendingCleanup.set(key, owned);
          throw artifactFailure("CLEANUP_PENDING");
        }
      }
    },
    boundary.signal,
  );
}
