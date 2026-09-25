import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { Store } from "../config/store.js";
import { NativeRuntime } from "../sandbox/runtime.js";
import { nativeImage } from "../sandbox/artifact.js";
import { openNativeGateway, type NativeGateway } from "../sandbox/gateway.js";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
/** Installation-admin terminal only; not a managed multi-tenant service. */
export class NativeTerminal {
  private tickets = new Map<string, { expires: number; authority: string }>();
  private sockets = new Set<WebSocket>();
  private ws?: WebSocket;
  private runtime?: NativeRuntime;
  private gateway?: NativeGateway;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private cleanupFailed = false;
  private generation = 0;
  private controller?: AbortController;
  private output = "";
  private detach?: NodeJS.Timeout;
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16384,
    perMessageDeflate: false,
  });
  constructor(
    private store: Store,
    server: Server,
    origin: () => string,
    private allowed: () => boolean = () => true,
  ) {
    server.on("upgrade", (req, socket, head) => {
      if (
        req.url !== "/api/terminal/ws" ||
        req.headers.host !== new URL(origin()).host ||
        req.headers.origin !== origin() ||
        this.sockets.size >= 4
      ) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
    });
  }
  get active() {
    return !!(this.runtime || this.starting);
  }
  private authority() {
    return hash(
      JSON.stringify([this.store.publicConfig().revision, this.store.secrets]),
    );
  }
  ticket() {
    if (
      this.stopping ||
      this.cleanupFailed ||
      this.runtime?.cleanupPending ||
      !this.allowed()
    )
      throw new Error("NATIVE_UNAVAILABLE");
    for (const [key, value] of this.tickets)
      if (value.expires <= Date.now()) this.tickets.delete(key);
    if (this.tickets.size >= 8) throw new Error("NATIVE_TICKET_LIMIT");
    const ticket = randomBytes(32).toString("hex");
    this.tickets.set(hash(ticket), {
      expires: Date.now() + 10000,
      authority: this.authority(),
    });
    return { ticket, path: "/api/terminal/ws", expiresIn: 10 };
  }
  private send(ws: WebSocket, value: unknown) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 256 * 1024) {
      ws.close(1008, "Slow terminal");
      return;
    }
    ws.send(JSON.stringify(value));
  }
  private accept(ws: WebSocket) {
    this.sockets.add(ws);
    let admitted = false;
    let authority = "";
    const timer = setTimeout(() => ws.close(1008, "Ticket required"), 3000);
    ws.on("error", () => ws.terminate());
    ws.on("close", () => {
      clearTimeout(timer);
      this.sockets.delete(ws);
      if (this.ws === ws) {
        this.ws = undefined;
        this.detach = setTimeout(() => {
          void this.stop();
        }, 30000);
      }
    });
    ws.on("message", async (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (!admitted) {
          const key =
            typeof message.ticket === "string" ? hash(message.ticket) : "";
          const ticket = this.tickets.get(key);
          this.tickets.delete(key);
          if (
            this.cleanupFailed ||
            this.runtime?.cleanupPending ||
            this.stopping ||
            !this.allowed() ||
            !ticket ||
            ticket.expires <= Date.now() ||
            ticket.authority !== this.authority()
          )
            throw new Error("AUTH");
          admitted = true;
          authority = ticket.authority;
          clearTimeout(timer);
          clearTimeout(this.detach);
          this.ws?.close(1000, "Reattached elsewhere");
          this.ws = ws;
          this.send(ws, { type: "output", data: this.output });
          await this.start();
          if (this.ws === ws) this.send(ws, { type: "ready" });
          return;
        }
        if (this.ws !== ws || authority !== this.authority())
          throw new Error("AUTH");
        if (message.type === "input" && typeof message.data === "string")
          this.runtime?.input(message.data);
        else if (message.type === "resize")
          await this.runtime?.resize(message.cols, message.rows);
        else throw new Error("FRAME");
      } catch {
        this.send(ws, {
          type: "error",
          message:
            "Native Pi unavailable or session revoked. Stop before retrying; actions are never replayed.",
        });
        ws.close(1008, "Session rejected");
      }
    });
  }
  private start() {
    if (this.cleanupFailed || this.runtime?.cleanupPending)
      return Promise.reject(new Error("NATIVE_UNAVAILABLE"));
    if (this.starting) return this.starting;
    if (this.runtime) return Promise.resolve();
    const generation = this.generation;
    return (this.starting = (async () => {
      await this.stopping;
      if (generation !== this.generation) throw new Error("REVOKED");
      const controller = (this.controller = new AbortController());
      const gateway = await openNativeGateway(this.store, controller.signal);
      let image: string;
      try {
        image = await nativeImage(this.store.dir);
      } catch (error) {
        await gateway.close();
        throw error;
      }
      if (generation !== this.generation) {
        await gateway.close();
        throw new Error("REVOKED");
      }
      this.gateway = gateway;
      const runtime = (this.runtime = new NativeRuntime(image));
      runtime.onExit = () => {
        if (this.runtime === runtime) void this.stop().catch(() => {});
      };
      runtime.onOutput = (chunk) => {
        this.output = (this.output + chunk).slice(-65536);
        if (this.ws) this.send(this.ws, { type: "output", data: chunk });
      };
      try {
        await runtime.start(gateway);
        await runtime.attach();
      } catch {
        try {
          await runtime.stop();
          this.runtime = undefined;
        } catch {
          this.cleanupFailed = true;
        } finally {
          await gateway.close();
          this.gateway = undefined;
        }
        throw new Error("NATIVE_START_FAILED");
      }
    })().finally(() => {
      this.starting = undefined;
    }));
  }
  stop() {
    this.generation++;
    this.tickets.clear();
    clearTimeout(this.detach);
    this.controller?.abort();
    if (this.stopping) return this.stopping;
    for (const ws of this.sockets) ws.close(1008, "Session stopped");
    this.ws = undefined;
    this.output = "";
    const starting = this.starting;
    return (this.stopping = (async () => {
      await starting?.catch(() => {});
      const runtime = this.runtime,
        gateway = this.gateway;
      try {
        await runtime?.stop();
        this.runtime = undefined;
        this.cleanupFailed = false;
      } catch (error) {
        this.cleanupFailed = true;
        throw error;
      } finally {
        await gateway?.close();
        this.gateway = undefined;
      }
    })().finally(() => {
      this.stopping = undefined;
    }));
  }
  async close() {
    await this.stop();
    for (const ws of this.sockets) ws.terminate();
    this.wss.close();
  }
}
