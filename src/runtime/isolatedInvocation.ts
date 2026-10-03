import type { Store } from "../config/store.js";
import type { RuntimeContext } from "../autonomy/host.js";
import { HeadlessCycleRuntime } from "../autonomy/headless.js";
import { nativeImage } from "../sandbox/artifact.js";
import { openProfileGateway } from "../sandbox/gateway.js";
import type { WorkerOptions } from "../worker/runner.js";

/**
 * The installed Worker's completion seam. No host Agent/provider fallback:
 * request-scoped tools stay on the host, Pi and its workspace stay offline.
 * Admission is held by Worker for this entire call, including teardown.
 */
export function isolatedWorkerCompletion(
  store: Store,
  context: () => Promise<RuntimeContext>,
): WorkerOptions["complete"] {
  return async (message, signal, prompt, tools, _ref, budget) => {
    signal.throwIfAborted();
    const owner = await context();
    const image = await nativeImage(store.dir);
    signal.throwIfAborted();
    const runtime = new HeadlessCycleRuntime({ image, cleanup: owner.cleanup });
    await runtime.sweep();
    signal.throwIfAborted();
    const cycleMs = Math.min(
      100000,
      (budget?.deadlineAt ?? Date.now() + 100000) - Date.now(),
    );
    if (!(cycleMs > 0)) throw new Error("LEASE_EXPIRED");
    const gateway = await openProfileGateway(store, signal, {
      profile: "worker",
      prompt,
      tools,
      skills: true,
      budgets: {
        tool_calls: 64,
        provider_tokens: 200000,
        images_per_cycle: store.publicConfig().provider.vision ? 5 : 0,
      },
    });
    try {
      const result = await runtime.run({
        profile: "worker",
        gateway,
        message,
        signal,
        cycleMs,
      });
      signal.throwIfAborted();
      return result.text;
    } finally {
      await gateway.close();
    }
  };
}
