import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/config/store.js";
import { autonomyRunner } from "../src/autonomy/runner.js";
import { AutonomyBackend } from "../src/autonomy/backend.js";
import { HeadlessFailure } from "../src/autonomy/headless.js";
import { pairedSkip } from "./helpers/account-backend.js";
import { startAutonomyBackend } from "./helpers/autonomy-backend.js";

// Real authenticated loopback HTTP and disposable Mongo transactions. Only
// inference and Date are controlled: advancing Date does not replace network,
// driver or runtime timers. No expired completion authority is granted.
test(
  "deadline settlement: slow inference commits a canonical budget_exhausted receipt before claim expiry",
  { skip: pairedSkip, timeout: 60000 },
  async (t) => {
    const b = await startAutonomyBackend();
    let dir: string | undefined;
    try {
      await b.saveMandate({
        mode: "observe",
        timezone: "UTC",
        delegated_actions: [],
        digest: {
          enabled: false,
          local_time: "18:00",
          weekdays: [0],
          suppress_empty: true,
        },
      });
      const token = await b.bearer();
      dir = await mkdtemp(join(tmpdir(), "deadline0210-paired-"));
      const store = new Store(dir);
      await store.init();
      await store.save({
        ...store.publicConfig(),
        origin: b.origin,
        token,
        apiKey: "synthetic-deadline-key",
        provider: { baseUrl: b.origin + "/v1", model: "synthetic-model" },
      });
      const backend = new AutonomyBackend(
        b.origin,
        token,
        new AbortController().signal,
        [token],
      );
      const mandate = await backend.mandate();
      assert.ok(mandate.mandate_id);
      const origin = Date.now();
      t.mock.timers.enable({ apis: ["Date"], now: origin });
      const queued = await b.enqueue(mandate.mandate_id);
      const claimed = await backend.claimCycle({ lease_seconds: 120 });
      assert.ok(claimed, "real work claimed");
      assert.equal(claimed.work.id, String(queued._id));
      const expires = Date.parse(claimed.work.timeout_at!);
      assert.equal(expires, origin + mandate.budgets.cycle_seconds * 1000);
      t.mock.timers.setTime(origin + 2000); // start/setup never renews timeout_at
      const work = await backend.start(
        claimed.work.id,
        claimed.work.lease_generation,
      );
      let admittedMs = 0;
      let runs = 0;
      const runtime = {
        async run(run: { cycleMs: number }) {
          runs++;
          admittedMs = run.cycleMs;
          assert.ok(
            admittedMs > 0,
            "runtime received a positive finite budget",
          );
          t.mock.timers.setTime(Date.now() + admittedMs + 1000); // expiry plus teardown
          throw new HeadlessFailure("HEADLESS_TIMEOUT");
        },
      };
      let error: any;
      const result = await autonomyRunner({ store, runtime })({
        work,
        mandate,
        backend,
        capability: claimed.capability,
        signal: new AbortController().signal,
      }).catch((e) => {
        error = e;
        return undefined;
      });
      const receipt = await backend.completionReceipt(
        work.id,
        work.lease_generation,
      );
      const stored = await b.db
        .collection("coach_autonomy_work")
        .findOne({ _id: queued._id });
      t.diagnostic(
        JSON.stringify({
          assertionsReached:
            "claim, backend timeout, runtime admission, exact receipt read",
          runs,
          admittedMs,
          expires,
          settledAt: Date.now(),
          error: error?.code,
          receiptState: receipt.state,
          status: stored.status,
        }),
      );
      assert.equal(
        error,
        undefined,
        "deadline exhaustion must settle, not lose completion with LEASE_LOST",
      );
      assert.equal(runs, 1, "no correction or retry after timeout");
      assert.ok(Date.now() < expires, "settlement retains backend authority");
      assert.equal(result?.outcome.result, "blocked");
      assert.equal(result?.outcome.blocked_reason, "budget_exhausted");
      assert.equal(receipt.state, "committed");
      assert.equal(receipt.receipt?.result, "blocked");
      assert.equal(receipt.receipt?.report_id, result?.report_id);
      assert.equal(stored.status, "blocked");
      assert.equal(stored.blocked_reason, "budget_exhausted");
      assert.equal(
        await b.db
          .collection("coach_autonomy_reports")
          .countDocuments({ work_id: queued._id }),
        1,
      );
      assert.equal(
        await backend.claimCycle(),
        null,
        "blocked identity is never automatically replayed",
      );
    } finally {
      t.mock.timers.reset();
      await b.close();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  },
);
