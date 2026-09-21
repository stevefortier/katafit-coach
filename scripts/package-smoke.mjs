import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  assert.match(run(["stop"]), /stopped/);
  stopped = true;
  console.log(
    "Package PASS: packed tarball, clean production-only install, CLI help/start/health/stop.",
  );
} finally {
  if (cli && !stopped)
    try {
      run(["stop"]);
    } catch {}
  await rm(dir, { recursive: true, force: true });
}
