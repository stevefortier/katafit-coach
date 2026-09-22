import { fork, type ChildProcess } from "node:child_process";
import { Store } from "../config/store.js";
import { Updates, validSha } from "./updates.js";
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
          if (name.endsWith(".json"))
            backup.set(
              name,
              await managedFile(join(home, name), 4 * 1024 * 1024),
            );
        const oldPort = Number(new URL(origin).port);
        const keep = new Set([sha, active?.revision]);
        await stop();
        try {
          await launch(candidate, sha, oldPort);
          const pointer = join(home, "active-" + randomUUID() + ".tmp");
          try {
            await writeFile(pointer, JSON.stringify({ revision: sha }), {
              mode: 0o600,
              flag: "wx",
            });
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
      controller.abort();
      clearInterval(timer);
      await operation?.catch(() => {});
      await stop();
    },
  };
}
