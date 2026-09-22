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
  override snapshot() {
    return { ...super.snapshot(), supported: this.supported };
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
  override async apply(sha: unknown) {
    this.validate(sha);
    this.applying = true;
    this.accepted = rpc("apply", sha).then((state) => {
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
    const { admin } = await import(
      pathToFileURL(join(root, "dist/server/admin.js")).href
    );
    const store = new Store(home);
    await store.init();
    app = await admin(
      store,
      Number(port),
      undefined,
      () => {
        void rpc("shutdown");
      },
      updates,
    );
    process.send?.({ type: "ready", origin: app.origin, nonce });
  } catch {
    process.exit(1);
  }
});
