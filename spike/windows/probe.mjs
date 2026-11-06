// Spike: call Coach's startup steps directly on Windows and print each real
// error with its stack. Usage: node probe.mjs <extracted katafit-coach dir> <home>
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [root, home] = process.argv.slice(2);
mkdirSync(home, { recursive: true });
const app = (path) => pathToFileURL(join(root, "app", "dist", path)).href;
const step = async (name, run) => {
  try {
    const result = await run();
    console.log(`OK   ${name}`);
    return result;
  } catch (error) {
    console.log(`FAIL ${name}: ${error?.stack ?? error}`);
    return undefined;
  }
};
const { Store } = await import(app("config/store.js"));
const store = new Store(home);
await step("Store.init", () => store.init());
const { supervise } = await import(app("update/supervisor.js"));
const owner = await step("supervise", () => supervise(store, 0));
if (owner) {
  console.log("origin", owner.origin);
  await step("Studio HTTP", async () => {
    const r = await fetch(owner.origin + "/");
    if (!r.ok) throw Error("HTTP " + r.status);
  });
  await step("status API", async () => {
    const r = await fetch(owner.origin + "/api/status", {
      headers: { Authorization: "Bearer " + store.secrets.admin },
    });
    console.log("status", r.status, (await r.text()).slice(0, 300));
  });
  await step("close", () => owner.close());
}
process.exit(0);
