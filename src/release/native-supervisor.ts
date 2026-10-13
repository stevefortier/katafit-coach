import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

type Options = { signal?: AbortSignal; workMs?: number; drainMs?: number };
// Internal test seam: executable code chosen by the caller, never request data,
// environment variables, a manifest field, or a public CLI option.
type Boundary = {
  entry?: URL;
  onSpawn?: (child: ChildProcess) => void;
  onEvent?: (value: any) => void;
};

export function superviseNativeWorker(
  request: unknown,
  options: Options = {},
  boundary: Boundary = {},
): Promise<unknown> {
  const workMs = options.workMs ?? 600000,
    drainMs = options.drainMs ?? 5000;
  if (
    ![workMs, drainMs].every(
      (n) => Number.isSafeInteger(n) && n > 0 && n <= 900000,
    )
  )
    return Promise.reject(Error("RELEASE_WORKER_DEADLINE_INVALID"));
  if (options.signal?.aborted)
    return Promise.reject(Error("RELEASE_IMAGE_IDENTITY_CANCELLED"));
  const token = randomUUID();
  const source = import.meta.url.endsWith(".ts");
  return new Promise((resolve, reject) => {
    const child = fork(
      boundary.entry ??
        new URL(
          source ? "./native-worker.ts" : "./native-worker.js",
          import.meta.url,
        ),
      [],
      {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "json",
        // Do not inherit test-runner flags or arbitrary NODE_OPTIONS into the
        // production worker. Test bootstrap is an explicit trusted code seam.
        execArgv: boundary.entry || source ? ["--import", "tsx"] : [],
        env: { ...process.env, NODE_OPTIONS: "" },
      },
    );
    let done = false,
      cancelled = false,
      terminal: any;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(work);
      clearTimeout(drain);
      options.signal?.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      if (done || cancelled) return;
      cancelled = true;
      if (child.connected) child.send({ kind: "cancel", token }, () => {});
      drain = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        // Dropping the parent's observation does NOT release the worker's lock.
        // IPC EOF cancels the worker too. The detached worker owns its liveness.
        if (child.connected) child.disconnect();
        child.unref();
        reject(
          Object.assign(Error("RELEASE_NATIVE_OWNERSHIP_RETAINED"), {
            owner: { pid: child.pid, token },
            cleanup: "unconfirmed",
          }),
        );
      }, drainMs);
    };
    const work = setTimeout(cancel, workMs);
    options.signal?.addEventListener("abort", cancel, { once: true });
    child.on("message", (message: any) => {
      if (done || message?.token !== token) return;
      if (message.kind === "event") boundary.onEvent?.(message.value);
      else if (message.kind === "settled" && !terminal) terminal = message;
      else cancel();
    });
    child.once("error", () => cancel());
    child.once("close", (code, signal) => {
      if (done) return;
      done = true;
      cleanup();
      if (code !== 0 || signal || !terminal)
        reject(
          Object.assign(Error("RELEASE_WORKER_EXIT_UNCONFIRMED"), {
            owner: { pid: child.pid, token },
            cleanup: "unconfirmed",
          }),
        );
      else if (cancelled) reject(Error("RELEASE_IMAGE_IDENTITY_CANCELLED"));
      else if (terminal.error) reject(Error(terminal.error));
      else resolve(terminal.value);
    });
    boundary.onSpawn?.(child);
    child.send({ kind: "start", token, request }, (error) => {
      if (error) cancel();
    });
    if (options.signal?.aborted) cancel();
  });
}

/** One IPC-authenticated request per worker. EOF/parent death requests abort;
 * no operation is started from argv, a socket, a file or an environment token.
 * The liveness handle belongs to the worker, never the bounded supervisor. */
export function runNativeWorker(
  work: (
    request: any,
    signal: AbortSignal,
    event: (value: unknown) => void,
  ) => Promise<unknown>,
) {
  if (!process.send || !process.connected)
    throw Error("RELEASE_WORKER_CHANNEL_REQUIRED");
  const controller = new AbortController();
  const cancel = () =>
    controller.abort(Error("RELEASE_IMAGE_IDENTITY_CANCELLED"));
  const live = setInterval(() => {}, 1000);
  let started = false,
    token: string | undefined;
  const idle = setTimeout(() => {
    if (!started) {
      clearInterval(live);
      process.disconnect?.();
    }
  }, 10000);
  process.on("disconnect", cancel);
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);
  const send = (message: object) => {
    if (process.connected) process.send?.({ ...message, token }, () => {});
  };
  process.on("message", (message: any) => {
    if (message?.kind === "cancel" && message.token === token) {
      cancel();
      return;
    }
    if (
      started ||
      message?.kind !== "start" ||
      typeof message.token !== "string" ||
      !/^[a-f0-9-]{36}$/.test(message.token)
    ) {
      cancel();
      return;
    }
    started = true;
    token = message.token;
    clearTimeout(idle);
    void (async () => {
      try {
        controller.signal.throwIfAborted();
        const value = await work(message.request, controller.signal, (value) =>
          send({ kind: "event", value }),
        );
        send({ kind: "settled", value });
      } catch (error: any) {
        send({
          kind: "settled",
          error:
            typeof error?.message === "string"
              ? error.message.slice(0, 256)
              : "RELEASE_WORKER_FAILED",
        });
      } finally {
        clearInterval(live);
        if (process.connected) process.disconnect?.();
      }
    })();
  });
}
