// Only fixed local codes/hints and finite numeric metadata cross diagnostics boundaries.
export const hints = {
  DISCOVERY_REJECTED:
    "Request data-tool discovery failed validation. Check backend and worker compatibility; no access was expanded.",
  CAPABILITIES_REJECTED:
    "Request-scoped capabilities failed validation. Check credential grants and backend compatibility.",
  SCHEMA_REJECTED:
    "A backend read-tool schema failed local safety validation. Check backend and worker compatibility.",
  ARGUMENTS_REJECTED:
    "Read-tool arguments failed scoped validation. No unauthorized read was dispatched.",
  TOOL_BUDGET_EXHAUSTED:
    "The request exceeded its 48 read-tool call budget. Reduce the request.",
  RESULT_REJECTED: "A read result failed safety, size or structure validation.",
  PLAN_UNAVAILABLE:
    "Could not classify the request with the configured model; no member data or action was assumed.",
  READ_UNAVAILABLE:
    "The scoped read was unavailable. Check request authority, grants and supported capabilities.",
  READ_NOT_FOUND:
    "No record matched within the authorized read scope; check date bounds without expanding access.",
  READ_NOT_AUTHORIZED:
    "The backend denied this read. Do not retry by changing authorization or scope.",
  READ_LIMIT:
    "The backend read limit was reached. Do not bypass request scope or grants.",
  READ_REPEAT_BLOCKED:
    "An identical failed read was suppressed; use verified evidence or state uncertainty.",
  BACKEND_TIMEOUT:
    "The Kata.fit backend operation exceeded its time budget. Check backend connectivity and request authority.",
  MODEL_INPUT_TOO_LARGE:
    "The serialized provider input exceeds 1 MiB. Reduce context or tool metadata; this is a local byte limit, not the model context window.",
  MODEL_BUDGET_EXHAUSTED:
    "The bounded inference budget was exhausted (48 MiB cumulative input, 40 turns, 64 tool calls or 48000 output tokens). Reduce the request.",
  PROVIDER_AUTH_FAILED:
    "Check the saved provider API key and its model permissions.",
  PROVIDER_RATE_LIMITED:
    "The provider rate limit was reached. Wait before retrying and check provider request limits.",
  PROVIDER_QUOTA_EXCEEDED:
    "Provider credits or quota are exhausted. Check billing and available credits before retrying.",
  PROVIDER_CONTEXT_LIMIT:
    "The provider rejected its model context window. Reduce context or choose a larger-context model; the local byte limit is separate.",
  PROVIDER_PAYLOAD_TOO_LARGE:
    "The provider rejected the multimodal request size. Reduce image size or image count before retrying; changing the model context window alone will not fix HTTP 413.",
  PROVIDER_REQUEST_REJECTED:
    "The provider rejected the request. Check model, endpoint and supported input capabilities.",
  PROVIDER_UNAVAILABLE:
    "The provider is unavailable. Check its service status and retry later.",
  PROVIDER_TIMEOUT:
    "Inference exceeded its time budget. Check provider latency or reduce the request.",
  PROVIDER_CONNECTION_FAILED:
    "The provider connection failed. Check endpoint, network and TLS configuration.",
  MODEL_EMPTY_RESPONSE:
    "The provider returned no usable text. Check the model and retry.",
  MODEL_TOOL_FORMAT_UNSUPPORTED:
    "The model emitted tool-command text instead of native tool calls. This text was not executed or published; check the installed model's tool parser and provider compatibility.",
  MODEL_FAILED:
    "Inference did not complete successfully. Check provider compatibility and retry.",
  CONTEXT_REJECTED:
    "Authorized context or attachment access could not be validated. Check request scope and image opt-in; access was not expanded.",
  DELIVERY_UNVERIFIED:
    "A reply may already be saved. Check the canonical Kata.fit conversation before retrying; delivery could not be verified.",
  CANCELLED:
    "The operation was cancelled. No further publication will be attempted; check Kata.fit if publication had already started.",
  LEASE_EXPIRED:
    "Request authority expired. Refresh its canonical state in Kata.fit before retrying.",
  OUTPUT_REJECTED:
    "The generated output failed local safety or size validation.",
  TASK_OUTPUT_JSON: "Typed task output was not valid JSON.",
  TASK_OUTPUT_SCHEMA: "Typed task output did not match its strict schema.",
  TASK_OUTPUT_SEMANTIC: "Typed task output failed a semantic constraint.",
  TASK_OUTPUT_SECURITY:
    "Typed task output failed credential safety validation.",
  TASK_OUTPUT_SIZE: "Typed task output exceeded the size limit.",
  MEDIA_REJECTED: "Image input failed type, encoding or size validation.",
  VISION_UNSUPPORTED:
    "Original images require an explicitly enabled vision-capable provider.",
  CREDENTIAL_REJECTED: "Check the Kata.fit credential, expiration and scope.",
  CONNECTIVITY_ERROR: "Check the saved Kata.fit origin and network connection.",
  RESPONSE_TOO_LARGE:
    "The backend response exceeded its bounded transport limit.",
  MCP_PROTOCOL_ERROR: "The backend returned an incompatible protocol response.",
  MCP_TOOL_FAILED:
    "The backend rejected the scoped operation. Check request authority and capabilities.",
  CONTRACT_UNSUPPORTED:
    "The backend protocol version is unsupported. Check installation compatibility.",
  BACKEND_INSTRUCTIONS_UNAVAILABLE:
    "Exact preview unavailable: backend instructions could not be fetched or validated. No inference ran. Check the saved Kata.fit origin.",
  INVALID_CONFIG: "Check the saved configuration fields.",
  INVALID_PERSONA: "Check persona fields and their length limits.",
  INVALID_URL:
    "Use a supported endpoint URL without embedded credentials, query or fragment.",
  INVALID_SECRET: "Check the credential format and length.",
  TOKEN_REQUIRED: "Save a Kata.fit connection credential first.",
  CONNECTION_AND_PROVIDER_REQUIRED:
    "Save both the Kata.fit credential and provider API key first.",
  STOP_WORKER_BEFORE_PREVIEW: "Stop the worker before previewing.",
  PROVIDER_KEY_REQUIRED: "Save a provider API key first.",
  NO_PREVIOUS_REVISION: "There is no previous saved revision to restore.",
  SECRET_IN_CONFIG:
    "A known credential was detected at a protected boundary. Remove credentials from nonsecret configuration and context.",
  INVALID_PREVIEW:
    "Enter a nonempty sample question of at most 8000 characters.",
  REQUEST_FAILED:
    "The operation failed. Check local configuration and connectivity; raw errors are intentionally withheld.",
} as const;
export type ErrorCode = keyof typeof hints;
export function numericMetadata(input: Record<string, unknown> = {}) {
  const result: Record<string, number> = {};
  for (const key of [
    "status",
    "bytes",
    "wireBytes",
    "wireLimit",
    "limit",
    "totalBytes",
    "totalLimit",
    "elapsedMs",
    "turn",
    "nativeCalls",
    "textParts",
    "leaseGeneration",
    "turns",
    "turnLimit",
    "calls",
    "callLimit",
    "reads",
    "readLimit",
    "outputTokens",
    "outputTokenLimit",
  ])
    if (
      typeof input[key] === "number" &&
      Number.isSafeInteger(input[key]) &&
      input[key] >= 0
    )
      result[key] = input[key];
  return result;
}
export class SafeError extends Error {
  readonly hint: string;
  readonly metadata: Record<string, number>;
  constructor(
    readonly code: ErrorCode,
    metadata: Record<string, unknown> = {},
  ) {
    super(code);
    this.hint = hints[code];
    this.metadata = numericMetadata(metadata);
  }
}
export function safeError(error: unknown): SafeError {
  if (error instanceof SafeError)
    return new SafeError(error.code, error.metadata);
  if (error instanceof Error) {
    if (Object.hasOwn(hints, error.message))
      return new SafeError(error.message as ErrorCode);

    if (error.name === "AbortError") return new SafeError("CANCELLED");
  }
  return new SafeError("REQUEST_FAILED");
}
export function providerFailure(status: number, code?: unknown) {
  const kind: ErrorCode =
    status === 401 || status === 403
      ? "PROVIDER_AUTH_FAILED"
      : status === 429 &&
          ["insufficient_quota", "quota_exceeded"].includes(
            typeof code === "string" ? code : "",
          )
        ? "PROVIDER_QUOTA_EXCEEDED"
        : status === 429
          ? "PROVIDER_RATE_LIMITED"
          : status === 408 || status === 504
            ? "PROVIDER_TIMEOUT"
            : status === 413
              ? "PROVIDER_PAYLOAD_TOO_LARGE"
              : status >= 500
                ? "PROVIDER_UNAVAILABLE"
                : [
                      "context_length_exceeded",
                      "context_window_exceeded",
                    ].includes(typeof code === "string" ? code : "")
                  ? "PROVIDER_CONTEXT_LIMIT"
                  : "PROVIDER_REQUEST_REJECTED";
  return new SafeError(kind, { status });
}
