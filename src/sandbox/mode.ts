import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { windows } from "../runtime/platform.js";

/**
 * Where Pi sessions run: "docker" (the hardened container) or "workspace"
 * (Pi as a permission-limited process with just-bash tools, no Docker).
 * Installation-owned: `sandbox.json` in Coach's home, `{"mode":"workspace"}`.
 * Absent means Docker (workspace on Windows, where Docker mode cannot run);
 * anything unreadable or invalid fails closed.
 */
export type SandboxMode = "docker" | "workspace";
export const sandboxModeFile = (home: string) => join(home, "sandbox.json");

export async function sandboxMode(home: string): Promise<SandboxMode> {
  let file;
  try {
    file = await open(
      sandboxModeFile(home),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error: any) {
    // Docker mode is Linux-only: without a choice, Windows runs workspace.
    if (error?.code === "ENOENT") return windows ? "workspace" : "docker";
    throw new Error("SANDBOX_MODE_INVALID");
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 256)
      throw new Error("SANDBOX_MODE_INVALID");
    const value = JSON.parse((await file.readFile()).toString("utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).join() !== "mode" ||
      (value.mode !== "docker" && value.mode !== "workspace")
    )
      throw new Error("SANDBOX_MODE_INVALID");
    return value.mode;
  } catch {
    throw new Error("SANDBOX_MODE_INVALID");
  } finally {
    await file.close();
  }
}
