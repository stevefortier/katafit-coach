// Content-free sequence-timing scope. Only a validated UUID ref, a 48-bit
// attempt digest, ordinals and monotonic millisecond intervals ever leave it.
// See docs/worker-sequence-timing.md for the stage contract.
export type Clock = () => number;
export const monotonic: Clock = () => performance.now();
export const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Upper bound for any persisted interval or offset (24 hours). */
export const TRACE_MS_MAX = 86400000;

/**
 * Fixed `task-span` codes. Spans may nest or overlap; they are inclusive
 * intervals on one process-local monotonic clock, never one-way latencies.
 */
export const SPAN_CODES = Object.freeze({
  taskClaim: 1,
  contextRead: 2,
  contextPrepare: 3,
  memoryPrepare: 4,
  mealAcquire: 5,
  promptAssemble: 6,
  inferenceCall: 7,
  outputParse: 8,
  completeSubmit: 9,
  receiptReconcile: 10,
  memoryRetain: 11,
  failureReport: 12,
  memoryRecover: 13,
  admissionWait: 14,
  nativeSetup: 15,
  gatewayOpen: 16,
  nativeRun: 17,
  gatewayClose: 18,
  providerRequest: 19,
  toolCall: 20,
});
export const SPAN_CODE_MAX = 20;
/** 1 ok, 2 failed, 3 cancelled by an enclosing signal, 4 timeout/expiry. */
export const SPAN_OUTCOMES = Object.freeze({
  ok: 1,
  failed: 2,
  cancelled: 3,
  timeout: 4,
});

export interface TraceScope {
  /** The originating poll/operation ref (validated UUID). */
  readonly ref: string;
  /** clock() at the start of the originating poll/operation. */
  readonly origin: number;
  readonly clock: Clock;
  /** taskAttemptDigest once a task attempt is bound; never before claim. */
  readonly attemptDigest?: number;
  /** Shared physical backend-call ordinal for every client in this scope. */
  readonly ordinal: { value: number };
}
/** Inference-call trace handed through InferenceBudget (no identity). */
export interface InferenceTrace {
  origin: number;
  clock?: Clock;
}

/** A clock fault never changes the measured operation; it drops the value. */
export function read(clock: Clock): number {
  try {
    const value = clock();
    return typeof value === "number" ? value : NaN;
  } catch {
    return NaN;
  }
}
/** Rounded bounded milliseconds; unknown/out-of-range values stay absent. */
export function ms(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 0 || value > TRACE_MS_MAX)
    return undefined;
  return Math.round(value);
}
export function between(
  start: number | undefined,
  end: number | undefined,
): number | undefined {
  return start === undefined || end === undefined ? undefined : ms(end - start);
}
/** Drop undefined/unknown values: unknown is never reported as zero. */
export function defined(
  input: Record<string, number | undefined>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(input))
    if (value !== undefined) out[key] = value;
  return out;
}
export function traceScope(ref: string, clock: Clock = monotonic): TraceScope {
  return {
    ref: UUID_PATTERN.test(ref) ? ref : "",
    origin: read(clock),
    clock,
    ordinal: { value: 0 },
  };
}
/** Same ref/origin/ordinal, bound to one exact task attempt. */
export function withAttempt(
  scope: TraceScope,
  attemptDigest: number | undefined,
): TraceScope {
  return {
    ...scope,
    ...(validDigest(attemptDigest) ? { attemptDigest } : {}),
  };
}
export const validDigest = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  value < 2 ** 48;
/** Exactly a finite origin and optional function clock, or nothing. */
export function inferenceTrace(
  value: unknown,
): { origin: number; clock: Clock } | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const { origin, clock } = value as InferenceTrace;
    if (typeof origin !== "number" || !Number.isFinite(origin)) return;
    if (clock !== undefined && typeof clock !== "function") return;
    return { origin, clock: clock ?? monotonic };
  } catch {
    return undefined;
  }
}
export function spanOutcome(error: unknown, signal?: AbortSignal): number {
  try {
    const code =
      error && typeof error === "object"
        ? String((error as { code?: unknown; message?: unknown }).code ?? "") ||
          String((error as { message?: unknown }).message ?? "")
        : "";
    if (
      /^(?:BACKEND_TIMEOUT|PROVIDER_TIMEOUT|LEASE_EXPIRED|HEADLESS_TIMEOUT|NATIVE_PROVIDER_TIMEOUT)$/.test(
        code,
      )
    )
      return SPAN_OUTCOMES.timeout;
    if (signal?.aborted || /^(?:CANCELLED|NATIVE_CANCELLED)$/.test(code))
      return SPAN_OUTCOMES.cancelled;
    return SPAN_OUTCOMES.failed;
  } catch {
    // Observing arbitrary thrown values must never replace the business error.
    return SPAN_OUTCOMES.failed;
  }
}

// Server-Timing from the Kata.fit requestPerformance middleware. Only these
// fixed names are retained; other well-formed entries are counted, never named.
const SERVER_TIMING: Readonly<Record<string, string>> = Object.freeze({
  total: "serverTotalMs",
  auth: "serverAuthMs",
  handler: "serverHandlerMs",
});
export function serverTiming(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof raw !== "string") return out;
  let entries = 0;
  for (const part of raw.slice(0, 2048).split(",").slice(0, 32)) {
    const match =
      /^\s*([a-z_]{1,64});\s*dur=(\d{1,9}(?:\.\d{1,6})?)(?:\s*;[^,]*)?\s*$/.exec(
        part,
      );
    if (!match) continue;
    entries++;
    const key = Object.hasOwn(SERVER_TIMING, match[1])
      ? SERVER_TIMING[match[1]]
      : undefined;
    const value = Number(match[2]);
    if (
      key &&
      out[key] === undefined &&
      Number.isFinite(value) &&
      value <= TRACE_MS_MAX
    )
      out[key] = Math.round(value);
  }
  if (entries) out.serverTimingEntries = entries;
  return out;
}
/** Exactly the validated Worker attempt binding, or nothing. */
export function attributionOf(value: unknown): Record<string, number> {
  try {
    const a = value as { attemptDigest?: unknown; outputAttempt?: unknown };
    if (
      a &&
      typeof a === "object" &&
      validDigest(a.attemptDigest) &&
      (a.outputAttempt === 1 || a.outputAttempt === 2)
    )
      return { attemptDigest: a.attemptDigest, outputAttempt: a.outputAttempt };
  } catch {}
  return {};
}
