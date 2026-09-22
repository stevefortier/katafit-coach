import { pathToFileURL } from "node:url";
import { join } from "node:path";
const [root, home] = process.argv.slice(2);
const deadline = setTimeout(() => process.exit(1), 10000);
let app: any;
try {
  const { Store } = await import(
    pathToFileURL(join(root, "dist/config/store.js")).href
  );
  const store = new Store(home);
  await store.init();
  const { admin } = await import(
    pathToFileURL(join(root, "dist/server/admin.js")).href
  );
  app = await admin(store, 0);
  const r = await fetch(app.origin + "/api/status", {
    headers: { Authorization: "Bearer " + store.secrets.admin },
    signal: AbortSignal.timeout(5000),
  });
  const status = (await r.json()) as { state: string };
  if (!r.ok || status.state !== "stopped") throw new Error();
} catch {
  process.exitCode = 1;
} finally {
  await app?.close();
  clearTimeout(deadline);
}
