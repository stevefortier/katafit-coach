import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { NativeGateway } from "../sandbox/gateway.js";
import type { CleanupRegistry } from "./cleanup.js";
import type { LogInput } from "../diagnostics/log.js";
import {
  dockerProbeEngine,
  NATIVE_PROFILES,
  NativeRuntime,
  type NativeOwnership,
  type NativeProbeEngine,
  type NativeProfile,
} from "../sandbox/runtime.js";

export const HEADLESS_ROLE_LABEL = "fit.kata.native.role";
export const HEADLESS_ROLE = "autonomy";
export const HEADLESS_OWNER_LABEL = "fit.kata.native.owner";
export const HEADLESS_NAME =
  /^katafit-pi-auto-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** One RPC stdout line; larger output ends the cycle. */
export const HEADLESS_LINE_LIMIT = 8 * 1024 * 1024;
// Grace for Pi to acknowledge an abort before the container is removed.
const ABORT_GRACE_MS = 500;

export type HeadlessCode =
  | "HEADLESS_BUSY"
  | "HEADLESS_TIMEOUT"
  | "HEADLESS_ABORTED"
  | "HEADLESS_EXITED"
  | "HEADLESS_PROMPT_REJECTED"
  | "HEADLESS_NO_OUTPUT"
  | "HEADLESS_MODEL_FAILED"
  | "HEADLESS_OUTPUT_TOO_LARGE"
  | "HEADLESS_CLEANUP_PENDING";
export class HeadlessFailure extends Error {
  constructor(readonly code: HeadlessCode) {
    super(code);
  }
}

/** Pi 0.86.1 agent_end includes failed assistant turns. Text-query RPC
 * success is not generation success; attest only this ending invocation. */
function terminalText(event: any): string {
  if (!Array.isArray(event.messages) || !event.messages.length)
    throw new HeadlessFailure("HEADLESS_MODEL_FAILED");
  const pending = new Set<string>();
  for (const message of event.messages) {
    if (message?.role === "assistant") {
      if (!Array.isArray(message.content))
        throw new HeadlessFailure("HEADLESS_MODEL_FAILED");
      for (const part of message.content) {
        if (part?.type !== "toolCall") continue;
        if (typeof part.id !== "string" || !part.id || pending.has(part.id))
          throw new HeadlessFailure("HEADLESS_MODEL_FAILED");
        pending.add(part.id);
      }
    } else if (message?.role === "toolResult") {
      if (!pending.delete(message.toolCallId))
        throw new HeadlessFailure("HEADLESS_MODEL_FAILED");
    }
  }
  const last = event.messages.at(-1);
  if (
    last?.role !== "assistant" ||
    !["stop", "length"].includes(last.stopReason) ||
    pending.size ||
    last.content.some((part: any) => part?.type === "toolCall")
  )
    throw new HeadlessFailure("HEADLESS_MODEL_FAILED");
  const text = last.content
    .filter((part: any) => part?.type === "text")
    .map((part: any) => {
      if (typeof part.text !== "string")
        throw new HeadlessFailure("HEADLESS_MODEL_FAILED");
      return part.text;
    })
    .join("")
    .trim();
  if (!text) throw new HeadlessFailure("HEADLESS_NO_OUTPUT");
  return text;
}

type Engine = ConstructorParameters<typeof NativeRuntime>[1] & {};
export interface HeadlessRun {
  profile: NativeProfile;
  gateway: NativeGateway;
  message: string;
  cycleMs: number;
  /** Absolute inference cutoff; never a fresh budget after runtime setup. */
  deadlineAt?: number;
  signal?: AbortSignal;
  /** Operational work only, never account/Dojo/member identity. */
  operational?: { workId: string; leaseGeneration: number };
}

/**
 * Bounded headless native Pi: one network-none container per cycle, driven
 * over Pi's JSONL RPC, always removed. At most one container at a time.
 * With a `cleanup` registry (production) every container is labelled with
 * the installation owner and durably recorded before create; a teardown
 * that cannot be confirmed stays recorded and refuses further cycles until
 * a scoped retry proves absence (C5 F4/F5).
 */
export class HeadlessCycleRuntime {
  private running = false;
  private invocation = 0;
  private readonly onDiagnostic?: (event: LogInput) => void;
  private readonly image: string;
  private readonly engine: Engine;
  private readonly cleanup?: CleanupRegistry;
  private readonly probe: NativeProbeEngine;
  constructor(options: {
    image: string;
    engine?: Engine;
    cleanup?: CleanupRegistry;
    onDiagnostic?: (event: LogInput) => void;
  }) {
    this.image = options.image;
    this.engine = options.engine ?? {};
    this.cleanup = options.cleanup;
    this.onDiagnostic = options.onDiagnostic;
    this.probe = dockerProbeEngine(
      this.engine.exec ??
        (promisify(execFile) as unknown as NonNullable<Engine["exec"]>),
      this.engine.socketPath ?? "/var/run/docker.sock",
    );
  }
  get active() {
    return this.running;
  }

  async run(run: HeadlessRun): Promise<{ text: string; container: string }> {
    if (!NATIVE_PROFILES.includes(run.profile))
      throw new Error("PROFILE_REJECTED");
    if (run.signal?.aborted) throw new HeadlessFailure("HEADLESS_ABORTED");
    if (this.running) throw new HeadlessFailure("HEADLESS_BUSY");
    const deadline = Math.min(
      Date.now() + run.cycleMs,
      run.deadlineAt ?? Infinity,
    );
    if (!Number.isFinite(deadline) || deadline <= Date.now())
      throw new HeadlessFailure("HEADLESS_TIMEOUT");
    this.running = true;
    const name = "katafit-pi-auto-" + randomUUID();
    const invocation = ++this.invocation;
    let phase = 1;
    let firstObserved = false;
    let runtime: NativeRuntime | undefined;
    const limbs = (hex: string, prefix: string) =>
      Object.fromEntries(
        hex.match(/.{8}/g)!.map((limb, i) => [prefix + i, parseInt(limb, 16)]),
      );
    // Snapshot primitives once: caller mutation cannot rebind an invocation's logs.
    const workId = run.operational?.workId;
    const leaseGeneration = run.operational?.leaseGeneration;
    const workKnown =
      typeof workId === "string" &&
      /^[a-f0-9]{24}$/.test(workId) &&
      typeof leaseGeneration === "number" &&
      Number.isSafeInteger(leaseGeneration) &&
      leaseGeneration >= 0;
    const emit = (
      stage: LogInput["stage"],
      extra: Record<string, number> = {},
    ) => {
      try {
        const id = runtime?.diagnosticContainerId;
        const known = typeof id === "string" && /^[a-f0-9]{64}$/.test(id);
        this.onDiagnostic?.({
          source: "worker",
          stage,
          ref: name.slice("katafit-pi-auto-".length),
          metadata: {
            profileCode: NATIVE_PROFILES.indexOf(run.profile) + 1,
            headlessPhase: phase,
            headlessInvocation: invocation,
            headlessWorkKnown: workKnown ? 1 : 0,
            ...(workKnown
              ? {
                  ...limbs(workId, "headlessWork"),
                  leaseGeneration,
                }
              : {}),
            headlessContainerKnown: known ? 1 : 0,
            ...(known ? limbs(id!, "headlessContainer") : {}),
            ...extra,
          },
        });
      } catch {}
    };
    const boundary = (source: number, intentional = false) => {
      if (firstObserved) return;
      // Latch before calling the sink, including throwing/reentrant sinks.
      firstObserved = true;
      emit("headless-first-boundary", {
        headlessSource: source,
        headlessIntentional: intentional ? 1 : 0,
      });
    };
    const milestone = (next: number) => {
      phase = next;
      emit("headless-lifecycle");
    };
    milestone(1);
    let ownership: NativeOwnership | undefined;
    if (this.cleanup) {
      const cleanup = this.cleanup;
      try {
        if (
          !cleanup.healthy ||
          (cleanup.pending > 0 && (await cleanup.drain(this.probe)) > 0)
        )
          throw new Error("HEADLESS_CLEANUP_PENDING");
        ownership = await cleanup.begin({
          name,
          image: this.image,
          labels: {
            [HEADLESS_ROLE_LABEL]: HEADLESS_ROLE,
            [HEADLESS_OWNER_LABEL]: cleanup.owner,
          },
        });
      } catch {
        boundary(5, true);
        this.running = false;
        throw new HeadlessFailure("HEADLESS_CLEANUP_PENDING");
      }
    }
    // Durable ownership acquisition/drain is setup time too. If it consumed
    // the inference window, no container/provider may be launched. Forget only
    // this never-created identity; any older unconfirmed cleanup stays held.
    if (run.signal?.aborted || deadline <= Date.now()) {
      boundary(run.signal?.aborted ? 4 : 3);
      try {
        if (ownership) await this.cleanup!.end(name, true);
      } catch {
        throw new HeadlessFailure("HEADLESS_CLEANUP_PENDING");
      } finally {
        this.running = false;
      }
      throw new HeadlessFailure(
        run.signal?.aborted ? "HEADLESS_ABORTED" : "HEADLESS_TIMEOUT",
      );
    }
    runtime = new NativeRuntime(this.image, {
      ...this.engine,
      ...(ownership
        ? { ownership, probeEngine: this.probe }
        : { name, labels: { [HEADLESS_ROLE_LABEL]: HEADLESS_ROLE } }),
    });
    let fail!: (failure: HeadlessFailure) => void;
    const failed = new Promise<never>((_, reject) => {
      fail = (failure) => reject(failure);
    });
    failed.catch(() => {});
    let failure: HeadlessFailure | undefined;
    const end = (code: HeadlessCode) => {
      if (failure) return;
      failure = new HeadlessFailure(code);
      fail(failure);
    };
    const responses = new Map<string, (response: any) => void>();
    let agentEnd!: (text: string) => void;
    const ended = new Promise<string>((resolve) => (agentEnd = resolve));
    let pending = "";
    runtime.onOutput = (chunk) => {
      pending += chunk;
      let index;
      while ((index = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        if (Buffer.byteLength(line) > HEADLESS_LINE_LIMIT) {
          end("HEADLESS_OUTPUT_TOO_LARGE");
          continue;
        }
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event?.type === "response" && typeof event.id === "string")
          responses.get(event.id)?.(event);
        else if (event?.type === "agent_end") {
          try {
            agentEnd(terminalText(event));
          } catch (error) {
            end(
              error instanceof HeadlessFailure
                ? error.code
                : "HEADLESS_MODEL_FAILED",
            );
          }
        }
      }
      if (Buffer.byteLength(pending) > HEADLESS_LINE_LIMIT) {
        pending = "";
        end("HEADLESS_OUTPUT_TOO_LARGE");
      }
    };
    runtime.onBoundary = boundary;
    runtime.onExit = () => {
      end("HEADLESS_EXITED");
      boundary(1);
    };
    // Removal may be unconfirmed; the cycle still ends now and `finally`
    // retains the owned record instead of holding the cycle budget.
    runtime.onDetached = () => {
      end("HEADLESS_EXITED");
      boundary(2);
    };
    const response = (id: string) =>
      new Promise<any>((resolve) => responses.set(id, resolve));
    // Commit the original terminal outcome before a sink can reenter callbacks.
    // Promise reactions run later; the first-boundary latch/source still precede cleanup.
    const timer = setTimeout(
      () => {
        end("HEADLESS_TIMEOUT");
        boundary(3);
      },
      Math.max(0, deadline - Date.now()),
    );
    const onAbort = () => {
      end("HEADLESS_ABORTED");
      boundary(4);
    };
    run.signal?.addEventListener("abort", onAbort, { once: true });
    let prompted = false;
    try {
      milestone(2);
      await Promise.race([
        runtime.start(run.gateway, { mode: "rpc", profile: run.profile }),
        failed,
      ]);
      milestone(3);
      milestone(4);
      await Promise.race([runtime.attach(), failed]);
      milestone(5);
      const promptId = randomUUID();
      const accepted = response(promptId);
      prompted = true;
      milestone(6);
      await Promise.race([
        runtime.rpc({ id: promptId, type: "prompt", message: run.message }),
        failed,
      ]);
      const reply = await Promise.race([accepted, failed]);
      if (reply.success !== true)
        throw new HeadlessFailure("HEADLESS_PROMPT_REJECTED");
      milestone(7);
      const attestedText = await Promise.race([ended, failed]);
      milestone(8);
      const textId = randomUUID();
      const last = response(textId);
      await Promise.race([
        runtime.rpc({ id: textId, type: "get_last_assistant_text" }),
        failed,
      ]);
      const final = await Promise.race([last, failed]);
      const text = final.success === true ? final.data?.text : undefined;
      if (typeof text !== "string" || !text.trim())
        throw new HeadlessFailure("HEADLESS_NO_OUTPUT");
      if (text !== attestedText)
        throw new HeadlessFailure("HEADLESS_MODEL_FAILED");
      milestone(9);
      return { text, container: name };
    } catch (error) {
      const code = failure?.code;
      if (
        prompted &&
        (code === "HEADLESS_TIMEOUT" || code === "HEADLESS_ABORTED")
      ) {
        milestone(10);
        await this.abort(runtime, response);
      }
      throw failure ?? error;
    } finally {
      boundary(5, true);
      milestone(11);
      clearTimeout(timer);
      run.signal?.removeEventListener("abort", onAbort);
      runtime.onOutput = () => {};
      runtime.onDetached = () => {};
      if (!ownership) {
        try {
          await runtime.stop();
        } finally {
          this.running = false;
          milestone(12);
        }
      } else {
        let absent = false;
        try {
          await runtime.stop();
          absent = true;
        } catch {
          // Retained: the durable record keeps the host unsafe.
        }
        try {
          await this.cleanup!.end(name, absent);
        } catch {
          absent = false;
        } finally {
          this.running = false;
          milestone(12);
        }
        if (!absent) throw new HeadlessFailure("HEADLESS_CLEANUP_PENDING");
      }
    }
  }

  private async abort(
    runtime: NativeRuntime,
    response: (id: string) => Promise<any>,
  ) {
    const id = randomUUID();
    const acknowledged = response(id);
    let grace: NodeJS.Timeout | undefined;
    try {
      await runtime.rpc({ id, type: "abort" });
      await Promise.race([
        acknowledged,
        new Promise((resolve) => (grace = setTimeout(resolve, ABORT_GRACE_MS))),
      ]);
    } catch {
      // The container is removed regardless.
    } finally {
      clearTimeout(grace);
    }
  }

  /**
   * Startup sweep, installation-scoped: retries retained records exactly,
   * then removes only exactly named containers labelled with this role AND
   * this owner that no cycle here owns. Another installation's live
   * containers, legacy role-only and unrelated containers are never touched.
   */
  async sweep(): Promise<number> {
    const cleanup = this.cleanup;
    if (!cleanup) throw new Error("HEADLESS_OWNER_REQUIRED");
    await cleanup.drain(this.probe);
    const run =
      this.engine.exec ??
      (promisify(execFile) as unknown as NonNullable<Engine["exec"]>);
    const host =
      "--host=unix://" + (this.engine.socketPath ?? "/var/run/docker.sock");
    const { stdout } = await run(
      "docker",
      [
        host,
        "ps",
        "--all",
        "--filter",
        `label=${HEADLESS_ROLE_LABEL}=${HEADLESS_ROLE}`,
        "--filter",
        `label=${HEADLESS_OWNER_LABEL}=${cleanup.owner}`,
        "--format",
        "{{.Names}}",
      ],
      { timeout: 10000, maxBuffer: 65536 },
    );
    let removed = 0;
    for (const name of String(stdout)
      .split("\n")
      .map((n) => n.trim())) {
      if (!HEADLESS_NAME.test(name) || cleanup.isOwnedActive(name)) continue;
      await run("docker", [host, "rm", "--force", name], {
        timeout: 15000,
        maxBuffer: 65536,
      });
      removed++;
    }
    return removed;
  }
}
