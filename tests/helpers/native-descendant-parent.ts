import { superviseNativeWorker } from "../../src/release/native-supervisor.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
const r = JSON.parse(process.argv[2]);
process.on("message", (message) => {
  if (message === "exit-now") process.exit(0);
});
try {
  await superviseNativeWorker(
    r,
    { workMs: 700, drainMs: 100 },
    { entry: new URL("./native-descendant-worker.ts", import.meta.url) },
  );
} catch (e: any) {
  await writeFile(
    join(r.state, "parent-result"),
    JSON.stringify({ error: e.message, cleanup: e.cleanup }),
  );
}
if (process.connected) process.disconnect();
