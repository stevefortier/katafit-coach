import { join } from "node:path";
import { managedFile, directory } from "./managed.js";
import { open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { validSha } from "./updates.js";

/** Installation-wide consent, separate from persona/config revision. Missing is OFF. */
export class AutoUpdateSetting {
  constructor(readonly home: string) {}
  async read(): Promise<{ enabled: boolean }> {
    try {
      const value = JSON.parse(
        (await managedFile(join(this.home, "auto-update.json"), 128)).toString(
          "utf8",
        ),
      );
      if (
        Object.keys(value).join(",") !== "enabled" ||
        typeof value.enabled !== "boolean"
      )
        throw new Error("INVALID_AUTO_SETTING");
      return { enabled: value.enabled };
    } catch (error: any) {
      if (error.code === "ENOENT") return { enabled: false };
      throw error;
    }
  }
  async write(enabled: boolean) {
    await directory(this.home);
    await this.read(); // Refuse corrupt or redirected existing settings.
    const temp = join(this.home, `auto-update.${randomUUID()}.tmp`);
    try {
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ enabled }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, join(this.home, "auto-update.json"));
      const parent = await open(this.home, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await rm(temp, { force: true });
    }
  }
  async failedTarget(): Promise<string | null> {
    try {
      const value = JSON.parse(
        (await managedFile(join(this.home, "auto-failed.json"), 128)).toString(
          "utf8",
        ),
      );
      if (Object.keys(value).join(",") !== "sha" || !validSha(value.sha))
        throw new Error("INVALID_AUTO_FAILURE");
      return value.sha;
    } catch (e: any) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
  /** Forget a failure record once that exact revision is installed. */
  async clearFailed(installed: string) {
    if (!validSha(installed)) return;
    if ((await this.failedTarget()) !== installed) return;
    await rm(join(this.home, "auto-failed.json"), { force: true });
    const parent = await open(this.home, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
  async markFailed(sha: string) {
    if (!validSha(sha)) throw new Error("INVALID_AUTO_FAILURE");
    await this.failedTarget();
    const temp = join(this.home, `auto-failed.${randomUUID()}.tmp`);
    try {
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ sha }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, join(this.home, "auto-failed.json"));
      const parent = await open(this.home, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await rm(temp, { force: true });
    }
  }
}

export async function isMainDescendant(
  installed: string,
  latest: string,
  request: typeof fetch = fetch,
): Promise<boolean> {
  if (!validSha(installed) || !validSha(latest) || installed === latest)
    return false;
  try {
    const response = await request(
      `https://api.github.com/repos/stevefortier/katafit-coach/compare/${installed}...${latest}?per_page=1`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "katafit-coach",
        },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok || !response.body) return false;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) return false;
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return (
      data.status === "ahead" &&
      Number.isSafeInteger(data.ahead_by) &&
      data.ahead_by > 0
    );
  } catch {
    return false;
  }
}

/** Stable-owner scheduler; tick never overlaps and a failed SHA is never retried. */
export class AutoUpdater {
  private pending?: Promise<void>;
  constructor(
    readonly setting: AutoUpdateSetting,
    readonly hooks: {
      check: () => Promise<{ installed: string | null; latest: string | null }>;
      isDescendant: (installed: string, latest: string) => Promise<boolean>;
      apply: (sha: string) => Promise<void>;
      suppressed?: (sha: string) => void;
    },
  ) {}
  tick(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.run().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  async settle() {
    await this.pending?.catch(() => {});
  }
  private async run() {
    if (!(await this.setting.read()).enabled) return;
    const { installed, latest } = await this.hooks.check();
    // A later manual (or other) success supersedes an earlier failed attempt.
    if (validSha(installed)) await this.setting.clearFailed(installed);
    if (!validSha(installed) || !validSha(latest) || installed === latest)
      return;
    if (latest === (await this.setting.failedTarget())) {
      this.hooks.suppressed?.(latest);
      return;
    }
    if (!(await this.hooks.isDescendant(installed, latest))) return;
    if (!(await this.setting.read()).enabled) return;
    try {
      await this.hooks.apply(latest);
    } catch (error) {
      await this.setting.markFailed(latest);
      throw error;
    }
  }
}
