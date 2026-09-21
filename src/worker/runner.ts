import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "../katafit/client.js";
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
  complete: (
    context: string,
    signal: AbortSignal,
    system: string,
  ) => Promise<string>;
  onState?: (state: string) => void;
  pollMs?: number;
  modelMs?: number;
}
export class Worker {
  private controller = new AbortController();
  private active?: Promise<void>;
  private loop?: Promise<void>;
  state = "stopped";
  constructor(private options: WorkerOptions) {}
  private update(s: string) {
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
    let fence: any;
    let deadline = 0;
    let publishing = false;
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
      const instructions = (
        await c.fetch("/api/agents/coach.md", undefined, 10000, 65536)
      ).text;
      if (
        !/^# Kata\.fit external Coach agent v1[ \t]*(?:\r?\n|$)/.test(
          instructions,
        )
      )
        throw new Error("CONTRACT_UNSUPPORTED");
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
      await c.call("coach_start_request", fence, budget());
      const context = await c.call("coach_read_context", fence, budget());
      const current = context.request;
      if (
        !current ||
        ["id", "requester_id", "scope", "lease_generation"].some(
          (k) => current[k] !== request[k],
        ) ||
        !current.requester_id ||
        !["personal", "dojo"].includes(current.scope) ||
        current.attachment_count !== 0
      )
        throw new Error("CONTEXT_REJECTED");
      const serialized = JSON.stringify(context);
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
      const modelSignal = AbortSignal.any([signal, timeout]);
      const text = await bounded(
        () =>
          this.options.complete(
            serialized,
            modelSignal,
            this.options.system + "\n" + instructions,
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
      await c.call("coach_respond", { ...fence, text }, budget());
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
    } catch (error) {
      if (fence && !publishing && !signal.aborted && deadline > Date.now()) {
        try {
          await c.call(
            "coach_fail_request",
            {
              ...fence,
              code: "EXTERNAL_AGENT_FAILED",
              message:
                "The external Coach could not complete this request. Please retry.",
            },
            budget(),
          );
        } catch {}
      }
      throw error;
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
