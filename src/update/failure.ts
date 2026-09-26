/** Fixed diagnostics only: never persist child output, paths, or exception text. */
export const failureReasons = [
  "EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED",
  "INSUFFICIENT_DISK",
  "BUILD_TOOL_UNAVAILABLE",
  "BUILD_FAILED",
  "BUILD_CANCELLED",
  "INCOMPATIBLE_BUILD",
  "SOURCE_MISMATCH",
  "PACKAGE_REJECTED",
  "UNSAFE_PATH",
  "ACTIVATION_ROLLED_BACK",
  "STARTUP_FAILED",
  "STARTUP_TIMEOUT",
  "HEALTH_FAILED",
  "AUTO_UPDATE_DISABLED",
  "UPGRADE_FAILED",
] as const;
export type FailureReason = (typeof failureReasons)[number];
export function isFailureReason(value: unknown): value is FailureReason {
  return (
    typeof value === "string" && failureReasons.includes(value as FailureReason)
  );
}
export function failureReason(error: unknown): FailureReason {
  return error instanceof Error && isFailureReason(error.message)
    ? error.message
    : "UPGRADE_FAILED";
}
