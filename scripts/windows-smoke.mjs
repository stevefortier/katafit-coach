// Runs an extracted Windows archive the way an installed copy runs: the
// bootstrap starts the supervisor, which starts Studio. Checks Studio and the
// authenticated status, then a clean stop through the CLI, and that a second
// owner of the same home is refused.
//   node windows-smoke.mjs <extracted katafit-coach dir> <home>
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [root, home] = process.argv.slice(2);
mkdirSync(home, { recursive: true });
const node = join(root, "node", "node.exe");
const env = { ...process.env, KATAFIT_COACH_HOME: home };
const boot = spawn(node, [join(root, "app", "dist", "boot.js")], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
for (const stream of [boot.stdout, boot.stderr])
  stream.on("data", (d) => (output += d));
const exited = new Promise((resolve) => boot.once("exit", resolve));
const fail = (message) => {
  console.log(output.slice(-4000));
  boot.kill();
  throw new Error(message);
};

let origin;
for (const started = Date.now(); Date.now() - started < 90000; ) {
  if (boot.exitCode !== null) fail(`bootstrap exited with ${boot.exitCode}`);
  try {
    origin = JSON.parse(readFileSync(join(home, "service.json"), "utf8")).origin;
    if ((await fetch(origin + "/")).ok) break;
  } catch {}
  origin = undefined;
  await new Promise((r) => setTimeout(r, 500));
}
if (!origin) fail("Studio never answered");
const { admin } = JSON.parse(readFileSync(join(home, "secrets.json"), "utf8"));
const status = await fetch(origin + "/api/status", {
  headers: { Authorization: "Bearer " + admin },
});
assert.equal(status.status, 200);
console.log(`Studio answers at ${origin}; status ${(await status.json()).state}`);

// A second owner of the same home is refused while the first runs.
const second = spawnSync(node, [join(root, "app", "dist", "cli.js"), "serve"], {
  env,
  encoding: "utf8",
  timeout: 30000,
});
assert.notEqual(second.status, 0, "a second owner must be refused");
console.log("A second owner is refused.");

const stop = spawnSync(node, [join(root, "app", "dist", "cli.js"), "stop"], {
  env,
  encoding: "utf8",
  timeout: 60000,
});
assert.equal(stop.status, 0, stop.stdout + stop.stderr);
const code = await Promise.race([
  exited,
  new Promise((r) => setTimeout(() => r("timeout"), 30000)),
]);
if (code === "timeout") fail("the bootstrap did not exit after stop");
assert.ok(!existsSync(join(home, "service.json")), "service.json is removed");
console.log(`Stopped cleanly; the bootstrap exited with ${code}.`);
