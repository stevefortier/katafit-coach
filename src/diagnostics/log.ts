import {
  appendFileSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
} from "node:fs";
import {
  hints,
  numericMetadata,
  safeError,
  type ErrorCode,
} from "../runtime/errors.js";

export const stages = [
  "studio-started",
  "operation-failed",
  "connecting",
  "claimed",
  "context-read",
  "reads-ready",
  "inference",
  "provider-payload",
  "publishing",
  "verifying",
  "reply-persisted",
  "request-failed",
  "task-working",
  "task-result-stored",
  "task-publication-confirmed",
  "task-failure-reported",
  "task-failure-unverified",
  "task-failed",
  "task-output-correction",
  "task-result-unknown",
  "failure-reported",
  "failure-report-unverified",
  "cancelled",
  "idle",
  "stopped",
  "preview-started",
  "preview-completed",
] as const;
export type Stage = (typeof stages)[number];
export interface LogInput {
  source: "studio" | "worker" | "provider";
  stage: Stage;
  level?: "info" | "warn" | "error";
  ref?: string;
  error?: unknown;
  metadata?: Record<string, unknown>;
}
export interface Entry {
  time: string;
  source: LogInput["source"];
  stage: Stage;
  level: "info" | "warn" | "error";
  ref?: string;
  code?: ErrorCode;
  hint?: string;
  metadata: Record<string, number>;
}
export const LOG_ENTRIES = 500;
export const LOG_FILE_BYTES = 256 * 1024;
// No user strings, remote IDs, URLs, prompts or errors are accepted as log text.
function entry(input: LogInput, time = new Date().toISOString()): Entry {
  const error = input.error === undefined ? undefined : safeError(input.error);
  return {
    time,
    source: ["studio", "worker", "provider"].includes(input.source)
      ? input.source
      : "studio",
    stage: stages.includes(input.stage) ? input.stage : "operation-failed",
    level: error
      ? input.level === "warn"
        ? "warn"
        : "error"
      : input.level === "warn" || input.level === "error"
        ? input.level
        : "info",
    ...(typeof input.ref === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      input.ref,
    )
      ? { ref: input.ref }
      : {}),
    ...(error ? { code: error.code, hint: error.hint } : {}),
    metadata: numericMetadata({ ...error?.metadata, ...input.metadata }),
  };
}
export class Diagnostics {
  private entries: Entry[] = [];
  private retainedError: Entry | null = null;
  persistence = true;
  private path: string;
  constructor(dir: string) {
    this.path = dir + "/diagnostics.jsonl";
    for (const path of [this.path + ".1", this.path]) {
      let fd: number | undefined;
      try {
        fd = openSync(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > LOG_FILE_BYTES)
          throw new Error("UNSAFE_LOG");
        const raw = readFileSync(fd, "utf8");
        for (const line of raw.split("\n")) {
          try {
            const e = JSON.parse(line);
            if (
              typeof e.time !== "string" ||
              !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(e.time) ||
              !Number.isFinite(Date.parse(e.time))
            )
              continue;
            this.entries.push(
              entry(
                {
                  ...e,
                  error:
                    typeof e.code === "string" && Object.hasOwn(hints, e.code)
                      ? new Error(e.code)
                      : undefined,
                },
                e.time,
              ),
            );
          } catch {}
        }
      } catch (e: any) {
        if (e.code !== "ENOENT") this.persistence = false;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    this.retainedError =
      [...this.entries].reverse().find((e) => e.level === "error" && e.code) ??
      null;
    this.entries = this.entries.slice(-LOG_ENTRIES);
  }
  record(input: LogInput) {
    const e = entry(input);
    if (e.level === "error" && e.code) this.retainedError = e;
    this.entries.push(e);
    this.entries = this.entries.slice(-LOG_ENTRIES);
    if (!this.persistence) return;
    let fd: number | undefined;
    try {
      const line = JSON.stringify(e) + "\n";
      fd = openSync(
        this.path,
        constants.O_CREAT |
          constants.O_APPEND |
          constants.O_WRONLY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600,
      );
      fchmodSync(fd, 0o600);
      if (!fstatSync(fd).isFile()) throw new Error("UNSAFE_LOG");
      if (fstatSync(fd).size + Buffer.byteLength(line) > LOG_FILE_BYTES) {
        closeSync(fd);
        fd = undefined;
        renameSync(this.path, this.path + ".1");
        fd = openSync(
          this.path,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            constants.O_NOFOLLOW,
          0o600,
        );
      }
      appendFileSync(fd, line);
    } catch {
      this.persistence = false;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  snapshot() {
    return {
      entries: structuredClone(this.entries),
      capacity: LOG_ENTRIES,
      fileByteLimit: LOG_FILE_BYTES,
      persistence: this.persistence,
    };
  }
  get lastError() {
    return structuredClone(this.retainedError);
  }
}
