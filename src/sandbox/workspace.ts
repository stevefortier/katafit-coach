import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AttachmentFailure } from "./attachments.js";
import type { NativeGateway } from "./gateway.js";
import { serveRelay } from "./relayChannel.js";
import {
  NATIVE_PROFILES,
  RPC_COMMAND_LIMIT,
  validRpc,
  type NativeProfile,
  type RpcCommand,
} from "./runtime.js";

/** The installed application: Pi, just-bash and the workspace launcher. */
const app = fileURLToPath(new URL("../../", import.meta.url));
const SESSION = /^katafit-pi-ws-[0-9a-f-]{36}$/;
/** Last stderr of recent sessions, bounded; see workspaceStderr(). */
const lastStderr = new Map<string, string>();
/** The most recent session's stderr tail (tests and local debugging). */
export const workspaceStderr = () => [...lastStderr.values()].at(-1) ?? "";
/** Session folders owned by a live runtime in this process. */
const live = new Set<string>();
/** Sessions live here, one private folder each, removed on stop. */
export const workspaceSessions = (home: string) => join(home, "sandbox");

/**
 * Node's permission model for a workspace-mode Pi. The process may read the
 * installed application and its own session folder, and write only the
 * session folder. It may not spawn programs, open network connections, load
 * native addons or use WASI. Worker threads are allowed because just-bash
 * runs Python in one; workers inherit these same limits.
 */
export function workspacePermissions(session: string): string[] {
  return [
    "--permission",
    `--allow-fs-read=${app}`,
    `--allow-fs-read=${session}`,
    `--allow-fs-write=${session}`,
    "--allow-worker",
    "--import",
    pathToFileURL(join(app, "workspace/permission-shim.mjs")).href,
  ];
}

/** Environment of a workspace-mode Pi: its own home and temp, nothing else. */
function workspaceEnvironment(session: string, profile: NativeProfile) {
  const home = join(session, "home");
  const tmp = join(session, "tmp");
  return {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    ...(process.platform === "win32" && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    NATIVE_PROFILE: profile,
  };
}

/**
 * Removes session folders no live runtime in this process owns: those left
 * by a crashed process. Session processes end with Coach: their stdin and
 * relay channel close, and Pi exits.
 */
export async function sweepWorkspaceSessions(home: string): Promise<number> {
  let removed = 0;
  let names: string[] = [];
  try {
    names = await readdir(workspaceSessions(home));
  } catch (error: any) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  for (const name of names) {
    if (!SESSION.test(name) || live.has(name)) continue;
    await rm(join(workspaceSessions(home), name), {
      recursive: true,
      force: true,
      maxRetries: 5,
    });
    removed++;
  }
  return removed;
}

/**
 * Pi as an ordinary process under Node's permission model, its tools backed
 * by just-bash (workspace/tools.mjs), its only channel out the relay over
 * Node's IPC channel. Same surface as NativeRuntime for headless RPC sessions.
 */
export class WorkspaceRuntime {
  readonly name = "katafit-pi-ws-" + randomUUID();
  onOutput: (chunk: string) => void = () => {};
  onExit: () => void = () => {};
  onDetached: () => void = () => {};
  onBoundary: (source: number, intentional: boolean) => void = () => {};
  private readonly sessions: string;
  private readonly session: string;
  private gateway?: NativeGateway;
  private profile?: NativeProfile;
  private child?: ChildProcess;
  private created = false;
  private closing = false;
  private stopping?: Promise<void>;
  private readonly requests = new Map<number, AbortController>();
  private readonly spawnPi: typeof spawn;
  constructor(options: { home: string; spawn?: typeof spawn }) {
    this.sessions = workspaceSessions(options.home);
    this.session = join(this.sessions, this.name);
    this.spawnPi = options.spawn ?? spawn;
  }
  get cleanupPending() {
    return this.closing;
  }
  /** No container: diagnostics carry no container identity. */
  get containerId(): undefined {
    return undefined;
  }
  get diagnosticContainerId(): undefined {
    return undefined;
  }
  private boundary(source: number) {
    try {
      this.onBoundary(source, this.closing);
    } catch {}
  }
  async start(
    gateway?: NativeGateway,
    options: { mode?: "interactive" | "rpc"; profile?: NativeProfile } = {},
  ) {
    if (this.closing) throw new Error("RUNTIME_CLEANUP_PENDING");
    if (
      options.mode !== "rpc" ||
      !gateway ||
      !NATIVE_PROFILES.includes(options.profile as NativeProfile)
    )
      throw new Error("RPC_PROFILE_REQUIRED");
    this.gateway = gateway;
    this.profile = options.profile;
    this.created = true;
    live.add(this.name);
    try {
      await mkdir(this.sessions, { recursive: true, mode: 0o700 });
      for (const part of ["", "workspace", "home", "tmp"])
        await mkdir(join(this.session, part), { mode: 0o700 });
    } catch (error) {
      this.boundary(11);
      await this.stop();
      throw error;
    }
  }
  async attach() {
    if (!this.created || this.closing) throw new Error("RUNTIME_NOT_STARTED");
    const child = (this.child = this.spawnPi(
      process.execPath,
      [
        ...workspacePermissions(this.session),
        join(app, "workspace/launch.mjs"),
      ],
      {
        cwd: join(this.session, "workspace"),
        env: workspaceEnvironment(this.session, this.profile!),
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        windowsHide: true,
      },
    ));
    const decoder = new StringDecoder("utf8");
    child.stdout!.on("data", (bytes: Buffer) => {
      const text = decoder.write(bytes);
      if (text) this.onOutput(text);
    });
    // A short tail for tests and local debugging; untrusted, never logged.
    child.stderr!.on("data", (bytes: Buffer) => {
      lastStderr.set(this.name, (lastStderr.get(this.name) ?? "") + bytes);
      const tail = lastStderr.get(this.name)!;
      if (tail.length > 4096) lastStderr.set(this.name, tail.slice(-4096));
    });
    child.stdin!.on("error", () => {});
    child.once("error", () => {
      this.boundary(9);
      void this.stop().catch(() => {});
    });
    child.once("exit", () => {
      this.boundary(6);
      this.onDetached();
      void this.stop().catch(() => {});
    });
    // The relay speaks over Node's IPC channel, one frame per message; these
    // adapters give serveRelay the byte streams it frames and bounds.
    const input = new PassThrough();
    child.on("message", (frame) => {
      if (typeof frame === "string") input.write(frame);
      else void this.stop().catch(() => {});
    });
    child.once("disconnect", () => {
      this.boundary(7);
      void this.stop().catch(() => {});
    });
    const output = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        if (!child.connected) return done(new Error("RELAY_CLOSED"));
        child.send(chunk.toString("utf8"), (error) => done(error ?? undefined));
      },
    });
    output.on("error", () => {
      this.boundary(10);
      void this.stop().catch(() => {});
    });
    serveRelay({
      input,
      output,
      requests: this.requests,
      gateway: () => this.gateway,
      closing: () => this.closing,
      fail: () => void this.stop().catch(() => {}),
    });
  }
  /** Writes one allowlisted Pi RPC command. */
  rpc(command: RpcCommand): Promise<void> {
    if (!validRpc(command)) throw new Error("RPC_COMMAND_REJECTED");
    const line = JSON.stringify(command) + "\n";
    const stdin = this.child?.stdin;
    if (
      !stdin ||
      stdin.destroyed ||
      Buffer.byteLength(line) > RPC_COMMAND_LIMIT ||
      stdin.writableLength > RPC_COMMAND_LIMIT
    )
      throw new Error("RPC_BACKPRESSURE");
    // Resolves once flushed, so a final abort is not lost to teardown.
    return new Promise((resolve) => stdin.write(line, () => resolve()));
  }
  input(_data: string): void {
    throw new Error("RPC_MODE");
  }
  async resize(_cols: number, _rows: number): Promise<void> {
    throw new Error("RPC_MODE");
  }
  async readWorkspaceFile(): Promise<Buffer> {
    throw new AttachmentFailure("ATTACHMENT_UNAVAILABLE");
  }
  stop(): Promise<void> {
    this.boundary(8);
    this.closing = true;
    for (const request of this.requests.values()) request.abort();
    this.requests.clear();
    void this.gateway?.close().catch(() => {});
    if (this.stopping) return this.stopping;
    if (!this.created) return Promise.resolve();
    return (this.stopping = (async () => {
      const child = this.child;
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGKILL");
        await Promise.race([
          exited,
          new Promise((resolve) => setTimeout(resolve, 5000).unref()),
        ]);
      }
      // A folder that cannot be removed now is swept at the next start.
      await rm(this.session, {
        recursive: true,
        force: true,
        maxRetries: 5,
      }).catch(() => {});
      live.delete(this.name);
      // Keep only the latest few tails.
      for (const key of [...lastStderr.keys()].slice(0, -4))
        lastStderr.delete(key);
      this.created = false;
      this.onExit();
    })());
  }
}
