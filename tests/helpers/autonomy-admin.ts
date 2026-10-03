import { createServer, type Server } from "node:http";
import { admin } from "../../src/server/admin.js";
import { Updates } from "../../src/update/updates.js";
import { HeadlessFailure } from "../../src/autonomy/headless.js";
import type { AutonomyRuntimes } from "../../src/autonomy/host.js";
import {
  leaked,
  ScriptedRuntime,
  setup,
  type Script,
} from "./autonomy-cycle.js";

/** Cancellable, fast scheduler delay so the cadence loop runs in tests. */
export const fastWait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, Math.min(ms, 20));
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export async function until<T>(
  probe: () => Promise<T> | T,
  message: string,
  timeoutMs = 15000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out: " + message);
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** A planner that blocks until its cycle is aborted (headless semantics). */
export const blockingRuntime = (entered?: () => void) => ({
  runs: 0,
  async run(run: { signal?: AbortSignal }) {
    this.runs++;
    entered?.();
    return new Promise<never>((_, reject) => {
      const abort = () => reject(new HeadlessFailure("HEADLESS_ABORTED"));
      if (run.signal?.aborted) return abort();
      run.signal?.addEventListener("abort", abort, { once: true });
    });
  },
});

/**
 * Proxy in front of the fake backend that can hold every action write until
 * released; the held write still commits upstream once released.
 */
export async function holdingProxy(target: string) {
  const state = {
    hold: false,
    /** Which requests `hold` captures (default: action PUTs). */
    holds: (method: string, url: string) =>
      method === "PUT" && /\/actions\//.test(url),
    held: [] as (() => void)[],
    entered: [] as string[],
    /** Answer without reaching the backend (nothing commits). */
    intercept: undefined as
      | undefined
      | ((method: string, url: string) => { status: number; body: any } | void),
    /** Rewrite a JSON answer after the backend processed the request. */
    rewrite: undefined as
      | undefined
      | ((method: string, url: string, body: any) => any),
  };
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const intercepted = () => {
      const answer = state.intercept?.(req.method!, req.url!);
      if (!answer) return false;
      if (!res.destroyed) {
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.body));
      }
      return true;
    };
    if (intercepted()) return;
    if (state.hold && state.holds(req.method!, req.url!)) {
      state.entered.push(req.url!);
      await new Promise<void>((resolve) => state.held.push(resolve));
      if (intercepted()) return;
    }
    try {
      const upstream = await fetch(target + req.url, {
        method: req.method,
        headers: Object.fromEntries(
          Object.entries(req.headers).filter(
            ([k]) => !["host", "content-length", "connection"].includes(k),
          ) as [string, string][],
        ),
        body: raw && req.method !== "GET" ? raw : undefined,
      });
      let body = Buffer.from(await upstream.arrayBuffer());
      if (
        state.rewrite &&
        upstream.headers.get("content-type")?.startsWith("application/json")
      ) {
        const value = state.rewrite(
          req.method!,
          req.url!,
          JSON.parse(body.toString("utf8")),
        );
        if (value !== undefined) body = Buffer.from(JSON.stringify(value));
      }
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "text/plain",
        // The backend's own clock: lease fencing never uses the client's.
        ...(upstream.headers.get("date")
          ? { date: upstream.headers.get("date")! }
          : {}),
      });
      res.end(body);
    } catch {
      res.destroy();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    origin: `http://127.0.0.1:${(server.address() as any).port}`,
    state,
    release() {
      state.hold = false;
      for (const go of state.held.splice(0)) go();
    },
    async close() {
      this.release();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/**
 * The real admin over a synthetic backend. Each autonomy start takes the next
 * runtime pair (planner + its own composer), recorded for assertions.
 */
export async function autonomyAdmin(
  o: Parameters<typeof setup>[0] & {
    planners?: (ScriptedRuntime | ReturnType<typeof blockingRuntime>)[];
    composers?: (ScriptedRuntime | ReturnType<typeof blockingRuntime>)[];
    /** In-cycle mandate observation cadence (host option). */
    mandateCheckMs?: number;
    keepWork?: boolean;
    origin?: string;
    supported?: boolean;
  } = {},
) {
  const env = await setup(o);
  if (!o.keepWork) env.fake.state.work.delete(env.workId);
  if (o.origin)
    await env.store.save({ ...env.store.publicConfig(), origin: o.origin });
  const planners = o.planners ?? [];
  const composers = o.composers ?? [];
  const pairs: AutonomyRuntimes[] = [];
  const options = {
    autonomy: {
      runtimes: async () => {
        const planner =
          planners.shift() ?? new ScriptedRuntime([], "unscripted-");
        const pair = {
          planner,
          composer: composers.shift() ?? new ScriptedRuntime([], "composer-"),
        };
        pairs.push(pair);
        return pair;
      },
      scheduler: { wait: fastWait, random: () => 0.5 },
      ...(o.mandateCheckMs ? { mandateCheckMs: o.mandateCheckMs } : {}),
    },
  };
  const open = () =>
    admin(
      env.store,
      0,
      undefined,
      undefined,
      new Updates(null, o.supported === false ? null : async () => {}),
      options,
    );
  let app = await open();
  const headers = () => ({
    Authorization: "Bearer " + env.store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(app.origin + path, {
      method,
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const status = async () =>
    (await call("GET", "/api/autonomy/status")).body as any;
  const close = async () => {
    leaked.delete(close);
    await app.close();
    await env.close();
  };
  leaked.add(close);
  return {
    ...env,
    get app() {
      return app;
    },
    pairs,
    options,
    call,
    status,
    headers,
    /** Close and reopen admin on the same installation (process restart). */
    async restart() {
      await app.close();
      app = await open();
    },
    close,
  };
}
export type { Script };
