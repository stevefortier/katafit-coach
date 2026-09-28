import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { activateLegacyFixture } from "./helpers/legacy-supervisor.js";
const exec = promisify(execFile);
test("killing foreground wrapper also closes its owner and runtime", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-wrapper-");
  await activateLegacyFixture(dir);
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "serve"],
    {
      env: { ...process.env, KATAFIT_COACH_HOME: dir, KATAFIT_COACH_PORT: "0" },
      stdio: "ignore",
    },
  );
  let info: any;
  const started = performance.now();
  try {
    // The runtime alone has a 10s startup budget; allow launcher/tsx overhead.
    while (performance.now() - started < 15000) {
      assert.equal(
        child.exitCode,
        null,
        "foreground launcher exited before readiness",
      );
      try {
        info = JSON.parse(await readFile(dir + "/service.json", "utf8"));
        break;
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(info);
    console.log(
      JSON.stringify({
        fixture: "foreground-wrapper",
        startupMs: Math.round(performance.now() - started),
      }),
    );
    child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 1000));
    await assert.rejects(readFile(dir + "/service.json"));
    assert.throws(() => process.kill(info.pid, 0));
    assert.throws(() => process.kill(info.runtimePid, 0));
  } finally {
    child.kill("SIGKILL");
    if (info)
      for (const pid of [info.pid, info.runtimePid])
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
    await new Promise((r) => setTimeout(r, 100));
    await rm(dir, { recursive: true, force: true });
  }
});
test("legacy non-Linux launcher retains Studio with upgrades disabled (synthetic platform)", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-legacy-");
  const shim = dir + "/platform.mjs";
  await writeFile(
    shim,
    "Object.defineProperty(process,'platform',{value:'darwin'});",
  );
  const run = (...args: string[]) =>
    exec(
      process.execPath,
      ["--import", shim, "--import", "tsx", "src/cli.ts", ...args],
      {
        env: {
          ...process.env,
          KATAFIT_COACH_HOME: dir,
          KATAFIT_COACH_PORT: "0",
        },
        timeout: 15000,
      },
    );
  try {
    assert.match((await run("start")).stdout, /started/);
    const info = JSON.parse(await readFile(dir + "/service.json", "utf8")),
      secrets = JSON.parse(await readFile(dir + "/secrets.json", "utf8"));
    assert.equal(
      (
        await (
          await fetch(info.origin + "/api/update", {
            headers: { Authorization: "Bearer " + secrets.admin },
          })
        ).json()
      ).supported,
      false,
    );
    await run("stop");
  } finally {
    await run("stop").catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
test("CLI starts an installed service, reports health, rejects duplicate ownership and stops", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-cli-");
  await activateLegacyFixture(dir);
  const run = (...args: string[]) =>
    exec(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      env: { ...process.env, KATAFIT_COACH_HOME: dir, KATAFIT_COACH_PORT: "0" },
      timeout: 15000,
    });
  try {
    assert.match((await run("start")).stdout, /started/);
    assert.match((await run("status")).stdout, /stopped/);
    const info = JSON.parse(await readFile(dir + "/service.json", "utf8"));
    const secrets = JSON.parse(await readFile(dir + "/secrets.json", "utf8"));
    const update = await (
      await fetch(info.origin + "/api/update", {
        headers: { Authorization: "Bearer " + secrets.admin },
      })
    ).json();
    assert.equal(update.supported, true);
    assert.ok(Number.isInteger(info.runtimePid));
    assert.notEqual(info.pid, info.runtimePid);
    await assert.rejects(run("start"));
    process.kill(info.runtimePid, "SIGKILL");
    try {
      await new Promise((r) => setTimeout(r, 700));
      assert.match((await run("start")).stdout, /started/);
    } catch (e) {
      try {
        process.kill(info.pid, "SIGTERM");
      } catch {}
      throw e;
    }
    assert.match((await run("stop")).stdout, /stopped/);
  } finally {
    await run("stop").catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
test("CLI run distinguishes reported, unconfirmed and unsupported worker presence", async () => {
  // Synthetic local service: only /api/run answers, with a fixed presence.
  let presence = "reported";
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(req.url === "/api/run" ? { ok: true, presence } : {}),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const dir = await mkdtemp(tmpdir() + "/coach-cli-presence-");
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  await writeFile(dir + "/service.json", JSON.stringify({ origin }));
  const run = async () =>
    (
      await exec(process.execPath, ["--import", "tsx", "src/cli.ts", "run"], {
        env: { ...process.env, KATAFIT_COACH_HOME: dir },
        timeout: 15000,
      })
    ).stdout.trim();
  try {
    assert.equal(await run(), "Worker started; presence reported.");
    presence = "unconfirmed";
    const unconfirmed = await run();
    assert.equal(
      unconfirmed,
      "Worker started; presence unconfirmed: the backend did not confirm a heartbeat.",
    );
    assert.doesNotMatch(unconfirmed, /unsupported|does not support/);
    presence = "unsupported";
    assert.equal(
      await run(),
      "Worker started; explicit presence unsupported by backend.",
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
test("CLI pause waits beyond 10s for a Stop with two bounded presence reports", async () => {
  // Worker Stop may await an in-flight heartbeat and then the stop report,
  // each bounded at 6.5s; the CLI must not abandon a Stop still in progress.
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url !== "/api/stop") return res.end("{}");
    setTimeout(() => res.end(JSON.stringify({ ok: true })), 10500);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const dir = await mkdtemp(tmpdir() + "/coach-cli-pause-");
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  await writeFile(dir + "/service.json", JSON.stringify({ origin }));
  try {
    const { stdout } = await exec(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "pause"],
      { env: { ...process.env, KATAFIT_COACH_HOME: dir }, timeout: 30000 },
    );
    assert.equal(stdout.trim(), "Worker paused.");
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
