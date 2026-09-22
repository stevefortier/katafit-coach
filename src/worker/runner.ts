import { randomUUID } from "node:crypto";
import { SafeError, safeError } from "../runtime/errors.js";
import type { LogInput, Stage } from "../diagnostics/log.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { discoverReads } from "../katafit/readTools.js";
import { assertNoSecrets } from "../config/store.js";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "../katafit/client.js";
import { serializeContext } from "../katafit/context.js";
import { effectivePrompt, fetchInstructions } from "../runtime/prompt.js";
export async function bounded<T>(
  action: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("CANCELLED"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([action(), cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
export interface WorkerOptions {
  origin: string;
  token: string;
  system: string;
  secrets?: string[];
  vision?: boolean;
  complete: (
    context: string,
    signal: AbortSignal,
    system: string,
    tools: AgentTool[],
    ref: string,
  ) => Promise<string>;
  onState?: (state: string) => void;
  onDiagnostic?: (event: LogInput) => void;
  pollMs?: number;
  modelMs?: number;
}
export class Worker {
  private controller = new AbortController();
  private active?: Promise<void>;
  private loop?: Promise<void>;
  state = "stopped";
  lastError: SafeError | null = null;
  private diagnostic(event: LogInput) {
    try {
      this.options.onDiagnostic?.(event);
    } catch {}
  }
  constructor(private options: WorkerOptions) {}
  private update(s: string) {
    if (this.state === s) return;
    if (["connecting", "idle", "stopped"].includes(s))
      this.diagnostic({ source: "worker", stage: s as Stage });
    this.state = s;
    this.options.onState?.(s);
  }
  pollOnce() {
    if (!this.active)
      this.active = this.poll().finally(() => {
        this.active = undefined;
      });
    return this.active;
  }
  private async poll() {
    const signal = this.controller.signal;
    signal.throwIfAborted();
    const c = new Client(this.options.origin, this.options.token, signal);
    const ref = randomUUID();
    const started = Date.now();
    const stage = (stage: Stage, metadata: Record<string, unknown> = {}) =>
      this.diagnostic({
        source: "worker",
        stage,
        ref,
        level: stage === "failure-report-unverified" ? "warn" : "info",
        metadata: { ...metadata, elapsedMs: Date.now() - started },
      });
    let modelSignal: AbortSignal | undefined;
    let inferenceStarted = false;
    let fence: any;
    let deadline = 0;
    let publishing = false;
    let disposeReads: (() => void) | undefined;
    const budget = () => {
      signal.throwIfAborted();
      const n = deadline - Date.now();
      if (!Number.isFinite(n) || n <= 0) throw new Error("LEASE_EXPIRED");
      return Math.min(10000, n);
    };
    try {
      await c.connect();
      const listed = await c.call("coach_list_requests", { limit: 10 });
      if (
        !listed.requests?.some((r: any) =>
          ["queued", "claimed", "working"].includes(r.status),
        )
      ) {
        this.update("idle");
        return;
      }
      const instructions = await fetchInstructions(c);
      const { request } = await c.call("coach_claim_request", {
        lease_seconds: 120,
      });
      if (!request) {
        this.update("idle");
        return;
      }
      fence = {
        request_id: request.id,
        lease_generation: request.lease_generation,
      };
      deadline =
        Math.min(
          Date.parse(request.lease_expires_at),
          Date.parse(request.timeout_at),
        ) - 2000;
      this.update("working");
      stage("claimed", { leaseGeneration: request.lease_generation });
      await c.call("coach_start_request", fence, budget());
      const context = await c.call("coach_read_context", fence, budget());
      const current = context.request;
      if (
        !current ||
        ["id", "requester_id", "scope", "lease_generation"].some(
          (k) => current[k] !== request[k],
        ) ||
        !current.requester_id ||
        !["personal", "dojo"].includes(current.scope)
      )
        throw new Error("CONTEXT_REJECTED");
      const serialized = serializeContext(context);
      stage("context-read", {
        bytes: Buffer.byteLength(serialized),
        limit: 4 * 1024 * 1024,
      });
      assertNoSecrets(context, [
        this.options.token,
        ...(this.options.secrets ?? []),
      ]);
      if (
        serialized.includes(this.options.token) ||
        instructions.includes(this.options.token)
      )
        throw new Error("CONTEXT_REJECTED");
      const ms = Math.min(
        this.options.modelMs ?? 60000,
        deadline - Date.now() - 10000,
      );
      if (ms <= 0) throw new Error("LEASE_EXPIRED");
      const timeout = AbortSignal.timeout(ms);
      modelSignal = AbortSignal.any([signal, timeout]);
      const inferenceSignal = modelSignal;
      const reads = await bounded(
        () =>
          discoverReads(
            new Client(
              this.options.origin,
              this.options.token,
              inferenceSignal,
            ),
            fence,
            {
              vision: this.options.vision === true,
              secrets: [this.options.token, ...(this.options.secrets ?? [])],
            },
          ),
        modelSignal,
      );
      disposeReads = reads.dispose;
      stage("reads-ready");
      if (
        current.attachment_count !== 0 &&
        !reads.tools.some((t) => t.name === "coach_read_media")
      )
        throw new Error("CONTEXT_REJECTED");
      stage("inference");
      inferenceStarted = true;
      const text = await bounded(
        () =>
          this.options.complete(
            JSON.stringify({
              ...JSON.parse(serialized),
              "Request data capabilities": reads.status,
            }),
            inferenceSignal,
            effectivePrompt(this.options.system, instructions, [
              this.options.token,
              ...(this.options.secrets ?? []),
            ]),
            reads.tools,
            ref,
          ),
        modelSignal,
      );
      modelSignal.throwIfAborted();
      budget();
      if (
        typeof text !== "string" ||
        !text.trim() ||
        text.length > 8000 ||
        text.includes(this.options.token)
      )
        throw new Error("OUTPUT_REJECTED");
      publishing = true;
      stage("publishing");
      await c.call("coach_respond", { ...fence, text }, budget());
      stage("verifying");
      // Read canonical state back; never claim persistence from transport success alone.
      const checked = await c.call(
        "coach_list_requests",
        { statuses: ["completed"], limit: 100 },
        budget(),
      );
      const saved = checked.requests?.find((r: any) => r.id === request.id);
      if (!saved || saved.status !== "completed")
        throw new Error("DELIVERY_UNVERIFIED");
      this.update("reply-persisted");
      stage("reply-persisted");
    } catch (error) {
      const failure = publishing
        ? new SafeError("DELIVERY_UNVERIFIED")
        : signal.aborted
          ? new SafeError("CANCELLED")
          : modelSignal?.aborted
            ? new SafeError(
                inferenceStarted ? "PROVIDER_TIMEOUT" : "BACKEND_TIMEOUT",
              )
            : safeError(error);
      if (failure.code !== "CANCELLED") this.lastError = failure;
      this.diagnostic({
        source: "worker",
        stage: failure.code === "CANCELLED" ? "cancelled" : "request-failed",
        level: failure.code === "CANCELLED" ? "warn" : "error",
        ref,
        error: failure,
        metadata: { elapsedMs: Date.now() - started },
      });
      if (fence && !publishing && !signal.aborted && deadline > Date.now()) {
        try {
          await c.call(
            "coach_fail_request",
            {
              ...fence,
              code: failure.code,
              message: failure.hint,
            },
            budget(),
          );
          const check = await c.call(
            "coach_list_requests",
            { statuses: ["failed"], limit: 100 },
            budget(),
          );
          stage(
            check.requests?.some(
              (r: any) =>
                r.id === fence.request_id &&
                r.status === "failed" &&
                r.failure_code === failure.code &&
                r.lease_generation === fence.lease_generation,
            )
              ? "failure-reported"
              : "failure-report-unverified",
          );
        } catch {
          stage("failure-report-unverified");
        }
      }
      throw failure;
    } finally {
      disposeReads?.();
    }
  }
  start() {
    if (this.loop) return;
    this.update("connecting");
    this.loop = this.run();
  }
  private async run() {
    let delay = this.options.pollMs ?? 5000;
    while (!this.controller.signal.aborted) {
      try {
        await this.pollOnce();
        delay = this.options.pollMs ?? 5000;
      } catch (e: any) {
        if (!this.controller.signal.aborted)
          this.update(
            e.message === "CREDENTIAL_REJECTED"
              ? "credential-rejected"
              : "connection-or-request-failed",
          );
        delay = Math.min(60000, delay * 2);
      }
      await sleep(delay, undefined, { signal: this.controller.signal }).catch(
        () => {},
      );
    }
    this.update("stopped");
  }
  async stop() {
    this.controller.abort();
    await Promise.allSettled([this.active, this.loop]);
    this.update("stopped");
  }
}
