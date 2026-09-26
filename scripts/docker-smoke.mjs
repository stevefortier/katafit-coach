// Run after docker build -t katafit-coach:qa . Uses disposable synthetic state.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { statSync } from "node:fs";
const image = process.env.COACH_DOCKER_IMAGE ?? "katafit-coach:qa";
const expectedRevision = process.env.COACH_EXPECTED_REVISION;
const nativeImage = process.env.NATIVE_TEST_IMAGE;
assert.match(nativeImage ?? "", /^sha256:[a-f0-9]{64}$/);
const authority = [
  "--user",
  "1000:1000",
  "--group-add",
  String(statSync("/var/run/docker.sock").gid),
  "--mount",
  "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
];
const id = randomUUID();
const name = "coach-smoke-" + id;
const volume = name + "-data";
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 90000,
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
    ...authority,
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
  docker(
    "run",
    "--rm",
    "--init",
    "--network",
    "none",
    ...authority,
    "--mount",
    `source=${volume},target=/home/node/.katafit-coach`,
    image,
    "node",
    "--input-type=module",
    "-e",
    'import {provisionArtifact} from "./dist/sandbox/artifact.js"; await provisionArtifact("/home/node/.katafit-coach",process.cwd(),process.argv[1]);',
    nativeImage,
  );
  start();
  await ready();
  assert.equal(docker("exec", name, "id", "-u"), "1000");
  assert.equal(
    docker(
      "exec",
      name,
      "node",
      "--input-type=module",
      "-e",
      'import {nativePreflight} from "./dist/sandbox/artifact.js"; console.log(await nativePreflight(process.cwd(),"/home/node/.katafit-coach"));',
    ),
    nativeImage,
  );
  assert.ok(
    JSON.parse(docker("inspect", name))[0].Mounts.some(
      (m) => m.Destination === "/var/run/docker.sock",
    ),
  );
  assert.match(docker("exec", name, "flock", "--version"), /flock/);
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
      nativeSiblingPreflight: true,
      nativeImage,
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
