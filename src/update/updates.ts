import { randomUUID } from "node:crypto";
import { failureReason, type FailureReason } from "./failure.js";
export interface LastOperation {
  id: string;
  sha: string;
  state: "applying" | "succeeded" | "failed" | "interrupted";
  at: number;
  phase?: "preparing" | "activating";
  reason?: FailureReason;
}
export const repository = "https://github.com/stevefortier/katafit-coach.git";
export const validSha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
export class Updates {
  latest: string | null = null;
  checkedAt = 0;
  applying = false;
  cleanupWarning = false;
  autoOutcome?: {
    sha: string;
    state: string;
    reason?:
      | "FAILED_TARGET"
      | "AUTO_UPDATE_BUSY"
      | "WORKER_STOP_UNCONFIRMED"
      | "LOCAL_UNAVAILABLE"
      | "AUTO_UPDATE_DISABLED";
  };
  accepted: Promise<void> = Promise.resolve();
  lastOperation: LastOperation | undefined;
  guidance = "Use a managed Linux launcher to enable upgrades.";
  private pending?: Promise<ReturnType<Updates["snapshot"]>>;
  constructor(
    public installed: string | null,
    readonly applyTarget: ((sha: string) => Promise<void>) | null,
    private readonly request: typeof fetch = fetch,
    private readonly persist?: (operation: LastOperation) => Promise<void>,
  ) {
    if (applyTarget) this.guidance = "Check for source updates.";
  }
  snapshot() {
    return {
      installed: this.installed,
      latest: this.latest,
      checkedAt: this.checkedAt,
      supported: !!this.applyTarget,
      applying: this.applying,
      guidance: this.guidance,
      lastOperation: this.lastOperation,
      autoOutcome: this.autoOutcome,
    };
  }
  validate(sha: unknown): string {
    if (this.applying) throw new Error("UPDATE_IN_PROGRESS");
    if (!validSha(sha)) throw new Error("TARGET_REJECTED");
    if (!this.latest || Date.now() - this.checkedAt > 300000)
      throw new Error("CHECK_FIRST");
    if (sha !== this.latest || sha === this.installed)
      throw new Error("TARGET_REJECTED");
    if (!this.applyTarget) throw new Error("UNSUPPORTED_INSTALLATION");
    return sha;
  }
  async apply(value: unknown) {
    const sha = this.validate(value);
    this.applying = true;
    this.cleanupWarning = false;
    this.lastOperation = {
      id: randomUUID(),
      sha,
      state: "applying",
      at: Date.now(),
      phase: "preparing",
    };
    this.accepted = this.persist?.(this.lastOperation) ?? Promise.resolve();
    this.guidance =
      "Preparing pinned source. Keep Studio open; worker stays stopped.";
    try {
      if (this.persist) await this.accepted;
      await this.applyTarget!(sha);
      this.installed = sha;
      if (
        this.autoOutcome?.sha === sha &&
        this.autoOutcome.state === "suppressed"
      )
        this.autoOutcome = undefined;
      this.guidance =
        "Upgrade healthy. Worker remains stopped; preview before Run." +
        (this.cleanupWarning
          ? " Cleanup incomplete; check protected home permissions before the next upgrade."
          : "");
    } catch (error) {
      this.lastOperation.reason = failureReason(error);
      this.guidance =
        error instanceof Error &&
        error.message === "EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED"
          ? "Upgrade failed: matching external artifact or native bootstrap required. Provision and preflight the exact candidate image outside Pi, then retry. Previous runtime was not replaced."
          : "Upgrade failed; previous version restored if available. Check free disk and Git/npm network access.";
      throw new Error("UPGRADE_FAILED");
    } finally {
      this.lastOperation = {
        ...this.lastOperation,
        state: this.installed === sha ? "succeeded" : "failed",
        at: Date.now(),
      };
      try {
        await this.persist?.(this.lastOperation);
      } catch {
        this.guidance +=
          " Outcome journal unavailable; restart reconciles the active revision.";
      }
      this.applying = false;
    }
  }
  async check() {
    if (this.pending) return this.pending;
    if (this.checkedAt && Date.now() - this.checkedAt < 60000)
      return this.snapshot();
    this.checkedAt = Date.now();
    this.latest = null;
    this.pending = (async () => {
      try {
        const response = await this.request(
          "https://api.github.com/repos/stevefortier/katafit-coach/git/ref/heads/main",
          {
            headers: {
              Accept: "application/vnd.github+json",
              "User-Agent": "katafit-coach",
            },
            signal: AbortSignal.timeout(10000),
            redirect: "error",
          },
        );
        if ([403, 429].includes(response.status)) {
          this.guidance =
            "GitHub rate limit. Wait before checking again (at least one minute).";
          return this.snapshot();
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (!response.body) throw new Error();
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 100000) throw new Error();
            chunks.push(value);
          }
        } finally {
          await reader.cancel();
        }
        const text = Buffer.concat(chunks).toString("utf8");
        const data = JSON.parse(text) as { object?: { sha: unknown } };
        if (!response.ok || !validSha(data.object?.sha)) throw new Error();
        this.latest = data.object.sha;
        this.guidance = this.applyTarget
          ? this.installed === this.latest
            ? "Installed source is current."
            : "New source available. Pause worker and finish preview before upgrading."
          : "Use a managed Linux launcher to enable upgrades.";
      } catch {
        this.guidance =
          "GitHub unavailable or timed out. Check network access and retry after one minute.";
      }
      return this.snapshot();
    })();
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }
}
