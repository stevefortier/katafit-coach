// Runs the real Pi CLI in RPC mode under Node's permission model, with its
// tools backed by just-bash and a scripted model attempting escapes.
//   node run-pi.mjs [--allow-worker]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const piRoot = join(here, "node_modules/@earendil-works/pi-coding-agent");
const cli = join(piRoot, "dist/bundle/cli.js");
const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-perm-")));
const ws = join(base, "workspace");
const home = join(base, "pi-home");
mkdirSync(ws);
mkdirSync(home);
writeFileSync(join(base, "secret.txt"), "TOP-SECRET");
writeFileSync(join(ws, "notes.txt"), "alpha\nbeta needle\n");
const flags = [
  "--permission",
  `--allow-fs-read=${here}`,
  `--allow-fs-read=${home}`,
  `--allow-fs-read=${ws}`,
  `--allow-fs-write=${home}`,
  `--allow-fs-write=${ws}`,
  ...process.argv.slice(2),
];
const started = Date.now();
const pi = spawn(
  process.execPath,
  [
    ...flags,
    "--import", pathToFileURL(join(here, "permission-shim.mjs")).href,
    cli,
    "--mode", "rpc", "--no-session", "--offline",
    "--no-builtin-tools", "--no-approve", "--no-extensions", "--no-skills",
    "--no-prompt-templates", "--no-themes", "--no-context-files",
    "-e", join(here, "workspace-tools.mjs"),
    "-e", join(here, "scripted-model.mjs"),
    "--provider", "script", "--model", "script-1",
  ],
  {
    cwd: ws,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: home,
      USERPROFILE: home,
      PI_CODING_AGENT_DIR: home,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      KATAFIT_WORKSPACE: ws,
      SPIKE_SECRET: join(base, "secret.txt"),
      SPIKE_OUTSIDE: join(base, "evil-from-pi.txt"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);
let stderr = "";
pi.stderr.on("data", (d) => (stderr += d));
let buffer = "";
const results = [];
let ended = false;
let toolStarted = 0;
pi.stdout.setEncoding("utf8");
pi.stdout.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "tool_execution_start") toolStarted = Date.now();
    if (e.type === "tool_execution_end")
      results.push({ tool: `${e.toolName} (${Date.now() - toolStarted} ms)`, error: e.isError, text: JSON.stringify(e.result?.content ?? e.result).slice(0, 1200) });
    if (e.type === "agent_end") ended = true;
    if (e.type === "response" && e.success === false) console.log("RPC error:", line.slice(0, 300));
  }
});
pi.stdin.write(JSON.stringify({ type: "prompt", message: "go" }) + "\n");
const deadline = Date.now() + 120000;
while (!ended && Date.now() < deadline && pi.exitCode === null) await new Promise((r) => setTimeout(r, 50));
const seconds = ((Date.now() - started) / 1000).toFixed(1);
pi.kill();
const rows = [];
let failures = 0;
const row = (ok, name, detail) => {
  if (!ok) failures++;
  rows.push(`| ${ok ? "ok" : "FAIL"} | ${name} | ${String(detail).replace(/\s+/g, " ").replaceAll("|", "\\|").slice(0, Number(process.env.SPIKE_DETAIL ?? 160))} |`);
};
row(ended, `Pi ran the scripted session (${seconds}s)`, ended ? "agent_end received" : `no agent_end; stderr: ${stderr.slice(0, 300)}`);
for (const r of results) row(!r.text.includes("TOP-SECRET") && !r.text.includes("root:x:"), `tool ${r.tool}`, r.text);
row(results.some((r) => r.text.includes("bash-ran-42")), "bash ran in just-bash", "");
row(existsSync(join(ws, "report.txt")), "write landed in the workspace", "");
row(!existsSync(join(base, "evil.txt")), "nothing written outside by tools", "");
const probes = [...stderr.matchAll(/^PROBE (\S+) (.*)$/gm)];
for (const [, name, outcome] of probes) {
  const expectAllowed = name === "worker" && flags.includes("--allow-worker");
  row(expectAllowed ? outcome === "ALLOWED" : outcome !== "ALLOWED", `in-process probe: ${name}`, outcome);
}
row(probes.length === 5, "all in-process probes reported", probes.length);
row(!existsSync(join(base, "evil-from-pi.txt")), "Pi's process wrote nothing outside", "");
const table = ["| | Check | Detail |", "|---|---|---|", ...rows].join("\n");
console.log(`flags: ${flags.join(" ")}`);
console.log(table);
if (!ended) console.log("stderr tail:", stderr.slice(-1500));
if (process.env.GITHUB_STEP_SUMMARY)
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Pi under the permission model, ${process.platform} ${process.argv.slice(2).join(" ")}\n${table}\n`, { flag: "a" });
process.exit(failures ? 1 : 0);
