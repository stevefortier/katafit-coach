import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
const exec = promisify(execFile);
test("killing foreground wrapper also closes its owner and runtime", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-wrapper-");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "serve"],
    {
      env: { ...process.env, KATAFIT_COACH_HOME: dir, KATAFIT_COACH_PORT: "0" },
      stdio: "ignore",
    },
  );
  let info: any;
  try {
    for (let i = 0; i < 100; i++) {
      try {
        info = JSON.parse(await readFile(dir + "/service.json", "utf8"));
        break;
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(info);
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
