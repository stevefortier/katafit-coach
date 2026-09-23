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
  "provider-response",
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
  rejection?: { kind: string; attempt: number; reason: string; text: string };
  preview?: string;
  shape?: ProviderShape;
}
export interface ProviderShape {
  toolChoice: "auto" | "none" | "required" | "default-auto";
  toolCount: number;
  toolNames: string[];
  messageCount: number;
  lastRole: "system" | "user" | "assistant" | "tool";
  lastContentShape: "text" | "text-parts" | "multimodal" | "other";
  previewSource: "last-message";
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
  rejection?: { kind: string; attempt: number; reason: string; text: string };
  preview?: string;
  shape?: ProviderShape;
}
export const LOG_ENTRIES = 500;
export const LOG_FILE_BYTES = 256 * 1024;
const credentialPattern =
  /(?:(?:kcoach_|rgn_coach_)[a-z0-9_\-]+|Bearer\s+\S+|-----BEGIN[^-]*PRIVATE KEY|sk-[a-z0-9_-]{12,}|redacted:sk-)/i;
const operationalWords = new Set([
  "please",
  "list",
  "available",
  "tools",
  "tool",
  "read",
  "status",
  "show",
  "the",
  "current",
  "result",
  "results",
  "now",
  "and",
  "count",
]);
export function safeProviderPreview(text: unknown): text is string {
  return (
    typeof text === "string" &&
    text.length > 0 &&
    text.length <= 100 &&
    !credentialPattern.test(text) &&
    !/[\\<>/@_={}\[\]0-9]/.test(text) &&
    /^[A-Za-z .,?!:'"\n-]+$/.test(text) &&
    !!text.trim() &&
    !!text
      .match(/[A-Za-z]+/g)
      ?.every((word) => operationalWords.has(word.toLowerCase()))
  );
}
function safeProviderShape(value: unknown): value is ProviderShape {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  return (
    ["auto", "none", "required", "default-auto"].includes(
      s.toolChoice as string,
    ) &&
    Number.isInteger(s.toolCount) &&
    (s.toolCount as number) >= 0 &&
    (s.toolCount as number) <= 64 &&
    Array.isArray(s.toolNames) &&
    s.toolNames.length === s.toolCount &&
    s.toolNames.every(
      (name: unknown) =>
        typeof name === "string" &&
        /^(?:coach_|studio_operator_)[a-z_]{1,48}$/.test(name),
    ) &&
    Number.isInteger(s.messageCount) &&
    (s.messageCount as number) > 0 &&
    (s.messageCount as number) <= 100 &&
    ["system", "user", "assistant", "tool"].includes(s.lastRole as string) &&
    ["text", "text-parts", "multimodal", "other"].includes(
      s.lastContentShape as string,
    ) &&
    s.previewSource === "last-message"
  );
}
function safeRejectionText(text: string, code: ErrorCode | undefined) {
  if (credentialPattern.test(text)) return false;
  if (code === "TASK_OUTPUT_JSON") return !/\\u[0-9a-f]{4}/i.test(text);
  try {
    return !credentialPattern.test(JSON.stringify(JSON.parse(text)));
  } catch {
    return false;
  }
}
// The sole content exception is a bounded, credential-screened typed-task
// rejection. Studio logs are owner-authenticated and stored mode 0600; copies
// and downloads can contain private meal/health data and must be treated as such.
function entry(input: LogInput, time = new Date().toISOString()): Entry {
  const error = input.error === undefined ? undefined : safeError(input.error);
  const rejection = input.rejection;
  const showRejection =
    input.stage === "task-output-correction" &&
    ["TASK_OUTPUT_JSON", "TASK_OUTPUT_SCHEMA", "TASK_OUTPUT_SEMANTIC"].includes(
      error?.code ?? "",
    ) &&
    rejection &&
    /^[a-z_]{1,40}$/.test(rejection.kind) &&
    [1, 2].includes(rejection.attempt) &&
    typeof rejection.reason === "string" &&
    Buffer.byteLength(rejection.reason) <= 24000 &&
    typeof rejection.text === "string" &&
    Buffer.byteLength(rejection.text) <= 24000 &&
    safeRejectionText(rejection.text, error?.code) &&
    !credentialPattern.test(rejection.reason);
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
    ...(input.source === "provider" &&
    input.stage === "provider-payload" &&
    safeProviderShape(input.shape)
      ? {
          shape: {
            toolChoice: input.shape.toolChoice,
            toolCount: input.shape.toolCount,
            toolNames: [...input.shape.toolNames],
            messageCount: input.shape.messageCount,
            lastRole: input.shape.lastRole,
            lastContentShape: input.shape.lastContentShape,
            previewSource: input.shape.previewSource,
          },
          ...(safeProviderPreview(input.preview)
            ? { preview: input.preview }
            : {}),
        }
      : {}),
    ...(showRejection
      ? {
          rejection: {
            kind: rejection.kind,
            attempt: rejection.attempt,
            reason: rejection.reason,
            text: rejection.text,
          },
        }
      : {}),
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
