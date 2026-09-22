import { open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Store } from "../config/store.js";
import { admin } from "../server/admin.js";
// Preserve the pre-updater macOS Studio path; it does not support source apply.
export async function legacyServe(store: Store, port: number) {
  await store.init();
  const lockPath = join(store.dir, "service.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
    const pid = Number(await readFile(lockPath, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("INVALID_LOCK");
    try {
      process.kill(pid, 0);
      throw new Error("ALREADY_RUNNING");
    } catch (check: any) {
      if (check.code !== "ESRCH") throw check;
    }
    await unlink(lockPath);
    lock = await open(lockPath, "wx", 0o600);
  }
  await lock.writeFile(String(process.pid));
  await lock.close();
  let app: Awaited<ReturnType<typeof admin>> | undefined,
    closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app?.close();
    await unlink(join(store.dir, "service.json")).catch(() => {});
    await unlink(lockPath).catch(() => {});
  };
  try {
    app = await admin(store, port, undefined, () => void close());
    await store.atomic("service", { origin: app.origin, pid: process.pid });
    process.once("SIGTERM", () => void close());
    process.once("SIGINT", () => void close());
    console.log(
      "Kata.fit Coach Studio listening at " +
        app.origin +
        " (source upgrades require managed Linux; worker stopped).",
    );
  } catch (e) {
    await close();
    throw e;
  }
}
