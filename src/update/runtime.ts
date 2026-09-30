import { Updates } from "./updates.js";

import { pathToFileURL } from "node:url";
import { join } from "node:path";
const [root, home, port, nonce] = process.argv.slice(2);
let id = 0;
const pending = new Map<
  number,
  { resolve: (value: any) => void; reject: (error: Error) => void }
>();
const rpc = (method: string, sha?: unknown) =>
  new Promise<any>((resolve, reject) => {
    const ref = ++id;
    pending.set(ref, { resolve, reject });
    process.send?.({ type: "rpc", id: ref, method, sha });
  });
class RemoteUpdates extends Updates {
  supported = false;
  private preparationAwareAdmin = false;
  configureAdmin(protocol: unknown) {
    this.preparationAwareAdmin = protocol === 1;
  }
  override snapshot() {
    const state = { ...super.snapshot(), supported: this.supported };
    if (!this.preparationAwareAdmin) {
      state.preparationSupported = false;
      state.manualRestartSupported = false;
    }
    return state;
  }
  override validate(sha: unknown) {
    if (!this.supported) throw new Error("UNSUPPORTED_INSTALLATION");
    return super.validate(sha);
  }
  override async check() {
    const state = await rpc("check");
    Object.assign(this, state);
    return this.snapshot();
  }
  override async prepare(sha: unknown) {
    if (!this.preparationAwareAdmin)
      throw new Error("LAUNCHER_UPGRADE_REQUIRED");
    this.validate(sha);
    this.preparing = true;
    try {
      const state = await rpc("prepare", sha);
      Object.assign(this, state);
    } finally {
      this.preparing = false;
    }
  }
  override async cancelPreparation(sha: unknown) {
    if (typeof sha !== "string") return;
    const state = await rpc("cancelPreparation", sha);
    Object.assign(this, state);
  }
  override async apply(sha: unknown, resume = false) {
    if (this.preparationAwareAdmin) this.validatePrepared(sha);
    else this.validate(sha);
    this.applying = true;
    this.accepted = rpc(
      this.preparationAwareAdmin ? "apply" : "legacyApply",
      resume ? { sha, resume: true } : sha,
    ).then((state) => {
      Object.assign(this, state);
    });
    try {
      await this.accepted;
    } catch {
      this.applying = false;
      this.guidance = "Upgrade request rejected. Check again.";
    }
  }
}
const updates = new RemoteUpdates(null, async () => {});
let initialized = false,
  app: any,
  closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app?.close();
  process.exit(0);
}
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
process.once("disconnect", () => void close());
process.on("message", async (message: any) => {
  if (message?.type === "reply") {
    const waiting = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiting?.reject(new Error(message.error));
    else waiting?.resolve(message.data);
  }
  if (message?.type !== "state") return;
  Object.assign(updates, message.data);
  if (initialized) return;
  initialized = true;
  try {
    const { Store } = await import(
      pathToFileURL(join(root, "dist/config/store.js")).href
    );
    const application = await import(
      pathToFileURL(join(root, "dist/server/admin.js")).href
    );
    if (typeof application.admin !== "function") throw new Error();
    updates.configureAdmin(application.updatePreparationProtocol);
    if (message.data?.manualOnlySourceUpdates !== 1)
      throw new Error("LAUNCHER_UPGRADE_REQUIRED");
    const store = new Store(
      home,
      message.data?.launcherSkillCatalog === 2 ? 2 : 1,
      message.data?.manualOnlySourceUpdates === 1,
    );
    await store.init();
    app = await application.admin(
      store,
      Number(port),
      undefined,
      () => {
        void rpc("shutdown");
      },
      updates,
    );
    process.send?.({ type: "ready", origin: app.origin, nonce });
  } catch (error) {
    const reason =
      error instanceof Error &&
      ["LAUNCHER_UPGRADE_REQUIRED", "INVALID_SKILL_STORAGE"].includes(
        error.message,
      )
        ? error.message
        : "STARTUP_FAILED";
    if (process.send)
      process.send({ type: "startupFailure", nonce, reason }, () =>
        process.exit(1),
      );
    else process.exit(1);
  }
});
