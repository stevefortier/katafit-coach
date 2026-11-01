import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Store } from "../config/store.js";
import type { RuntimeContext } from "../autonomy/host.js";
import { HeadlessCycleRuntime } from "../autonomy/headless.js";
import { nativeBinding } from "../sandbox/artifact.js";
import {
  openProfileGateway,
  type ProfileGatewayOptions,
} from "../sandbox/gateway.js";
import type { WorkerOptions } from "../worker/runner.js";
import type { InferenceBudget } from "./piAdapter.js";
import type { LogInput } from "../diagnostics/log.js";
import {
  between,
  defined,
  inferenceTrace,
  read,
  SPAN_CODES,
  SPAN_OUTCOMES,
  spanOutcome,
  UUID_PATTERN,
  attributionOf,
} from "../diagnostics/trace.js";

// Temporary per-generation headroom for background Coach work only.
export const WORKER_PROVIDER_TOKENS = 500000;

/** The installed Worker's profile gateway options for one completion. */
export function workerGatewayOptions(
  store: Store,
  call: {
    prompt: string;
    tools: AgentTool[];
    ref: string;
    budget?: InferenceBudget;
    onDiagnostic?: ProfileGatewayOptions["onDiagnostic"];
  },
): ProfileGatewayOptions {
  return {
    profile: "worker",
    prompt: call.prompt,
    tools: call.tools,
    skills: true,
    onDiagnostic: call.onDiagnostic,
    diagnosticRef: call.ref,
    ...(call.budget?.attribution
      ? { diagnosticAttribution: call.budget.attribution }
      : {}),
    ...(call.budget?.trace ? { diagnosticTrace: call.budget.trace } : {}),
    budgets: {
      tool_calls: 64,
      provider_tokens: WORKER_PROVIDER_TOKENS,
      images_per_cycle: store.publicConfig().provider.vision ? 5 : 0,
    },
  };
}
/**
 * The installed Worker's completion seam. No host Agent/provider fallback:
 * request-scoped tools stay on the host, Pi and its workspace stay offline.
 * Admission is held by Worker for this entire call, including teardown.
 */
export function isolatedWorkerCompletion(
  store: Store,
  context: () => Promise<RuntimeContext>,
): WorkerOptions["complete"] {
  return async (message, signal, prompt, tools, ref, budget) => {
    signal.throwIfAborted();
    const owner = await context();
    const timed = nativeSpans(owner.onDiagnostic, ref, budget, signal);
    const runtime = await timed(SPAN_CODES.nativeSetup, async () => {
      const image = await nativeBinding(store.dir);
      signal.throwIfAborted();
      const runtime = new HeadlessCycleRuntime({
        image,
        cleanup: owner.cleanup,
        ...(timed.lifecycle ? { onDiagnostic: timed.lifecycle } : {}),
      });
      await runtime.sweep();
      signal.throwIfAborted();
      return runtime;
    });
    const cycleMs = Math.min(
      100000,
      (budget?.deadlineAt ?? Date.now() + 100000) - Date.now(),
    );
    if (!(cycleMs > 0)) throw new Error("LEASE_EXPIRED");
    const gateway = await timed(SPAN_CODES.gatewayOpen, () =>
      openProfileGateway(
        store,
        signal,
        workerGatewayOptions(store, {
          prompt,
          tools,
          ref,
          budget,
          onDiagnostic: owner.onDiagnostic,
        }),
      ),
    );
    try {
      const result = await timed(SPAN_CODES.nativeRun, () =>
        runtime.run({
          profile: "worker",
          gateway,
          message,
          signal,
          cycleMs,
        }),
      );
      signal.throwIfAborted();
      return result.text;
    } finally {
      await timed(SPAN_CODES.gatewayClose, () => gateway.close());
    }
  };
}
/**
 * Native-seam `task-span` receipts and headless lifecycle correlation for one
 * traced Worker completion. Untraced calls are byte-for-byte unchanged: no
 * spans and no lifecycle sink. Never throws and never alters the call.
 */
export function nativeSpans(
  sink: ((event: LogInput) => void) | undefined,
  ref: string,
  budget: InferenceBudget | undefined,
  signal: AbortSignal,
) {
  const trace = inferenceTrace(budget?.trace);
  const parentRef = UUID_PATTERN.test(ref) ? ref : undefined;
  const attribution = attributionOf(budget?.attribution);
  const emit = (event: LogInput) => {
    try {
      sink?.(event);
    } catch {}
  };
  const timed = async <T>(code: number, run: () => Promise<T>): Promise<T> => {
    if (!trace || !parentRef || !sink) return run();
    const started = read(trace.clock);
    let outcome: number = SPAN_OUTCOMES.failed;
    try {
      const value = await run();
      outcome = SPAN_OUTCOMES.ok;
      return value;
    } catch (error) {
      outcome = spanOutcome(error, signal);
      throw error;
    } finally {
      const ended = read(trace.clock);
      emit({
        source: "worker",
        stage: "task-span",
        level: "verbose",
        ref: parentRef,
        metadata: {
          ...attribution,
          ...defined({
            spanStartMs: between(trace.origin, started),
            spanMs: between(started, ended),
          }),
          spanCode: code,
          spanOutcome: outcome,
        },
      });
    }
  };
  // Headless milestones keep their own container ref; parentRef joins them to
  // the originating Worker poll and spanStartMs places them on its timeline.
  const lifecycle =
    trace && parentRef && sink
      ? (event: LogInput) => {
          let offset: number | undefined;
          try {
            offset = between(trace.origin, read(trace.clock));
          } catch {}
          emit({
            ...event,
            parentRef,
            metadata: {
              ...event.metadata,
              ...attribution,
              ...defined({ spanStartMs: offset }),
            },
          });
        }
      : undefined;
  return Object.assign(timed, { lifecycle });
}
