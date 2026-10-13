import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  fstatSync,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import type { Writable, Readable } from "node:stream";

// Two trusted owners: this wrapper and the Linux subreaper. A single crash
// leaves either a reaping owner or a live uncertain owner holding the flock.
const lock = fstatSync(3);
if (
  !process.send ||
  !lock.isFile() ||
  lock.size !== 0 ||
  lock.uid !== process.getuid?.() ||
  (lock.mode & 0o777) !== 0o600
)
  throw Error("RELEASE_COMMAND_CHANNEL_REQUIRED");
const live = setInterval(() => {}, 1000);
let started = false,
  cancelled = false,
  finished = false;
let child: ChildProcess | undefined;
let control: Writable | undefined;
let requestSent = false;
const cancel = () => {
  cancelled = true;
  control?.end(requestSent ? "cancel\n" : undefined);
};
process.on("SIGTERM", cancel);
process.on("SIGINT", cancel);
process.on("disconnect", () => {
  cancel();
  if (!started) finish({ code: 1, signal: "SIGTERM", failed: true }, "");
});
function finish(status: any, token: string, stdout = "", stderr = "") {
  if (finished) return;
  try {
    closeSync(3);
  } catch {
    return;
  } // uncertain close retains this owner
  finished = true;
  if (process.connected)
    process.send?.(
      { token, settled: true, outputLimit: false, ...status, stdout, stderr },
      () => {},
    );
  clearInterval(live);
  if (process.connected) process.disconnect();
}
process.once("message", (request: any) => {
  if (
    finished ||
    !request ||
    typeof request.token !== "string" ||
    !/^[a-f0-9-]{36}$/.test(request.token) ||
    typeof request.file !== "string" ||
    !Array.isArray(request.args) ||
    request.args.some((v: unknown) => typeof v !== "string")
  )
    return;
  started = true;
  if (cancelled) {
    finish({ code: 1, signal: "SIGTERM", failed: true }, request.token);
    return;
  }
  // Fixed absolute interpreter and package-relative absolute helper, never PATH,
  // PYTHONPATH, site customizations, manifest input or a runtime env override.
  const interpreter = "/usr/bin/python3";
  const helper = fileURLToPath(
    new URL("./native-subreaper.py", import.meta.url),
  );
  try {
    const binary = statSync(realpathSync(interpreter));
    const script = lstatSync(helper);
    if (
      !binary.isFile() ||
      binary.uid !== 0 ||
      binary.mode & 0o022 ||
      !script.isFile() ||
      ![0, process.getuid?.()].includes(script.uid) ||
      script.mode & 0o022
    )
      throw Error("untrusted launcher");
  } catch {
    finish(
      { code: 1, signal: null, failed: true },
      request.token,
      "",
      "RELEASE_NATIVE_SUBREAPER_UNAVAILABLE",
    );
    return;
  }
  child = spawn(interpreter, ["-I", "-S", helper], {
    stdio: ["pipe", "pipe", "pipe", 3, "pipe", "pipe"],
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  control = child.stdio[4] as Writable;
  control.on("error", () => {}); // child close + authenticated receipt decides settlement
  let ready = false,
    settlement: any,
    protocol = "",
    failed = false,
    outputLimit = false,
    stdoutBytes = 0,
    stderrBytes = 0;
  // Fixed allocation and a combined retained-byte cap. After overflow, keep
  // draining both pipes without storing more output; settlement is independent.
  const capture = request.stream ? undefined : Buffer.alloc(2 * 65536);
  const stdout = capture?.subarray(0, 65536);
  const stderr = capture?.subarray(65536);
  const receipts = (child.stdio as unknown as Readable[])[5];
  receipts.on("data", (chunk: Buffer) => {
    protocol += chunk.toString();
    if (protocol.length > 4096) {
      failed = true;
      cancel();
      return;
    }
    let end;
    while ((end = protocol.indexOf("\n")) >= 0) {
      let message: any;
      try {
        message = JSON.parse(protocol.slice(0, end));
      } catch {
        failed = true;
        cancel();
        return;
      }
      protocol = protocol.slice(end + 1);
      if (!ready && message.ready === 1) {
        ready = true;
        if (cancelled) control!.end();
        else {
          requestSent = true;
          control!.write(
            JSON.stringify({
              file: request.file,
              args: request.args,
              cwd: request.cwd,
              env: request.env,
            }) + "\n",
          );
        }
      } else if (
        ready &&
        !settlement &&
        message.settled === true &&
        (message.code === null || Number.isInteger(message.code)) &&
        (message.signal === null || typeof message.signal === "string") &&
        typeof message.failed === "boolean"
      )
        settlement = message;
      else {
        failed = true;
        cancel();
      }
    }
  });
  if (request.stream) {
    process.stdin.pipe(child.stdin!);
    child.stdin!.on("error", () => {});
    child.stdout!.pipe(process.stdout);
    child.stderr!.pipe(process.stderr);
  } else {
    child.stdin!.end();
    for (const [stream, isOut] of [
      [child.stdout, true],
      [child.stderr, false],
    ] as const)
      stream!.on("data", (chunk: Buffer) => {
        if (outputLimit) return; // discard, do not pause a client's pipes
        if (chunk.length > 65536 - stdoutBytes - stderrBytes) {
          outputLimit = true;
          cancel();
          return;
        }
        if (isOut) {
          chunk.copy(stdout!, stdoutBytes);
          stdoutBytes += chunk.length;
        } else {
          chunk.copy(stderr!, stderrBytes);
          stderrBytes += chunk.length;
        }
      });
  }
  child.on("error", () => {
    failed = true;
  });
  child.once("close", (code, signal) => {
    // No receipt means possible orphan clients. Do NOT close the lock or exit.
    // The upstream supervisor's work/drain deadline reports retained ownership.
    if (code !== 0 || signal || !settlement || failed || protocol.length)
      return;
    process.stdin.unpipe();
    process.stdin.pause();
    finish(
      {
        ...settlement,
        failed: settlement.failed || outputLimit,
        outputLimit,
        capture: {
          allocatedBytes: capture?.length ?? 0,
          retainedBytes: stdoutBytes + stderrBytes,
        },
      },
      request.token,
      stdout?.subarray(0, stdoutBytes).toString() ?? "",
      stderr?.subarray(0, stderrBytes).toString() ?? "",
    );
  });
});
