import { open, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Never publish protected-home files, raw HTTP/error text or command output.
export const cleanupPhases = [
  "inspect",
  "identity",
  "remove-present",
  "remove-unconfirmed",
  "durable-drain",
  "local-drain",
  "runtime-stop",
  "ownership-record-remove",
];
const reasons = [
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
  "UNCLASSIFIED",
];
export function sanitizeCleanup(row) {
  if (
    !row ||
    row.protocol !== 1 ||
    !cleanupPhases.includes(row.phase) ||
    !reasons.includes(row.reason) ||
    !Number.isSafeInteger(row.durationMs) ||
    row.durationMs < 0 ||
    row.durationMs > 2147483647
  )
    return undefined;
  return {
    protocol: 1,
    phase: row.phase,
    reason: row.reason,
    durationMs: row.durationMs,
    ...(typeof row.probeFailed === "boolean"
      ? { probeFailed: row.probeFailed }
      : {}),
  };
}
async function readDiagnostics(path) {
  let file;
  try {
    file = await open(path, "r");
    const bytes = Buffer.alloc(32768);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const rows = bytes.subarray(0, bytesRead).toString("utf8").split("\n");
    return {
      state: "read",
      rows: rows.slice(0, 64).flatMap((line) => {
        try {
          const row = sanitizeCleanup(JSON.parse(line));
          return row ? [row] : [];
        } catch {
          return [];
        }
      }),
    };
  } catch {
    return { state: "unavailable", rows: [] };
  } finally {
    await file?.close();
  }
}
const bool = (value) => (typeof value === "boolean" ? value : null);
const choice = (value, values) => (values.includes(value) ? value : null);
const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value) ? value : null;
export function sanitizeFailure({ status, target, offset, update, worker }) {
  return {
    protocol: 1,
    status:
      Number.isInteger(status) && status >= 100 && status <= 599
        ? status
        : null,
    target: sha(target),
    offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : null,
    update: {
      installed: sha(update?.installed),
      applying: bool(update?.applying),
      recovering: bool(update?.recovering),
      preparation: {
        state: choice(update?.preparationAttempt?.state, [
          "failed",
          "preparing",
          "succeeded",
        ]),
        stage: choice(update?.preparationAttempt?.stage, [
          "source",
          "install",
          "build",
          "artifact",
          "probe",
        ]),
        artifactReason: choice(update?.preparationAttempt?.artifactReason, [
          "MISSING_MATCHING_ARTIFACT",
          "INVALID_BINDING",
          "DOCKER_UNAVAILABLE",
          "PROBE_FAILED",
          "CLEANUP_PENDING",
        ]),
        durable: bool(update?.preparationAttempt?.durable),
      },
    },
    worker: {
      state: choice(worker?.state, [
        "idle",
        "stopped",
        "starting",
        "stopping",
        "working",
        "error",
      ]),
      presence: choice(worker?.presence, ["reported", "unconfirmed"]),
      safeToReplace: bool(worker?.safeToReplace),
      stopConfirmed: bool(worker?.stopConfirmed),
    },
  };
}
export async function writeFailureEvidence(
  directory,
  diagnosticsPath,
  snapshot = {},
) {
  if (!directory) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const evidence = {
    ...sanitizeFailure(snapshot),
    cleanup: await readDiagnostics(diagnosticsPath),
  };
  await writeFile(
    join(directory, "failure.json"),
    JSON.stringify(evidence, null, 2) + "\n",
    { mode: 0o600 },
  );
}
