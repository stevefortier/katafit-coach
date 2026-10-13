import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import { dirname } from "node:path";

export type NativeEngine = "legacy" | "bounded-v1";
export interface NativeBinding {
  readonly image: string;
  readonly engine: NativeEngine;
}
export const nativeEngineInstallation = "/etc/katafit/native-engines.json";
const sockets = {
  legacy: "/var/run/docker.sock",
  "bounded-v1": "/var/lib/katafit-bounded/store/run/docker.sock",
} as const;
export function nativeEngine(value: unknown): NativeEngine {
  if (value !== "legacy" && value !== "bounded-v1")
    throw Error("NATIVE_ENGINE_INVALID");
  return value;
}
export function recordEngine(value: { engine?: unknown }): NativeEngine {
  return Object.hasOwn(value, "engine") ? nativeEngine(value.engine) : "legacy";
}
export function asNativeBinding(value: string | NativeBinding): NativeBinding {
  // String callers are the explicit, frozen legacy interface only.
  const binding =
    typeof value === "string"
      ? { image: value, engine: "legacy" as const }
      : value;
  if (
    !binding ||
    typeof binding !== "object" ||
    Array.isArray(binding) ||
    Object.keys(binding).sort().join(",") !== "engine,image" ||
    typeof binding.image !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(binding.image)
  )
    throw Error("NATIVE_BINDING_INVALID");
  return { image: binding.image, engine: nativeEngine(binding.engine) };
}
export function sameNativeBinding(a: NativeBinding, b: NativeBinding) {
  return a.image === b.image && a.engine === b.engine;
}
export function engineField(engine: NativeEngine) {
  return engine === "legacy" ? {} : { engine };
}
/** Fixed installed authority; no file-selected URL or environment fallback.
 * The filesystem parameter is a code-only unit fixture, never an input API. */
export function validateNativeEngineInstallation(io: typeof fs = fs): void {
  let fd: number | undefined;
  try {
    for (let p = dirname(nativeEngineInstallation); ; p = dirname(p)) {
      const s = io.lstatSync(p);
      if (
        !s.isDirectory() ||
        s.isSymbolicLink() ||
        s.uid !== 0 ||
        s.mode & 0o022
      )
        throw Error();
      if (p === dirname(p)) break;
    }
    const flags =
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
    fd = io.openSync(nativeEngineInstallation, flags);
    const check = (s: fs.Stats) => {
      if (
        !s.isFile() ||
        s.isSymbolicLink() ||
        s.uid !== 0 ||
        s.nlink !== 1 ||
        s.mode & 0o022 ||
        s.size > 256
      )
        throw Error();
    };
    const opened = io.fstatSync(fd);
    check(opened);
    const linked = io.lstatSync(nativeEngineInstallation);
    check(linked);
    if (opened.dev !== linked.dev || opened.ino !== linked.ino) throw Error();
    const bytes = Buffer.alloc(257),
      length = io.readSync(fd, bytes, 0, 257, 0);
    if (length > 256) throw Error();
    const after = io.fstatSync(fd);
    check(after);
    if (after.size !== length) throw Error();
    const value = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).join(",") !== "bounded-v1" ||
      value["bounded-v1"] !== sockets["bounded-v1"]
    )
      throw Error();
    const final = io.lstatSync(nativeEngineInstallation);
    check(final);
    if (final.dev !== opened.dev || final.ino !== opened.ino) throw Error();
  } catch {
    throw Error("NATIVE_ENGINE_INSTALLATION_REQUIRED");
  } finally {
    if (fd !== undefined) io.closeSync(fd);
  }
}
const fixture = new AsyncLocalStorage<() => void>();
/** Explicit code-only fixture for tests with no root installation. Cannot
 * change endpoint mapping; never populated by CLI/IPC/manifest/environment. */
export function withNativeEngineAuthorityFixture<T>(
  read: () => void,
  work: () => T,
): T {
  return fixture.run(read, work);
}
export function nativeEngineSocket(engine: NativeEngine): string {
  nativeEngine(engine);
  if (engine !== "legacy")
    (fixture.getStore() ?? validateNativeEngineInstallation)();
  return sockets[engine];
}
export function nativeEngineHost(engine: NativeEngine): string {
  return "--host=unix://" + nativeEngineSocket(engine);
}
export function legacyImage(binding: NativeBinding): string {
  if (binding.engine !== "legacy")
    throw Error("NATIVE_ENGINE_CONTEXT_REQUIRED");
  return binding.image;
}
