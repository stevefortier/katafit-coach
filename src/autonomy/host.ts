import type { Store } from "../config/store.js";
import type { LogInput } from "../diagnostics/log.js";
import type { Admission } from "../runtime/admission.js";
import { nativeImage } from "../sandbox/artifact.js";
import { AutonomyBackend, AutonomyFailure } from "./backend.js";
import { HeadlessCycleRuntime, type HeadlessRun } from "./headless.js";
import { autonomyRunner } from "./runner.js";
import {
  AutonomyScheduler,
  type Cycle,
  type SchedulerOptions,
  type SchedulerState,
} from "./scheduler.js";

type Runtime = {
  run(run: HeadlessRun): Promise<{ text: string; container?: string }>;
};
export interface AutonomyRuntimes {
  planner: Runtime;
  /** [AC1] Always a different runtime: one fresh container per composition. */
  composer: Runtime;
}
type Engine = ConstructorParameters<typeof HeadlessCycleRuntime>[0]["engine"];

/**
 * Production wiring: the planner and the composer each get their own bounded
 * headless runtime on the installation's verified native image. Leftover
 * autonomy containers from a crashed process are swept first.
 */
export async function productionRuntimes(
  home: string,
  o: { image?: (home: string) => Promise<string>; engine?: Engine } = {},
): Promise<AutonomyRuntimes> {
  const image = await (o.image ?? nativeImage)(home);
  const planner = new HeadlessCycleRuntime({ image, engine: o.engine });
  const composer = new HeadlessCycleRuntime({ image, engine: o.engine });
  await planner.sweep();
  return { planner, composer };
}

// Lease steps have no external effect: a lost answer just lets the lease expire.
const LEASE_STEP = /\/work\/(?:claim|[0-9a-f]{24}\/(?:start|checkpoint))$/;

/** Tracks effectful writes so an abandoned one is never mistaken for none. */
class TrackedBackend extends AutonomyBackend {
  inflight = 0;
  onUnknown = () => {};
  override async request(method: string, path: string, body?: unknown) {
    if (method === "GET" || LEASE_STEP.test(path))
      return super.request(method, path, body);
    this.inflight++;
    try {
      return await super.request(method, path, body);
    } catch (error) {
      if (
        error instanceof AutonomyFailure &&
        error.code === "AUTONOMY_OUTCOME_UNKNOWN"
      )
        this.onUnknown();
      throw error;
    } finally {
      this.inflight--;
    }
  }
}

export interface AutonomyHostOptions {
  store: Store;
  admission: Admission;
  onDiagnostic?: (event: LogInput) => void;
  runtimes?: (home: string) => Promise<AutonomyRuntimes>;
  scheduler?: Pick<
    SchedulerOptions,
    "wait" | "random" | "minBackoffMs" | "maxBackoffMs" | "leaseSeconds"
  >;
}
export type AutonomyHostState = SchedulerState | "starting";

/**
 * The continuous Coach inside the admin process, independent of the request
 * Worker, the native terminal and any browser. It shares only the inference
 * admission slot. Stopping aborts an active cycle without a local release;
 * an effectful write abandoned mid-flight leaves its work "unknown", which
 * blocks process replacement until a later cycle on that work settles it.
 */
export class AutonomyHost {
  private scheduler?: AutonomyScheduler;
  private lifetime?: AbortController;
  private starting?: Promise<void>;
  private backend?: TrackedBackend;
  private active?: string;
  private readonly unknown = new Set<string>();
  private last: {
    outcome?: string;
    workId?: string;
    at?: string;
    error?: string;
  } = {};

  constructor(private readonly options: AutonomyHostOptions) {}

  get state(): AutonomyHostState {
    if (this.starting) return "starting";
    return this.scheduler?.state ?? "stopped";
  }
  get running() {
    return !!this.scheduler || !!this.starting;
  }
  /** A cycle (or its claim) is in flight: never interrupted for an update. */
  get busy() {
    return (
      !!this.starting ||
      ["claiming", "running"].includes(this.state) ||
      (this.backend?.inflight ?? 0) > 0
    );
  }
  get safeToReplace() {
    return !this.busy && this.unknown.size === 0;
  }

  snapshot() {
    return {
      state: this.state,
      busy: this.busy,
      unknownOutcome: this.unknown.size > 0,
      safeToReplace: this.safeToReplace,
      lastOutcome: this.last.outcome ?? null,
      lastWorkId: this.last.workId ?? null,
      lastCycleAt: this.last.at ?? null,
      lastError: this.last.error ?? null,
    };
  }

  private diagnostic(
    stage: Extract<LogInput["stage"], `autonomy-${string}`>,
    level: LogInput["level"] = "info",
    metadata: Record<string, number> = {},
  ) {
    try {
      this.options.onDiagnostic?.({ source: "worker", stage, level, metadata });
    } catch {}
  }

  async start() {
    if (this.scheduler) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const { store } = this.options;
      const token = store.secrets.token;
      if (!token || !store.secrets.apiKey)
        throw new Error("CONNECTION_AND_PROVIDER_REQUIRED");
      const runtimes = await (this.options.runtimes ?? productionRuntimes)(
        store.dir,
      );
      if (runtimes.planner === runtimes.composer)
        throw new Error("COMPOSER_RUNTIME_SHARED");
      const lifetime = new AbortController();
      const backend = new TrackedBackend(
        store.publicConfig().origin,
        token,
        lifetime.signal,
        Object.values(store.secrets),
      );
      backend.onUnknown = () => {
        if (!this.active) return;
        this.unknown.add(this.active);
        this.diagnostic("autonomy-outcome-unknown", "warn");
      };
      const runner = autonomyRunner({
        store,
        runtime: runtimes.planner,
        compose: { runtime: runtimes.composer },
        leaseSeconds: this.options.scheduler?.leaseSeconds,
      });
      const scheduler = new AutonomyScheduler({
        ...this.options.scheduler,
        backend,
        admission: this.options.admission,
        onDiagnostic: this.options.onDiagnostic,
        run: (cycle) => this.run(runner, cycle),
      });
      this.lifetime = lifetime;
      this.backend = backend;
      this.scheduler = scheduler;
      scheduler.start();
      this.last.error = undefined;
      this.diagnostic("autonomy-started");
    })();
    try {
      await this.starting;
    } catch (error) {
      this.last.error =
        error instanceof Error && /^[A-Z_]+$/.test(error.message)
          ? error.message
          : "AUTONOMY_START_FAILED";
      throw error;
    } finally {
      this.starting = undefined;
    }
  }

  private async run(runner: ReturnType<typeof autonomyRunner>, cycle: Cycle) {
    this.active = cycle.work.id;
    try {
      const result = await runner(cycle);
      // Completed: the backend now holds every receipt durably.
      this.unknown.delete(cycle.work.id);
      this.last = {
        outcome: result.outcome.result,
        workId: cycle.work.id,
        at: new Date().toISOString(),
      };
      return result;
    } finally {
      this.active = undefined;
    }
  }

  async stop() {
    await this.starting?.catch(() => {});
    const scheduler = this.scheduler;
    if (!scheduler) return;
    // An aborted effectful write fails AUTONOMY_OUTCOME_UNKNOWN, which
    // fences replacement through onUnknown until the work completes.
    this.lifetime?.abort(new Error("AUTONOMY_STOPPED"));
    await scheduler.stop();
    this.scheduler = undefined;
    this.backend = undefined;
    this.lifetime = undefined;
    this.diagnostic("autonomy-stopped", "info", {
      calls: this.unknown.size,
    });
  }
}
