import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import type { NativeGateway } from "./gateway.js";
import {
  NATIVE_REQUEST_FRAME_LIMIT,
  NATIVE_RESPONSE_FRAME_LIMIT,
  failureFrame,
} from "./failures.js";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import type { Duplex } from "node:stream";
import { sandboxArgs } from "./policy.js";
import {
  AttachmentFailure,
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
  labels: Record<string, string>;
  containerId: string | null;
}
export interface NativeProbeEngine {
  inspect(reference: string): Promise<any | undefined>;
  remove(id: string): Promise<void>;
}

function dockerProbeEngine(
  run: (
    file: string,
    args: string[],
    options: any,
  ) => Promise<{ stdout: string }>,
  socketPath: string,
): NativeProbeEngine {
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
  ownership: NativeProbeOwnership,
  engine: NativeProbeEngine = dockerProbeEngine(exec, "/var/run/docker.sock"),
) {
  let found: any;
  try {
    found = await engine.inspect(ownership.name);
  } catch {
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
  )
    throw new Error("NATIVE_CLEANUP_PENDING");
  try {
    await engine.remove(found.Id);
  } catch {
    try {
      if ((await engine.inspect(found.Id)) === undefined) return;
    } catch {}
    throw new Error("NATIVE_CLEANUP_PENDING");
  }
}
const record = (value: any) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function validFrame(frame: any): boolean {
  if (!record(frame)) return false;
  const keys = Object.keys(frame);
  if (keys.length === 1 && keys[0] === "delivered")
    return Number.isSafeInteger(frame.delivered) && frame.delivered > 0;
  if (keys.length === 1 && keys[0] === "cancel")
    return Number.isSafeInteger(frame.cancel) && frame.cancel > 0;
  if (
    keys.length !== 2 ||
    !keys.includes("id") ||
    !keys.includes("request") ||
    !Number.isSafeInteger(frame.id) ||
    frame.id < 1 ||
    !record(frame.request)
  )
    return false;
  const request = frame.request,
    fields = Object.keys(request);
  if (request.kind === "catalog") return fields.length === 1;
  if (request.kind === "provider")
    return (
      fields.length === 2 && fields.includes("body") && record(request.body)
    );
  return (
    request.kind === "tool" &&
    fields.length === 3 &&
    fields.includes("name") &&
    fields.includes("args") &&
    typeof request.name === "string" &&
    request.name.length > 0 &&
    request.name.length <= 256 &&
    record(request.args)
  );
}

/** Control-plane only. Docker's socket is never mounted inside the runtime. */
export class NativeRuntime {
  readonly name: string;
  private socket?: Duplex;
  private created = false;
  onOutput: (chunk: string) => void = () => {};
  onExit: () => void = () => {};
  private version = "";
  private stopping?: Promise<void>;
  private closing = false;
  get cleanupPending() {
    return this.closing;
  }
  get containerId() {
    return this.ownership?.containerId ?? undefined;
  }
  private readonly run: (
    file: string,
    args: string[],
    options: any,
  ) => Promise<{ stdout: string }>;
  private readonly socketPath: string;
  private readonly ownership?: NativeProbeOwnership;
  private readonly probeEngine?: NativeProbeEngine;
  constructor(
    readonly image: string,
    engine: {
      socketPath?: string;
      exec?: (
        file: string,
        args: string[],
        options: any,
      ) => Promise<{ stdout: string }>;
      ownership?: NativeProbeOwnership;
      probeEngine?: NativeProbeEngine;
    } = {},
  ) {
    this.run = engine.exec ?? exec;
    this.socketPath = engine.socketPath ?? "/var/run/docker.sock";
    this.ownership = engine.ownership;
    this.name = engine.ownership?.name ?? "katafit-pi-" + randomUUID();
    this.probeEngine =
      engine.probeEngine ??
      (engine.ownership
        ? dockerProbeEngine(this.run, this.socketPath)
        : undefined);
  }
  private gateway?: NativeGateway;
  private relay?: ChildProcessWithoutNullStreams;
  private requests = new Map<number, AbortController>();
  async start(gateway?: NativeGateway) {
    if (this.closing) throw new Error("RUNTIME_CLEANUP_PENDING");
    this.gateway = gateway;
    const args = sandboxArgs(this.name, this.image, this.ownership?.labels);
    args.splice(1, 0, "--tty", ...(gateway ? ["--env=NATIVE_GATEWAY=1"] : []));
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
      if (this.ownership && containerId.test(id))
        this.ownership.containerId = id;
    } catch (error) {
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
        socket.on("error", () => socket.destroy());
        const decoder = new StringDecoder("utf8");
        const emit = (bytes: Buffer) => {
          const text = decoder.write(bytes);
          if (text) this.onOutput(text);
        };
        if (head.length) emit(head);
        socket.on("data", emit);
        socket.once("close", () => {
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
      const relay = (this.relay = spawn(
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
      // Byte-counted line framing over raw chunks: linear in frame size, and a
      // single request line may not exceed the relay's own request frame cap.
      let chunks: Buffer[] = [];
      let buffered = 0;
      let pending = 0,
        lastId = 0;
      const requests = this.requests;
      const deliveries = new Map<number, string>();
      relay.stderr.resume();
      relay.on("error", () => {
        void this.stop().catch(() => {});
      });
      relay.on("exit", () => {
        if (this.created) void this.stop().catch(() => {});
      });
      const respond = (response: any) => {
        let data = JSON.stringify(response) + "\n";
        // An oversized result is withheld as a fixed code, not a teardown.
        if (Buffer.byteLength(data) > NATIVE_RESPONSE_FRAME_LIMIT)
          data =
            JSON.stringify({
              id: response.id,
              error: "NATIVE_RESULT_TOO_LARGE",
            }) + "\n";
        if (
          relay.stdin.destroyed ||
          relay.stdin.writableLength > 2 * NATIVE_RESPONSE_FRAME_LIMIT
        ) {
          void this.stop().catch(() => {});
          return;
        }
        if (
          response.result?.completion_id &&
          Buffer.byteLength(JSON.stringify(response) + "\n") <=
            NATIVE_RESPONSE_FRAME_LIMIT
        ) {
          deliveries.clear(); // at most one completed response awaits delivery
          deliveries.set(response.id, response.result.completion_id);
        }
        relay.stdin.write(data);
      };
      const accept = (line: string) => {
        let frame: any;
        try {
          frame = JSON.parse(line);
          if (!validFrame(frame)) throw new Error("FRAME_REJECTED");
        } catch {
          void this.stop().catch(() => {});
          return false;
        }
        if (Number.isSafeInteger(frame.delivered)) {
          const completion = deliveries.get(frame.delivered);
          deliveries.delete(frame.delivered);
          if (completion)
            void this.gateway?.confirmDelivery?.(completion).catch(() => {});
          return true;
        }
        if (Number.isSafeInteger(frame.cancel)) {
          requests.get(frame.cancel)?.abort();
          return true;
        }
        if (
          ++pending > 4 ||
          !Number.isSafeInteger(frame.id) ||
          frame.id <= lastId
        ) {
          void this.stop().catch(() => {});
          return false;
        }
        lastId = frame.id;
        const controller = new AbortController();
        requests.set(frame.id, controller);
        void Promise.resolve()
          .then(() => {
            if (this.closing) throw new Error("NATIVE_CLOSED");
            return this.gateway!.handle(frame.request, controller.signal);
          })
          .then(
            (result) => ({ id: frame.id, result }),
            (error) => ({
              id: frame.id,
              ...failureFrame(error, frame.request?.kind),
            }),
          )
          .then((response) => {
            pending--;
            requests.delete(frame.id);
            respond(response);
          })
          .catch(() => {
            void this.stop().catch(() => {});
          });
        return true;
      };
      relay.stdout.on("data", (data: Buffer | string) => {
        if (this.closing) return;
        try {
          const chunk = typeof data === "string" ? Buffer.from(data) : data;
          let start = 0,
            end;
          while ((end = chunk.indexOf(10, start)) >= 0) {
            if (buffered + end - start > NATIVE_REQUEST_FRAME_LIMIT) {
              void this.stop().catch(() => {});
              return;
            }
            chunks.push(chunk.subarray(start, end));
            const line = Buffer.concat(chunks).toString("utf8");
            chunks = [];
            buffered = 0;
            start = end + 1;
            if (!accept(line)) return;
          }
          if (start < chunk.length) {
            buffered += chunk.length - start;
            if (buffered > NATIVE_REQUEST_FRAME_LIMIT) {
              void this.stop().catch(() => {});
              return;
            }
            chunks.push(chunk.subarray(start));
          }
        } catch {
          void this.stop().catch(() => {});
        }
      });
      relay.stdin.on("error", () => {
        void this.stop().catch(() => {});
      });
    }
  }
  input(data: string) {
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
    if (
      !Array.isArray(parts) ||
      parts.length < 1 ||
      parts.length > 8 ||
      parts.some(
        (part) =>
          typeof part !== "string" ||
          !part ||
          part === "." ||
          part === ".." ||
          /[/\u0000]/.test(part) ||
          Buffer.byteLength(part) > 128,
      ) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 16 * 1024 * 1024
    )
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
