import { randomUUID } from "node:crypto";
import {
  discoverRelease,
  boundedBytes,
  requestOptions,
  type Manifest,
} from "../release/manifest.js";
import { failureReason, type FailureReason } from "./failure.js";
import { artifactReason, type PreparationAttempt } from "./preparation.js";
export type Readiness = {
  sha: string;
  fingerprint: string;
  checkedAt: number;
  observedAt: number;
  state: "ready" | "delivery-pending" | "blocked";
  reason?:
    | "MISSING_MATCHING_ARTIFACT"
    | "DOCKER_UNAVAILABLE"
    | "INVALID_BINDING"
    | "LOCAL_UNAVAILABLE";
};
export interface LastOperation {
  id: string;
  sha: string;
  state: "applying" | "succeeded" | "failed" | "interrupted";
  at: number;
  phase?: "preparing" | "activating";
  reason?: FailureReason;
}
export const validPreparationToken = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export const repository = "https://github.com/stevefortier/katafit-coach.git";
export const validSha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
export class Updates {
  sourceChannel: "ready-releases-v1" | "legacy-or-unknown" =
    "ready-releases-v1";
  readinessProtocol = 1;
  readinessSupported = false;
  readiness?: Readiness;
  private releaseTarget?: Manifest;
  private stateSequence = 0;
  private localPending?: Promise<void>;
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
        this.readiness = undefined;
        this.releaseTarget = undefined;
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
  preparationProtocol = 2;
  preparationSupported = false;
  preparationOutcomeSupported = false;
  preparationAttempt?: PreparationAttempt;
  preparationJournalIssue?: "PREPARATION_JOURNAL_UNAVAILABLE";
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
  private preparationHeld = false;
  private pending?: Promise<ReturnType<Updates["snapshot"]>>;
  constructor(
    public installed: string | null,
    readonly applyTarget: ((sha: string) => Promise<void>) | null,
    private readonly request: typeof fetch = fetch,
    private readonly persist?: (operation: LastOperation) => Promise<void>,
    private readonly prepareTarget?: (
      sha: string,
      token: string,
    ) => Promise<void>,
    private readonly cancelPreparedTarget?: (
      sha: string,
      token: string,
    ) => Promise<void>,
    private readonly persistPreparation?: (
      attempt: PreparationAttempt,
    ) => Promise<void>,
    private readonly observeReadiness?: (target: Manifest) => Promise<string>,
  ) {
    this.readinessSupported = !!observeReadiness;
    if (applyTarget) this.guidance = "Check for source updates.";
    this.preparationSupported = !!prepareTarget;
    this.preparationOutcomeSupported = !!persistPreparation;
  }
  snapshot() {
    return {
      stateSequence: ++this.stateSequence,
      serverNow: Date.now(),
      sourceChannel:
        this.sourceChannel === "ready-releases-v1"
          ? ("ready-releases-v1" as const)
          : ("legacy-or-unknown" as const),
      installed: this.installed,
      latest: this.latest,
      readinessProtocol: this.readinessProtocol,
      readinessSupported: this.readinessSupported,
      readiness:
        this.readinessSupported &&
        this.readinessProtocol === 1 &&
        this.readiness?.sha === this.latest &&
        this.readiness?.checkedAt === this.checkedAt &&
        Date.now() - this.checkedAt <= 300000 &&
        !this.checkError &&
        !(this.sourceRetryAt && Date.now() < this.sourceRetryAt)
          ? this.readiness
          : undefined,
      checkedAt: this.checkedAt,
      checking: this.checking,
      checkError: this.checkError,
      sourceRetryAt: this.sourceRetryAt,

      supported: !!this.applyTarget,
      applying: this.applying,
      preparing: this.preparing,
      preparationProtocol: this.preparationProtocol,
      preparationSupported: this.preparationSupported,
      preparationOutcomeSupported: this.preparationOutcomeSupported,
      preparationAttempt: this.preparationAttempt,
      preparationJournalIssue: this.preparationJournalIssue,
      manualRestartSupported: this.manualRestartSupported,
      recovering: this.recovering,
      cleanupWarning: this.cleanupWarning,
      guidance: this.guidance,
      lastOperation: this.lastOperation,
      recoveryOutcome: this.recoveryOutcome,
    };
  }
  /** Manual local observation never renews remote approval or contacts source. */
  private heldApproval(value: unknown, token?: string) {
    return (
      validPreparationToken(token) &&
      this.preparationHeld &&
      this.preparationAttempt?.state === "ready" &&
      this.preparationAttempt.sha === value &&
      this.preparationAttempt.id === token
    );
  }
  async refreshReadiness(value: unknown = this.latest, token?: string) {
    if (value !== this.latest) throw new Error("TARGET_REJECTED");
    if (this.localPending) {
      await this.localPending;
      return this.snapshot();
    }
    const target = this.releaseTarget;
    const checkedAt = this.checkedAt,
      generation = this.cooldownGeneration;
    const current = () =>
      target === this.releaseTarget &&
      target?.revision === this.latest &&
      this.checkedAt === checkedAt &&
      generation === this.cooldownGeneration &&
      (Date.now() - checkedAt <= 300000 || this.heldApproval(value, token)) &&
      !this.checkError &&
      !(this.sourceRetryAt && Date.now() < this.sourceRetryAt);
    this.readiness = undefined;
    if (!target || !this.observeReadiness || !current()) return this.snapshot();
    this.localPending = (async () => {
      let result: Readiness = {
        sha: target.revision,
        fingerprint: target.fingerprint,
        checkedAt,
        observedAt: Date.now(),
        state: "ready",
      };
      try {
        await this.observeReadiness!(structuredClone(target));
      } catch (error) {
        const reason = artifactReason(error);
        result.state =
          reason === "MISSING_MATCHING_ARTIFACT"
            ? "delivery-pending"
            : "blocked";
        result.reason =
          reason === "MISSING_MATCHING_ARTIFACT" ||
          reason === "DOCKER_UNAVAILABLE" ||
          reason === "INVALID_BINDING"
            ? reason
            : "LOCAL_UNAVAILABLE";
      }
      result.observedAt = Date.now();
      if (current()) this.readiness = result;
    })();
    try {
      await this.localPending;
    } finally {
      this.localPending = undefined;
    }
    return this.snapshot();
  }
  async assertReady(value: unknown, token?: string) {
    if (!this.readinessSupported || this.readinessProtocol !== 1)
      throw new Error("LAUNCHER_UPGRADE_REQUIRED");
    await this.refreshReadiness(value, token);
    this.validateReadiness(value, token);
  }
  validateReadiness(value: unknown, token?: string) {
    if (!this.readinessSupported || this.readinessProtocol !== 1)
      throw new Error("LAUNCHER_UPGRADE_REQUIRED");
    const ready =
      this.heldApproval(value, token) &&
      this.readiness?.sha === this.latest &&
      this.readiness?.checkedAt === this.checkedAt &&
      !this.checkError &&
      !(this.sourceRetryAt && Date.now() < this.sourceRetryAt)
        ? this.readiness
        : this.snapshot().readiness;
    if (!ready || ready.sha !== value || ready.state !== "ready")
      throw new Error(
        ready?.state === "delivery-pending"
          ? "UPDATE_DELIVERY_PENDING"
          : "UPDATE_READINESS_BLOCKED",
      );
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
  async prepare(value: unknown, token = randomUUID() as string) {
    const sha = this.validate(value);
    if (!this.prepareTarget) return;
    if (!validPreparationToken(token)) throw new Error("TARGET_REJECTED");
    if (this.preparationHeld) throw new Error("UPDATE_IN_PROGRESS");
    await this.assertReady(sha);
    this.validate(sha);
    if (this.preparationHeld) throw new Error("UPDATE_IN_PROGRESS");
    this.preparing = true;
    this.guidance =
      "Preparing and validating pinned source while Coach remains available.";
    this.preparationAttempt = {
      id: token,
      sha,
      state: "preparing",
      stage: "source",
      at: Date.now(),
      durable: false,
    };
    try {
      await this.savePreparation();
      this.preparationHeld = true;
      await this.prepareTarget(sha, token);
      this.preparationAttempt.state = "ready";
      this.preparationAttempt.at = Date.now();
      await this.savePreparation();
      this.guidance =
        "Pinned candidate ready. Installation still requires confirmed safe admission.";
    } catch (error) {
      try {
        await this.cancelPreparedTarget?.(sha, token);
        this.preparationHeld = false;
      } catch {
        error = new Error("UPDATE_CLEANUP_PENDING");
      }
      this.preparationAttempt.state =
        error instanceof Error && error.message === "BUILD_CANCELLED"
          ? "cancelled"
          : "failed";
      this.preparationAttempt.reason = failureReason(error);
      const subreason = artifactReason(error);
      if (subreason) this.preparationAttempt.artifactReason = subreason;
      this.preparationAttempt.at = Date.now();
      await this.savePreparation().catch(() => {});
      this.guidance =
        "Candidate preparation failed before Coach was stopped. No installation was accepted.";
      if (!this.preparationAttempt.durable)
        this.guidance +=
          " Preparation outcome is process-local; owner journal unavailable or unsupported.";
      throw error;
    } finally {
      this.preparing = false;
    }
  }
  async cancelPreparation(value: unknown, token?: string) {
    if (
      !validSha(value) ||
      !validPreparationToken(token) ||
      this.preparationAttempt?.sha !== value ||
      this.preparationAttempt.id !== token ||
      this.preparing ||
      this.applying ||
      (!this.preparationHeld && this.preparationAttempt.state !== "cancelled")
    )
      throw new Error("TARGET_REJECTED");
    try {
      await this.cancelPreparedTarget?.(value, token);
    } catch {
      this.preparationAttempt.state = "failed";
      this.preparationAttempt.reason = "UPDATE_CLEANUP_PENDING";
      this.preparationAttempt.stage = "cleanup";
      this.preparationAttempt.at = Date.now();
      await this.savePreparation().catch(() => {});
      this.guidance =
        "Candidate cleanup failed. Ownership is retained until cleanup succeeds; no installation was accepted.";
      throw new Error("UPDATE_CLEANUP_PENDING");
    }
    if (
      ["ready", "cancelled", "failed"].includes(this.preparationAttempt.state)
    ) {
      this.preparationAttempt.state = "cancelled";
      delete this.preparationAttempt.reason;
      delete this.preparationAttempt.artifactReason;
      this.preparationAttempt.at = Date.now();
      await this.savePreparation();
      this.preparationHeld = false;
      this.guidance =
        "Prepared candidate cancelled. No installation was accepted.";
    }
  }
  private async savePreparation() {
    const attempt = this.preparationAttempt!;
    attempt.durable = false;
    if (this.persistPreparation) {
      try {
        await this.persistPreparation(attempt);
        attempt.durable = true;
        this.preparationJournalIssue = undefined;
      } catch {
        this.preparationJournalIssue = "PREPARATION_JOURNAL_UNAVAILABLE";
        throw new Error("PREPARATION_JOURNAL_UNAVAILABLE");
      }
    }
  }
  async preparationStage(stage: PreparationAttempt["stage"]) {
    if (
      !this.preparationAttempt ||
      this.preparationAttempt.state !== "preparing"
    )
      return;
    this.preparationAttempt.stage = stage;
    this.preparationAttempt.at = Date.now();
    await this.savePreparation();
  }
  async recordPreparationFailure(_sha: string, _error: unknown) {
    // prepare() owns the observation. Never overwrite an accepted install receipt.
  }
  async apply(
    value: unknown,
    _resume = false,
    prepared = false,
    token?: string,
  ) {
    let sha: string;
    if (!prepared && this.prepareTarget) {
      sha = this.validate(value);
      await this.assertReady(sha);
      try {
        token = randomUUID();
        await this.prepare(sha, token);
      } catch (error) {
        if (
          error instanceof Error &&
          [
            "UPDATE_DELIVERY_PENDING",
            "UPDATE_READINESS_BLOCKED",
            "LAUNCHER_UPGRADE_REQUIRED",
          ].includes(error.message)
        )
          throw error;
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
    if (
      prepared &&
      this.prepareTarget &&
      (this.preparationAttempt?.state !== "ready" ||
        this.preparationAttempt.sha !== sha ||
        this.preparationAttempt.id !== token)
    )
      throw new Error("TARGET_REJECTED");
    this.validateReadiness(sha, token);
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
        "Upgrade healthy. Verify live worker and restart status before Run." +
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
      this.preparationHeld = false;
      this.applying = false;
    }
  }
  private async sourceIsAhead(
    request: typeof fetch,
    base: string,
    head: string,
  ): Promise<boolean> {
    if (!validSha(base) || !validSha(head) || base === head) return false;
    const url = `https://api.github.com/repos/stevefortier/katafit-coach/compare/${base}...${head}`;
    // GitHub includes up to 300 file patches on page one, even with per_page=1.
    // Page two retains comparison-wide metadata without those patches. For a
    // one-commit relation it has no commits; on longer histories its last commit
    // need not be head. The exact immutable comparison URL binds the head instead.
    // https://docs.github.com/en/rest/commits/commits#compare-two-commits
    const comparison = JSON.parse(
      (
        await boundedBytes(
          await request(`${url}?per_page=1&page=2`, requestOptions()),
          256 * 1024,
        )
      ).toString(),
    );
    return (
      comparison !== null &&
      typeof comparison === "object" &&
      !Array.isArray(comparison) &&
      comparison.url === url &&
      comparison.status === "ahead" &&
      comparison.base_commit?.sha === base &&
      comparison.merge_base_commit?.sha === base &&
      Number.isSafeInteger(comparison.ahead_by) &&
      comparison.ahead_by > 0 &&
      comparison.behind_by === 0 &&
      Number.isSafeInteger(comparison.total_commits) &&
      comparison.total_commits === comparison.ahead_by
    );
  }
  /** Fixed HTTPS immutable published-source channel. Artifact provenance is
   * verified externally before Docker/code staging; no daemon gh/credentials. */
  async readyRelease(request: typeof fetch): Promise<string> {
    const manifest = (await discoverRelease(request)).manifest;
    const sha = manifest.revision;
    // Release contents-write authority is not reviewed-main authority. An
    // unsigned manifest may select source, never authorize branch execution.
    const ref = JSON.parse(
      (
        await boundedBytes(
          await request(
            "https://api.github.com/repos/stevefortier/katafit-coach/git/ref/heads/main",
            requestOptions(),
          ),
          100000,
        )
      ).toString(),
    );
    const main = ref.object?.sha;
    if (!validSha(main)) throw Error("MAIN_SOURCE_UNKNOWN");
    if (sha !== main && !(await this.sourceIsAhead(request, sha, main)))
      throw Error("READY_SOURCE_NOT_REVIEWED_MAIN");
    if (!validSha(this.installed)) throw Error("INSTALLED_SOURCE_UNKNOWN");
    if (sha === this.installed) {
      this.releaseTarget = manifest;
      return sha;
    }
    const installed = this.installed;
    if (
      !(await this.sourceIsAhead(request, installed, sha)) ||
      this.installed !== installed
    )
      throw Error("READY_SOURCE_NOT_AHEAD");
    this.releaseTarget = manifest;
    return sha;
  }
  async check() {
    if (this.pending) return this.pending;
    if (this.sourceRetryAt && Date.now() < this.sourceRetryAt)
      return this.snapshot();
    if (this.checkedAt && Date.now() - this.checkedAt < 60000)
      return this.refreshReadiness();
    this.checkedAt = Date.now();
    this.latest = null;
    this.readiness = undefined;
    this.releaseTarget = undefined;
    this.checking = true;
    const generation = this.cooldownGeneration;
    this.pending = (async () => {
      try {
        const sha = await this.readyRelease(this.sourceRequest);
        if (generation !== this.cooldownGeneration)
          throw new Error("RATE_LIMITED");
        this.latest = sha;
        this.sourceRetryAt = null;
        this.checkError = null;
        await this.refreshReadiness();
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
