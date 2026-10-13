import { AsyncLocalStorage } from "node:async_hooks";
import {
  fork,
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

// A failed close/unlink is not an ordinary rejected operation. Only the owning
// worker may retain it; never let the operator-lock finally treat it as settled.
export class NativeOwnershipUncertain extends Error {
  constructor(
    readonly resource: unknown,
    cause: unknown,
  ) {
    super("RELEASE_NATIVE_OWNERSHIP_RETAINED", { cause });
    nativeLockContext.getStore()?.uncertain.push(this);
  }
}
const retained = new Set<unknown>();
export async function retainNativeOwnership(
  ...resources: unknown[]
): Promise<never> {
  resources.forEach((resource) => retained.add(resource));
  await new Promise(() => {});
  throw Error("unreachable");
}
export const nativeLockContext = new AsyncLocalStorage<{
  fd: number;
  uncertain: unknown[];
  pending: Set<Promise<void>>;
  closed: boolean;
}>();
const ordinaryExec = promisify(execFile);

/** A trusted CLI wrapper receives an explicit duplicate of the flock descriptor.
 * No procfd path is passed to Docker. Resolve only at child close, including
 * cancellation, output overflow and lost replies. A stuck child retains both
 * this worker's operation and its own lock descriptor. */
export async function nativeOwnedExec(
  file: string,
  args: string[],
  options: any = {},
): Promise<{ stdout: string; stderr: string }> {
  const owner = nativeLockContext.getStore();
  if (owner === undefined) return ordinaryExec(file, args, options) as any;
  if (owner.uncertain.length)
    throw new NativeOwnershipUncertain(
      owner,
      Error("RELEASE_PRIOR_OWNERSHIP_UNCERTAIN"),
    );
  return ownedCommand(owner, file, args, options, false).result;
}

/** Stream-preserving release-only relay launcher. Its tracked settlement is
 * drained by the actual operator-lock scope even if NativeRuntime.stop returns. */
export function nativeOwnedSpawn(
  file: string,
  args: string[],
  options: any = {},
): ChildProcessWithoutNullStreams {
  const owner = nativeLockContext.getStore();
  if (!owner)
    return spawn(file, args, options) as ChildProcessWithoutNullStreams;
  if (owner.uncertain.length)
    throw new NativeOwnershipUncertain(
      owner,
      Error("RELEASE_PRIOR_OWNERSHIP_UNCERTAIN"),
    );
  return ownedCommand(owner, file, args, options, true)
    .child as ChildProcessWithoutNullStreams;
}

function ownedCommand(
  owner: NonNullable<ReturnType<typeof nativeLockContext.getStore>>,
  file: string,
  args: string[],
  options: any,
  stream: boolean,
) {
  if (owner.closed) throw Error("RELEASE_OPERATOR_SCOPE_CLOSED");
  const lock = owner.fd;
  options.signal?.throwIfAborted();
  let child!: ReturnType<typeof fork>;
  const result = new Promise<{ stdout: string; stderr: string }>(
    (resolve, reject) => {
      const source = import.meta.url.endsWith(".ts");
      const token = randomUUID();
      child = fork(
        new URL(
          source ? "./native-command.ts" : "./native-command.js",
          import.meta.url,
        ),
        [],
        {
          env: { ...process.env, NODE_OPTIONS: "" },
          execArgv: source ? ["--import", "tsx"] : [],
          stdio: [
            stream ? "pipe" : "ignore",
            stream ? "pipe" : "ignore",
            stream ? "pipe" : "ignore",
            lock,
            "ipc",
          ],
        },
      );
      let settlement: any;
      child.on("message", (message: any) => {
        if (
          message?.token === token &&
          message.settled === true &&
          typeof message.stdout === "string" &&
          typeof message.stderr === "string" &&
          message.stdout.length + message.stderr.length <= 65536 &&
          (message.code === null || Number.isInteger(message.code)) &&
          (message.signal === null || typeof message.signal === "string") &&
          typeof message.failed === "boolean" &&
          typeof message.outputLimit === "boolean"
        )
          settlement = message;
      });
      let failure: Error | undefined;
      const stop = (error: Error) => {
        failure ??= error;
        child.kill("SIGTERM"); // exact ChildProcess handle, never a guessed PID
      };
      const abort = () => stop(Error("RELEASE_IMAGE_IDENTITY_CANCELLED"));
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      const timer = setTimeout(
        () => stop(Error("RELEASE_CHILD_TIMEOUT")),
        options.timeout ?? 180000,
      );
      child.once("error", (error) => {
        failure ??= error;
      });
      child.once("close", (wrapperCode, wrapperSignal) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (wrapperCode !== 0 || wrapperSignal || !settlement) {
          reject(
            new NativeOwnershipUncertain(
              { lock, child },
              failure ?? Error("RELEASE_CHILD_SETTLEMENT_UNKNOWN"),
            ),
          );
          return;
        }
        const { code, signal, failed, outputLimit, stdout, stderr } =
          settlement;
        if (failure || code !== 0 || signal || failed || outputLimit) {
          reject(
            Object.assign(
              outputLimit
                ? Error("RELEASE_CHILD_OUTPUT_LIMIT")
                : (failure ?? Error("RELEASE_CHILD_FAILED")),
              {
                code: outputLimit ? "RELEASE_CHILD_OUTPUT_LIMIT" : code,
                ...(outputLimit ? { exitCode: code } : {}),
                signal,
                killed: !!failure || outputLimit,
                stdout,
                stderr,
              },
            ),
          );
        } else resolve({ stdout, stderr });
      });
      child.send(
        { token, file, args, cwd: options.cwd, env: options.env, stream },
        (error) => {
          if (error) stop(error);
        },
      );
    },
  );
  const pending = result.then(
    () => {},
    () => {},
  );
  owner.pending.add(pending);
  void pending.then(() => owner.pending.delete(pending));
  return { child, result };
}
