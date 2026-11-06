// Spike: run the Windows archive as an installed copy would and report what
// happens. Usage (on Windows): node run.mjs <extracted katafit-coach dir> <home>
import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [root, home] = process.argv.slice(2);
mkdirSync(home, { recursive: true });
const node = join(root, "node", "node.exe");
const boot = spawn(node, [join(root, "app", "dist", "boot.js")], {
  env: { ...process.env, KATAFIT_COACH_HOME: home, KATAFIT_COACH_PORT: "4317" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
boot.stdout.on("data", (d) => (out += d));
boot.stderr.on("data", (d) => (out += d));
let exited;
boot.on("exit", (code) => (exited = code));
const started = Date.now();
let studio = "not reached";
while (Date.now() - started < 90000 && exited === undefined) {
  if (existsSync(join(home, "service.json"))) {
    try {
      const { origin } = JSON.parse(readFileSync(join(home, "service.json"), "utf8"));
      const r = await fetch(origin + "/");
      studio = `${origin} -> HTTP ${r.status}`;
      break;
    } catch (e) {
      studio = "service.json present, fetch failed: " + e.message;
    }
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`boot exited: ${exited ?? "still running"} after ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`studio: ${studio}`);
console.log("--- output ---\n" + out.slice(-6000));
boot.kill();
process.exit(studio.includes("HTTP 200") ? 0 : 1);
