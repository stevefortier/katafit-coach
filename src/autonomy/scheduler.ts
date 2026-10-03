import type { Admission } from "../runtime/admission.js";
import type { AutonomyCapability } from "../capability/autonomy.js";
import type { LogInput } from "../diagnostics/log.js";
import { AutonomyFailure, type AutonomyBackend } from "./backend.js";
import type { MandateView, WorkItem } from "./types.js";

export type SchedulerState =
  | "stopped"
  | "idle"
  | "disabled"
  | "claiming"
  | "running"
  | "backoff"
  | "paused"
  | "credential_rejected";
export type TickOutcome =
  | "idle"
  | "disabled"
  | "ran"
  | "contended"
  | "backoff"
  | "paused"
  | "interrupted"
  | "stopped"
  | "credential_rejected";
export interface Cycle {
  work: WorkItem;
  mandate: MandateView;
  backend: AutonomyBackend;
  signal: AbortSignal;
  /** Negotiated coach.capability.v1 admission; null on an older backend. */
  capability: AutonomyCapability | null;
}
export interface SchedulerOptions {
  backend: AutonomyBackend;
  admission: Admission;
  /** Executes one started work item; owns checkpoint and completion. */
  run: (cycle: Cycle) => Promise<unknown>;
  leaseSeconds?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
  /** Cancellable delay between ticks (injectable for tests). */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  onState?: (state: SchedulerState) => void;
  /** Local precondition for a claim (e.g. owned cleanup confirmed). */
  ready?: () => Promise<boolean>;
  onDiagnostic?: (event: LogInput) => void;
}

const CREDENTIAL_CODES = new Set([
  "AUTONOMY_AUTH_EXPIRED",
  "AUTONOMY_NOT_AUTHORIZED",
]);
const DISABLED_CODES = new Set([
  "AUTONOMY_DISABLED",
  "AUTONOMY_SCOPE_CHANGED",
  "AUTONOMY_MANDATE_CHANGED",
]);
const DEFAULT_TICK_MS = 60_000;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", done);
      resolve();
    }, ms);
    signal.addEventListener("abort", done, { once: true });
  });

/**
 * Drives the continuous Coach independently of any browser: each tick reads
 * the mandate and the due queue (never inferring when nothing is due), then
 * takes the shared admission slot, claims at most one item, starts it and
 * hands it to the runner. Ticks are single-flight. Stop and pause abort the
 * active cycle and never release or complete a lease locally: the backend
 * lease expires and the slot ledger makes any later claimant safe.
 */
export class AutonomyScheduler {
  private current: SchedulerState = "stopped";
  private inflight?: Promise<{ outcome: TickOutcome; delayMs: number }>;
  private cycle?: AbortController;
  private loop?: Promise<void>;
  private lifetime = new AbortController();
  private failures = 0;
  private paused = false;
  private rejected = false;
  private stopped = false;
  private interrupts = 0;

  constructor(private readonly options: SchedulerOptions) {}

  get state() {
    return this.current;
  }

  private set(state: SchedulerState) {
    if (this.current === state) return;
    this.current = state;
    this.options.onState?.(state);
  }

  private diagnostic(
    stage: Extract<LogInput["stage"], `autonomy-${string}`>,
    level: LogInput["level"],
    metadata: Record<string, number | undefined> = {},
  ) {
    this.options.onDiagnostic?.({ source: "worker", stage, level, metadata });
  }

  private backoff(): { outcome: TickOutcome; delayMs: number } {
    this.failures += 1;
    const min = this.options.minBackoffMs ?? 5_000;
    const max = this.options.maxBackoffMs ?? 900_000;
    const base = Math.min(max, min * 2 ** (this.failures - 1));
    const random = Math.min(
      1,
      Math.max(0, (this.options.random ?? Math.random)()),
    );
    this.set("backoff");
    return {
      outcome: "backoff",
      delayMs: Math.round(base / 2 + (random * base) / 2),
    };
  }

  /** One scheduling step; concurrent callers share the in-flight tick. */
  tick() {
    if (!this.inflight)
      this.inflight = this.step().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  private async step(): Promise<{ outcome: TickOutcome; delayMs: number }> {
    if (this.stopped) return { outcome: "stopped", delayMs: 0 };
    if (this.rejected) return { outcome: "credential_rejected", delayMs: 0 };
    if (this.paused) return { outcome: "paused", delayMs: 0 };
    const epoch = this.interrupts;
    const { backend, admission } = this.options;
    let mandate: MandateView;
    let tickMs = DEFAULT_TICK_MS;
    try {
      mandate = await backend.mandate();
      tickMs = mandate.cadence.client_tick_seconds * 1000;
      if (
        mandate.mode === "off" ||
        mandate.paused ||
        mandate.status !== "active"
      ) {
        this.failures = 0;
        this.set("disabled");
        return { outcome: "disabled", delayMs: tickMs };
      }
      const due = await backend.listWork({ status: "due", limit: 1 });
      if (!due.items.length) {
        this.failures = 0;
        this.set("idle");
        return { outcome: "idle", delayMs: tickMs };
      }
      if (this.options.ready && !(await this.options.ready()))
        return this.backoff();
    } catch (error) {
      return this.failed(error, tickMs);
    }
    // A pause or stop that landed during the reads admits no claim.
    if (this.stopped) return { outcome: "stopped", delayMs: 0 };
    if (this.paused) {
      this.set("paused");
      return { outcome: "paused", delayMs: 0 };
    }
    // An interrupt during the reads admits no claim on what they saw.
    if (this.interrupts !== epoch) {
      this.set("idle");
      return { outcome: "interrupted", delayMs: 0 };
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    this.cycle = controller;
    try {
      return await admission.run("autonomy", signal, async () => {
        signal.throwIfAborted();
        this.set("claiming");
        const claim = await backend.claimCycle({
          lease_seconds: this.options.leaseSeconds ?? 120,
        });
        if (!claim) {
          this.set("idle");
          return { outcome: "contended" as const, delayMs: tickMs };
        }
        signal.throwIfAborted();
        const claimed = claim.work;
        const work = await backend.start(claimed.id, claimed.lease_generation);
        this.set("running");
        this.diagnostic("autonomy-cycle", "info", {
          attempt: work.attempts,
        });
        await this.options.run({
          work,
          mandate,
          backend,
          signal,
          capability: claim.capability,
        });
        this.failures = 0;
        this.set("idle");
        return { outcome: "ran" as const, delayMs: 0 };
      });
    } catch (error) {
      if (signal.aborted) {
        const outcome = this.stopped
          ? "stopped"
          : this.paused
            ? "paused"
            : "interrupted";
        this.set(outcome === "interrupted" ? "idle" : outcome);
        return { outcome, delayMs: 0 };
      }
      return this.failed(error, tickMs);
    } finally {
      if (this.cycle === controller) this.cycle = undefined;
    }
  }

  private failed(error: unknown, tickMs: number) {
    const code = error instanceof AutonomyFailure ? error.code : undefined;
    if (code && CREDENTIAL_CODES.has(code)) {
      this.rejected = true;
      this.set("credential_rejected");
      this.diagnostic("autonomy-credential", "error", {
        status: (error as AutonomyFailure).status,
      });
      return { outcome: "credential_rejected" as const, delayMs: 0 };
    }
    if (code && DISABLED_CODES.has(code)) {
      this.set("disabled");
      return { outcome: "disabled" as const, delayMs: tickMs };
    }
    const result = this.backoff();
    this.diagnostic("autonomy-backoff", "warn", {
      status: error instanceof AutonomyFailure ? error.status : undefined,
      budgetMs: result.delayMs,
    });
    return result;
  }

  /** Run ticks on the mandate cadence until stop(); idempotent. */
  start() {
    if (this.loop || this.stopped) return;
    const wait = this.options.wait ?? sleep;
    const signal = this.lifetime.signal;
    this.set("idle");
    this.loop = (async () => {
      while (!signal.aborted) {
        const { outcome, delayMs } = await this.tick();
        if (outcome === "credential_rejected" || outcome === "stopped") break;
        if (outcome === "paused") {
          await wait(DEFAULT_TICK_MS, signal);
          continue;
        }
        await wait(delayMs, signal);
      }
    })();
  }

  /** Abort the active cycle (no local release) and admit nothing new. */
  async pause() {
    this.paused = true;
    this.cycle?.abort(new Error("AUTONOMY_PAUSED"));
    await this.inflight?.catch(() => {});
    this.set("paused");
  }

  /**
   * Abort the active cycle (no local release) and wait until it has drained,
   * without pausing the loop: the next tick re-reads the mandate.
   */
  async interrupt(reason = "AUTONOMY_INTERRUPTED") {
    this.interrupts++;
    this.cycle?.abort(new Error(reason));
    await this.inflight?.catch(() => {});
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    if (!this.stopped && !this.rejected) this.set("idle");
  }

  /** Stop the loop and abort the active cycle; the lease simply expires. */
  async stop() {
    this.stopped = true;
    this.lifetime.abort(new Error("AUTONOMY_STOPPED"));
    await this.inflight?.catch(() => {});
    await this.loop?.catch(() => {});
    this.set("stopped");
  }
}
