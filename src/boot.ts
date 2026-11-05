#!/usr/bin/env node
// Frozen bootstrap: the one process a service manager (systemd, a Windows
// startup task, a container entrypoint) runs. It starts the active version's
// own supervisor, starts the next one when that supervisor hands over after an
// upgrade, and restores the previous version if a newly handed-over one never
// becomes healthy. It never touches the network, Docker or settings, and
// imports nothing from the application, so upgrades never need to replace it.
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
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
  /** Test seam: start one supervisor. */
  start?: (root: string, home: string) => ChildProcess;
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
const startSupervisor = (root: string, home: string) =>
  spawn(process.execPath, [join(root, "dist/cli.js"), "serve"], {
    stdio: "inherit",
    env: {
      ...process.env,
      KATAFIT_COACH_HOME: home,
      KATAFIT_BOOT_PROTOCOL: BOOT_PROTOCOL,
    },
  });

/** The active version's package, or the seed while none is active. */
export function activeRoot(home: string, seed: string) {
  const revision = readJson(join(home, "active.json"))?.revision;
  const root = join(home, "versions", String(revision));
  return SHA.test(revision) && existsSync(join(root, "dist/cli.js"))
    ? root
    : seed;
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

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
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
  let stopping = false;
  const forward = (signal: NodeJS.Signals) => () => {
    stopping = true;
    current?.kill(signal);
  };
  const onTerm = forward("SIGTERM"),
    onInt = forward("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  try {
    for (;;) {
      const handoff = readJson(join(home, "handoff.json"));
      const active = readJson(join(home, "active.json"));
      const since = Date.now() - 1000;
      const child = (current = start(activeRoot(home, seed), home));
      const code = exited(child);
      if (
        handoff &&
        SHA.test(handoff.revision) &&
        handoff.revision === active?.revision
      ) {
        if (await healthy(home, child, since, healthMs)) {
          rmSync(join(home, "handoff.json"), { force: true });
        } else if (stopping) {
          // A requested stop is not a failed version; keep it for next start.
          return await code;
        } else {
          // The new version never became healthy: go back to the one before.
          await stop(child);
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
      if (status === HANDOVER_EXIT && !stopping) continue;
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
