import { createHash, randomUUID } from "node:crypto";
import {
  discoverTasks,
  validateTask,
  TASK_PROTOCOL,
  taskContext,
  taskSchema,
  parseTaskResult,
  TaskOutputError,
  verifyTaskReceipt,
  verifyTaskFailure,
  verifyTaskResolution,
} from "../katafit/tasks.js";
import { SafeError, safeError } from "../runtime/errors.js";
import type { LogInput, Stage } from "../diagnostics/log.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { discoverReads } from "../katafit/readTools.js";
import type { InferenceBudget } from "../runtime/piAdapter.js";
import { assertNoSecrets } from "../config/store.js";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "../katafit/client.js";
import { backendWireBudget } from "../katafit/wireBudget.js";
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
    budget?: InferenceBudget,
  ) => Promise<string>;
  onState?: (state: string) => void;
  onDiagnostic?: (event: LogInput) => void;
  pollMs?: number;
  presenceMs?: number;
  modelMs?: number;
  isolationMs?: number;
}
type PendingTask = { task: any; digest: string };
type Incident = PendingTask & { reason: string; nextCheck: number };
const DENIAL_CODES = new Set([
  "TASK_SOURCE_CHANGED",
  "TASK_ROUTING_CHANGED",
  "CONVERSATION_CLEARED",
  "SCOPE_CHANGED",
  "REQUESTER_SCOPE_CHANGED",
  "EXTERNAL_COACH_AUTO_ACCEPTANCE_CONFLICT",
  "CREDENTIAL_REJECTED",
]);
const MAX_INCIDENTS = 32;
export class Worker {
  private controller = new AbortController();
  private active?: Promise<void>;
  private preferTask = true;
  private pendingTask?: PendingTask;
  private isolated: Incident[] = [];
  get incidents() {
    return this.isolated.map(({ task, digest, reason, nextCheck }) => ({
      taskId: task.id,
      leaseGeneration: task.lease_generation,
      digest,
      reason,
      nextCheck,
    }));
  }
  private loop?: Promise<void>;
  private startup?: Promise<"reported" | "unsupported">;
  private stopping?: Promise<void>;
  private presenceTimer?: ReturnType<typeof setInterval>;
  private presenceCall?: Promise<void>;
  private readonly instanceId = randomUUID();
  private presenceGeneration?: string;
  private presenceAttempted = false;
  presence: "unconfirmed" | "reported" | "unsupported" = "unconfirmed";
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
    if (
      [
        "connecting",
        "idle",
        "stopped",
        "task-working",
        "task-result-stored",
        "task-publication-confirmed",
        "task-failure-reported",
        "task-failure-unverified",
        "task-result-unknown",
      ].includes(s)
    )
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
    let taskAttempt = false;
    let fence: any;
    let deadline = 0;
    let publishing = false;
    let disposeReads: (() => void) | undefined;
    const budget = () => {
      signal.throwIfAborted();
      const n = deadline - Date.now();
      if (!Number.isFinite(n) || n <= 0) throw new Error("LEASE_EXPIRED");
      return backendWireBudget(n);
    };
    try {
      await c.connect();
      const taskKinds = await discoverTasks(c);
      const due = this.isolated.find(
        (incident) => incident.nextCheck <= Date.now(),
      );
      if (due) {
        due.nextCheck = Date.now() + (this.options.isolationMs ?? 60000);
        try {
          await this.reconcileTask(due);
        } catch {
          /* No read is a proof. */
        }
      }
      let triedTasks = false;
      const tryTasks = async () => {
        if (triedTasks || !taskKinds.length) return false;
        triedTasks = true;
        // Flip before work so provider/task errors cannot starve main chat.
        this.preferTask = false;
        if (this.pendingTask) {
          try {
            await this.reconcileTask();
          } catch {
            // A failed read is not evidence of completion or noncompletion.
            this.update("task-result-unknown");
          }
          return true;
        }
        if (this.isolated.length >= MAX_INCIDENTS) return false;
        taskAttempt = true;
        const handled = await this.pollTask(c, taskKinds, ref);
        if (!handled) taskAttempt = false;
        return handled;
      };
      if (this.preferTask && (await tryTasks())) return;
      // Alternate attempted work as well as successful work: a failing main
      // listing must not pin priority forever and starve the task queue.
      this.preferTask = true;
      const listed = await c.call("coach_list_requests", { limit: 10 });
      if (
        !listed.requests?.some((r: any) =>
          ["queued", "claimed", "working"].includes(r.status),
        )
      ) {
        if (await tryTasks()) return;
        this.update("idle");
        return;
      }
      this.preferTask = true;
      const instructions = await fetchInstructions(c);
      const { request } = await c.call("coach_claim_request", {
        lease_seconds: 120,
      });
      if (!request) {
        if (await tryTasks()) return;
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
        this.options.modelMs ?? 100000,
        deadline - Date.now() - 10000,
      );
      if (ms <= 0) throw new Error("LEASE_EXPIRED");
      const deadlineAt = Date.now() + ms;
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
            { deadlineAt, readBudget: reads.readBudget },
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
        stage: taskAttempt
          ? "task-failed"
          : failure.code === "CANCELLED"
            ? "cancelled"
            : "request-failed",
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
  private async reconcileTask(
    pending: PendingTask | Incident | undefined = this.pendingTask,
  ) {
    if (!pending) return;
    const control = new Client(
      this.options.origin,
      this.options.token,
      AbortSignal.timeout(3000),
    );
    let checked: any;
    try {
      const result = await control.rpc(
        "tools/call",
        {
          name: "coach_reconcile_task",
          arguments: {
            protocol: TASK_PROTOCOL,
            task_id: pending.task.id,
            lease_generation: pending.task.lease_generation,
          },
        },
        false,
        3000,
      );
      if (result.isError) {
        let code: unknown;
        try {
          code = JSON.parse(
            result.content?.find((v: any) => v.type === "text")?.text,
          ).code;
        } catch {}
        if (typeof code === "string" && DENIAL_CODES.has(code))
          throw new Error(code);
        throw new Error("MCP_TOOL_FAILED");
      }
      checked =
        result.structuredContent ??
        JSON.parse(result.content?.find((v: any) => v.type === "text")?.text);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "";
      if (
        DENIAL_CODES.has(reason) &&
        pending === this.pendingTask &&
        this.isolated.length < MAX_INCIDENTS
      ) {
        this.isolated.push({
          ...pending,
          reason,
          nextCheck: Date.now() + (this.options.isolationMs ?? 60000),
        });
        this.pendingTask = undefined;
        this.diagnostic({
          source: "worker",
          stage: "task-result-unknown",
          level: "warn",
          metadata: { leaseGeneration: pending.task.lease_generation },
        });
      }
      throw error;
    }
    const status = verifyTaskResolution(pending.task, checked, pending.digest);
    if (status === "claimed") {
      this.update("task-result-unknown");
      return;
    }
    if (pending === this.pendingTask) this.pendingTask = undefined;
    else
      this.isolated = this.isolated.filter((incident) => incident !== pending);
    if (status === "completed" || status === "consumed") {
      this.update(
        status === "consumed"
          ? "task-publication-confirmed"
          : "task-result-stored",
      );
    } else {
      this.diagnostic({
        source: "worker",
        stage: "task-result-unknown",
        level: "warn",
      });
      this.update("task-result-unverified");
    }
  }
  private async pollTask(c: Client, kinds: string[], ref: string) {
    const { task } = await c.call("coach_claim_task", {
      protocol: TASK_PROTOCOL,
      kinds,
      lease_seconds: 60,
    });
    if (!task) return false;
    validateTask(task, kinds);
    const fence = {
      protocol: TASK_PROTOCOL,
      task_id: task.id,
      lease_generation: task.lease_generation,
    };
    const deadline =
      Math.min(Date.parse(task.timeout_at), Date.parse(task.lease_expires_at)) -
      2000;
    const budget = () => {
      this.controller.signal.throwIfAborted();
      const left = deadline - Date.now();
      if (!Number.isFinite(left) || left <= 0) throw new Error("LEASE_EXPIRED");
      return backendWireBudget(left);
    };
    let phase = "context";
    let taskModelSignal: AbortSignal | undefined;
    let completing = false;
    try {
      const context = await c.call("coach_read_task_context", fence, budget());
      const secrets = [this.options.token, ...(this.options.secrets ?? [])];
      const serialized = taskContext(task, context, secrets);
      this.update("task-working");
      const ms = Math.min(
        this.options.modelMs ?? 60000,
        deadline - Date.now() - 10000,
      );
      if (ms <= 0) throw new Error("LEASE_EXPIRED");
      const signal = AbortSignal.any([
        this.controller.signal,
        AbortSignal.timeout(ms),
      ]);
      taskModelSignal = signal;
      const deadlineAt = Date.now() + ms;
      phase = "provider";
      const system =
        effectivePrompt(this.options.system, context.instructions, secrets) +
        "\nThis is a generation task, not a user chat turn. Do not invent a user question. Return only JSON matching this local result schema: " +
        JSON.stringify(taskSchema(task.kind));
      let result: any;
      for (let attempt = 0; attempt < 2; attempt++) {
        const text = await bounded(
          () =>
            this.options.complete(
              serialized,
              signal,
              system +
                (attempt === 1
                  ? "\nYour previous result failed local validation. Return a new JSON object matching the schema and semantic constraints; no prose or tools. The rejected result is not available."
                  : ""),
              [],
              ref,
            ),
          signal,
        );
        signal.throwIfAborted();
        budget();
        phase = "output";
        try {
          result = parseTaskResult(task.kind, text, secrets);
          break;
        } catch (error) {
          if (!(error instanceof TaskOutputError)) throw error;
          this.diagnostic({
            source: "worker",
            stage: "task-output-correction",
            level: "warn",
            ref,
            error: new SafeError(`TASK_OUTPUT_${error.category}`),
          });
          // Reuse the original inference timer and fence, never renew a lease.
          // Keep time for a backend failure receipt if correction cannot finish.
          if (
            attempt === 1 ||
            !["JSON", "SCHEMA", "SEMANTIC"].includes(error.category) ||
            signal.aborted ||
            Math.min(deadline, deadlineAt) - Date.now() < 5000
          )
            throw error;
          phase = "provider";
        }
      }
      budget();
      completing = true;
      // Retain only identity/digest, never generated/member content. Reconciliation
      // has its own live transport even if stop aborted the completion transport.
      this.pendingTask = {
        task,
        digest: createHash("sha256")
          .update(JSON.stringify(result))
          .digest("hex"),
      };
      try {
        const receipt = await c.call(
          "coach_complete_task",
          { ...fence, result },
          budget(),
        );
        verifyTaskReceipt(task, receipt, this.pendingTask.digest);
        this.pendingTask.digest = receipt.result_sha256;
      } catch {
        /* The read, never a repeated write, decides the outcome. */
      }
      await this.reconcileTask();
      return true;
    } catch (error) {
      if (
        !completing &&
        !this.controller.signal.aborted &&
        deadline > Date.now()
      ) {
        const code =
          phase === "context"
            ? "TASK_CONTEXT_UNAVAILABLE"
            : phase === "output"
              ? "TASK_INVALID_OUTPUT"
              : "TASK_PROVIDER_FAILED";
        try {
          await c.call("coach_fail_task", { ...fence, code }, budget());
          const checked = await c.call(
            "coach_read_task_receipt",
            fence,
            budget(),
          );
          verifyTaskFailure(task, checked, code);
          this.update("task-failure-reported");
        } catch {
          this.update("task-failure-unverified");
        }
      }
      if (completing) this.update("task-result-unknown");
      throw completing
        ? new SafeError("DELIVERY_UNVERIFIED")
        : taskModelSignal?.aborted && !this.controller.signal.aborted
          ? new SafeError("PROVIDER_TIMEOUT")
          : error;
    }
  }
  start(): Promise<"reported" | "unsupported"> {
    if (this.controller.signal.aborted)
      return Promise.reject(new Error("CANCELLED"));
    if (this.startup) return this.startup;
    this.startup = (async () => {
      const signal = this.controller.signal;
      const c = new Client(this.options.origin, this.options.token, signal);
      try {
        await c.connect();
        const catalog = await c.rpc("tools/list", {});
        if (!Array.isArray(catalog?.tools))
          throw new Error("MCP_PROTOCOL_ERROR");
        if (
          !catalog.tools.some(
            (tool: any) => tool?.name === "coach_report_worker_presence",
          )
        ) {
          this.presence = "unsupported";
        } else {
          this.presenceAttempted = true;
          // Presence RPCs must finish even if Stop aborts polling mid-flight:
          // the returned generation is needed to fence the final stop.
          await this.report("running", AbortSignal.timeout(2500));
          this.presence = "reported";
        }
        signal.throwIfAborted();
        this.update("connecting");
        this.loop = this.run();
        if (this.presence === "reported") {
          this.presenceTimer = setInterval(() => {
            if (this.controller.signal.aborted || this.presenceCall) return;
            this.presenceCall = this.report(
              "running",
              AbortSignal.timeout(2500),
            )
              .then(() => {
                this.presence = "reported";
              })
              .catch(() => {
                this.presence = "unconfirmed";
              })
              .finally(() => {
                this.presenceCall = undefined;
              });
          }, this.options.presenceMs ?? 10000);
        }
        return this.presence;
      } catch (error) {
        this.controller.abort();
        this.update("stopped");
        throw error;
      }
    })();
    return this.startup;
  }
  private async report(state: "running" | "stopped", signal: AbortSignal) {
    if (state === "stopped" && !this.presenceGeneration)
      throw new Error("WORKER_PRESENCE_UNCONFIRMED");
    const c = new Client(this.options.origin, this.options.token, signal);
    await c.connect();
    const result = await c.call(
      "coach_report_worker_presence",
      {
        instance_id: this.instanceId,
        state,
        ...(this.presenceGeneration
          ? { generation: this.presenceGeneration }
          : {}),
      },
      2000,
    );
    if (result.state !== state) throw new Error("MCP_PROTOCOL_ERROR");
    if (state === "running") {
      if (
        typeof result.generation !== "string" ||
        !/^[a-f0-9]{32}$/.test(result.generation)
      )
        throw new Error("MCP_PROTOCOL_ERROR");
      this.presenceGeneration = result.generation;
    } else {
      this.presenceGeneration = undefined;
    }
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
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      this.controller.abort();
      if (this.presenceTimer) clearInterval(this.presenceTimer);
      await Promise.allSettled([
        this.startup,
        this.presenceCall,
        this.active,
        this.loop,
      ]);
      if (this.presenceAttempted) {
        try {
          await this.report("stopped", AbortSignal.timeout(2500));
          this.presence = "reported";
        } catch {
          this.presence = "unconfirmed";
        }
      }
      this.update("stopped");
    })();
    return this.stopping;
  }
}
