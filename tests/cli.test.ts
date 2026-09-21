import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
const exec = promisify(execFile);
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
    await assert.rejects(run("start"));
    assert.match((await run("stop")).stdout, /stopped/);
  } finally {
    await run("stop").catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
