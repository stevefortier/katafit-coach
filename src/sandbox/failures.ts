// Fixed, allowlisted native failure codes. Only a code (and, for upstream
// provider failures, a numeric HTTP status) crosses into the sandbox; the relay
// owns the matching fixed message text. Never upstream bodies, URLs or stacks.
export const NATIVE_FAILURE_CODES = [
  "NATIVE_TEXT_TOO_LARGE",
  "NATIVE_IMAGE_REJECTED",
  "NATIVE_WIRE_TOO_LARGE",
  "NATIVE_RESULT_TOO_LARGE",
  "NATIVE_REQUEST_BUSY",
  "NATIVE_REQUEST_REJECTED",
  "NATIVE_MODEL_REJECTED",
  "NATIVE_CREDENTIAL_BLOCKED",
  "NATIVE_SESSION_EXPIRED",
  "NATIVE_SESSION_REVOKED",
  "NATIVE_CANCELLED",
  "NATIVE_DELIVERY_UNVERIFIED",
  "NATIVE_TURN_UNRESOLVED",
  "NATIVE_TURN_REQUIRED",
  "NATIVE_AUTHORIZATION_FAILED",
  "NATIVE_PROVIDER_AUTH_FAILED",
  "NATIVE_PROVIDER_RATE_LIMITED",
  "NATIVE_PROVIDER_QUOTA_EXCEEDED",
  "NATIVE_PROVIDER_TIMEOUT",
  "NATIVE_PROVIDER_UNAVAILABLE",
  "NATIVE_PROVIDER_PAYLOAD_TOO_LARGE",
  "NATIVE_PROVIDER_CONTEXT_LIMIT",
  "NATIVE_PROVIDER_REQUEST_REJECTED",
  "NATIVE_PROVIDER_NETWORK_FAILED",
  "NATIVE_PROVIDER_OUTPUT_REJECTED",
  "NATIVE_TOOL_FAILED",
  "NATIVE_GATEWAY_FAILED",
] as const;
export type NativeFailureCode = (typeof NATIVE_FAILURE_CODES)[number];

/**
 * A classified gateway failure. `message` keeps the internal reason for host
 * callers and tests; only `code` and `status` are ever framed to the relay.
 */
export class NativeFailure extends Error {
  constructor(
    readonly code: NativeFailureCode,
    message: string = code,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** The only failure shape the runtime frames back to the relay. */
export function failureFrame(
  error: unknown,
  kind?: unknown,
): {
  error: NativeFailureCode;
  status?: number;
} {
  // Unclassified tool failures may follow a backend mutation: keep no-replay.
  if (
    !(error instanceof NativeFailure) ||
    !NATIVE_FAILURE_CODES.includes(error.code)
  )
    return {
      error: kind === "tool" ? "NATIVE_TOOL_FAILED" : "NATIVE_GATEWAY_FAILED",
    };
  return Number.isInteger(error.status) &&
    error.status! >= 100 &&
    error.status! <= 599
    ? { error: error.code, status: error.status }
    : { error: error.code };
}

// Directional stdio frame limits. Relay HTTP caps (sandbox/relay.mjs) mirror
// these values; tests pin both sides.
export const NATIVE_TEXT_LIMIT = 1024 * 1024;
/** Final validated/compacted envelope actually sent to the provider. */
export const NATIVE_PROVIDER_WIRE_LIMIT = 24 * 1024 * 1024;
/**
 * Raw provider history as Pi sends it (every earlier photo is resent each
 * turn). Carried losslessly to the host, which alone validates and compacts.
 */
export const NATIVE_PROVIDER_UPLOAD_LIMIT = 48 * 1024 * 1024;
/** relay -> host: one raw provider request plus the fixed frame envelope. */
export const NATIVE_REQUEST_FRAME_LIMIT = NATIVE_PROVIDER_UPLOAD_LIMIT + 65536;
/** host -> relay: an 8 MiB original image result is ~11.2 MB of base64. */
export const NATIVE_RESPONSE_FRAME_LIMIT = 16 * 1024 * 1024;
