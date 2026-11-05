// Measures the VM's stdio as the relay channel: the Docker runtime speaks
// JSON lines to the relay over `docker exec -i`; under WebAssembly the same
// frames would cross the VM console. Times boot to first reply, small
// round trips, and large frames in both directions (the relay allows 32 MiB
// requests and 16 MiB responses).
//
//   node channel.mjs <image.wasm> <work-dir>
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [image, workArg] = process.argv.slice(2);
const work = resolve(workArg);
mkdirSync(work, { recursive: true });
writeFileSync(
  `${work}/echo.mjs`,
  `import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
process.stdout.write(JSON.stringify({ r: 1, ready: true }) + "\\n");
for await (const line of lines) {
  const m = JSON.parse(line);
  const reply = m.big ? { r: 1, id: m.id, data: "y".repeat(m.big) } : { r: 1, id: m.id, length: line.length };
  process.stdout.write(JSON.stringify(reply) + "\\n");
}
`,
);
const host =
  process.platform === "win32" ? work.replaceAll("/", "\\") : work;
const started = Date.now();
const vm = spawn(
  "wasmtime",
  ["run", "--dir", `${host}::/mnt/work`, image, "node", "/mnt/work/echo.mjs"],
  { stdio: ["pipe", "pipe", "inherit"] },
);
let buffer = "";
let echoed = 0;
const waiters = [];
vm.stdout.setEncoding("utf8");
vm.stdout.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).replace(/\r$/, "");
    buffer = buffer.slice(i + 1);
    let message;
    try {
      message = JSON.parse(line);
    } catch {}
    if (message?.r !== 1) {
      echoed++;
      if (echoed <= 5) console.log(`  (console) ${line.slice(0, 120)}`);
      continue;
    }
    waiters.shift()?.(message);
  }
});
const next = () =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("TIMEOUT")), 180000);
    waiters.push((m) => {
      clearTimeout(timer);
      resolve(m);
    });
  });
const send = (message) => vm.stdin.write(JSON.stringify(message) + "\n");
const rows = [];
let failures = 0;
async function step(name, run) {
  const t = Date.now();
  try {
    const detail = await run();
    rows.push(`| ${name} | ${((Date.now() - t) / 1000).toFixed(2)}s | ok ${detail ?? ""} |`);
  } catch (error) {
    failures++;
    rows.push(`| ${name} | ${((Date.now() - t) / 1000).toFixed(2)}s | FAILED ${error.message} |`);
    throw error;
  }
}
try {
  await step("boot to first reply", async () => {
    const m = await next();
    if (!m.ready) throw Error("unexpected first line");
  });
  await step("20 small round trips", async () => {
    for (let id = 1; id <= 20; id++) {
      send({ id });
      if ((await next()).id !== id) throw Error("out of order");
    }
  });
  for (const mib of [1, 8, 32]) {
    await step(`request ${mib} MiB`, async () => {
      const payload = "x".repeat(mib * 1024 * 1024);
      send({ id: 100 + mib, payload });
      const m = await next();
      if (m.length !== JSON.stringify({ id: 100 + mib, payload }).length)
        throw Error(`length ${m.length}`);
    });
  }
  for (const mib of [1, 16]) {
    await step(`response ${mib} MiB`, async () => {
      send({ id: 200 + mib, big: mib * 1024 * 1024 });
      const m = await next();
      if (m.data?.length !== mib * 1024 * 1024) throw Error("short");
    });
  }
} catch {}
vm.stdin.end();
vm.kill();
console.log(`Non-reply console lines: ${echoed}`);
console.log(`Total ${((Date.now() - started) / 1000).toFixed(1)}s`);
const table = ["| Channel step | Time | Result |", "|---|---|---|", ...rows].join("\n");
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY)
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Channel ${process.platform}\n${table}\n`, { flag: "a" });
process.exit(failures ? 1 : 0);
