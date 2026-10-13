import { superviseNativeWorker } from "../../src/release/native-supervisor.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
const request = JSON.parse(process.argv[2]);
process.on("message", (message) => {
  if (message === "exit-now") process.exit(0);
});
try {
  await superviseNativeWorker(
    request,
    { workMs: 300, drainMs: 100 },
    {
      entry: new URL("./native-owned-worker.ts", import.meta.url),
      onEvent: (value) => process.send?.(value),
    },
  );
} catch (error: any) {
  await writeFile(join(request.state, "parent-result"), error.message);
}
if (process.connected) process.disconnect();
