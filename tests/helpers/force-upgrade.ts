import { WebSocket } from "ws";
import { Worker } from "../../src/worker/runner.js";
import { admin } from "../../src/server/admin.js";
import { Updates } from "../../src/update/updates.js";
import { NativeTerminal } from "../../src/server/terminal.js";
import { openNativeGateway } from "../../src/sandbox/gateway.js";
import { fixture } from "./native.js";

// Automatic owned Pi closure plus Force on remaining worker waits. Real admin
// server, ticketed WebSocket, host gateway and synthetic provider/backend;
// only the Docker runtime is an in-memory stand-in whose teardown we control.
export const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
export const until = async <T>(read: () => T | Promise<T>, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 20));
  }
};
export const settled = (promise: Promise<unknown>, ms: number) =>
  Promise.race([
    promise.then(
      () => "resolved",
      () => "rejected",
    ),
    new Promise((r) => setTimeout(() => r("pending"), ms)),
  ]);

export type Teardown = "cooperative" | "never" | "reject";
export async function forceHarness(
  opts: {
    teardown?: Teardown;
    heldStart?: boolean;
    heldWorker?: boolean;
    heldPublication?: boolean;
    heldWorkerStop?: boolean;
    forceStopMs?: number;
  } = {},
) {
  const proto = NativeTerminal.prototype as any;
  const original = {
    createRuntime: proto.createRuntime,
    resolveImage: proto.resolveImage,
    openGateway: proto.openGateway,
  };
  const workerGate = deferred();
  const originalDrain = Worker.prototype.drainForUpdate;
  const originalStop = Worker.prototype.stop;
  const originalReserve = Worker.prototype.reserveForManualUpdate;
  const originalReconcile = Worker.prototype.reconcilePublications;
  let capturedWorker: any;
  Worker.prototype.reserveForManualUpdate = function () {
    capturedWorker = this;
    const reserved = originalReserve.call(this);
    if (opts.heldPublication) {
      (this as any).pendingTask = {
        task: {
          id: "synthetic-unresolved-task",
          lease_generation: "original-generation",
        },
        digest: "d".repeat(64),
      };
    }
    return reserved;
  };
  if (opts.heldPublication)
    Worker.prototype.reconcilePublications = () => workerGate.promise;
  if (opts.heldWorker)
    Worker.prototype.drainForUpdate = () => workerGate.promise;
  Worker.prototype.stop = async function () {
    if (opts.heldWorkerStop) await workerGate.promise;
    else if (!opts.heldPublication) workerGate.resolve();
    await originalStop.call(this);
  };
  const hang = deferred();
  const startGate = deferred();
  const startEntered = deferred();
  let providerCalls = 0;
  const f = await fixture(
    async (name, result, body) => {
      if (name === "provider") {
        providerCalls++;
        // A model turn that never finishes on its own.
        await hang.promise;
        return "data: [DONE]\n\n";
      }
      if (name === "tools/list")
        return {
          tools: [
            "coach_report_worker_presence",
            "coach_list_requests",
            "coach_claim_request",
          ].map((name) => ({ name })),
        };
      if (name === "coach_report_worker_presence")
        return {
          state: body.params.arguments.state,
          generation: "a".repeat(32),
        };
      if (name === "coach_list_requests") return { requests: [] };
      if (name === "coach_claim_request") return { request: null };
      return result;
    },
    (url) =>
      url === "/api/agents/coach.md"
        ? {
            type: "text/markdown",
            body: "# Kata.fit external Coach agent v1\n",
          }
        : { status: 404 },
  );
  const runtimes: any[] = [];
  const releaseStop = deferred();
  let teardown: Teardown = opts.teardown ?? "cooperative";
  proto.resolveImage = async () => "sha256:" + "c".repeat(64);
  proto.openGateway = async (...args: Parameters<typeof openNativeGateway>) => {
    const gateway = await openNativeGateway(...args);
    if (opts.heldStart) {
      startEntered.resolve();
      await Promise.race([
        startGate.promise,
        new Promise<void>((r) =>
          args[1]?.addEventListener("abort", () => r(), { once: true }),
        ),
      ]);
    }
    return gateway;
  };
  proto.createRuntime = function () {
    const runtime: any = {
      cleanupPending: false,
      stops: 0,
      onOutput: () => {},
      onExit: () => {},
      async start(gateway: any) {
        runtime.gateway = gateway;
      },
      async attach() {},
      input() {},
      async resize() {},
      stop() {
        runtime.stops++;
        if (teardown === "never") return releaseStop.promise;
        if (teardown === "reject")
          return Promise.reject(new Error("NATIVE_CLEANUP_PENDING"));
        return Promise.resolve();
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
  let preparations = 0,
    cancellations = 0;
  const applications: string[] = [];
  const updates = new Updates(
    "a".repeat(40),
    async (sha) => {
      applications.push(sha);
    },
    // Synthetic source check only; never contacts GitHub.
    async () =>
      new Response(JSON.stringify({ object: { sha: "b".repeat(40) } })),
    undefined,
    async () => {
      preparations++;
    },
    async () => {
      cancellations++;
    },
  );
  updates.manualRestartSupported = true;
  updates.latest = "b".repeat(40);
  updates.checkedAt = Date.now();
  const applyCalls: any[][] = [];
  const apply = updates.apply.bind(updates);
  updates.apply = (...args: Parameters<Updates["apply"]>) => {
    applyCalls.push(args);
    return apply(...args);
  };
  const app = await admin(f.store, 0, undefined, undefined, updates, {
    ...(opts.forceStopMs ? { nativeForceStopMs: opts.forceStopMs } : {}),
  });
  const headers = {
    Authorization: "Bearer " + f.store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  const post = (path: string, body: unknown = {}, h: any = headers) =>
    fetch(app.origin + path, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
    });
  const queue = async () =>
    (await (await fetch(app.origin + "/api/update", { headers })).json())
      .manualQueue;
  const sockets: WebSocket[] = [];
  const connect = async (wait = true) => {
    const ticket: any = await (await post("/api/terminal/ticket")).json();
    const ws = new WebSocket(app.origin.replace("http:", "ws:") + ticket.path, {
      origin: app.origin,
    });
    sockets.push(ws);
    const frames: any[] = [];
    const closed = new Promise<number>((r) => ws.once("close", r));
    ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
    await new Promise<void>((r, j) => {
      ws.once("open", r);
      ws.once("error", j);
    });
    ws.send(JSON.stringify({ ticket: ticket.ticket }));
    if (wait) await until(() => frames.some((m) => m.type === "ready"));
    return { ws, frames, closed };
  };
  return {
    get worker() {
      return capturedWorker;
    },
    f,
    app,
    updates,
    runtimes,
    headers,
    post,
    queue,
    connect,
    applications,
    applyCalls,
    startEntered,
    get preparations() {
      return preparations;
    },
    get cancellations() {
      return cancellations;
    },
    get providerCalls() {
      return providerCalls;
    },
    set teardown(value: Teardown) {
      teardown = value;
    },
    releaseWorker: () => workerGate.resolve(),
    releaseStop: () => releaseStop.resolve(),
    neverEndingTurn: () =>
      runtimes.at(-1).gateway.handle({
        kind: "provider",
        body: {
          model: "approved-custom-model",
          stream: true,
          messages: [{ role: "user", content: "Plan my whole season." }],
        },
      }) as Promise<unknown>,
    async close() {
      workerGate.resolve();
      teardown = "cooperative";
      hang.resolve();
      startGate.resolve();
      releaseStop.resolve();
      for (const ws of sockets) ws.terminate();
      await app.close();
      Object.assign(proto, original);
      Worker.prototype.drainForUpdate = originalDrain;
      Worker.prototype.stop = originalStop;
      Worker.prototype.reserveForManualUpdate = originalReserve;
      Worker.prototype.reconcilePublications = originalReconcile;
      await f.close();
    },
  };
}
