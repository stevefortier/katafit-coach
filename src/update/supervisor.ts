import { fork, type ChildProcess } from "node:child_process";
import { nativePreflight } from "../sandbox/artifact.js";
import { Store } from "../config/store.js";
import { Updates, validSha } from "./updates.js";
import { AutoUpdater, AutoUpdateSetting, isMainDescendant } from "./auto.js";
import { UpdateJournal } from "./journal.js";
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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
interface Boundary {
  housekeeping?: () => Promise<void>;
  prepare?: (sha: string, signal: AbortSignal) => Promise<string>;
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
  const autoSetting = new AutoUpdateSetting(home);
  let autoAttempt: string | undefined;
  let ambiguousQuiesce = false;
  let recoveryWasRunning: boolean | undefined;
  let recoverySha: string | undefined;
  let recoveryOutcome = "deferred";
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
  ) {
    if (revision && (await metadata(path)).revision !== revision)
      throw new Error("INVALID_ACTIVE");
    if (revision) await nativePreflight(path, home);
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
      if (message.method === "apply") {
        try {
          updates.validate(message.sha);
          const promise = updates.apply(message.sha);
          void promise.catch(() => {});
          await updates.accepted;
          reply(updates.snapshot());
          send({ type: "state", data: updates.snapshot() });
          void promise
            .catch(() => {})
            .finally(() => send({ type: "state", data: updates.snapshot() }));
        } catch {
          reply(undefined, "TARGET_REJECTED");
        }
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
          if (m?.type === "ready" && m.nonce === nonce) {
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
            data: { ...updates.snapshot(), installed: revision },
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
  const apply = async (sha: string) => {
    operation = (async () => {
      const candidate = await (
        boundary.prepare ?? ((s, signal) => stage(home, s, {}, signal))
      )(sha, controller.signal);
      const probeHome = join(home, "update-probe");
      const previous = active ? join(home, "versions", active.revision) : root;
      const previousRevision = active?.revision ?? installed;
      try {
        if ((await metadata(candidate)).revision !== sha)
          throw new Error("SOURCE_MISMATCH");
        const image = await nativePreflight(candidate, home);
        await rm(probeHome, { recursive: true, force: true });
        await mkdir(probeHome, { mode: 0o700 });
        await command(
          process.execPath,
          [join(root, "dist/update/probe.js"), candidate, probeHome],
          candidate,
          probeHome,
          controller.signal,
        );
        if (closing) throw new Error("CLOSING");
        // Protocol 1 forbids migrations. Snapshot existing JSON records as an
        // extra startup-failure guard; candidate is first probed on empty home.
        const backup = new Map<string, Buffer>();
        for (const name of await readdir(home))
          if (
            name.endsWith(".json") &&
            !["auto-update.json", "auto-failed.json"].includes(name)
          )
            backup.set(
              name,
              await managedFile(join(home, name), 4 * 1024 * 1024),
            );
        const oldPort = Number(new URL(origin).port);
        const keep = new Set([sha, active?.revision]);
        if (
          autoAttempt === sha &&
          (closing || !(await autoSetting.read()).enabled)
        )
          throw new Error("AUTO_UPDATE_DISABLED");
        await stop();
        try {
          await launch(candidate, sha, oldPort);
          const pointer = join(home, "active-" + randomUUID() + ".tmp");
          try {
            await writeFile(
              pointer,
              JSON.stringify({ revision: sha, ...(image ? { image } : {}) }),
              {
                mode: 0o600,
                flag: "wx",
              },
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
      } catch (e) {
        if (active?.revision !== sha)
          await rm(candidate, { recursive: true, force: true });
        throw e;
      } finally {
        await rm(probeHome, { recursive: true, force: true }).catch(() => {
          updates.cleanupWarning = true;
        });
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
  );
  const journal = new UpdateJournal(home);
  updates.lastOperation = await journal.recover(installed);
  await launch(
    active ? join(home, "versions", active.revision) : root,
    installed,
    port,
  );
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
      if (state.autoQuiesced) {
        if (!state.autoQuiesceReady) return false;
        recoveryWasRunning = state.autoWasRunning === true;
        if (closing) return false;
        if (!(await postRetry("/api/update/auto/release")).ok) return false;
      }
      if (recoveryWasRunning && state.state === "stopped") {
        if (closing) return false;
        if (!(await postRetry("/api/run")).ok) return false;
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
        updates.autoOutcome = { sha: recoverySha, state: recoveryOutcome };
      ambiguousQuiesce = false;
      recoveryWasRunning = undefined;
      recoverySha = undefined;
      recoveryOutcome = "deferred";
      return true;
    } catch {
      return false;
    }
  }
  const auto = new AutoUpdater(autoSetting, {
    check: async () => {
      if (closing || !supported || updates.applying)
        return { installed: null, latest: null };
      const state = await updates.check();
      return { installed: state.installed, latest: state.latest };
    },
    isDescendant: (old, next) => isMainDescendant(old, next, boundary.request),
    apply: async (sha) => {
      if (closing || !supported) return;
      // A local transport failure before acceptance is not a bad source SHA.
      const paused = await postRetry("/api/update/auto/quiesce");
      if (!paused.ok) {
        if (paused.status === 503) {
          ambiguousQuiesce = true;
          recoverySha = sha;
          recoveryOutcome = "deferred";
          const recovered = await recoverAmbiguousQuiesce();
          updates.autoOutcome = {
            sha,
            state: recovered ? "deferred" : "resume-failed",
          };
        } else updates.autoOutcome = { sha, state: "deferred" };
        return; // Busy/unavailable; no source operation was accepted.
      }
      const wasRunning = paused.data.wasRunning === true;
      let failure: unknown;
      let attempted = false;
      try {
        autoAttempt = sha;
        if (!closing && (await autoSetting.read()).enabled) {
          attempted = true;
          await updates.apply(sha);
        }
      } catch (error) {
        failure = error;
      } finally {
        autoAttempt = undefined;
      }
      try {
        send({ type: "state", data: updates.snapshot() });
        // IPC state is asynchronous; release must not race the child's stale applying flag.
        for (let n = 0; n < 30; n++) {
          try {
            const state = await fetch(origin + "/api/update", {
              headers: { Authorization: "Bearer " + store.secrets.admin },
              signal: AbortSignal.timeout(2000),
            });
            if (state.ok && !((await state.json()) as any).applying) break;
          } catch {
            // The child can briefly disconnect during replacement; retry.
          }
          await sleep(50);
        }
        const released = await postRetry("/api/update/auto/release");
        if (!released.ok) throw new Error("AUTO_RELEASE_FAILED");
        if (wasRunning && !closing) {
          const resumed = await postRetry("/api/run");
          if (!resumed.ok) throw new Error("AUTO_RESUME_FAILED");
          let confirmed = false;
          for (let n = 0; n < 3; n++) {
            try {
              const status = await fetch(origin + "/api/status", {
                headers: { Authorization: "Bearer " + store.secrets.admin },
                signal: AbortSignal.timeout(5000),
              });
              const state = status.ok ? ((await status.json()) as any) : {};
              if (
                ["idle", "connecting", "working", "task-working"].includes(
                  state.state,
                )
              ) {
                confirmed = true;
                break;
              }
            } catch {
              // A lost read is not proof that the worker failed to start.
            }
            if (n < 2) await sleep(200);
          }
          if (!confirmed) throw new Error("AUTO_RESUME_UNCONFIRMED");
          updates.autoOutcome = {
            sha,
            state: !attempted
              ? "deferred"
              : failure
                ? "restored-running"
                : "running",
          };
        } else
          updates.autoOutcome = {
            sha,
            state: failure ? "failed" : attempted ? "stopped" : "deferred",
          };
      } catch {
        updates.autoOutcome = { sha, state: "resume-failed" };
        if (!closing) {
          ambiguousQuiesce = true;
          recoverySha = sha;
          recoveryWasRunning = wasRunning;
          recoveryOutcome = !attempted
            ? "deferred"
            : failure
              ? wasRunning
                ? "restored-running"
                : "failed"
              : wasRunning
                ? "running"
                : "stopped";
        }
      }
      if (failure) throw failure;
    },
  });
  const tickAuto = async () => {
    if (ambiguousQuiesce) {
      await recoverAmbiguousQuiesce();
      return; // Restore the previous worker first; check source on a later tick.
    }
    await auto.tick();
  };
  let autoTimer: ReturnType<typeof setTimeout> | undefined;
  let autoTimerWork: Promise<void> | undefined;
  const schedule = (ms: number) => {
    autoTimer = setTimeout(() => {
      const work = (async () => {
        if (closing) return;
        try {
          await tickAuto();
        } catch {
          /* Journal carries failure; no secret output. */
        }
        if (!closing)
          schedule(
            ambiguousQuiesce
              ? 10000
              : updates.latest === null && updates.checkedAt
                ? 900000
                : 90000,
          );
      })();
      autoTimerWork = work;
      void work.then(
        () => {
          if (autoTimerWork === work) autoTimerWork = undefined;
        },
        () => {
          if (autoTimerWork === work) autoTimerWork = undefined;
        },
      );
    }, ms);
    autoTimer.unref();
  };
  if (supported) schedule(90000);
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
    auto: { tick: tickAuto },
    async close() {
      closing = true;
      if (autoTimer) clearTimeout(autoTimer);
      controller.abort();
      clearInterval(timer);
      await autoTimerWork?.catch(() => {});
      await auto.settle();
      await operation?.catch(() => {});
      await stop();
    },
  };
}
