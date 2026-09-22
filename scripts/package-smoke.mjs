import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const dir = await mkdtemp(join(tmpdir(), "coach-package-"));
let cli;
let stopped = false;
const env = {
  ...process.env,
  KATAFIT_COACH_HOME: join(dir, "state"),
  KATAFIT_COACH_PORT: "0",
};
function run(args) {
  return execFileSync(process.execPath, [cli, ...args], {
    env,
    encoding: "utf8",
    timeout: 15000,
  });
}
try {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", dir], {
      encoding: "utf8",
    }),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      join(dir, "install"),
      "--omit=dev",
      "--ignore-scripts",
      join(dir, Object.values(packed)[0].filename),
    ],
    { stdio: "pipe", timeout: 120000 },
  );
  cli = join(dir, "install/node_modules/@katafit/coach/dist/cli.js");
  const receipt = execFileSync(
    process.execPath,
    [
      "scripts/data-acceptance.mjs",
      join(dir, "install/node_modules/@katafit/coach"),
    ],
    { encoding: "utf8", timeout: 20000 },
  );
  console.log(receipt.trim());
  await writeFile("docs/evidence/data-packed-receipt.json", receipt);
  const secretReceipt = execFileSync(
    process.execPath,
    [
      "scripts/secret-acceptance.mjs",
      join(dir, "install/node_modules/@katafit/coach"),
    ],
    { encoding: "utf8", timeout: 20000 },
  );
  console.log(secretReceipt.trim());
  await writeFile("docs/evidence/secret-packed-receipt.json", secretReceipt);
  if (process.env.COACH_BACKEND_ROOT) {
    const backendReceipt = execFileSync(
      process.execPath,
      [
        "scripts/data-backend-acceptance.mjs",
        process.env.COACH_BACKEND_ROOT,
        join(dir, "install/node_modules/@katafit/coach"),
      ],
      { encoding: "utf8", timeout: 120000 },
    );
    console.log(backendReceipt.trim());
    await writeFile(
      "docs/evidence/data-backend-packed-receipt.json",
      backendReceipt,
    );
  }
  assert.match(run(["help"]), /katafit-coach/);
  assert.match(run(["start"]), /started/);
  assert.match(run(["status"]), /stopped/);
  const secrets = JSON.parse(
    await readFile(join(env.KATAFIT_COACH_HOME, "secrets.json"), "utf8"),
  );
  async function api(path, body, authorized = true) {
    const { origin } = JSON.parse(
      await readFile(join(env.KATAFIT_COACH_HOME, "service.json"), "utf8"),
    );
    return fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(authorized ? { Authorization: "Bearer " + secrets.admin } : {}),
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  }
  const denied = await api("/api/logs", undefined, false);
  assert.equal(denied.status, 401);
  await denied.text();
  const invalid = await api("/api/preview", {
    text: "",
    ignored: "synthetic-private-marker",
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, "INVALID_PREVIEW");
  const logsResponse = await api("/api/logs");
  assert.equal(logsResponse.status, 200);
  assert.equal(logsResponse.headers.get("cache-control"), "no-store");
  const logs = await logsResponse.json();
  const statusResponse = await api("/api/status");
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.lastError.code, "INVALID_PREVIEW");
  assert.ok(
    logs.entries.some(
      (entry) =>
        entry.ref === status.lastError.ref && entry.code === "INVALID_PREVIEW",
    ),
  );
  assert.ok(logs.entries.length <= 500);
  for (const secret of [secrets.admin, "synthetic-private-marker"])
    assert.equal(JSON.stringify(logs).includes(secret), false);
  assert.equal(
    (await stat(join(env.KATAFIT_COACH_HOME, "diagnostics.jsonl"))).mode &
      0o777,
    0o600,
  );
  assert.match(run(["stop"]), /stopped/);
  let unlocked = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      execFileSync(
        "flock",
        ["--nonblock", join(env.KATAFIT_COACH_HOME, "service.lock"), "true"],
        { stdio: "ignore" },
      );
      unlocked = true;
      break;
    } catch {}
    await sleep(20);
  }
  assert.ok(unlocked, "stopped service releases its owned lock before restart");
  assert.match(run(["start"]), /started/);
  const restartedResponse = await api("/api/logs");
  assert.equal(restartedResponse.status, 200);
  const restarted = await restartedResponse.json();
  assert.ok(
    restarted.entries.some(
      (entry) =>
        entry.code === "INVALID_PREVIEW" && entry.ref === status.lastError.ref,
    ),
  );
  const restoredStatusResponse = await api("/api/status");
  assert.equal(restoredStatusResponse.status, 200);
  const restoredStatus = await restoredStatusResponse.json();
  assert.equal(restoredStatus.lastError.code, "INVALID_PREVIEW");
  assert.equal(restoredStatus.lastError.ref, status.lastError.ref);
  assert.match(run(["stop"]), /stopped/);
  stopped = true;
  console.log(
    "Package PASS: clean production-only install, CLI lifecycle, authenticated/no-store safe logs, private file mode, retained error after service restart.",
  );
} finally {
  if (cli && !stopped)
    try {
      run(["stop"]);
    } catch {}
  await rm(dir, { recursive: true, force: true });
}
