import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "../src/worker/runner.js";
import { Diagnostics } from "../src/diagnostics/log.js";
import { taskFixture } from "./task-fixtures.js";

test("authority-denied reconciliation persists its safe cause and original generation reference without asserting delivery", async () => {
  for (const code of [
    "TASK_SOURCE_CHANGED",
    "TASK_ROUTING_CHANGED",
    "CONVERSATION_CLEARED",
    "SCOPE_CHANGED",
    "REQUESTER_SCOPE_CHANGED",
    "EXTERNAL_COACH_AUTO_ACCEPTANCE_CONFLICT",
    "CREDENTIAL_REJECTED",
  ]) {
    const dir = await mkdtemp(join(tmpdir(), "task-delivery-diagnostic-"));
    const log = new Diagnostics(dir);
    const f = await taskFixture({ dropComplete: true, reconcileDenial: code });
    let generationRef = "";
    const w = new Worker({
      origin: f.origin,
      token: "synthetic-worker-secret",
      system: "Coach",
      onDiagnostic: (event) => log.record(event),
      complete: async (_context, _signal, _system, _tools, ref) => {
        generationRef = ref;
        return '{"text":"synthetic private candidate"}';
      },
    });
    try {
      const first = f.enqueue();
      f.deny(first.id);
      await assert.rejects(w.pollOnce(), /DELIVERY_UNVERIFIED/);
      const persisted = new Diagnostics(dir).snapshot();
      assert.equal(persisted.persistence, true);
      const denial = persisted.entries.find(
        (event) =>
          event.stage === "task-result-unknown" && event.level === "warn",
      );
      assert.equal(denial?.code, code);
      assert.equal(denial?.ref, generationRef);
      assert.deepEqual(denial?.metadata, { leaseGeneration: 1 });
      assert.ok(denial?.hint);
      assert.equal(w.lastError?.code, "DELIVERY_UNVERIFIED");
      assert.equal(w.incidents[0].reason, code);
      assert.equal(w.incidents[0].taskId, first.id);
      assert.equal(f.saved.length, 1);
      assert.ok(!f.calls.some((call) => call.name === "coach_fail_task"));
      const serialized = JSON.stringify(persisted);
      for (const privateValue of [
        first.id,
        "synthetic-worker-secret",
        "synthetic private candidate",
      ])
        assert.ok(!serialized.includes(privateValue));
      f.enqueue();
      await w.pollOnce();
      assert.equal(w.state, "task-result-stored");
      assert.equal(w.incidents.length, 1);
      assert.equal(
        f.calls.filter(
          (call) =>
            call.name === "coach_complete_task" &&
            call.args.task_id === first.id,
        ).length,
        1,
      );
    } finally {
      await w.stop();
      await f.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});
