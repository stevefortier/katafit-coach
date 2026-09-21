#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, open, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Store } from "./config/store.js";
import { admin } from "./server/admin.js";
const dir = process.env.KATAFIT_COACH_HOME ?? join(homedir(), ".katafit-coach");
const store = new Store(dir);
const command = process.argv[2] ?? "help";
async function target() {
  const t = JSON.parse(await readFile(join(dir, "service.json"), "utf8"));
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(t.origin))
    throw new Error("INVALID_SERVICE");
  return t;
}
async function call(path: string, post = false) {
  const t = await target();
  const r = await fetch(t.origin + "/api/" + path, {
    method: post ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + store.secrets.admin,
      Origin: t.origin,
      "Content-Type": "application/json",
    },
    body: post ? "{}" : undefined,
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error("SERVICE_REQUEST_FAILED");
  return r.json();
}
async function main() {
  if (command === "help") {
    console.log(
      "katafit-coach start | serve | open | status | run | pause | stop\nstart: background local studio; open: authenticated browser; run: start worker\npause: stop worker; stop: stop service. Node 22.19+ required.",
    );
    return;
  }
  await store.init();
  if (command === "serve") {
    const lockPath = join(dir, "service.lock");
    let lock;
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      const pid = Number(await readFile(lockPath, "utf8"));
      try {
        process.kill(pid, 0);
        throw new Error("ALREADY_RUNNING");
      } catch (check: any) {
        if (check.code !== "ESRCH") throw check;
      }
      await unlink(lockPath);
      lock = await open(lockPath, "wx", 0o600);
    }
    await lock.writeFile(String(process.pid));
    await lock.close();
    let app: Awaited<ReturnType<typeof admin>> | undefined;
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await app?.close();
      await unlink(join(dir, "service.json")).catch(() => {});
      await unlink(lockPath).catch(() => {});
    };
    try {
      app = await admin(
        store,
        Number(process.env.KATAFIT_COACH_PORT ?? 4317),
        undefined,
        () => {
          void close();
        },
      );
      await store.atomic("service", { origin: app.origin, pid: process.pid });
      process.once("SIGTERM", () => void close());
      process.once("SIGINT", () => void close());
      console.log(
        "Kata.fit Coach studio listening at " +
          app.origin +
          " (worker stopped; use run after preview).",
      );
    } catch (e) {
      await close();
      throw e;
    }
    return;
  }
  if (command === "start") {
    try {
      await call("status");
      throw new Error("ALREADY_RUNNING");
    } catch (e: any) {
      if (e.message === "ALREADY_RUNNING") throw e;
    }
    const log = await open(join(dir, "service.log"), "a", 0o600);
    const child = spawn(
      process.execPath,
      [...process.execArgv, fileURLToPath(import.meta.url), "serve"],
      { detached: true, stdio: ["ignore", log.fd, log.fd], env: process.env },
    );
    child.unref();
    await log.close();
    for (let i = 0; i < 60; i++) {
      try {
        await call("status");
        console.log("Service started. Run katafit-coach open to configure.");
        return;
      } catch {
        await sleep(100);
      }
    }
    throw new Error("START_FAILED");
  }
  if (command === "status") {
    console.log(JSON.stringify(await call("status")));
    return;
  }
  if (command === "run" || command === "pause") {
    await call(command === "run" ? "run" : "stop", true);
    console.log(command === "run" ? "Worker started." : "Worker paused.");
    return;
  }
  if (command === "stop") {
    await call("shutdown", true);
    for (let i = 0; i < 50; i++) {
      try {
        await call("status");
        await sleep(100);
      } catch {
        console.log("Service stopped.");
        return;
      }
    }
    throw new Error("STOP_UNCONFIRMED");
  }
  if (command === "open") {
    const t = await target();
    await call("status");
    const url = t.origin + "/#" + store.secrets.admin;
    const child = spawn(
      process.platform === "darwin" ? "open" : "xdg-open",
      [url],
      { stdio: "ignore" },
    );
    child.once("error", () => {
      console.error(
        "Browser could not open. Use a local desktop browser; credential storage is encrypted. See the protected headless setup instructions in README.",
      );
    });
    return;
  }
  throw new Error("UNKNOWN_COMMAND");
}
main().catch(() => {
  console.error(
    "Coach command failed. Check service status, protected installation directory and port availability. Use help for commands.",
  );
  process.exitCode = 1;
});
