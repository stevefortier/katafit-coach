import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { Store } from "../config/store.js";
import { NativeRuntime } from "../sandbox/runtime.js";
import { nativeImage } from "../sandbox/artifact.js";
import { openNativeGateway, type NativeGateway } from "../sandbox/gateway.js";
import { AttachmentFailure } from "../sandbox/attachments.js";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
/** Installation-admin terminal only; not a managed multi-tenant service. */
// Relative, so the browser needs no trusted wall clock; null for legacy.
const expiresIn = (at?: string | null) =>
  at ? Math.max(0, Date.parse(at) - Date.now()) : null;
export class NativeTerminal {
  /** Liveness frames let an offline browser notice a silently dead link. */
  static heartbeatMs = 10000;
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

  // Random per runtime; scopes the private attachment endpoint to it.
  private session?: string;
  private sessionAuthority?: string;

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
    private onDiagnostic?: import("../katafit/client.js").BackendLogger,
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
  /**
   * No native start, runtime, teardown (including gateway disposal, which
   * reconciles the action journal) or unconfirmed cleanup exists. Automatic
   * update quiescence requires this before protected journals are snapshotted.
   */
  get idle() {
    return (
      !this.runtime &&
      !this.starting &&
      !this.stopping &&
      !this.gateway &&
      !this.cleanupFailed
    );
  }
  private authority() {
    return hash(
      JSON.stringify([
        this.store.publicConfig().revision,
        this.store.skills.runtime().revision,
        this.store.secrets,
      ]),
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

          if (this.ws) {
            // The replaced tab can no longer be reached by a later Stop.
            this.send(this.ws, { type: "attachments-cleared" });
            this.ws.close(1000, "Reattached elsewhere");
          }
          this.ws = ws;
          const beat = setInterval(() => {
            if (this.ws === ws) this.send(ws, { type: "heartbeat" });
          }, NativeTerminal.heartbeatMs);
          beat.unref();
          ws.once("close", () => clearInterval(beat));
          const replayOutput = this.output;
          await this.start();
          if (this.ws === ws && this.session) {
            this.send(ws, { type: "ready" });

            void this.replay(ws, this.session, replayOutput);
          }
          return;
        }
        if (this.ws !== ws || authority !== this.authority())
          throw new Error("AUTH");
        if (message.type === "input" && typeof message.data === "string") {
          const runtime = this.runtime;
          runtime?.input(message.data);
          // Only authenticated browser input actually written to this PTY may
          // arm the gateway's single human-turn latch; never runtime output,
          // relay/provider frames, resize or reconnect replay.
          if (runtime) this.gateway?.noteHumanInput?.(message.data);
        } else if (message.type === "resize")
          await this.runtime?.resize(message.cols, message.rows);
        else throw new Error("FRAME");
      } catch (error) {
        this.send(ws, {
          type: "error",
          message:
            "Native Pi unavailable or session revoked. Reconnect to start a fresh runtime; actions are never replayed.",
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
      const session = randomBytes(16).toString("hex");
      const authority = this.authority();
      let owned: NativeRuntime | undefined;
      const gateway = await this.openGateway(this.store, controller.signal, {
        onDiagnostic: this.onDiagnostic,
        attachments: {
          // Only this generation's own container; never a sandbox-named path.
          read: (parts, limit, signal) => {
            if (
              generation !== this.generation ||
              !owned ||
              this.runtime !== owned
            )
              throw new AttachmentFailure("ATTACHMENT_UNAVAILABLE");
            return owned.readWorkspaceFile(parts, limit, signal);
          },
          publish: (item) => {
            if (generation !== this.generation || this.session !== session)
              return false;
            const ws = this.ws;
            if (!ws || ws.readyState !== WebSocket.OPEN) return false;
            this.send(ws, {
              type: "attachment",
              session,
              item,
              context_expires_in_ms: expiresIn(
                this.gateway?.continuity?.()?.context_expires_at,
              ),
            });
            return ws.readyState === WebSocket.OPEN;
          },
          connected: () =>
            generation === this.generation &&
            this.ws?.readyState === WebSocket.OPEN,
        },
        // Retained context was denied, expired or became unknown. The gateway
        // has closed its backend session; destroy this whole runtime (process,
        // transcript, filesystem, retained output). Never reopen it: a later
        // Start creates a new, empty runtime and backend session.
        onTerminate: () => {
          if (generation !== this.generation) return;
          for (const ws of this.sockets)
            this.send(ws, {
              type: "error",
              message:
                "Native Pi retained context was revoked or expired, so this runtime was destroyed. Reconnect for a fresh session; actions are never replayed.",
            });
          void this.stop().catch(() => {});
        },
      });
      let image: string;
      try {
        image = await this.resolveImage();
      } catch (error) {
        await gateway.close();
        throw error;
      }
      if (generation !== this.generation) {
        await gateway.close();
        throw new Error("REVOKED");
      }
      this.gateway = gateway;
      this.session = session;
      this.sessionAuthority = authority;

      const runtime = (this.runtime = owned = this.createRuntime(image));
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
  /**
   * One metadata snapshot per admission, only after a fresh backend
   * authorization. Recoverable refusals are reported content-free and retried
   * while this exact socket and session remain current.
   */
  private async replay(ws: WebSocket, session: string, output = "") {
    let delay = 2000;
    let reported = "";
    while (this.ws === ws && this.session === session) {
      const gateway = this.gateway;
      if (!gateway?.snapshot) return;
      if (this.sessionAuthority !== this.authority()) {
        void this.stop().catch(() => {});
        return;
      }
      try {
        const snapshot = await gateway.snapshot(Boolean(output));
        if (this.ws !== ws || this.session !== session) return;
        if (output) this.send(ws, { type: "output", data: output });
        this.send(ws, {
          type: "attachments",
          session,
          items: snapshot.items,
          context_expires_in_ms: expiresIn(snapshot.context_expires_at),
        });
        return;
      } catch (error) {
        const reason = (
          {
            ATTACHMENT_AUTHORIZATION_BUSY: "busy",
            ATTACHMENT_AUTHORIZATION_UNAVAILABLE: "unavailable",
            ATTACHMENT_TURN_REQUIRED: "turn_required",
          } as Record<string, string>
        )[(error as Error)?.message];
        if (this.ws !== ws || this.session !== session) return;
        if (!reason) {
          // Authority loss: the gateway terminated (owner stops) or config
          // changed; nothing is replayed.
          if (this.sessionAuthority !== this.authority())
            void this.stop().catch(() => {});
          return;
        }
        if (reason !== reported)
          this.send(ws, {
            type: "attachments-pending",
            session,
            reason,
            context_expires_in_ms: expiresIn(
              gateway.continuity?.()?.context_expires_at,
            ),
          });
        reported = reason;
        await new Promise((r) =>
          setTimeout(r, reason === "busy" ? 1000 : delay).unref(),
        );
        if (reason !== "busy") delay = Math.min(delay * 2, 10000);
      }
    }
  }
  /** Test seam: the Docker-backed runtime for one generation. */
  protected openGateway(...args: Parameters<typeof openNativeGateway>) {
    return openNativeGateway(...args);
  }
  protected createRuntime(image: string) {
    return new NativeRuntime(image);
  }
  protected resolveImage() {
    return nativeImage(this.store.dir);
  }
  /**
   * Fenced attachment bytes for the exact current native session. Unknown,
   * foreign or old sessions are indistinguishable (not found).
   */
  async attachment(session: string, id: string) {
    const gateway = this.gateway;
    if (
      typeof session !== "string" ||
      !this.session ||
      session !== this.session ||
      !this.runtime ||
      this.runtime.cleanupPending ||
      !gateway?.readAttachment ||
      this.stopping ||
      this.starting ||
      this.cleanupFailed
    )
      throw new Error("ATTACHMENT_NOT_FOUND");
    if (this.sessionAuthority !== this.authority()) {
      void this.stop().catch(() => {});
      throw new Error("ATTACHMENT_REVOKED");
    }
    if (!this.allowed()) throw new Error("ATTACHMENT_UNAVAILABLE");
    const entry = await gateway.readAttachment(id);
    if (
      this.session !== session ||
      this.gateway !== gateway ||
      this.sessionAuthority !== this.authority()
    )
      throw new Error("ATTACHMENT_REVOKED");
    return entry;
  }
  stop() {
    this.generation++;
    this.tickets.clear();

    this.controller?.abort();
    // Erase panel access before teardown completes; old URLs are now unknown.
    this.session = undefined;
    this.sessionAuthority = undefined;
    if (this.stopping) return this.stopping;
    for (const ws of this.sockets) {
      this.send(ws, { type: "attachments-cleared" });
      ws.close(1008, "Session stopped");
    }
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
