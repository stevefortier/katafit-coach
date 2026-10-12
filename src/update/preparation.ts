import { join } from "node:path";
import { atomicWrite } from "./journal.js";
import { managedFile } from "./managed.js";
import { isFailureReason, type FailureReason } from "./failure.js";

export const preparationStages = [
  "source",
  "artifact",
  "probe",
  "cleanup",
] as const;
export const artifactReasons = [
  "MISSING_MATCHING_ARTIFACT",
  "DOCKER_UNAVAILABLE",
  "INVALID_BINDING",
  "PROBE_FAILED",
  "CLEANUP_PENDING",
] as const;
export type ArtifactReason = (typeof artifactReasons)[number];
export interface PreparationAttempt {
  id: string;
  sha: string;
  stage: (typeof preparationStages)[number];
  state:
    | "preparing"
    | "ready"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  at: number;
  reason?: FailureReason;
  artifactReason?: ArtifactReason;
  durable: boolean;
}
export function artifactReason(error: unknown): ArtifactReason | undefined {
  const value = (error as { artifactReason?: unknown } | null)?.artifactReason;
  return artifactReasons.includes(value as ArtifactReason)
    ? (value as ArtifactReason)
    : undefined;
}
export function artifactFailure(reason: ArtifactReason): Error {
  return Object.assign(new Error("EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED"), {
    artifactReason: reason,
  });
}
export function validatePreparation(value: unknown): PreparationAttempt {
  const v = value as PreparationAttempt;
  if (
    !v ||
    typeof v !== "object" ||
    Object.keys(v).some(
      (k) =>
        ![
          "id",
          "sha",
          "stage",
          "state",
          "at",
          "reason",
          "artifactReason",
          "durable",
        ].includes(k),
    ) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      v.id,
    ) ||
    !/^[a-f0-9]{40}$/.test(v.sha) ||
    !preparationStages.includes(v.stage) ||
    ![
      "preparing",
      "ready",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ].includes(v.state) ||
    !Number.isSafeInteger(v.at) ||
    v.at <= 0 ||
    typeof v.durable !== "boolean" ||
    (v.reason !== undefined && !isFailureReason(v.reason)) ||
    (v.artifactReason !== undefined &&
      !artifactReasons.includes(v.artifactReason))
  )
    throw new Error("UPDATE_PREPARATION_JOURNAL_INVALID");
  return structuredClone(v);
}
/** Separate owner observation, never an accepted installation receipt. */
export class PreparationJournal {
  constructor(readonly home: string) {}
  issue?: "PREPARATION_JOURNAL_UNAVAILABLE";
  private async read(): Promise<PreparationAttempt | undefined> {
    try {
      return validatePreparation(
        JSON.parse(
          (
            await managedFile(join(this.home, "update-preparation.json"), 2048)
          ).toString(),
        ),
      );
    } catch (error: any) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  async write(attempt: PreparationAttempt) {
    try {
      // Preserve corrupt evidence. Only a valid or absent diagnostic may be replaced.
      await this.read();
      await atomicWrite(
        this.home,
        "update-preparation.json",
        validatePreparation({ ...attempt, durable: true }),
      );
      this.issue = undefined;
    } catch {
      this.issue = "PREPARATION_JOURNAL_UNAVAILABLE";
      throw new Error(this.issue);
    }
  }
  async recover(): Promise<PreparationAttempt | undefined> {
    let attempt: PreparationAttempt | undefined;
    try {
      attempt = await this.read();
    } catch {
      this.issue = "PREPARATION_JOURNAL_UNAVAILABLE";
      return undefined;
    }
    if (!attempt) return undefined;
    if (attempt.state === "preparing") {
      attempt = { ...attempt, state: "interrupted", at: Date.now() };
      await this.write(attempt).catch(() => {
        attempt!.durable = false;
      });
    } else if (attempt.state === "ready") {
      // Readiness was completed, but its process-local reservation is gone.
      // This says nothing about installation acceptance or activation: those
      // remain exclusively in the separate operation journal. Preserve the
      // actual preparation time rather than inventing a restart-time failure.
      attempt = { ...attempt, state: "completed" };
      await this.write(attempt).catch(() => {
        attempt!.durable = false;
      });
    }
    return attempt;
  }
}
