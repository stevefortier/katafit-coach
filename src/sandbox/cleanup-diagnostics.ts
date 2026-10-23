import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";

// Optional local observation only: never grants cleanup authority, changes an
// error, or copies Docker output/paths/identities into diagnostics. Consumers
// must be trusted, bounded and nonthrowing (diagnostics_channel contract).
const diagnostics = channel("katafit.native-cleanup");
export type CleanupPhase =
  | "inspect"
  | "identity"
  | "remove-present"
  | "remove-unconfirmed"
  | "durable-drain"
  | "local-drain"
  | "runtime-stop"
  | "ownership-record-remove";
const reasons = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOENT",
  "EACCES",
  "EPERM",
  "EIO",
  "ENOSPC",
  "DOCKER_TIMEOUT",
  "DOCKER_RESPONSE_LIMIT",
  "DOCKER_REQUEST_REJECTED",
  "DOCKER_API_UNSUPPORTED",
  "NATIVE_CLEANUP_RECORD_INVALID",
  "NATIVE_CLEANUP_PENDING",
]);
export function cleanupDiagnostic(
  phase: CleanupPhase,
  started: number,
  error?: unknown,
  probeFailed?: boolean,
) {
  if (!diagnostics.hasSubscribers) return;
  const value = error as { code?: unknown; message?: unknown } | undefined;
  const reason =
    [value?.code, value?.message].find(
      (v): v is string => typeof v === "string" && reasons.has(v),
    ) ?? "UNCLASSIFIED";
  diagnostics.publish({
    protocol: 1,
    phase,
    reason,
    durationMs: Math.min(
      2_147_483_647,
      Math.max(0, Math.round(performance.now() - started)),
    ),
    ...(probeFailed === undefined ? {} : { probeFailed }),
  });
}
