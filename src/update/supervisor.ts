import { fork, type ChildProcess } from "node:child_process";
import {
  artifactRequired,
  drainNativePreflightCleanup,
  nativePreflight,
} from "../sandbox/artifact.js";
import { Store } from "../config/store.js";
import { launcherSkillCatalog } from "../config/skills.js";
import { Updates, validSha } from "./updates.js";
import {
  AUTONOMY_LEDGER_CAPABILITY,
  manualOnlySourceUpdates,
} from "./capability.js";
import { ledgerObligations } from "../autonomy/ledger.js";

import { UpdateJournal, atomicWrite } from "./journal.js";
import {
  stage,
  metadata,
  command,
  buildEnvironment,
  managedFile,
  directory,
} from "./managed.js";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  readdir,
  access,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
interface Boundary {
  housekeeping?: () => Promise<void>;
  prepare?: (sha: string, signal: AbortSignal) => Promise<string>;
  preflight?: (
    root: string,
    home: string,
    signal: AbortSignal,
  ) => Promise<string | undefined>;
  recoveryTimer?: typeof setTimeout;
  request?: typeof fetch;
}
export async function supervise(
  store: Store,
  port: number,
  onShutdown?: () => void,
  boundary: Boundary = {},
) {
  const home = store.dir,
    root = fileURLToPath(new URL("../../", import.meta.url));
  await directory(home);
  let active: { revision: string } | null = null;
  try {
    active = JSON.parse(
      (await managedFile(join(home, "active.json"), 1024)).toString("utf8"),
    );
    if (!validSha(active?.revision)) throw new Error("INVALID_ACTIVE");
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  let installed = active?.revision ?? null;
  if (!installed) {
    try {
      installed = (await metadata(root)).revision;
    } catch {}
  }
  let closing = false,
    child: ChildProcess | undefined,
    origin = "";
  const controller = new AbortController();
  let operation: Promise<void> | undefined;

  let ambiguousQuiesce = false;
  let recoveryWasRunning: boolean | undefined;
  let recoverySha: string | undefined;
  let recoveryOutcome = "deferred";
  let manualRecovery = false;
  let manualPending = false;
  let manualWork: Promise<void> | undefined;
  let supported =
    process.platform === "linux" &&
    process.env.KATAFIT_COACH_UPDATES !== "disabled";
  try {
    await access(home, constants.W_OK);
  } catch {
    supported = false;
  }
  async function stop(target = child) {
    if (!target || target.exitCode !== null || target.signalCode !== null)
      return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        target.kill("SIGKILL");
      }, 5000);
      target.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      target.kill("SIGTERM");
    });
  }
  const send = (data: unknown) => {
    if (child?.connected) child.send(data as any, () => {});
  };
  async function launch(
    path: string,
    revision: string | null,
    wantedPort: number,
    preparedImage?: string,
  ) {
    if (revision && (await metadata(path)).revision !== revision)
      throw new Error("INVALID_ACTIVE");
    // C5 R4: unresolved (or unreadable) autonomy writes may only be held by an
    // application that declares it honours the ledger. Fail closed: launch
    // nothing and leave the ledger and rollback artifacts untouched.
    if ((await ledgerObligations(home)) !== "none") {
      let capable = false;
      try {
        capable = !!(await metadata(path)).capabilities?.includes(
          AUTONOMY_LEDGER_CAPABILITY,
        );
      } catch {}
      if (!capable) throw new Error("AUTONOMY_LEDGER_UNSUPPORTED");
    }
    if (revision) {
      const image = await (
        boundary.preflight ??
        ((r, h, signal) => nativePreflight(r, h, { signal }))
      )(path, home, controller.signal);
      if (preparedImage !== undefined && image !== preparedImage)
        throw new Error(artifactRequired);
    }
    const nonce = randomUUID();
    const target = fork(
      join(root, "dist/update/runtime.js"),
      [path, home, String(wantedPort), nonce],
      {
        execArgv: [],
        env: buildEnvironment(home),
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    child = target;
    target.on("message", async (message: any) => {
      if (message?.type !== "rpc" || target !== child || closing) return;
      const reply = (data: unknown, error?: string) => {
        if (target.connected)
          target.send({ type: "reply", id: message.id, data, error }, () => {});
      };
      if (message.method === "check") {
        reply(await updates.check());
        return;
      }
      if (message.method === "prepare") {
        if (manualPending || ambiguousQuiesce)
          return reply(undefined, "UPDATE_IN_PROGRESS");
        const sha = message.sha;
        try {
          updates.validate(sha);
          manualPending = true;
          const promise = updates.prepare(sha);
          manualWork = promise;
          await promise;
          reply(updates.snapshot());
          send({ type: "state", data: updates.snapshot() });
        } catch (error) {
          manualPending = false;
          reply(
            undefined,
            error instanceof Error
              ? error.message
              : "UPDATE_PREPARATION_FAILED",
          );
        }
        return;
      }
      if (message.method === "cancelPreparation") {
        const sha = message.sha;
        await releaseReservation(sha).catch(() => {});
        manualPending = false;
        reply(updates.snapshot());
        return;
      }
      if (message.method === "apply" || message.method === "legacyApply") {
        const legacy = message.method === "legacyApply";
        if ((legacy ? manualPending : !manualPending) || ambiguousQuiesce)
          return reply(undefined, "UPDATE_IN_PROGRESS");
        try {
          const resume = message.sha?.resume === true;
          const sha = resume ? message.sha.sha : message.sha;
          if (legacy) {
            if (resume) throw new Error("LAUNCHER_UPGRADE_REQUIRED");
            updates.validate(sha);
            manualPending = true;
            const preparation = updates.prepare(sha);
            manualWork = preparation;
            try {
              await preparation;
            } catch (error) {
              await updates
                .recordPreparationFailure(sha, error)
                .catch(() => {});
              throw error;
            }
          }
          updates.validatePrepared(sha);
          if (resume) {
            await atomicWrite(home, "update-resume.json", {
              sha,
              pending: true,
            });
            manualRecovery = true;
            recoveryWasRunning = true;
            recoverySha = sha;
            updates.recovering = true;
          }
          const promise = updates.apply(sha, false, true);
          void promise.catch(() => {});
          manualWork = promise
            .catch(() => {})
            .finally(async () => {
              manualPending = false;
              if (resume) {
                ambiguousQuiesce = true;
                recoveryOutcome =
                  updates.installed === sha ? "running" : "restored-running";
                updates.recoveryOutcome = { sha, state: "resume-failed" };
              }
              send({ type: "state", data: updates.snapshot() });
              if (resume) await recoverAmbiguousQuiesce();
              if (ambiguousQuiesce && !closing) {
                scheduleRecovery();
              }
              send({ type: "state", data: updates.snapshot() });
            });
          await updates.accepted;
          reply(updates.snapshot());
          send({ type: "state", data: updates.snapshot() });
        } catch (error) {
          const sha =
            message.sha?.resume === true ? message.sha.sha : message.sha;
          await releaseReservation(sha).catch(() => {});
          manualPending = false;
          reply(
            undefined,
            error instanceof Error ? error.message : "TARGET_REJECTED",
          );
        }
        return;
      }
      if (message.method === "shutdown") onShutdown?.();
    });
    try {
      const ready = await new Promise<{ origin: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("STARTUP_TIMEOUT"));
        }, 10000);
        const exit = () => {
          cleanup();
          reject(new Error("STARTUP_FAILED"));
        };
        const receive = (m: any) => {
          if (m?.nonce !== nonce) return;
          if (m.type === "startupFailure") {
            cleanup();
            reject(
              new Error(
                ["LAUNCHER_UPGRADE_REQUIRED", "INVALID_SKILL_STORAGE"].includes(
                  m.reason,
                )
                  ? m.reason
                  : "STARTUP_FAILED",
              ),
            );
          } else if (m.type === "ready") {
            cleanup();
            resolve(m);
          }
        };
        const cleanup = () => {
          clearTimeout(timer);
          target.removeListener("exit", exit);
          target.removeListener("message", receive);
        };
        target.once("exit", exit);
        target.on("message", receive);
        target.send(
          {
            type: "state",
            data: {
              ...updates.snapshot(),
              installed: revision,
              launcherSkillCatalog,
              manualOnlySourceUpdates,
            },
          },
          () => {},
        );
      });
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(ready.origin))
        throw new Error("INVALID_ORIGIN");
      const auth = { Authorization: "Bearer " + store.secrets.admin };
      await sleep(500, undefined, { signal: controller.signal });
      if (target.exitCode !== null || target.signalCode !== null)
        throw new Error("STARTUP_FAILED");
      const r = await fetch(ready.origin + "/api/status", {
        headers: auth,
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok || ((await r.json()) as any).state !== "stopped")
        throw new Error("HEALTH_FAILED");
      origin = ready.origin;
      await store.atomic("service", {
        origin,
        pid: process.pid,
        runtimePid: target.pid,
      });
      target.once("exit", () => {
        if (!closing && !operation && target === child) onShutdown?.();
      });
    } catch (e) {
      await stop(target);
      throw e;
    }
  }
  type Preparation = {
    sha: string;
    candidate: string;
    image?: string;
  };
  type CandidateCleanup = {
    sha: string;
    candidate: string;
    retryError?: unknown;
  };
  let reservation: Preparation | undefined;
  let prepareWork: Promise<void> | undefined;
  const pendingCandidateCleanup = new Map<string, CandidateCleanup>();
  const cleanupCandidate = async (
    candidate: string,
    sha: string,
    retryError?: unknown,
  ) => {
    const expected = resolve(home, "versions", sha);
    if (resolve(candidate) !== expected || active?.revision === sha) {
      updates.cleanupWarning = true;
      return;
    }
    try {
      await rm(candidate, { recursive: true, force: true });
      const pending = pendingCandidateCleanup.get(sha);
      if (pending?.candidate === candidate) pendingCandidateCleanup.delete(sha);
    } catch (error) {
      updates.cleanupWarning = true;
      const previous = pendingCandidateCleanup.get(sha);
      pendingCandidateCleanup.set(sha, {
        sha,
        candidate,
        retryError: retryError ?? previous?.retryError,
      });
      throw error;
    }
  };
  const drainCandidateCleanup = async (sha: string) => {
    const pending = pendingCandidateCleanup.get(sha);
    if (!pending) return;
    try {
      await cleanupCandidate(
        pending.candidate,
        pending.sha,
        pending.retryError,
      );
    } catch (error) {
      throw pending.retryError ?? error;
    }
  };
  const releaseReservation = async (sha: string) => {
    const prepared = reservation;
    if (!prepared || prepared.sha !== sha) return;
    reservation = undefined;
    await cleanupCandidate(prepared.candidate, prepared.sha).catch(() => {
      updates.cleanupWarning = true;
    });
  };
  const prepareReservation = async (sha: string) => {
    if (reservation?.sha === sha) return;
    if (reservation || prepareWork || operation)
      throw new Error("UPDATE_IN_PROGRESS");
    await drainCandidateCleanup(sha);
    let candidate: string | undefined;
    const probeHome = join(home, "update-probe");
    const work = (async () => {
      try {
        candidate = await (
          boundary.prepare ?? ((s, signal) => stage(home, s, {}, signal))
        )(sha, controller.signal);
        if ((await metadata(candidate)).revision !== sha)
          throw new Error("SOURCE_MISMATCH");
        const image = await (
          boundary.preflight ??
          ((r, h, signal) => nativePreflight(r, h, { signal }))
        )(candidate, home, controller.signal);
        await rm(probeHome, { recursive: true, force: true });
        await mkdir(probeHome, { mode: 0o700 });
        await command(
          process.execPath,
          [join(root, "dist/update/probe.js"), candidate, probeHome],
          candidate,
          probeHome,
          controller.signal,
        );
        if (closing || controller.signal.aborted)
          throw new Error("BUILD_CANCELLED");
        reservation = { sha, candidate, image };
      } catch (error) {
        if (candidate)
          await cleanupCandidate(candidate, sha, error).catch(() => {});
        throw error;
      } finally {
        await rm(probeHome, { recursive: true, force: true }).catch(() => {
          updates.cleanupWarning = true;
        });
      }
    })();
    prepareWork = work;
    try {
      await work;
    } finally {
      if (prepareWork === work) prepareWork = undefined;
    }
  };
  const apply = async (sha: string) => {
    const prepared = reservation;
    if (!prepared || prepared.sha !== sha) throw new Error("TARGET_REJECTED");
    reservation = undefined;
    operation = (async () => {
      const { candidate, image } = prepared;
      const previous = active ? join(home, "versions", active.revision) : root;
      const previousRevision = active?.revision ?? installed;
      try {
        if ((await metadata(candidate)).revision !== sha)
          throw new Error("SOURCE_MISMATCH");
        if (updates.lastOperation) {
          updates.lastOperation.phase = "activating";
          await journal.write(updates.lastOperation);
        }
        // Protocol 1 forbids migrations. Snapshot existing JSON records as an
        // extra startup-failure guard; candidate was first probed on empty home.
        const backup = new Map<string, Buffer>();
        for (const name of await readdir(home))
          if (
            name.endsWith(".json") &&
            ![
              "auto-update.json",
              "auto-failed.json",
              "native-probe-cleanup.json",
            ].includes(name)
          )
            backup.set(
              name,
              await managedFile(join(home, name), 4 * 1024 * 1024),
            );
        const oldPort = Number(new URL(origin).port);
        const keep = new Set([sha, active?.revision]);
        await stop();
        try {
          await launch(candidate, sha, oldPort, image);
          const pointer = join(home, "active-" + randomUUID() + ".tmp");
          try {
            await writeFile(
              pointer,
              JSON.stringify({ revision: sha, ...(image ? { image } : {}) }),
              { mode: 0o600, flag: "wx" },
            );
            await rename(pointer, join(home, "active.json"));
            active = { revision: sha };
            updates.installed = sha;
          } finally {
            await rm(pointer, { force: true }).catch(() => {
              updates.cleanupWarning = true;
            });
          }
        } catch {
          await stop();
          for (const [name, content] of backup)
            await writeFile(join(home, name), content, { mode: 0o600 });
          if (!closing) await launch(previous, previousRevision, oldPort);
          throw new Error("ACTIVATION_ROLLED_BACK");
        }
        try {
          await boundary.housekeeping?.();
          for (const name of await readdir(join(home, "versions")))
            if (validSha(name) && !keep.has(name))
              await rm(join(home, "versions", name), {
                recursive: true,
                force: true,
              });
        } catch {
          updates.cleanupWarning = true;
        }
      } catch (error) {
        if (active?.revision !== sha)
          await cleanupCandidate(candidate, sha).catch(() => {
            updates.cleanupWarning = true;
          });
        throw error;
      }
    })();
    try {
      await operation;
    } finally {
      operation = undefined;
      if (
        !closing &&
        child &&
        (child.exitCode !== null || child.signalCode !== null)
      )
        setImmediate(() => onShutdown?.());
    }
  };
  const updates = new Updates(
    installed,
    supported ? apply : null,
    boundary.request,
    (operation) => journal.write(operation),
    (sha) => prepareReservation(sha),
    (sha) => releaseReservation(sha),
  );
  const journal = new UpdateJournal(home);
  updates.lastOperation = await journal.recover(installed);
  updates.manualRestartSupported = supported;
  try {
    const intent = JSON.parse(
      (await managedFile(join(home, "update-resume.json"), 256)).toString(
        "utf8",
      ),
    );
    if (
      Object.keys(intent).sort().join(",") !== "pending,sha" ||
      !validSha(intent.sha) ||
      typeof intent.pending !== "boolean"
    )
      throw new Error("UPDATE_RESUME_INVALID");
    if (intent.pending) {
      manualRecovery = true;
      ambiguousQuiesce = true;
      recoveryWasRunning = true;
      recoverySha = intent.sha;
      recoveryOutcome =
        installed === intent.sha ? "running" : "restored-running";
      updates.recovering = true;
    }
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await launch(
      active ? join(home, "versions", active.revision) : root,
      installed,
      port,
    );
  } catch (error) {
    controller.abort();
    try {
      await drainNativePreflightCleanup(home);
    } catch {
      throw new Error("UPDATE_CLEANUP_PENDING");
    }
    throw error;
  }
  async function post(path: string) {
    const response = await fetch(origin + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + store.secrets.admin,
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(15000),
    });
    return {
      ok: response.ok,
      status: response.status,
      data: (await response.json()) as any,
    };
  }
  async function postRetry(path: string, attempts = 3) {
    for (let n = 0; n < attempts; n++) {
      try {
        const result = await post(path);
        if (result.ok) return result;
        if (result.status !== 409 || n === attempts - 1) return result;
      } catch {
        if (n === attempts - 1) break;
      }
      await sleep(200);
    }
    return { ok: false, status: 503, data: null };
  }
  async function recoverAmbiguousQuiesce(): Promise<boolean> {
    if (!ambiguousQuiesce) return true;
    if (closing) return false;
    try {
      const response = await fetch(origin + "/api/status", {
        headers: { Authorization: "Bearer " + store.secrets.admin },
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return false;
      const state = (await response.json()) as any;
      if (closing) return false;
      if (state.updateQuiesced || state.autoQuiesced) {
        if (!(state.updateQuiesceReady ?? state.autoQuiesceReady)) return false;
        recoveryWasRunning =
          (state.updateWasRunning ?? state.autoWasRunning) === true;
        if (closing) return false;
        let released = await postRetry("/api/update/release");
        if (released.status === 404 && !closing)
          released = await postRetry("/api/update/auto/release");
        if (!released.ok) return false;
      }
      if (recoveryWasRunning && state.state === "stopped") {
        if (closing) return false;
        let resumed = await postRetry(
          manualRecovery ? "/api/update/resume" : "/api/run",
        );
        // A compatible legacy rollback application predates the recovery gate.
        if (manualRecovery && resumed.status === 404 && !closing)
          resumed = await postRetry("/api/run");
        if (!resumed.ok) return false;
      }
      if (recoveryWasRunning) {
        let confirmed = false;
        for (let n = 0; n < 3; n++) {
          if (closing) return false;
          try {
            const reply = await fetch(origin + "/api/status", {
              headers: { Authorization: "Bearer " + store.secrets.admin },
              signal: AbortSignal.timeout(3000),
            });
            const current = reply.ok ? ((await reply.json()) as any) : {};
            if (
              ["idle", "connecting", "working", "task-working"].includes(
                current.state,
              )
            ) {
              confirmed = true;
              break;
            }
          } catch {
            // A lost read is not proof of a failed local start.
          }
          if (n < 2) await sleep(200);
        }
        if (!confirmed) return false;
      }
      if (recoverySha)
        updates.recoveryOutcome = {
          sha: recoverySha,
          state: recoveryOutcome,
          ...(recoveryOutcome === "deferred"
            ? { reason: "LOCAL_UNAVAILABLE" as const }
            : {}),
        };
      if (manualRecovery && recoverySha) {
        await atomicWrite(home, "update-resume.json", {
          sha: recoverySha,
          pending: false,
        });
        manualRecovery = false;
        updates.recovering = false;
      }
      ambiguousQuiesce = false;
      recoveryWasRunning = undefined;
      recoverySha = undefined;
      recoveryOutcome = "deferred";
      return true;
    } catch {
      return false;
    }
  }
  // This timer only reconciles a durable, already accepted manual operation.
  // It cannot discover source, prepare a candidate or activate one.
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryWork: Promise<void> | undefined;
  const scheduleRecovery = (ms = 10000) => {
    if (closing || !ambiguousQuiesce) return;
    clearTimeout(recoveryTimer);
    recoveryTimer = (boundary.recoveryTimer ?? setTimeout)(() => {
      const work = (async () => {
        if (closing) return;
        await recoverAmbiguousQuiesce();
        if (!closing && ambiguousQuiesce) scheduleRecovery();
      })();
      recoveryWork = work;
      void work.finally(() => {
        if (recoveryWork === work) recoveryWork = undefined;
      });
    }, ms);
    recoveryTimer.unref();
  };
  if (ambiguousQuiesce) scheduleRecovery(1);
  // Refresh state even for code-driven updates and across a replaced child.
  const timer = setInterval(
    () => send({ type: "state", data: updates.snapshot() }),
    250,
  );
  return {
    get origin() {
      return origin;
    },
    get pid() {
      return child?.pid;
    },
    updates,

    async close() {
      closing = true;
      clearTimeout(recoveryTimer);
      controller.abort();
      clearInterval(timer);
      await recoveryWork?.catch(() => {});
      await manualWork?.catch(() => {});
      await prepareWork?.catch(() => {});
      await operation?.catch(() => {});
      if (reservation)
        await releaseReservation(reservation.sha).catch(() => {});
      let cleanupError: unknown;
      for (const sha of [...pendingCandidateCleanup.keys()])
        await drainCandidateCleanup(sha).catch((error) => {
          cleanupError ??= error;
          updates.cleanupWarning = true;
        });
      await drainNativePreflightCleanup(home).catch((error) => {
        cleanupError ??= error;
        updates.cleanupWarning = true;
      });
      if (cleanupError) {
        updates.guidance =
          "Shutdown is waiting for owned update cleanup. Retry shutdown; do not remove the protected home or broad-prune native resources.";
        closing = false;
        send({ type: "state", data: updates.snapshot() });
        return false;
      }
      await stop();
      return true;
    },
  };
}
