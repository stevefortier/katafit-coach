import {
  asNativeBinding,
  recordEngine,
  nativeEngineSocket,
  type NativeBinding,
  type NativeEngine,
} from "./binding.js";
import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import type { NativeGateway } from "./gateway.js";
import { record, serveRelay } from "./relayChannel.js";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { performance } from "node:perf_hooks";
import { cleanupDiagnostic } from "./cleanup-diagnostics.js";
import type { Duplex } from "node:stream";
import { sandboxArgs } from "./policy.js";
import {
  AttachmentFailure,
  validWorkspaceRead,
  WORKSPACE_READ_CODES,
  workspaceReadScript,
} from "./attachments.js";

const exec = promisify(execFile);
const containerId = /^[a-f0-9]{64}$/;
export interface NativeProbeOwnership {
  protocol: 1;
  name: string;
  token: string;
  revision: string;
  fingerprint: string;
  image: string;
  engine?: NativeEngine;
  labels: Record<string, string>;
  containerId: string | null;
}
/** The exact identity `cleanupNativeProbe` matches (probe or headless). */
export type NativeOwnership = Pick<
  NativeProbeOwnership,
  "name" | "image" | "engine" | "labels" | "containerId"
>;
export interface NativeProbeEngine {
  /** Missing only for legacy code-only fixtures. */
  engine?: NativeEngine;
  inspect(reference: string): Promise<any | undefined>;
  remove(id: string): Promise<void>;
}

export function dockerProbeEngine(
  run: (
    file: string,
    args: string[],
    options: any,
  ) => Promise<{ stdout: string }>,
  socketPath: string,
  engine: NativeEngine = "legacy",
): NativeProbeEngine {
  if (engine !== "legacy" && socketPath !== nativeEngineSocket(engine))
    throw Error("NATIVE_ENGINE_MISMATCH");
  let version: Promise<string> | undefined;
  const apiVersion = () =>
    (version ??= run(
      "docker",
      [
        "--host=unix://" + socketPath,
        "version",
        "--format",
        "{{.Server.APIVersion}}",
      ],
      { timeout: 10000, maxBuffer: 4096 },
    ).then(({ stdout }) => {
      const match = /^1\.(\d+)$/.exec(stdout.trim());
      if (!match || Number(match[1]) < 41)
        throw new Error("DOCKER_API_UNSUPPORTED");
      return "/v1." + Math.min(52, Number(match[1]));
    }));
  return {
    engine,
    async inspect(reference) {
      const prefix = await apiVersion();
      return new Promise<any | undefined>((resolve, reject) => {
        const req = request({
          socketPath,
          method: "GET",
          path: `${prefix}/containers/${encodeURIComponent(reference)}/json`,
        });
        const timer = setTimeout(
          () => req.destroy(new Error("DOCKER_TIMEOUT")),
          5000,
        );
        req.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        req.once("response", (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 65536) req.destroy(new Error("DOCKER_RESPONSE_LIMIT"));
            else chunks.push(chunk);
          });
          res.once("end", () => {
            clearTimeout(timer);
            if (res.statusCode === 404) return resolve(undefined);
            if (res.statusCode !== 200)
              return reject(new Error("DOCKER_REQUEST_REJECTED"));
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (error) {
              reject(error);
            }
          });
        });
        req.end();
      });
    },
    async remove(id) {
      await run(
        "docker",
        ["--host=unix://" + socketPath, "rm", "--force", id],
        { timeout: 15000, maxBuffer: 65536 },
      );
    },
  };
}

/** Remove only a container that exactly matches a durable probe receipt. */
export async function cleanupNativeProbe(
  ownership: NativeOwnership,
  engine?: NativeProbeEngine,
) {
  const selectedEngine = recordEngine(ownership);
  const started = performance.now();
  const socket = nativeEngineSocket(selectedEngine);
  if (engine && recordEngine(engine) !== selectedEngine)
    throw Error("NATIVE_ENGINE_MISMATCH");
  engine ??= dockerProbeEngine(exec, socket, selectedEngine);
  let found: any;
  try {
    found = await engine.inspect(ownership.name);
  } catch (error) {
    cleanupDiagnostic("inspect", started, error);
    throw new Error("NATIVE_CLEANUP_PENDING");
  }
  if (found === undefined) return;
  const labels = found?.Config?.Labels;
  const exactLabels = Object.entries(ownership.labels).every(
    ([key, value]) => labels?.[key] === value,
  );
  if (
    !containerId.test(found?.Id) ||
    found.Name !== "/" + ownership.name ||
    found.Image !== ownership.image ||
    found.Config?.Image !== ownership.image ||
    !exactLabels ||
    (ownership.containerId !== null && found.Id !== ownership.containerId)
  ) {
    cleanupDiagnostic("identity", started);
    throw new Error("NATIVE_CLEANUP_PENDING");
  }
  try {
    await engine.remove(found.Id);
  } catch (error) {
    try {
      if ((await engine.inspect(found.Id)) === undefined) return;
    } catch (inspectionError) {
      cleanupDiagnostic("remove-unconfirmed", started, inspectionError);
      throw new Error("NATIVE_CLEANUP_PENDING");
    }
    cleanupDiagnostic("remove-present", started, error);
    throw new Error("NATIVE_CLEANUP_PENDING");
  }
}
export const NATIVE_PROFILES = ["planner", "composer", "worker"] as const;
export type NativeProfile = (typeof NATIVE_PROFILES)[number];
export type RpcImage = { type: "image"; data: string; mimeType: string };
export type RpcCommand =
  | { type: "prompt"; message: string; id?: string; images?: RpcImage[] }
  | { type: "abort"; id?: string }
  | { type: "get_last_assistant_text"; id?: string };
export const RPC_COMMAND_LIMIT = 1024 * 1024;
/** Host-validated prompt images: at most five, 8 MiB each, 16 MiB total. */
export const RPC_PROMPT_IMAGES = 5;
const RPC_IMAGE_BYTES = 8 * 1024 * 1024;
const RPC_IMAGE_AGGREGATE = 16 * 1024 * 1024;
const RPC_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
/** Line bound for one command: images are budgeted separately from text. */
export function rpcCommandLimit(command: RpcCommand) {
  return command.type === "prompt" && command.images?.length
    ? RPC_COMMAND_LIMIT + Math.ceil((RPC_IMAGE_AGGREGATE * 4) / 3) + 4096
    : RPC_COMMAND_LIMIT;
}
function validImages(images: unknown) {
  if (
    !Array.isArray(images) ||
    images.length < 1 ||
    images.length > RPC_PROMPT_IMAGES
  )
    return false;
  let total = 0;
  for (const image of images) {
    if (
      !record(image) ||
      Object.keys(image).sort().join() !== "data,mimeType,type" ||
      image.type !== "image" ||
      !RPC_IMAGE_TYPES.includes(image.mimeType as string) ||
      typeof image.data !== "string" ||
      image.data.length === 0 ||
      image.data.length > Math.ceil((RPC_IMAGE_BYTES * 4) / 3) + 4 ||
      /[^A-Za-z0-9+/=]/.test(image.data)
    )
      return false;
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.toString("base64") !== image.data) return false;
    total += bytes.length;
    if (bytes.length > RPC_IMAGE_BYTES || total > RPC_IMAGE_AGGREGATE)
      return false;
  }
  return true;
}
/** Only prompt, abort and final-text reads; never sessions, bash or models. */
export function validRpc(command: any): command is RpcCommand {
  if (!record(command)) return false;
  const keys = Object.keys(command);
  const id =
    !keys.includes("id") ||
    (typeof command.id === "string" &&
      command.id.length > 0 &&
      command.id.length <= 128);
  const allowed =
    command.type === "prompt"
      ? ["type", "message", "id", "images"]
      : command.type === "abort" || command.type === "get_last_assistant_text"
        ? ["type", "id"]
        : undefined;
  return (
    !!allowed &&
    id &&
    keys.every((key) => allowed.includes(key)) &&
    (command.type !== "prompt" ||
      (typeof command.message === "string" &&
        command.message.length > 0 &&
        (!keys.includes("images") || validImages(command.images))))
  );
}
/** Streams Docker's multiplexed frames, passing stdout payload bytes only. */
function demultiplex(write: (bytes: Buffer) => void) {
  let header = Buffer.alloc(0);
  let remaining = 0;
  let stream = 0;
  return (chunk: Buffer) => {
    let offset = 0;
    while (offset < chunk.length) {
      if (remaining === 0) {
        const take = Math.min(8 - header.length, chunk.length - offset);
        header = Buffer.concat([header, chunk.subarray(offset, offset + take)]);
        offset += take;
        if (header.length < 8) return;
        stream = header[0];
        remaining = header.readUInt32BE(4);
        header = Buffer.alloc(0);
        continue;
      }
      const take = Math.min(remaining, chunk.length - offset);
      if (stream === 1) write(chunk.subarray(offset, offset + take));
      offset += take;
      remaining -= take;
    }
  };
}

/** Control-plane only. Docker's socket is never mounted inside the runtime. */
export class NativeRuntime {
  readonly name: string;
  private socket?: Duplex;
  private created = false;
  onOutput: (chunk: string) => void = () => {};
  onExit: () => void = () => {};
  /** The attached stream closed (process gone), before removal is known. */
  onDetached: () => void = () => {};
  private version = "";
  private stopping?: Promise<void>;
  private closing = false;
  get cleanupPending() {
    return this.closing;
  }
  // Content-free observer only; never changes teardown or callback semantics.
  onBoundary: (source: number, intentional: boolean) => void = () => {};
  private observedContainerId?: string;
  private boundary(source: number) {
    try {
      this.onBoundary(source, this.closing);
    } catch {}
  }
  get containerId() {
    return this.ownership?.containerId ?? undefined;
  }
  /** Exact validated create reply, observation only; no extra inspect/wait. */
  get diagnosticContainerId() {
    return this.containerId ?? this.observedContainerId;
  }
  private readonly run: (
    file: string,
    args: string[],
    options: any,
  ) => Promise<{ stdout: string }>;
  private readonly socketPath: string;
  private readonly spawnRelay: (
    file: string,
    args: string[],
    options: any,
  ) => ChildProcessWithoutNullStreams;
  private readonly labels: Record<string, string>;
  private mode: "interactive" | "rpc" = "interactive";
  private readonly ownership?: NativeOwnership;
  private readonly probeEngine?: NativeProbeEngine;
  readonly image: string;
  readonly binding: NativeBinding;
  constructor(
    image: string | NativeBinding,
    engine: {
      socketPath?: string;
      exec?: (
        file: string,
        args: string[],
        options: any,
      ) => Promise<{ stdout: string }>;
      ownership?: NativeOwnership;
      probeEngine?: NativeProbeEngine;
      /** Container name; ownership probes keep their own. */
      name?: string;
      /** Extra container labels, merged with ownership labels. */
      labels?: Record<string, string>;
      spawn?: (
        file: string,
        args: string[],
        options: any,
      ) => ChildProcessWithoutNullStreams;
    } = {},
  ) {
    this.binding =
      typeof image === "string"
        ? { image, engine: "legacy" }
        : asNativeBinding(image);
    this.image = this.binding.image;
    const socket = nativeEngineSocket(this.binding.engine);
    if (
      this.binding.engine !== "legacy" &&
      engine.socketPath !== undefined &&
      engine.socketPath !== socket
    )
      throw Error("NATIVE_ENGINE_MISMATCH");
    if (
      engine.ownership &&
      (recordEngine(engine.ownership) !== this.binding.engine ||
        engine.ownership.image !== this.image)
    )
      throw Error("NATIVE_ENGINE_MISMATCH");
    if (
      engine.probeEngine &&
      recordEngine(engine.probeEngine) !== this.binding.engine
    )
      throw Error("NATIVE_ENGINE_MISMATCH");
    this.run = engine.exec ?? exec;
    this.spawnRelay = engine.spawn ?? spawn;
    this.labels = engine.labels ?? {};
    this.socketPath = engine.socketPath ?? socket;
    this.ownership = engine.ownership;
    this.name =
      engine.ownership?.name ?? engine.name ?? "katafit-pi-" + randomUUID();
    this.probeEngine =
      engine.probeEngine ??
      (engine.ownership
        ? dockerProbeEngine(this.run, this.socketPath, this.binding.engine)
        : undefined);
  }
  private gateway?: NativeGateway;
  private relay?: ChildProcessWithoutNullStreams;
  private requests = new Map<number, AbortController>();
  async start(
    gateway?: NativeGateway,
    options: { mode?: "interactive" | "rpc"; profile?: NativeProfile } = {},
  ) {
    if (this.closing) throw new Error("RUNTIME_CLEANUP_PENDING");
    const rpc = options.mode === "rpc";
    if (
      rpc &&
      (!gateway || !NATIVE_PROFILES.includes(options.profile as NativeProfile))
    )
      throw new Error("RPC_PROFILE_REQUIRED");
    this.gateway = gateway;
    this.mode = rpc ? "rpc" : "interactive";
    const args = sandboxArgs(this.name, this.image, {
      ...this.labels,
      ...this.ownership?.labels,
    });
    args.splice(
      1,
      0,
      ...(rpc
        ? [
            "--env=NATIVE_GATEWAY=1",
            "--env=NATIVE_MODE=rpc",
            `--env=NATIVE_PROFILE=${options.profile}`,
          ]
        : ["--tty", ...(gateway ? ["--env=NATIVE_GATEWAY=1"] : [])]),
    );
    // Negotiate the daemon version, capped at the API this client implements.
    const { stdout } = await this.run(
      "docker",
      [
        "--host=unix://" + this.socketPath,
        "version",
        "--format",
        "{{.Server.APIVersion}}",
      ],
      { timeout: 10000, maxBuffer: 4096 },
    );
    const version = /^1\.(\d+)$/.exec(stdout.trim());
    if (!version || Number(version[1]) < 41)
      throw new Error("DOCKER_API_UNSUPPORTED");
    this.version = "/v1." + Math.min(52, Number(version[1]));
    this.created = true; // Name is owned before an ambiguous create dispatch.
    try {
      const created = await this.run(
        "docker",
        ["--host=unix://" + this.socketPath, ...args],
        {
          timeout: 15000,
          maxBuffer: 65536,
        },
      );
      const id = created.stdout.trim();
      if (containerId.test(id)) this.observedContainerId = id;
      if (this.ownership && containerId.test(id))
        this.ownership.containerId = id;
    } catch (error) {
      this.boundary(11);
      await this.stop();
      throw error;
    }
  }
  private api(path: string, upgrade = false): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = request({
        socketPath: this.socketPath,
        path: this.version + path,
        method: "POST",
        headers: upgrade ? { Connection: "Upgrade", Upgrade: "tcp" } : {},
      });
      const timeout = setTimeout(
        () => req.destroy(new Error("DOCKER_TIMEOUT")),
        10000,
      );
      req.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      req.once("upgrade", (_res, socket, head) => {
        clearTimeout(timeout);
        this.socket = socket;
        socket.on("error", () => {
          this.boundary(10);
          socket.destroy();
        });
        const decoder = new StringDecoder("utf8");
        const write = (bytes: Buffer) => {
          const text = decoder.write(bytes);
          if (text) this.onOutput(text);
        };
        // Without a TTY Docker multiplexes stdout/stderr behind 8-byte
        // headers; only stdout (Pi's RPC JSONL) is surfaced.
        const emit = this.mode === "rpc" ? demultiplex(write) : write;
        if (head.length) emit(head);
        socket.on("data", emit);
        socket.once("close", () => {
          this.boundary(6);
          this.onDetached();
          void this.stop().catch(() => {});
        });
        resolve(undefined);
      });
      req.once("response", (res) => {
        res.resume();
        res.once("end", () => {
          clearTimeout(timeout);
          res.statusCode! < 300 && !upgrade
            ? resolve(undefined)
            : reject(new Error("DOCKER_REQUEST_REJECTED"));
        });
      });
      req.end();
    });
  }
  async attach() {
    if (!this.created) throw new Error("RUNTIME_NOT_STARTED");
    await this.api(
      `/containers/${this.name}/attach?stream=1&stdin=1&stdout=1&stderr=1`,
      true,
    );
    await this.api(`/containers/${this.name}/start`);
    if (this.gateway) {
      const relay = (this.relay = this.spawnRelay(
        "docker",
        [
          "--host=unix://" + this.socketPath,
          "exec",
          "-i",
          this.name,
          "node",
          "/opt/coach/sandbox/relay.mjs",
        ],
        { stdio: "pipe" },
      ));
      relay.stderr.resume();
      relay.on("error", () => {
        this.boundary(9);
        void this.stop().catch(() => {});
      });
      relay.on("exit", () => {
        this.boundary(7);
        if (this.created) void this.stop().catch(() => {});
      });
      serveRelay({
        input: relay.stdout,
        output: relay.stdin,
        requests: this.requests,
        gateway: () => this.gateway,
        closing: () => this.closing,
        fail: () => void this.stop().catch(() => {}),
      });
    }
  }
  /** Writes one allowlisted Pi RPC command (rpc mode only). */
  rpc(command: RpcCommand): Promise<void> {
    if (this.mode !== "rpc" || !validRpc(command))
      throw new Error("RPC_COMMAND_REJECTED");
    const line = JSON.stringify(command) + "\n";
    const socket = this.socket;
    if (
      !socket ||
      socket.destroyed ||
      Buffer.byteLength(line) > rpcCommandLimit(command) ||
      socket.writableLength > RPC_COMMAND_LIMIT
    )
      throw new Error("RPC_BACKPRESSURE");
    // Resolves once flushed, so a final abort is not lost to teardown.
    return new Promise((resolve) => socket.write(line, () => resolve()));
  }
  input(data: string) {
    if (this.mode === "rpc") throw new Error("RPC_MODE");
    if (
      !this.socket ||
      this.socket.destroyed ||
      Buffer.byteLength(data) > 8192 ||
      this.socket.writableLength > 65536
    )
      throw new Error("TERMINAL_BACKPRESSURE");
    this.socket.write(data);
  }
  /**
   * Host-initiated, bounded read of one regular file below this runtime's own
   * /workspace. The script is host-supplied; the walk never follows links.
   */
  async readWorkspaceFile(
    parts: string[],
    limit: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    if (this.closing || !this.created)
      throw new AttachmentFailure("ATTACHMENT_UNAVAILABLE");
    if (!validWorkspaceRead(parts, limit))
      throw new AttachmentFailure("ATTACHMENT_PATH_REJECTED");
    let stdout: unknown;
    try {
      ({ stdout } = await this.run(
        "docker",
        [
          "--host=unix://" + this.socketPath,
          "exec",
          "--user",
          "1000:1000",
          "--workdir",
          "/",
          "--env",
          "NODE_OPTIONS=",
          this.name,
          // Absolute path: no PATH lookup for the host-initiated reader.
          "/usr/local/bin/node",
          "-e",
          workspaceReadScript(),
          JSON.stringify(parts),
          String(limit),
        ],
        {
          encoding: "buffer",
          maxBuffer: limit + 1,
          timeout: 15000,
          killSignal: "SIGKILL",
          signal,
        },
      ));
    } catch (error: any) {
      if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
        throw new AttachmentFailure("ATTACHMENT_TOO_LARGE");
      const code =
        error?.code === 3 && error.stderr !== undefined
          ? Buffer.from(error.stderr).toString("utf8").trim()
          : "";
      throw new AttachmentFailure(
        WORKSPACE_READ_CODES.includes(code)
          ? code
          : "ATTACHMENT_FILE_UNAVAILABLE",
      );
    }
    if (this.closing) throw new AttachmentFailure("ATTACHMENT_UNAVAILABLE");
    const bytes = Buffer.isBuffer(stdout)
      ? stdout
      : Buffer.from(String(stdout ?? ""));
    if (bytes.length > limit)
      throw new AttachmentFailure("ATTACHMENT_TOO_LARGE");
    if (!bytes.length) throw new AttachmentFailure("ATTACHMENT_FILE_EMPTY");
    return bytes;
  }
  async resize(cols: number, rows: number) {
    if (![cols, rows].every((n) => Number.isInteger(n) && n >= 2 && n <= 500))
      throw new Error("INVALID_SIZE");
    await this.api(`/containers/${this.name}/resize?w=${cols}&h=${rows}`);
  }
  async inspect(): Promise<any> {
    const { stdout } = await this.run(
      "docker",
      ["--host=unix://" + this.socketPath, "inspect", this.name],
      { timeout: 10000, maxBuffer: 65536 },
    );
    return JSON.parse(stdout)[0];
  }
  stop() {
    this.boundary(8);
    this.closing = true;
    for (const request of this.requests.values()) request.abort();
    this.requests.clear();
    void this.gateway?.close().catch(() => {});
    if (this.stopping) return this.stopping;
    this.socket?.destroy();
    this.relay?.kill();
    if (!this.created) return Promise.resolve();
    return (this.stopping = (async () => {
      if (this.ownership) {
        await cleanupNativeProbe(this.ownership, this.probeEngine!);
        this.created = false;
        this.onExit();
        return;
      }
      try {
        await this.run(
          "docker",
          ["--host=unix://" + this.socketPath, "rm", "--force", this.name],
          { timeout: 15000, maxBuffer: 65536 },
        );
      } catch {
        // A lost rm reply may mean success. Only a daemon 404 establishes
        // absence; CLI errors, socket errors and server errors retain ownership.
        const absent = await new Promise<boolean>((resolve) => {
          const req = request({
            socketPath: this.socketPath,
            method: "GET",
            path: this.version + `/containers/${this.name}/json`,
          });
          const timer = setTimeout(() => req.destroy(), 5000);
          req.once("error", () => {
            clearTimeout(timer);
            resolve(false);
          });
          req.once("response", (res) => {
            res.resume();
            res.once("end", () => {
              clearTimeout(timer);
              resolve(res.statusCode === 404);
            });
          });
          req.end();
        });
        if (!absent) throw new Error("NATIVE_CLEANUP_PENDING");
      }
      this.created = false;
      this.onExit();
    })().finally(() => {
      this.stopping = undefined;
    }));
  }
}
