#!/usr/bin/env node
// Frozen bootstrap: the one process a service manager (systemd, a Windows
// startup task, a container entrypoint) runs. It starts the active version's
// own supervisor, starts the next one when that supervisor hands over after an
// upgrade, and restores the previous version if a newly handed-over one never
// becomes healthy. Each version runs under the Node it brought, if any. It
// never touches the network, Docker or settings, and imports nothing from the
// application. Once this runtime-aware bootstrap is installed, later runtime
// upgrades need not replace it. An older frozen installed bootstrap needs a
// one-time controlled replacement; application updates cannot update that copy.
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A supervisor exits with this code to hand over to the active version. */
export const HANDOVER_EXIT = 75;
/** Told to each supervisor, so it knows it may hand over. */
export const BOOT_PROTOCOL = "1";
const SHA = /^[a-f0-9]{40}$/;

type Options = {
  home: string;
  /** The package this bootstrap shipped in; used until a version is active. */
  seed: string;
  /** How long a handed-over supervisor has to become healthy. */
  healthMs?: number;
  /** Test seam: start one supervisor under the given Node. */
  start?: (
    root: string,
    home: string,
    node: string,
    continuation: boolean,
  ) => ChildProcess;
};

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}
function writeAtomic(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, path);
}
const windows = process.platform === "win32";
const startSupervisor = (
  root: string,
  home: string,
  node: string,
  continuation: boolean,
) =>
  spawn(node, [join(root, "dist/cli.js"), "serve"], {
    // On Windows a stop reaches it over this IPC channel (see ask()). Not
    // elsewhere: an open channel would keep Linux's `serve` wrapper alive.
    stdio: windows ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
    env: {
      ...process.env,
      KATAFIT_COACH_HOME: home,
      KATAFIT_BOOT_PROTOCOL: BOOT_PROTOCOL,
      // Process-local lifecycle authority, never a persisted worker preference.
      KATAFIT_BOOT_CONTINUATION: continuation ? "1" : "0",
    },
  });

/** The active version and its package, or the seed while none is active. */
function active(
  home: string,
  seed: string,
  pointer = readJson(join(home, "active.json")),
) {
  const revision = pointer?.revision;
  const root = join(home, "versions", String(revision));
  return SHA.test(revision) && existsSync(join(root, "dist/cli.js"))
    ? { root, revision: revision as string }
    : { root: seed };
}
export const activeRoot = (home: string, seed: string) =>
  active(home, seed).root;

/**
 * The Node a version brought from its platform archive, kept beside it as
 * `versions/<SHA>.node`, or undefined if it brought none. A runtime that is
 * there but not a plain directory holding a plain executable is refused, not
 * replaced by this bootstrap's own Node.
 */
export function versionNode(
  home: string,
  revision: string,
  platform: NodeJS.Platform = process.platform,
) {
  if (!SHA.test(revision)) throw new Error("UNSAFE_RUNTIME");
  const runtime = join(home, "versions", `${revision}.node`);
  // Never follows links: lstat sees a link itself, which is neither.
  const kind = (path: string) => lstatSync(path, { throwIfNoEntry: false });
  if (!kind(runtime)) return undefined;
  // Found through a linked home or versions ancestor, it is not this home's.
  for (let path = resolve(runtime), depth = 0; ; depth++) {
    const parent = dirname(path);
    if (parent === path) break;
    if (depth > 64 || !kind(parent)?.isDirectory())
      throw new Error("UNSAFE_RUNTIME");
    path = parent;
  }
  const win = platform === "win32",
    node = win ? join(runtime, "node.exe") : join(runtime, "bin", "node"),
    file = kind(node);
  if (
    !kind(runtime)!.isDirectory() ||
    (!win && !kind(join(runtime, "bin"))?.isDirectory()) ||
    !file?.isFile() ||
    (!win && !(file.mode & 0o111))
  )
    throw new Error("UNSAFE_RUNTIME");
  return node;
}

/**
 * Starts a version's supervisor under its own Node, else this one. Undefined
 * if that Node is unusable or the system cannot start it at all.
 */
function launch(
  start: NonNullable<Options["start"]>,
  home: string,
  version: { root: string; revision?: string },
  continuation: boolean,
) {
  try {
    const node = version.revision
      ? (versionNode(home, version.revision) ?? process.execPath)
      : process.execPath;
    const child = start(version.root, home, node, continuation);
    if (child.pid !== undefined) return child;
    // Its spawn failure is reported as an error event, without an exit.
    child.on("error", () => {});
  } catch {}
  process.stderr.write(
    `katafit-coach-boot: cannot start ${version.revision ?? "the installed package"}\n`,
  );
  return undefined;
}

const exited = (child: ChildProcess) =>
  new Promise<number>((done) => {
    if (child.exitCode !== null) return done(child.exitCode);
    child.once("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
  });

// Healthy once the supervisor has written service.json after it started,
// which it does only after its application child is up.
async function healthy(
  home: string,
  child: ChildProcess,
  since: number,
  ms: number,
) {
  const deadline = Date.now() + ms;
  let ended = false;
  child.once("exit", () => (ended = true));
  const ready = () => {
    try {
      return statSync(join(home, "service.json")).mtimeMs >= since;
    } catch {
      return false;
    }
  };
  while (!ended && Date.now() < deadline) {
    if (ready()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  // It may have become healthy, then stopped, between two checks.
  return ready();
}

/**
 * Asks a supervisor to stop. On Windows a signal is a hard termination that
 * skips cleanup, so the IPC channel is closed instead; the supervisor shuts
 * down cleanly on disconnect.
 */
function ask(child: ChildProcess, signal: NodeJS.Signals) {
  if (windows && child.connected) child.disconnect();
  else child.kill(signal);
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  ask(child, "SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  await exited(child);
  clearTimeout(timer);
}

/** Runs supervisors until one exits for a reason other than a handover. */
export async function boot(options: Options): Promise<number> {
  const { home, seed } = options;
  const healthMs = options.healthMs ?? 60000;
  const start = options.start ?? startSupervisor;
  let current: ChildProcess | undefined;
  let continuation = false;
  let stopping = false;
  const forward = (signal: NodeJS.Signals) => () => {
    stopping = true;
    if (current) ask(current, signal);
  };
  const onTerm = forward("SIGTERM"),
    onInt = forward("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  try {
    for (;;) {
      const handoff = readJson(join(home, "handoff.json"));
      const pointer = readJson(join(home, "active.json"));
      const since = Date.now() - 1000;
      // A version that cannot be started fails like one that exits at once.
      const child = (current = launch(
        start,
        home,
        active(home, seed, pointer),
        continuation,
      ));
      const code = child ? exited(child) : Promise.resolve(1);
      if (
        handoff &&
        SHA.test(handoff.revision) &&
        handoff.revision === pointer?.revision
      ) {
        if (child && (await healthy(home, child, since, healthMs))) {
          rmSync(join(home, "handoff.json"), { force: true });
        } else if (stopping) {
          // A requested stop is not a failed version; keep it for next start.
          return await code;
        } else {
          // The new version never became healthy: go back to the one before.
          if (child) await stop(child);
          if (handoff.previous && SHA.test(handoff.previous.revision))
            writeAtomic(join(home, "active.json"), handoff.previous);
          else rmSync(join(home, "active.json"), { force: true });
          writeAtomic(join(home, "boot-rollback.json"), {
            revision: handoff.revision,
            restored: handoff.previous?.revision ?? null,
            at: Date.now(),
          });
          rmSync(join(home, "handoff.json"), { force: true });
          if (stopping) return 0;
          continue;
        }
      }
      const status = await code;
      if (status === HANDOVER_EXIT && !stopping) {
        continuation = true;
        continue;
      }
      return status;
    }
  } finally {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const home =
    process.env.KATAFIT_COACH_HOME ?? join(homedir(), ".katafit-coach");
  boot({
    home,
    seed: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  }).then(
    (code) => (process.exitCode = code),
    () => (process.exitCode = 1),
  );
}
