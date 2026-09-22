// Run after docker build -t katafit-coach:qa . Uses disposable synthetic state.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
const image = process.env.COACH_DOCKER_IMAGE ?? "katafit-coach:qa";
const expectedRevision = process.env.COACH_EXPECTED_REVISION;
const id = randomUUID();
const name = "coach-smoke-" + id;
const volume = name + "-data";
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const read = (file) =>
  JSON.parse(
    docker(
      "exec",
      name,
      "node",
      "-e",
      `process.stdout.write(require('fs').readFileSync('/home/node/.katafit-coach/${file}.json','utf8'))`,
    ),
  );
let origin;
let secrets;
async function ready() {
  for (let i = 0; i < 100; i++) {
    try {
      origin = read("service").origin;
      secrets = read("secrets");
      const response = await fetch(origin + "/api/status", {
        headers: { Authorization: "Bearer " + secrets.admin },
        signal: AbortSignal.timeout(1000),
      });
      assert.equal(response.status, 200);
      const state = await response.json();
      assert.equal(state.state, "stopped");
      return state;
    } catch {
      await sleep(100);
    }
  }
  throw new Error("Disposable container failed authenticated readiness");
}
function start() {
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--init",
    "--network",
    "host",
    "--mount",
    `source=${volume},target=/home/node/.katafit-coach`,
    "-e",
    "KATAFIT_COACH_PORT=0",
    image,
  );
}
async function verifyUpdateStatus() {
  const response = await fetch(origin + "/api/update", {
    headers: { Authorization: "Bearer " + secrets.admin },
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.supported, true);
  if (expectedRevision) assert.equal(state.installed, expectedRevision);
  return state.installed;
}
try {
  docker("volume", "create", volume);
  start();
  await ready();
  assert.equal(docker("exec", name, "id", "-u"), "1000");
  const identity = secrets.admin;
  const config = read("config");
  const installed = await verifyUpdateStatus();
  const denied = await fetch(origin + "/api/logs", {
    signal: AbortSignal.timeout(1000),
  });
  assert.equal(denied.status, 401);
  await denied.text();
  const logs = await fetch(origin + "/api/logs", {
    headers: { Authorization: "Bearer " + identity },
    signal: AbortSignal.timeout(1000),
  });
  assert.equal(logs.status, 200);
  assert.equal(logs.headers.get("cache-control"), "no-store");
  assert.equal((await logs.text()).includes(identity), false);
  docker("stop", "--time", "10", name);
  docker("rm", name);
  start();
  await ready();
  assert.equal(secrets.admin, identity);
  assert.deepEqual(read("config"), config);
  assert.equal(await verifyUpdateStatus(), installed);
  // An unclean container replacement must not strand a stale PID lock.
  docker("kill", "--signal", "KILL", name);
  docker("rm", name);
  start();
  await ready();
  assert.equal(secrets.admin, identity);
  assert.deepEqual(read("config"), config);
  assert.equal(await verifyUpdateStatus(), installed);
  console.log(
    JSON.stringify({
      docker: "passed",
      nonroot: true,
      authenticated: true,
      recreatedVolumeRetainsIdentityAndConfig: true,
      crashReplacementRecovered: true,
      installedRevision: installed,
      workerStopped: true,
      sourceUpgradeTested: false,
    }),
  );
} finally {
  try {
    docker("rm", "-f", name);
  } catch {}
  try {
    docker("volume", "rm", volume);
  } catch {}
}
