import { open, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { directory, managedFile } from "./managed.js";

export interface Operation {
  id: string;
  sha: string;
  state: "applying" | "succeeded" | "failed" | "interrupted";
  at: number;
  phase?: "preparing" | "activating";
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

/** One bounded, private last-operation receipt; no installer output or secrets. */
export class UpdateJournal {
  constructor(readonly home: string) {}
  async read(): Promise<Operation | undefined> {
    try {
      return validate(
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
  }
  async write(operation: Operation): Promise<void> {
    operation = validate(operation);
    await directory(this.home);
    const target = join(this.home, "update-operation.json");
    try {
      await managedFile(target, 2048);
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    const temporary = join(
      this.home,
      "update-operation." + randomUUID() + ".tmp",
    );
    try {
      const receipt = await open(temporary, "wx", 0o600);
      try {
        await receipt.writeFile(JSON.stringify(operation) + "\n");
        await receipt.sync();
      } finally {
        await receipt.close();
      }
      await rename(temporary, target);
      const parent = await open(
        this.home,
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
