// Host side of the multiplexer spike: one VM, a terminal stream and a
// line-framed relay stream at the same time over the console.
//
//   node vmux-host.mjs <image.wasm> <work-dir>
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [image, workArg] = process.argv.slice(2);
const work = resolve(workArg);
mkdirSync(`${work}/x`, { recursive: true });
writeFileSync(
  `${work}/echo.mjs`,
  `import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const m = JSON.parse(line);
  let reply;
  if (m.file) reply = { id: m.id, length: readFileSync("/workspace/" + m.file, "utf8").length };
  else if (m.bigfile) {
    writeFileSync("/workspace/x/resp-" + m.id, "y".repeat(m.bigfile));
    reply = { id: m.id, file: "x/resp-" + m.id };
  } else reply = m.big ? { id: m.id, data: "y".repeat(m.big) } : { id: m.id, length: line.length };
  process.stdout.write(JSON.stringify(reply) + "\\n");
}
`,
);
const host = process.platform === "win32" ? work.replaceAll("/", "\\") : work;
const started = Date.now();
const vm = spawn(
  "wasmtime",
  ["run", "--dir", `${host}::/workspace`, image, "node", "/opt/vmux/vmux.mjs"],
  { stdio: ["pipe", "pipe", "inherit"] },
);
const send = (frame) => vm.stdin.write(JSON.stringify(frame) + "\n");
let buffer = "";
let noise = 0;
const terminal = new Map(); // stream -> accumulated text
const lineWaiters = [];
const exits = new Map();
let onReady;
const ready = new Promise((r) => (onReady = r));
vm.stdout.setEncoding("utf8");
vm.stdout.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const raw = buffer.slice(0, i).replace(/\r$/, "");
    buffer = buffer.slice(i + 1);
    let f;
    try {
      f = JSON.parse(raw);
    } catch {
      if (raw.trim()) noise++;
      continue;
    }
    if (f.t === "ready") onReady();
    else if (f.t === "out")
      terminal.set(f.c, (terminal.get(f.c) ?? "") + Buffer.from(f.d, "base64").toString("utf8"));
    else if (f.t === "line") lineWaiters.shift()?.(JSON.parse(f.l));
    else if (f.t === "exit") exits.set(f.c, f.code);
  }
});
const vmExit = new Promise((r) => vm.on("exit", r));
const until = async (test, ms = 120000) => {
  const deadline = Date.now() + ms;
  while (!test()) {
    if (Date.now() > deadline) throw Error("TIMEOUT");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const nextLine = () => new Promise((r) => lineWaiters.push(r));
const shell = (c, command, expect) => {
  const before = (terminal.get(c) ?? "").length;
  send({ t: "line", c, l: command });
  return until(() => expect.test((terminal.get(c) ?? "").slice(before)));
};
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
  }
}
await step("boot to multiplexer ready", () => ready);
await step("pty shell sized 100x30", async () => {
  send({ t: "start", c: "tty", argv: ["sh"], pty: true, cols: 100, rows: 30 });
  await shell("tty", "stty size; echo pty-$((6*7))", /30 100[\s\S]*pty-42/);
});
await step("pty resize to 120x40", async () => {
  send({ t: "resize", c: "tty", cols: 120, rows: 40 });
  await shell("tty", "stty size", /40 120/);
});
await step("pty runs as uid 1000 in /workspace", () =>
  shell("tty", 'echo "$(id -u):$(pwd)"', /1000:\/workspace/),
);
await step("relay stream: 20 round trips beside the pty", async () => {
  send({ t: "start", c: "relay", argv: ["node", "/workspace/echo.mjs"] });
  for (let id = 1; id <= 20; id++) {
    send({ t: "line", c: "relay", l: JSON.stringify({ id }) });
    if ((await nextLine()).id !== id) throw Error("out of order");
  }
});
// Bulk bytes through the shared folder; the console carries only a notice.
for (const mib of [8, 32])
  await step(`exchange-folder request ${mib} MiB`, async () => {
    writeFileSync(`${work}/x/req-${mib}`, "x".repeat(mib << 20));
    send({ t: "line", c: "relay", l: JSON.stringify({ id: 300 + mib, file: `x/req-${mib}` }) });
    const m = await nextLine();
    if (m.length !== mib << 20) throw Error(`length ${m.length}`);
  });
for (const mib of [16])
  await step(`exchange-folder response ${mib} MiB`, async () => {
    send({ t: "line", c: "relay", l: JSON.stringify({ id: 400 + mib, bigfile: mib << 20 }) });
    const m = await nextLine();
    if (readFileSync(`${work}/${m.file}`, "utf8").length !== mib << 20) throw Error("short");
  });
for (const mib of [1])
  await step(`console request ${mib} MiB`, async () => {
    const l = JSON.stringify({ id: 100 + mib, payload: "x".repeat(mib << 20) });
    send({ t: "line", c: "relay", l });
    const m = await nextLine();
    if (m.length !== l.length) throw Error(`length ${m.length}`);
  });
for (const mib of [1])
  await step(`console response ${mib} MiB`, async () => {
    send({ t: "line", c: "relay", l: JSON.stringify({ id: 200 + mib, big: mib << 20 }) });
    const m = await nextLine();
    if (m.data?.length !== mib << 20) throw Error("short");
  });
await step("pty echo while relay busy", () => shell("tty", "echo still-$((2+3))", /still-5/));
await step("pi --version in the pty", () => shell("tty", "pi --version", /\d+\.\d+\.\d+/));
await step("Pi module import (warm-start cost)", async () => {
  writeFileSync(`${work}/warm.mjs`, readFileSync(new URL("./warm.mjs", import.meta.url)));
  await shell("tty", "node /workspace/warm.mjs", /import \d+ms/);
  return `(${/import (\d+ms)/.exec(terminal.get("tty"))?.[1]})`;
});
await step("Pi TUI first paint", async () => {
  send({ t: "start", c: "pi", argv: ["pi", "--offline", "--no-session"], pty: true, cols: 100, rows: 30 });
  await until(() => (terminal.get("pi") ?? "").length > 200 || exits.has("pi"), 90000);
  return `(${(terminal.get("pi") ?? "").length} bytes${exits.has("pi") ? `, exited ${exits.get("pi")}` : ""})`;
});
await step("closing stdin stops the VM", async () => {
  vm.stdin.end();
  await Promise.race([vmExit, new Promise((_, j) => setTimeout(() => j(Error("TIMEOUT")), 30000))]);
});
vm.kill();
const table = [`Non-frame console lines: ${noise}. Total ${((Date.now() - started) / 1000).toFixed(1)}s`, "", "| Multiplexer step | Time | Result |", "|---|---|---|", ...rows].join("\n");
console.log(table);
console.log("--- Pi TUI output (tail):", JSON.stringify((terminal.get("pi") ?? "").slice(-400)));
if (process.env.GITHUB_STEP_SUMMARY)
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Multiplexer ${process.platform}\n${table}\n`, { flag: "a" });
process.exit(failures ? 1 : 0);
