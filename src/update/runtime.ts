import { Updates, validPreparationToken } from "./updates.js";

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
  override sourceChannel: "ready-releases-v1" | "legacy-or-unknown" =
    "legacy-or-unknown";
  supported = false;
  override preparationProtocol = 0;
  override readinessProtocol = 0;
  private preparationAwareAdmin = false;
  private receivedSequence = 0;
  receiveState(state: any) {
    if (Number.isSafeInteger(state?.stateSequence) && state.stateSequence > 0) {
      if (state.stateSequence <= this.receivedSequence) return;
      this.receivedSequence = state.stateSequence;
    } else {
      // A legacy or unknown owner cannot advertise local readiness.
      state = {
        ...state,
        readinessProtocol: 0,
        readinessSupported: false,
        readiness: undefined,
      };
      if (this.receivedSequence) return;
    }
    Object.assign(this, state);
  }
  configureAdmin(protocol: unknown) {
    if (protocol === 2 && this.preparationProtocol !== 2)
      throw new Error("LAUNCHER_UPGRADE_REQUIRED");
    this.preparationAwareAdmin = protocol === 2;
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
    this.receiveState(state);
    return this.snapshot();
  }
  override async refreshReadiness(sha: unknown = this.latest) {
    if (this.readinessProtocol !== 1 || !this.readinessSupported)
      throw new Error("LAUNCHER_UPGRADE_REQUIRED");
    const state = await rpc("readiness", sha);
    this.receiveState(state);
    return this.snapshot();
  }
  override async assertReady(sha: unknown, token?: string) {
    if (this.readinessProtocol !== 1 || !this.readinessSupported)
      throw new Error("LAUNCHER_UPGRADE_REQUIRED");
    const state = await rpc("assertReady", { sha, token });
    this.receiveState(state);
  }
  override async prepare(sha: unknown, token?: string) {
    if (!this.preparationAwareAdmin || this.preparationProtocol !== 2)
      throw new Error("LAUNCHER_UPGRADE_REQUIRED");
    this.validate(sha);
    if (!validPreparationToken(token)) throw new Error("TARGET_REJECTED");
    this.preparing = true;
    try {
      const state = await rpc("prepare", { sha, token });
      this.receiveState(state);
    } finally {
      this.preparing = false;
    }
  }
  override async cancelPreparation(sha: unknown, token?: string) {
    if (!this.preparationAwareAdmin || !validPreparationToken(token))
      throw new Error("TARGET_REJECTED");
    const state = await rpc("cancelPreparation", { sha, token });
    this.receiveState(state);
  }
  override async apply(
    sha: unknown,
    resume = false,
    _prepared = false,
    token?: string,
  ) {
    if (this.preparationAwareAdmin) {
      if (!validPreparationToken(token)) throw new Error("TARGET_REJECTED");
      this.validatePrepared(sha);
    } else {
      if (resume) throw new Error("LAUNCHER_UPGRADE_REQUIRED");
      this.validate(sha);
    }
    this.applying = true;
    this.accepted = rpc(
      this.preparationAwareAdmin ? "apply" : "legacyApply",
      this.preparationAwareAdmin ? { sha, resume, token } : sha,
    ).then((state) => {
      this.receiveState(state);
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
    if (message.error) {
      if (message.data) updates.receiveState(message.data);
      waiting?.reject(new Error(message.error));
    } else waiting?.resolve(message.data);
  }
  if (message?.type !== "state") return;
  updates.receiveState(message.data);
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
