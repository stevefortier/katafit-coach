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

/** Control-plane only. Docker's socket is never mounted inside the runtime. */
export class NativeRuntime {
  readonly name = "katafit-pi-" + randomUUID();
  private socket?: Duplex;
  private created = false;
  onOutput: (chunk: string) => void = () => {};
  onExit: () => void = () => {};
  private version = "";
  private stopping?: Promise<void>;
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
  async start(gateway?: NativeGateway) {
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
          "--host=unix:///var/run/docker.sock",
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
      const requests = new Map<number, AbortController>();
      relay.stdout.setEncoding("utf8");
      relay.stderr.resume();
      relay.on("error", () => {
        void this.stop();
      });
      relay.on("exit", () => {
        if (this.created) void this.stop();
      });
      relay.stdout.on("data", (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 1500000) {
          void this.stop();
          return;
        }
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          let frame: any;
          try {
            frame = JSON.parse(buffer.slice(0, end));
          } catch {
            void this.stop();
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
            void this.stop();
            return;
          }
          lastId = frame.id;
          const controller = new AbortController();
          requests.set(frame.id, controller);
          void this.gateway!.handle(frame.request, controller.signal)
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
                void this.stop();
                return;
              }
              relay.stdin.write(data);
            });
        }
      });
      relay.stdin.on("error", () => {
        void this.stop();
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
      ["--host=unix:///var/run/docker.sock", "inspect", this.name],
      { timeout: 10000, maxBuffer: 65536 },
    );
    return JSON.parse(stdout)[0];
  }
  stop() {
    if (this.stopping) return this.stopping;
    this.socket?.destroy();
    this.relay?.kill();
    if (!this.created) return Promise.resolve();
    return (this.stopping = (async () => {
      await this.run(
        "docker",
        ["--host=unix://" + this.socketPath, "rm", "--force", this.name],
        { timeout: 15000, maxBuffer: 65536 },
      );
      this.created = false;
      this.onExit();
    })().finally(() => {
      this.stopping = undefined;
    }));
  }
}
