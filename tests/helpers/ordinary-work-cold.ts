import { Store } from "../../src/config/store.js";
import { AutonomyHost, productionRuntimes } from "../../src/autonomy/host.js";
import { Admission } from "../../src/runtime/admission.js";
const [home, image, workId] = process.argv.slice(2);
const store = new Store(home);
await store.init();
const host = new AutonomyHost({
  store,
  admission: new Admission(),
  runtimes: (dir, context) =>
    productionRuntimes(dir, { ...context, image: async () => image }),
  scheduler: { leaseSeconds: 120 },
});
try {
  await host.start();
  const deadline = Date.now() + 45000;
  while (host.snapshot().lastWorkId !== workId) {
    if (Date.now() > deadline)
      throw new Error(
        "COLD_NATIVE_DEADLINE:" + JSON.stringify(host.snapshot()),
      );
    await new Promise((r) => setTimeout(r, 25));
  }
  await host.stop();
  console.log(JSON.stringify({ pid: process.pid, snapshot: host.snapshot() }));
} finally {
  await host.stop();
}
