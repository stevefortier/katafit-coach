import { open, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isFailureReason, type FailureReason } from "./failure.js";
import { directory, managedFile } from "./managed.js";

export interface Operation {
  id: string;
  sha: string;
  state: "applying" | "succeeded" | "failed" | "interrupted";
  at: number;
  phase?: "preparing" | "activating";
  reason?: FailureReason;
}

function validate(value: unknown): Operation {
  const operation = value as Operation;
  const keys =
    value && typeof value === "object"
      ? Object.keys(value).sort().join(",")
      : "";
  if (
    !["at,id,sha,state", "at,id,phase,sha,state"].includes(keys) ||
    typeof operation.id !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      operation.id,
    ) ||
    typeof operation.sha !== "string" ||
    !/^[a-f0-9]{40}$/.test(operation.sha) ||
    !["applying", "succeeded", "failed", "interrupted"].includes(
      operation.state,
    ) ||
    !Number.isSafeInteger(operation.at) ||
    operation.at <= 0 ||
    (Object.hasOwn(operation, "phase") &&
      !["preparing", "activating"].includes(operation.phase!))
  )
    throw new Error("UPDATE_JOURNAL_INVALID");
  return structuredClone(operation);
}

/** Atomic private JSON write; refuses symlinked or oversized existing targets. */
async function atomicWrite(home: string, name: string, value: unknown) {
  await directory(home);
  const target = join(home, name);
  try {
    await managedFile(target, 2048);
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = join(home, name + "." + randomUUID() + ".tmp");
  try {
    const receipt = await open(temporary, "wx", 0o600);
    try {
      await receipt.writeFile(JSON.stringify(value) + "\n");
      await receipt.sync();
    } finally {
      await receipt.close();
    }
    await rename(temporary, target);
    const parent = await open(
      home,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * One bounded, private last-operation receipt; no installer output or secrets.
 * update-operation.json keeps the original key set so older launchers (rollback)
 * still read it. The fixed failure reason lives in a sidecar keyed by operation id.
 */
export class UpdateJournal {
  constructor(readonly home: string) {}
  async read(): Promise<Operation | undefined> {
    let operation: Operation;
    try {
      operation = validate(
        JSON.parse(
          (
            await managedFile(join(this.home, "update-operation.json"), 2048)
          ).toString("utf8"),
        ),
      );
    } catch (error: any) {
      if (error.code === "ENOENT") return undefined;
      throw new Error("UPDATE_JOURNAL_INVALID");
    }
    if (operation.state !== "failed") return operation;
    try {
      const failure = JSON.parse(
        (
          await managedFile(join(this.home, "update-failure.json"), 512)
        ).toString("utf8"),
      );
      if (
        Object.keys(failure).sort().join(",") === "id,reason" &&
        failure.id === operation.id &&
        isFailureReason(failure.reason)
      )
        operation.reason = failure.reason;
    } catch {
      // Missing or invalid sidecar only loses the diagnostic reason.
    }
    return operation;
  }
  async write(operation: Operation): Promise<void> {
    const { reason, ...base } = operation;
    const valid = validate(base);
    if (
      reason !== undefined &&
      (valid.state !== "failed" || !isFailureReason(reason))
    )
      throw new Error("UPDATE_JOURNAL_INVALID");
    if (valid.state === "failed" && reason)
      await atomicWrite(this.home, "update-failure.json", {
        id: valid.id,
        reason,
      });
    else await rm(join(this.home, "update-failure.json"), { force: true });
    await atomicWrite(this.home, "update-operation.json", valid);
  }
  async recover(installed: string | null): Promise<Operation | undefined> {
    const operation = await this.read();
    if (!operation || operation.state !== "applying") return operation;
    const recovered: Operation = {
      id: operation.id,
      sha: operation.sha,
      state: installed === operation.sha ? "succeeded" : "interrupted",
      at: Date.now(),
    };
    await this.write(recovered);
    return recovered;
  }
}
