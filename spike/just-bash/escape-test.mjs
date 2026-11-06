// Drives the just-bash-backed Pi tools directly: ordinary work must succeed,
// every attempt to reach the host outside the workspace must fail.
//   node escape-test.mjs
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { workspaceTools } from "./workspace-tools.mjs";

const base = mkdtempSync(join(tmpdir(), "jb-"));
const ws = join(base, "workspace");
mkdirSync(ws);
writeFileSync(join(base, "secret.txt"), "TOP-SECRET");
writeFileSync(join(ws, "notes.txt"), "alpha\nbeta needle\ngamma\n");
let hostLink = "skipped";
try {
  symlinkSync(join(base, "secret.txt"), join(ws, "planted-link"));
  hostLink = "planted";
} catch {}
const { tools } = workspaceTools(ws);
const tool = Object.fromEntries(tools.map((t) => [t.name, t]));
const text = (r) => r.content.map((c) => c.text ?? "").join("");
const call = async (name, params) => {
  let out = "";
  try {
    const r = await tool[name].execute("t", params, undefined, (u) => {}, { cwd: "/workspace" });
    out = text(r);
  } catch (e) {
    out = `ERROR ${e.message}`;
  }
  return out;
};
const rows = [];
let failures = 0;
const check = async (name, run, ok) => {
  const t = Date.now();
  const out = await run();
  const pass = ok(out);
  if (!pass) {
    failures++;
    console.log(`--- ${name} output:\n${out}`);
  }
  rows.push(`| ${pass ? "ok" : "FAIL"} | ${name} | ${Date.now() - t} ms | ${out.replace(/\s+/g, " ").slice(0, 90).replaceAll("|", "\\|")} |`);
};
const leaked = (out) => out.includes("TOP-SECRET");

// Ordinary work.
await check("read a workspace file", () => call("read", { path: "notes.txt" }), (o) => o.includes("beta needle"));
await check("write then read", async () => (await call("write", { path: "out/new.txt", content: "hello" })) + (await call("read", { path: "/workspace/out/new.txt" })), (o) => o.includes("hello"));
await check("edit", async () => (await call("edit", { path: "notes.txt", edits: [{ oldText: "gamma", newText: "delta" }] })) + readFileSync(join(ws, "notes.txt"), "utf8"), (o) => o.includes("delta"));
await check("ls", () => call("ls", { path: "." }), (o) => o.includes("notes.txt"));
await check("find", () => call("find", { pattern: "*.txt" }), (o) => o.includes("notes.txt"));
await check("grep", () => call("grep", { pattern: "needle" }), (o) => o.includes("needle"));
await check("bash pipeline", () => call("bash", { command: "cat notes.txt | grep -c a | awk '{print $1*10}'" }), (o) => /\d0/.test(o));
await check("bash jq", () => call("bash", { command: "echo '{\"a\":[1,2,3]}' | jq '.a|add'" }), (o) => o.includes("6"));
await check("bash python3", () => call("bash", { command: "python3 -c 'print(sum(range(10)))'" }), (o) => o.includes("45"));
await check("bash js-exec", () => call("bash", { command: "js-exec -c 'console.log([1,2,3].map(x=>x*2).join())'" }), (o) => o.includes("2,4,6"));
await check("bash sqlite3", () => call("bash", { command: "sqlite3 :memory: 'select 6*7'" }), (o) => o.includes("42"));
await check("bash writes visible on host", async () => (await call("bash", { command: "echo from-bash > b.txt" })) + (existsSync(join(ws, "b.txt")) ? readFileSync(join(ws, "b.txt"), "utf8") : "missing"), (o) => o.includes("from-bash"));

// Escapes.
const secret = join(base, "secret.txt");
await check("read ../secret.txt", () => call("read", { path: "../secret.txt" }), (o) => !leaked(o));
await check("read host absolute path", () => call("read", { path: secret }), (o) => !leaked(o));
await check("read ~/.ssh", () => call("read", { path: join(homedir(), ".ssh", "id_ed25519") }), (o) => !o.startsWith("-----BEGIN"));
await check("bash cat host path", () => call("bash", { command: `cat '${secret.replaceAll("\\", "/")}' /etc/passwd ../secret.txt` }), (o) => !leaked(o) && !o.includes("root:"));
await check(`read host-planted symlink (${hostLink})`, () => call("read", { path: "planted-link" }), (o) => !leaked(o));
await check("bash ln -s escape", () => call("bash", { command: `ln -s ../secret.txt l2; cat l2; ln -s '${secret.replaceAll("\\", "/")}' l3; cat l3` }), (o) => !leaked(o));
await check("write outside", async () => (await call("write", { path: "../evil.txt", content: "x" })) + (existsSync(join(base, "evil.txt")) ? " WROTE-OUTSIDE" : ""), (o) => !o.includes("WROTE-OUTSIDE"));
await check("bash write outside", async () => (await call("bash", { command: "echo x > ../evil2.txt; echo x > /tmp/evil3.txt" })) + (existsSync(join(base, "evil2.txt")) ? " WROTE-OUTSIDE" : ""), (o) => !o.includes("WROTE-OUTSIDE"));
await check("python3 open host file", () => call("bash", { command: `python3 -c "print(open('${secret.replaceAll("\\", "/")}').read())"` }), (o) => !leaked(o));
await check("python3 subprocess", () => call("bash", { command: `python3 -c "import subprocess; print(subprocess.run(['id'],capture_output=True))"` }), (o) => !/uid=\d+/.test(o));
await check("js-exec child_process", () => call("bash", { command: `js-exec -c "console.log(require('child_process').execSync('id').toString())"` }), (o) => !/uid=\d+/.test(o));
await check("js-exec host fs", () => call("bash", { command: `js-exec -c "console.log(require('fs').readFileSync('${secret.replaceAll("\\", "/")}','utf8'))"` }), (o) => !leaked(o));
if (process.platform === "win32") {
  await check("read C:\\Windows\\win.ini", () => call("read", { path: "C:\\Windows\\win.ini" }), (o) => !/\[fonts\]|for 16-bit/i.test(o));
  await check("read \\\\?\\ long path to the secret", () => call("read", { path: `\\\\?\\${secret}` }), (o) => !leaked(o));
  await check("read another drive's workspace-relative path", () => call("read", { path: "D:..\\secret.txt" }), (o) => !leaked(o));
  await check("bash cat C:/Windows/win.ini", () => call("bash", { command: "cat C:/Windows/win.ini /c/Windows/win.ini" }), (o) => !/\[fonts\]|for 16-bit/i.test(o));
}
await check("curl (network off)", () => call("bash", { command: "curl -s https://example.com | head -c 100" }), (o) => !o.includes("<html") && !o.includes("Example Domain"));
await check("env has no host secrets", () => call("bash", { command: "env" }), (o) => !o.includes(homedir()) && !/KEY|TOKEN|SECRET/.test(o));
await check("infinite loop is bounded", () => call("bash", { command: "while true; do :; done", timeout: 5 }), () => true);

const table = ["| | Check | Time | Output |", "|---|---|---|---|", ...rows].join("\n");
console.log(table);
console.log(`failures: ${failures}`);
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### just-bash tools ${process.platform}\n${table}\n`, { flag: "a" });
process.exit(failures ? 1 : 0);
