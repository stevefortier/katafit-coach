import { Actions } from "../chat/actions.js";
import type { Store } from "../config/store.js";
import type { LogInput } from "../diagnostics/log.js";
import type { Admission } from "../runtime/admission.js";
import { nativeImage } from "../sandbox/artifact.js";
import type { NativeProbeEngine } from "../sandbox/runtime.js";
import { CleanupRegistry } from "./cleanup.js";
import { AutonomyBackend, AutonomyFailure, type Effect } from "./backend.js";
import { HeadlessCycleRuntime, type HeadlessRun } from "./headless.js";
import { ledgerDigest, WriteLedger, type SyncDirectory } from "./ledger.js";
import { autonomyOwner } from "./owner.js";
import { RESOLVED, settle, type Attribution, type Proof } from "./reconcile.js";
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

/** Installation identity every production headless container is owned by. */
export interface RuntimeContext {
  owner: string;
  cleanup: CleanupRegistry;
  /** Existing installation logger, also used by the isolated request Worker. */
  onDiagnostic?: (event: LogInput) => void;
}
/**
 * Production wiring: the planner and the composer each get their own bounded
 * headless runtime on the installation's verified native image, sharing the
 * installation-owned cleanup registry. This installation's leftover
 * containers from a crashed process are swept first (never another owner's).
 */
export async function productionRuntimes(
  home: string,
  o: Partial<RuntimeContext> & {
    image?: (home: string) => Promise<string>;
    engine?: Engine;
  } = {},
): Promise<AutonomyRuntimes> {
  const image = await (o.image ?? nativeImage)(home);
  if (!o.owner || !o.cleanup || o.cleanup.owner !== o.owner)
    throw new Error("HEADLESS_OWNER_REQUIRED");
  const planner = new HeadlessCycleRuntime({
    image,
    engine: o.engine,
    cleanup: o.cleanup,
  });
  const composer = new HeadlessCycleRuntime({
    image,
    engine: o.engine,
    cleanup: o.cleanup,
  });
  await planner.sweep();
  return { planner, composer };
}

interface Binding {
  chief_id: string;
  dojo_id: string;
  mandate_id: string | null;
}

/** A definite rejection: the backend answered and committed nothing. */
const definite = (error: unknown) =>
  error instanceof AutonomyFailure &&
  error.code !== "AUTONOMY_OUTCOME_UNKNOWN" &&
  (error.status === undefined || (error.status >= 400 && error.status < 500));

/**
 * C5 F1/F2: every effectful typed write (request AND response validation) is
 * a durable ledger entry, fsynced before dispatch and bound to the exact
 * origin, account, installation and lease. Only a validated answer or a
 * definite first rejection removes it here; anything else stays for exact
 * read-only proof (`prove`). Reads, claims and checkpoints have no effect.
 */
class TrackedBackend extends AutonomyBackend {
  inflight = 0;
  readonly dispatched = new Set<string>();
  binding?: Binding;
  cycle?: AbortSignal;
  admitted?: { work_id: string; lease_generation: number; terminal: boolean };
  // Serialize only durable admission, not network requests. Already dispatched
  // operations drain normally; aborting them would manufacture more unknowns.
  private admission: Promise<unknown> = Promise.resolve();
  onUnknown = () => {};
  constructor(
    origin: string,
    token: string,
    signal: AbortSignal,
    secrets: string[],
    private readonly ledger: WriteLedger,
    private readonly installation: string,
    private readonly sharedHeld: () => boolean,
  ) {
    super(origin, token, signal, secrets);
  }
  override get mutationHeld(): boolean {
    return this.sharedHeld() || this.finiteMutationHeld;
  }
  override get finiteMutationHeld(): boolean {
    return (
      !this.ledger.healthy ||
      this.ledger.unresolved.some(
        (record) =>
          record.state === "unknown" || !this.dispatched.has(record.id),
      )
    );
  }
  protected override get scope() {
    return this.cycle
      ? AbortSignal.any([this.signal, this.cycle])
      : this.signal;
  }
  protected override async effect<T>(
    e: Effect,
    run: () => Promise<T>,
  ): Promise<T> {
    const binding = this.binding;
    if (!binding) throw new AutonomyFailure("AUTONOMY_UNAVAILABLE");
    const admit = async () => {
      const protectedWrites = (except?: string) =>
        this.ledger.unresolved.filter(
          (record) =>
            record.id !== except &&
            (record.state === "unknown" || !this.dispatched.has(record.id)),
        );
      const permits = (records: ReturnType<typeof protectedWrites>) => {
        if (
          !this.ledger.healthy ||
          (e.op === "complete" && this.admitted?.terminal)
        )
          return false;
        if (!records.length && !this.sharedHeld()) return true;
        const admitted = this.admitted;
        const outcome = (
          e.body as {
            outcome?: {
              result?: string;
              blocked_reason?: string;
              decisions?: unknown[];
            };
          }
        ).outcome;
        return (
          !!admitted &&
          !admitted.terminal &&
          e.op === "complete" &&
          e.work_id === admitted.work_id &&
          e.lease_generation === admitted.lease_generation &&
          outcome?.result === "blocked" &&
          outcome.blocked_reason === "uncertain_write" &&
          outcome.decisions?.length === 0 &&
          records.every(
            (record) =>
              record.op !== "complete" &&
              record.work_id === admitted.work_id &&
              record.lease_generation === admitted.lease_generation,
          )
        );
      };
      if (!permits(protectedWrites()))
        throw new AutonomyFailure("AUTONOMY_OUTCOME_UNKNOWN");
      let entry: { id: string; existing: boolean };
      try {
        entry = await this.ledger.begin({
          op: e.op,
          origin: this.origin,
          chief_id: binding.chief_id,
          dojo_id: binding.dojo_id,
          mandate_id: binding.mandate_id,
          installation: this.installation,
          work_id: e.work_id,
          lease_generation: e.lease_generation,
          slot: e.slot,
          follow_up_id: e.follow_up_id,
          digest: ledgerDigest(e.method, e.path, e.body),
          expect: e.expect,
        });
      } catch {
        // Not durably recorded: nothing may be sent.
        throw new AutonomyFailure("AUTONOMY_UNAVAILABLE");
      }
      // A running request may become unknown while begin fsyncs. Recheck
      // immediately before dispatch; never remove an existing obligation.
      if (entry.existing || !permits(protectedWrites(entry.id))) {
        if (!entry.existing)
          await this.ledger.resolve(entry.id).catch(() => {});
        throw new AutonomyFailure("AUTONOMY_OUTCOME_UNKNOWN");
      }
      if (this.scope.aborted) {
        await this.ledger.resolve(entry.id).catch(() => {});
        this.scope.throwIfAborted();
      }
      if (e.op === "complete" && this.admitted) this.admitted.terminal = true;
      this.inflight++;
      this.dispatched.add(entry.id);
      return entry;
    };
    const admission = this.admission.then(admit);
    this.admission = admission.catch(() => {});
    const entry = await admission;
    try {
      const value = await run();
      await this.ledger.resolve(entry.id).catch(() => {});
      return value;
    } catch (error) {
      // A rejected re-send says nothing about an earlier unknown attempt.
      if (definite(error) && !entry.existing)
        await this.ledger.resolve(entry.id).catch(() => {});
      else {
        // The response is already ambiguous: classify it as protected NOW.
        // unknown persistence can queue behind another durable begin; leaving
        // it in dispatched during that await would admit a new network write.
        this.dispatched.delete(entry.id);
        await this.ledger.unknown(entry.id).catch(() => {});
        this.onUnknown();
      }
      throw error;
    } finally {
      this.dispatched.delete(entry.id);
      this.inflight--;
    }
  }
}

export interface AutonomyHostOptions {
  store: Store;
  admission: Admission;
  onDiagnostic?: (event: LogInput) => void;
  runtimes?: (
    home: string,
    context: RuntimeContext,
  ) => Promise<AutonomyRuntimes>;
  /** Docker inspect/remove used for owned cleanup retry (tests: fake daemon). */
  cleanupEngine?: NativeProbeEngine;
  scheduler?: Pick<
    SchedulerOptions,
    "wait" | "random" | "minBackoffMs" | "maxBackoffMs" | "leaseSeconds"
  >;
  /**
   * In-cycle mandate observation cadence: another installation's pause, off,
   * suspension or mandate replacement interrupts the running cycle within
   * this bound plus one request timeout. Default 15 s, at most lease / 3.
   */
  mandateCheckMs?: number;
  /** Directory fsync seam (tests inject faults and observe ordering). */
  syncDirectory?: SyncDirectory;
  /** Minimum interval between background proofs (default 30 s). */
  proofThrottleMs?: number;
}
export type AutonomyHostState = SchedulerState | "starting";
const PROOF_TIMEOUT_MS = 30000;
const MANDATE_CHECK_MS = 15000;
const PROOF_THROTTLE_MS = 30000;

/**
 * The continuous Coach inside the admin process, independent of the request
 * Worker, the native terminal and any browser. It shares only the inference
 * admission slot. Stopping aborts an active cycle without a local release;
 * an effectful write abandoned mid-flight stays a durable ledger entry that
 * blocks process replacement (independent of participation) until an exact
 * read-only proof settles it.
 */
export class AutonomyHost {
  private scheduler?: AutonomyScheduler;
  private lifetime?: AbortController;
  private starting?: Promise<void>;
  private backend?: TrackedBackend;
  private ledger?: WriteLedger;
  private owner?: string;
  private cleanup?: CleanupRegistry;
  private initializing?: Promise<void>;
  private reconciling?: Promise<boolean>;
  private lastProof = 0;
  private readonly reasons = new Map<string, Proof>();
  /** Recent exact settlements (newest first), with honest attribution. */
  private settled: {
    op: string;
    work_id: string;
    proof: Proof;
    attribution: Attribution | null;
    at: string;
  }[] = [];
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
  get unresolvedWrites() {
    return this.ledger?.unresolved.length ?? 0;
  }
  get safeToReplace() {
    return (
      !this.busy &&
      !!this.ledger?.healthy &&
      this.ledger.unresolved.length === 0 &&
      !!this.cleanup?.healthy &&
      this.cleanup.pending === 0
    );
  }

  /** Synchronous idle reservation: never interrupt an admitted active cycle. */
  reserveForManualUpdate() {
    if (!this.safeToReplace) return false;
    // pause fences synchronously, including a cycle waiting for the shared
    // slot but not yet admitted to its backend claim.
    void this.scheduler?.pause().catch(() => {});
    return true;
  }

  releaseUpdateQuiesce() {
    this.scheduler?.resume();
  }

  snapshot() {
    const unresolved = this.ledger?.unresolved ?? [];
    return {
      state: this.state,
      busy: this.busy,
      unknownOutcome: unresolved.length > 0,
      unresolvedWrites: unresolved.length,
      ledgerHealthy: this.ledger?.healthy ?? false,
      cleanupPending: this.cleanup?.pending ?? 0,
      cleanupHealthy: this.cleanup?.healthy ?? false,
      unresolved: unresolved.slice(0, 10).map((e) => ({
        op: e.op,
        work_id: e.work_id,
        slot: e.slot,
        state: e.state,
        reason: this.reasons.get(e.id) ?? null,
        created_at: e.created_at,
      })),
      settled: this.settled,
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

  /**
   * Load the durable ledger and owner token. Runs at admin startup whether or
   * not the installation participates: replacement safety needs it.
   */
  init(): Promise<void> {
    this.initializing ??= (async () => {
      const dir = this.options.store.dir;
      const sync = this.options.syncDirectory;
      this.ledger = await WriteLedger.open(dir, sync);
      this.owner = await autonomyOwner(dir, sync);
      this.cleanup = await CleanupRegistry.open(dir, this.owner, {
        sync,
        probe: this.options.cleanupEngine,
      });
    })().catch((error) => {
      this.initializing = undefined;
      throw error;
    });
    return this.initializing;
  }

  /** Same installation cleanup owner for every background Pi audience. */
  async runtimeContext(): Promise<RuntimeContext> {
    await this.init();
    return {
      owner: this.owner!,
      cleanup: this.cleanup!,
      onDiagnostic: this.options.onDiagnostic,
    };
  }

  /**
   * Exact read-only proof for every settled unknown write (never a replay).
   * Single-flight; returns whether replacement is now safe.
   */
  reconcile(): Promise<boolean> {
    this.reconciling ??= this.proveAll().finally(
      () => (this.reconciling = undefined),
    );
    return this.reconciling;
  }

  /** Throttled background proof for status polling. */
  nudge() {
    if (
      (!this.ledger?.unresolved.length && !this.cleanup?.pending) ||
      Date.now() - this.lastProof <
        (this.options.proofThrottleMs ?? PROOF_THROTTLE_MS)
    )
      return;
    void this.reconcile().catch(() => {});
  }

  private async proveAll(): Promise<boolean> {
    try {
      await this.init();
    } catch {
      return false;
    }
    const ledger = this.ledger!;
    this.lastProof = Date.now();
    // Owned container teardown retry: exact, scoped, never a broad prune.
    if (this.cleanup?.pending) await this.cleanup.drain();
    const settled = ledger.unresolved.filter(
      (e) => !this.backend?.dispatched.has(e.id),
    );
    if (!settled.length) return this.safeToReplace;
    const { store } = this.options;
    const token = store.secrets.token;
    const keep = (reason: Proof) => {
      for (const e of settled) this.reasons.set(e.id, reason);
      return this.safeToReplace;
    };
    if (!token) return keep("binding_unavailable");
    const backend = new AutonomyBackend(
      store.publicConfig().origin,
      token,
      AbortSignal.timeout(PROOF_TIMEOUT_MS),
      Object.values(store.secrets),
    );
    // Completions are proven by their exact receipt alone; other writes
    // need the current mandate (an unreadable one keeps them).
    let mandate = null;
    if (settled.some((e) => e.op !== "complete"))
      mandate = await backend.mandate().catch(() => null);
    for (const entry of settled) {
      const { proof, attribution } = await settle(entry, { backend, mandate });
      if (RESOLVED.includes(proof)) {
        try {
          await ledger.resolve(entry.id);
          this.reasons.delete(entry.id);
          this.settled = [
            {
              op: entry.op,
              work_id: entry.work_id,
              proof,
              attribution,
              at: new Date().toISOString(),
            },
            ...this.settled,
          ].slice(0, 10);
          this.diagnostic("autonomy-outcome-settled");
        } catch {
          this.reasons.set(entry.id, "unavailable");
        }
      } else this.reasons.set(entry.id, proof);
    }
    return this.safeToReplace;
  }

  async start() {
    if (this.scheduler) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const { store } = this.options;
      const token = store.secrets.token;
      if (!token || !store.secrets.apiKey)
        throw new Error("CONNECTION_AND_PROVIDER_REQUIRED");
      await this.init();
      const runtimes = await (this.options.runtimes ?? productionRuntimes)(
        store.dir,
        { owner: this.owner!, cleanup: this.cleanup! },
      );
      if (runtimes.planner === runtimes.composer)
        throw new Error("COMPOSER_RUNTIME_SHARED");
      if (!this.ledger!.healthy) throw new Error("AUTONOMY_LEDGER_UNAVAILABLE");
      const lifetime = new AbortController();
      const backend = new TrackedBackend(
        store.publicConfig().origin,
        token,
        lifetime.signal,
        Object.values(store.secrets),
        this.ledger!,
        this.owner!,
        () => new Actions(store).unresolved(),
      );
      backend.onUnknown = () =>
        this.diagnostic("autonomy-outcome-unknown", "warn");
      const runner = autonomyRunner({
        store,
        runtime: runtimes.planner,
        compose: { runtime: runtimes.composer },
        onDiagnostic: this.options.onDiagnostic,
        leaseSeconds: this.options.scheduler?.leaseSeconds,
      });
      const scheduler = new AutonomyScheduler({
        ...this.options.scheduler,
        backend,
        admission: this.options.admission,
        onDiagnostic: this.options.onDiagnostic,
        ready: () => this.admissible(),
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

  /**
   * C5 R4 shared admission guard, checked before every claim: no new cycle
   * (claim, start, runner or effect) while any durable unknown write remains
   * or owned container teardown is unconfirmed (`autonomy-ledger-1`).
   * Reconciliation runs on its own (read-only, single-flight); only exact
   * settlement re-admits claims.
   */
  private async admissible() {
    const ledger = this.ledger;
    if (!ledger?.healthy) return false;
    if (ledger.unresolved.length) {
      this.nudge();
      return false;
    }
    // No claim while an owned container teardown is unconfirmed.
    return (
      !!this.cleanup?.healthy &&
      (this.cleanup.pending === 0 || (await this.cleanup.drain()) === 0)
    );
  }

  private async run(runner: ReturnType<typeof autonomyRunner>, cycle: Cycle) {
    const backend = this.backend;
    if (backend) {
      // Writes are bound to the authority this cycle was admitted under.
      backend.binding = {
        chief_id: cycle.mandate.chief_id,
        dojo_id: cycle.mandate.dojo_id,
        mandate_id: cycle.mandate.mandate_id,
      };
      backend.cycle = cycle.signal;
      backend.admitted = {
        work_id: cycle.work.id,
        lease_generation: cycle.work.lease_generation,
        terminal: false,
      };
    }
    const lease = (this.options.scheduler?.leaseSeconds ?? 120) * 1000;
    const every = Math.min(
      this.options.mandateCheckMs ?? MANDATE_CHECK_MS,
      lease / 3,
    );
    let checking = false;
    const watcher = setInterval(() => {
      if (checking || !backend || cycle.signal.aborted) return;
      checking = true;
      backend
        .mandate()
        .then(
          (m) => {
            if (
              m.paused ||
              m.mode === "off" ||
              m.status !== "active" ||
              m.mandate_id !== cycle.mandate.mandate_id
            )
              void this.scheduler?.interrupt("AUTONOMY_MANDATE_CHANGED");
          },
          () => {},
        )
        .finally(() => (checking = false));
    }, every);
    try {
      // A completion settles nothing by itself: only exact proof does.
      const result = await runner(cycle);
      this.last = {
        outcome: result.outcome.result,
        workId: cycle.work.id,
        at: new Date().toISOString(),
      };
      return result;
    } finally {
      clearInterval(watcher);
      if (backend) {
        backend.binding = undefined;
        backend.cycle = undefined;
        backend.admitted = undefined;
      }
      if (this.ledger?.unresolved.length) void this.reconcile().catch(() => {});
    }
  }

  /**
   * Abort the active cycle and wait until it has drained (an effectful write
   * caught mid-flight stays unknown in the ledger); the loop keeps running and
   * its next tick re-reads the mandate.
   */
  async interrupt(reason = "AUTONOMY_PAUSED") {
    await this.starting?.catch(() => {});
    await this.scheduler?.interrupt(reason);
  }

  async stop() {
    await this.starting?.catch(() => {});
    const scheduler = this.scheduler;
    if (!scheduler) return;
    // An aborted effectful write stays a durable unknown ledger entry.
    this.lifetime?.abort(new Error("AUTONOMY_STOPPED"));
    await scheduler.stop();
    this.scheduler = undefined;
    this.backend = undefined;
    this.lifetime = undefined;
    this.diagnostic("autonomy-stopped", "info", {
      calls: this.unresolvedWrites,
    });
  }
}
