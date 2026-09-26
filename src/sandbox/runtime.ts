import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import type { NativeGateway } from "./gateway.js";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import type { Duplex } from "node:stream";
import { sandboxArgs } from "./policy.js";

const exec = promisify(execFile);
const record = (value: any) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function validFrame(frame: any): boolean {
  if (!record(frame)) return false;
  const keys = Object.keys(frame);
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
  readonly name = "katafit-pi-" + randomUUID();
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
  private readonly run: (
    file: string,
    args: string[],
    options: any,
  ) => Promise<{ stdout: string }>;
  private readonly socketPath: string;
  constructor(
    readonly image: string,
    engine: {
      socketPath?: string;
      exec?: (
        file: string,
        args: string[],
        options: any,
      ) => Promise<{ stdout: string }>;
    } = {},
  ) {
    this.run = engine.exec ?? exec;
    this.socketPath = engine.socketPath ?? "/var/run/docker.sock";
  }
  private gateway?: NativeGateway;
  private relay?: ChildProcessWithoutNullStreams;
  private requests = new Map<number, AbortController>();
  async start(gateway?: NativeGateway) {
    if (this.closing) throw new Error("RUNTIME_CLEANUP_PENDING");
    this.gateway = gateway;
    const args = sandboxArgs(this.name, this.image);
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
      await this.run("docker", ["--host=unix://" + this.socketPath, ...args], {
        timeout: 15000,
        maxBuffer: 65536,
      });
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
      let buffer = "";
      let pending = 0,
        lastId = 0;
      const requests = this.requests;
      relay.stdout.setEncoding("utf8");
      relay.stderr.resume();
      relay.on("error", () => {
        void this.stop().catch(() => {});
      });
      relay.on("exit", () => {
        if (this.created) void this.stop().catch(() => {});
      });
      relay.stdout.on("data", (chunk) => {
        if (this.closing) return;
        try {
          buffer += chunk;
          if (Buffer.byteLength(buffer) > 1500000) {
            void this.stop().catch(() => {});
            return;
          }
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) {
            let frame: any;
            try {
              frame = JSON.parse(buffer.slice(0, end));
              if (!validFrame(frame)) throw new Error("FRAME_REJECTED");
            } catch {
              void this.stop().catch(() => {});
              return;
            }
            buffer = buffer.slice(end + 1);
            if (Number.isSafeInteger(frame.cancel)) {
              requests.get(frame.cancel)?.abort();
              continue;
            }
            if (
              ++pending > 4 ||
              !Number.isSafeInteger(frame.id) ||
              frame.id <= lastId
            ) {
              void this.stop().catch(() => {});
              return;
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
                () => ({ id: frame.id, error: "NATIVE_GATEWAY_REJECTED" }),
              )
              .then((response) => {
                pending--;
                requests.delete(frame.id);
                const data = JSON.stringify(response) + "\n";
                if (
                  relay.stdin.destroyed ||
                  relay.stdin.writableLength > 4 * 1024 * 1024 ||
                  Buffer.byteLength(data) > 4 * 1024 * 1024
                ) {
                  void this.stop().catch(() => {});
                  return;
                }
                relay.stdin.write(data);
              })
              .catch(() => {
                void this.stop().catch(() => {});
              });
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
