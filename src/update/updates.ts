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
  checking = false;
  sourceRetryAt?: number | null;
  private cooldownGeneration = 0;

  readonly sourceRequest: typeof fetch = async (input, init) => {
    if (this.sourceRetryAt && Date.now() < this.sourceRetryAt)
      throw new Error("RATE_LIMITED");
    const response = await this.request(input, init);
    if ([403, 429].includes(response.status)) {
      const limited =
        response.status === 429 ||
        response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.has("retry-after");
      if (limited) {
        const now = Date.now();
        let deadline = now + 900000;
        const accept = (value: number) => {
          // Reject deadlines that would overflow Node's signed 32-bit timer.
          if (
            Number.isSafeInteger(value) &&
            value - now <= 2147483647 &&
            value > deadline
          )
            deadline = value;
        };
        const retry = response.headers.get("retry-after") ?? "";
        if (/^\d+$/.test(retry)) accept(now + Number(retry) * 1000);
        else if (
          /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
            retry,
          )
        ) {
          const date = Date.parse(retry);
          if (Number.isFinite(date) && new Date(date).toUTCString() === retry)
            accept(date);
        }
        const reset = response.headers.get("x-ratelimit-reset") ?? "";
        if (/^\d+$/.test(reset)) accept(Number(reset) * 1000);
        this.cooldownGeneration++;
        this.sourceRetryAt = Math.max(this.sourceRetryAt ?? 0, deadline);
        this.latest = null;
        this.checkError = "RATE_LIMITED";
        this.guidance = "GitHub rate limit. Source check failed.";
      }
      await response.body?.cancel();
      throw new Error(limited ? "RATE_LIMITED" : "FORBIDDEN");
    }
    return response;
  };
  checkError: "RATE_LIMITED" | "FORBIDDEN" | "UNAVAILABLE" | null = null;
  applying = false;
  preparing = false;
  preparationSupported = false;
  manualRestartSupported = false;
  recovering = false;
  cleanupWarning = false;
  recoveryOutcome?: {
    sha: string;
    state: string;
    reason?: "LOCAL_UNAVAILABLE";
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
    private readonly prepareTarget?: (sha: string) => Promise<void>,
    private readonly cancelPreparedTarget?: (sha: string) => Promise<void>,
  ) {
    if (applyTarget) this.guidance = "Check for source updates.";
    this.preparationSupported = !!prepareTarget;
  }
  snapshot() {
    return {
      serverNow: Date.now(),
      installed: this.installed,
      latest: this.latest,
      checkedAt: this.checkedAt,
      checking: this.checking,
      checkError: this.checkError,
      sourceRetryAt: this.sourceRetryAt,

      supported: !!this.applyTarget,
      applying: this.applying,
      preparing: this.preparing,
      preparationSupported: this.preparationSupported,
      manualRestartSupported: this.manualRestartSupported,
      recovering: this.recovering,
      cleanupWarning: this.cleanupWarning,
      guidance: this.guidance,
      lastOperation: this.lastOperation,
      recoveryOutcome: this.recoveryOutcome,
    };
  }
  validate(sha: unknown): string {
    if (this.applying || this.preparing) throw new Error("UPDATE_IN_PROGRESS");
    if (!validSha(sha)) throw new Error("TARGET_REJECTED");
    if (!this.latest || Date.now() - this.checkedAt > 300000)
      throw new Error("CHECK_FIRST");
    if (sha !== this.latest || sha === this.installed)
      throw new Error("TARGET_REJECTED");
    if (!this.applyTarget) throw new Error("UNSUPPORTED_INSTALLATION");
    return sha;
  }
  validatePrepared(sha: unknown): string {
    if (this.applying) throw new Error("UPDATE_IN_PROGRESS");
    if (!validSha(sha) || sha !== this.latest || sha === this.installed)
      throw new Error("TARGET_REJECTED");
    if (!this.applyTarget) throw new Error("UNSUPPORTED_INSTALLATION");
    return sha;
  }
  async prepare(value: unknown) {
    const sha = this.validate(value);
    if (!this.prepareTarget) return;
    this.preparing = true;
    this.guidance =
      "Preparing and validating pinned source while Coach remains available.";
    try {
      await this.prepareTarget(sha);
    } finally {
      this.preparing = false;
    }
  }
  async cancelPreparation(value: unknown) {
    if (!validSha(value)) return;
    await this.cancelPreparedTarget?.(value);
  }
  async recordPreparationFailure(sha: string, error: unknown) {
    this.lastOperation = {
      id: randomUUID(),
      sha,
      state: "failed",
      at: Date.now(),
      phase: "preparing",
      reason: failureReason(error),
    };
    this.guidance =
      this.lastOperation.reason === "LAUNCHER_UPGRADE_REQUIRED"
        ? "Launcher upgrade required: install a reviewed compatible stable owner side by side before migrating the protected skill catalog. Keep the full home and linked history intact."
        : "Upgrade preparation failed before Coach was stopped. Check free disk and Git/npm network access.";
    if (this.cleanupWarning)
      this.guidance +=
        " Candidate cleanup is incomplete and must succeed before this revision can be staged again.";
    await this.persist?.(this.lastOperation);
  }
  async apply(value: unknown, _resume = false, prepared = false) {
    let sha: string;
    if (!prepared && this.prepareTarget) {
      sha = this.validate(value);
      try {
        await this.prepare(sha);
      } catch (error) {
        await this.recordPreparationFailure(sha, error).catch(() => {});
        this.guidance =
          error instanceof Error &&
          error.message === "EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED"
            ? "Upgrade failed: matching external artifact or native bootstrap required. Provision and preflight the exact candidate image outside Pi, then retry. Previous runtime was not replaced."
            : this.guidance;
        if (this.cleanupWarning && !/cleanup/i.test(this.guidance))
          this.guidance +=
            " Candidate cleanup is incomplete and must succeed before this revision can be staged again.";
        throw new Error("UPGRADE_FAILED");
      }
      prepared = true;
      sha = this.validatePrepared(sha);
    } else {
      sha = prepared ? this.validatePrepared(value) : this.validate(value);
    }
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
      if (this.cleanupWarning)
        this.guidance +=
          " Candidate cleanup is incomplete and must succeed before this revision can be staged again.";
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
    if (this.sourceRetryAt && Date.now() < this.sourceRetryAt)
      return this.snapshot();
    if (this.checkedAt && Date.now() - this.checkedAt < 60000)
      return this.snapshot();
    this.checkedAt = Date.now();
    this.latest = null;
    this.checking = true;
    const generation = this.cooldownGeneration;
    this.pending = (async () => {
      try {
        const response = await this.sourceRequest(
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
        if (generation !== this.cooldownGeneration)
          throw new Error("RATE_LIMITED");
        this.latest = data.object.sha;
        this.sourceRetryAt = null;
        this.checkError = null;
        this.guidance = this.applyTarget
          ? this.installed === this.latest
            ? "Installed source is current."
            : "New source available. Pause worker and finish preview before upgrading."
          : "Use a managed Linux launcher to enable upgrades.";
      } catch (error) {
        if (generation !== this.cooldownGeneration)
          error = new Error("RATE_LIMITED");
        this.checkError =
          error instanceof Error &&
          (error.message === "RATE_LIMITED" || error.message === "FORBIDDEN")
            ? error.message
            : "UNAVAILABLE";
        this.guidance =
          this.checkError === "RATE_LIMITED"
            ? "GitHub rate limit. Source check failed."
            : this.checkError === "FORBIDDEN"
              ? "GitHub denied the source check (HTTP 403). Rate limiting was not confirmed."
              : "GitHub unavailable or timed out. Source check failed; check network access.";
      } finally {
        this.checking = false;
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
