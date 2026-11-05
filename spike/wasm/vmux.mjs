// Guest side of the VM console multiplexer (spike). The console is the VM's
// only channel to the host, so one JSON line per frame carries every stream:
//
//   host -> guest  {t:"start", c, argv, pty?, cols?, rows?}  start stream c
//                  {t:"in", c, d}          base64 bytes for c's stdin
//                  {t:"line", c, l}        one text line for c's stdin
//                  {t:"resize", c, cols, rows}
//                  {t:"end", c}            close c's stdin
//   guest -> host  {t:"ready"}
//                  {t:"out", c, d}         base64 bytes from c
//                  {t:"line", c, l}        one text line from c (line streams)
//                  {t:"exit", c, code}
//
// Streams started with pty:true get a terminal (Pi's TUI); others are plain
// pipes framed by line (the relay's JSON lines, Pi's RPC mode).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import pty from "node-pty";

process.stdin.setRawMode?.(true);
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const streams = new Map();
const uid = Number(process.env.VMUX_UID ?? 1000);

function start({ c, argv, pty: terminal, cols = 80, rows = 24 }) {
  if (streams.has(c) || !Array.isArray(argv) || !argv.length) return;
  const options = { cwd: process.env.VMUX_CWD ?? "/workspace", env: { ...process.env, TERM: "xterm-256color" }, uid, gid: uid };
  if (terminal) {
    const term = pty.spawn(argv[0], argv.slice(1), { ...options, cols, rows, name: "xterm-256color" });
    term.onData((data) => send({ t: "out", c, d: Buffer.from(data).toString("base64") }));
    term.onExit(({ exitCode }) => {
      streams.delete(c);
      send({ t: "exit", c, code: exitCode });
    });
    streams.set(c, {
      write: (bytes) => term.write(bytes.toString("utf8")),
      line: (l) => term.write(l + "\n"),
      resize: (w, h) => term.resize(w, h),
      end: () => term.kill(),
    });
    return;
  }
  const child = spawn(argv[0], argv.slice(1), { ...options, stdio: ["pipe", "pipe", "inherit"] });
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (l) => send({ t: "line", c, l }));
  child.on("exit", (code) => {
    streams.delete(c);
    send({ t: "exit", c, code: code ?? 1 });
  });
  child.stdin.on("error", () => {});
  streams.set(c, {
    write: (bytes) => child.stdin.write(bytes),
    line: (l) => child.stdin.write(l + "\n"),
    resize: () => {},
    end: () => child.stdin.end(),
  });
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (raw) => {
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    return;
  }
  if (frame.t === "start") return start(frame);
  const stream = streams.get(frame.c);
  if (!stream) return;
  if (frame.t === "in") stream.write(Buffer.from(frame.d, "base64"));
  else if (frame.t === "line") stream.line(frame.l);
  else if (frame.t === "resize") stream.resize(frame.cols, frame.rows);
  else if (frame.t === "end") stream.end();
});
process.stdin.on("end", () => process.exit(0));
send({ t: "ready" });
