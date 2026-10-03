import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Socket } from "node:net";

// ---------------------------------------------------------------------------
// Fake Docker engine: a unix-socket API server whose attach upgrade speaks
// Docker's non-TTY multiplexed stream and a scripted Pi RPC peer.
// ---------------------------------------------------------------------------
// Fixtures are closed even when the code under test throws before a try.
export const leaked = new Set<() => Promise<void>>();
export const frame = (stream: number, data: string | Buffer) => {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
};
export interface FakePi {
  send(event: unknown): void;
  stderr(text: string): void;
  raw(bytes: Buffer): void;
  close(): void;
}
export type Script = (command: any, pi: FakePi) => void;

export const finalOutcome = JSON.stringify({ result: "completed" });
/** Well-behaved Pi: prompt → events → agent_end; returns `text`. */
export const obedient =
  (text = finalOutcome): Script =>
  (command, pi) => {
    if (command.type === "prompt") {
      pi.send({
        id: command.id,
        type: "response",
        command: "prompt",
        success: true,
      });
      pi.stderr("pi diagnostics are discarded\n");
      pi.send({ type: "agent_start" });
      pi.send({ type: "turn_start" });
      pi.send({ type: "agent_end", messages: [] });
    }
    if (command.type === "get_last_assistant_text")
      pi.send({
        id: command.id,
        type: "response",
        command: "get_last_assistant_text",
        success: true,
        data: { text },
      });
  };

/** A synthetic Docker daemon's container table, shareable by two homes. */
export interface FakeContainer {
  Id: string;
  Name: string;
  Image: string;
  Config: { Image: string; Labels: Record<string, string> };
}
export function fakeDaemon() {
  return {
    containers: new Map<string, FakeContainer>(),
    /** Next N `docker rm` calls fail (daemon error, container kept). */
    failRm: 0,
    /** Next N inspect GETs answer 500. */
    failInspect: 0,
    inspects: 0,
    find(reference: string) {
      for (const c of this.containers.values())
        if (c.Name === "/" + reference || c.Id === reference) return c;
      return undefined;
    },
  };
}
export type FakeDaemon = ReturnType<typeof fakeDaemon>;

let ids = 0;
/**
 * `ps` given: legacy canned `docker ps` output. Otherwise every create, rm,
 * filtered ps and inspect acts on `daemon`'s container table.
 */
export async function fakeEngine(
  script: Script,
  ps?: string,
  daemon: FakeDaemon = fakeDaemon(),
) {
  const dir = await mkdtemp(tmpdir() + "/autonomy-headless-");
  const socketPath = dir + "/docker.sock";
  const paths: string[] = [];
  const commands: any[] = [];
  const execs: string[][] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    paths.push(req.url!);
    const inspect = /^\/v1\.\d+\/containers\/([^/]+)\/json$/.exec(req.url!);
    if (req.method === "GET" && inspect) {
      daemon.inspects++;
      if (daemon.failInspect > 0) {
        daemon.failInspect--;
        res.writeHead(500);
        return res.end("{}");
      }
      const found = daemon.find(decodeURIComponent(inspect[1]));
      res.writeHead(found ? 200 : 404, {
        "Content-Type": "application/json",
      });
      return res.end(JSON.stringify(found ?? { message: "No such container" }));
    }
    res.writeHead(204);
    res.end();
  });
  server.on("upgrade", (req, socket: Socket) => {
    sockets.add(socket);
    paths.push(req.url!);
    socket.write(
      "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
    );
    // Writes stay ordered (a real daemon never interleaves frames) while
    // each stdout frame is split across writes to prove header reassembly.
    let chain = Promise.resolve();
    const write = (...parts: Buffer[]) =>
      void (chain = chain.then(async () => {
        for (const part of parts) {
          if (socket.destroyed) return;
          socket.write(part);
          await new Promise((r) => setImmediate(r));
        }
      }));
    const pi: FakePi = {
      send(event) {
        const bytes = frame(1, JSON.stringify(event) + "\n");
        write(bytes.subarray(0, 3), bytes.subarray(3));
      },
      stderr(text) {
        write(frame(2, text));
      },
      raw(bytes) {
        write(bytes);
      },
      close() {
        chain = chain.then(() => void socket.end());
      },
    };
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const command = JSON.parse(line);
        commands.push(command);
        setImmediate(() => script(command, pi));
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  const relays: any[] = [];
  const engine = {
    socketPath,
    exec: async (_file: string, args: string[]) => {
      execs.push(args);
      if (args.includes("version")) return { stdout: "1.52\n" };
      if (args.includes("create")) {
        const name = args[args.indexOf("--name") + 1];
        const labels: Record<string, string> = {};
        args.forEach((a, i) => {
          if (a === "--label") {
            const [key, ...value] = args[i + 1].split("=");
            labels[key] = value.join("=");
          }
        });
        const image = args.find((a) => /^sha256:[a-f0-9]{64}$/.test(a))!;
        const Id = (++ids).toString(16).padStart(64, "a");
        daemon.containers.set(Id, {
          Id,
          Name: "/" + name,
          Image: image,
          Config: { Image: image, Labels: labels },
        });
        return { stdout: Id + "\n" };
      }
      if (args.includes("ps")) {
        if (ps !== undefined) return { stdout: ps };
        const filters = args
          .map((a, i) => (args[i - 1] === "--filter" ? a : undefined))
          .filter((a): a is string => !!a && a.startsWith("label="))
          .map((a) => a.slice("label=".length).split("="));
        const names = [...daemon.containers.values()]
          .filter((c) => filters.every(([k, v]) => c.Config.Labels[k] === v))
          .map((c) => c.Name.slice(1));
        return { stdout: names.map((n) => n + "\n").join("") };
      }
      if (args.includes("rm")) {
        if (daemon.failRm > 0) {
          daemon.failRm--;
          throw new Error("synthetic daemon rm failure");
        }
        const found = daemon.find(args[args.length - 1]);
        if (found) daemon.containers.delete(found.Id);
        return { stdout: "" };
      }
      return { stdout: "" };
    },
    spawn: (_file: string, args: string[]) => {
      const child: any = new EventEmitter();
      child.args = args;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {
        child.killed = true;
        setImmediate(() => child.emit("exit", 0));
        return true;
      };
      relays.push(child);
      return child;
    },
  };
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      leaked.delete(close);
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    })());
  leaked.add(close);
  return {
    engine,
    paths,
    commands,
    execs,
    relays,
    daemon,
    creates: () => execs.filter((a) => a.includes("create")),
    removes: () => execs.filter((a) => a.includes("rm")),
    close,
  };
}
export async function until(condition: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("WAIT_TIMEOUT");
    await new Promise((r) => setTimeout(r, 5));
  }
}
export const stubGateway = () => ({
  handle: async () => ({}),
  close: async () => {},
});
export const IMAGE = "sha256:" + "c".repeat(64);
