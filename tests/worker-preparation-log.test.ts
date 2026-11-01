import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "../src/worker/runner.js";
import { numericMetadata, SafeError } from "../src/runtime/errors.js";
import { ToolFailure } from "../src/katafit/client.js";
import { Diagnostics } from "../src/diagnostics/log.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

test("failclosed diagnostics retain exact original error identity and persist only bounded fields", async () => {
  const home = await mkdtemp(tmpdir() + "/memory-phase-log-");
  try {
    const logs = new Diagnostics(home);
    for (const [error, subtype] of [
      [new ToolFailure("MEMORY_NOT_AUTHORIZED", false), 5],
      [new SafeError("CREDENTIAL_REJECTED"), 7],
      [new SafeError("MEMORY_RESULT_REJECTED"), 8],
      [new Error("PRIVATE-ERROR-TEXT"), 9],
    ] as const) {
      const events: any[] = [];
      const w = new Worker({
        origin: "http://127.0.0.1",
        token: "synthetic-secret",
        system: "Coach",
        complete: async () => {
          throw new Error("no completion");
        },
        onDiagnostic: (event) => {
          events.push(event);
          logs.record(event);
          throw new Error("PRIVATE-LOGGER-TEXT");
        },
      });
      const client = {
        rpc: async () => {
          throw error;
        },
      };
      await assert.rejects(
        (w as any).memoryFor(
          client,
          { kind: "request" },
          "PRIVATE-QUERY",
          () => 1000,
          "00000000-0000-4000-8000-000000000000",
        ),
        (e) => e === error,
      );
      assert.equal(events.length, 1);
      assert.equal(events[0].metadata.memorySubtypeCode, subtype);
      assert.equal(events[0].metadata.memoryOutcomeCode, 4);
      await w.stop();
    }
    const persisted = new Diagnostics(home).snapshot().entries;
    assert.equal(persisted.length, 4);
    assert.doesNotMatch(JSON.stringify(persisted), /PRIVATE-|synthetic-secret/);
    assert.deepEqual(
      persisted.map((e) => e.metadata.memorySubtypeCode),
      [5, 7, 8, 9],
    );
    const numeric = {
      reactionInventoryCode: 1,
      reactionInventoryEqual: 1,
      reactionInventoryDigest: 2 ** 48 - 1,
      reactionTargets: 40,
    };
    assert.deepEqual(numericMetadata(numeric), numeric);
    assert.deepEqual(
      numericMetadata({
        reactionInventoryCode: 3,
        reactionInventoryEqual: 2,
        reactionInventoryDigest: 2 ** 48,
        reactionTargets: 41,
      }),
      {},
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("inventory observation is nonvalidating and never faults for legacy or malformed data", () => {
  const w = new Worker({
    origin: "http://127.0.0.1",
    token: "synthetic-secret",
    system: "Coach",
    complete: async () => "",
  });
  const evidence = { observations: [] };
  assert.deepEqual(
    (w as any).reactionInventory(JSON.stringify({ evidence }), evidence),
    { reactionInventoryCode: 0 },
  );
  assert.deepEqual((w as any).reactionInventory("not JSON", evidence), {
    reactionInventoryCode: 2,
  });
  const original = {
    observations: [
      {
        label: "Eligible reaction targets",
        text: '[{"target_event_key":"PRIVATE-KEY","target_type":"set_completed"}]',
      },
    ],
  };
  const actual = {
    observations: [{ label: "Eligible reaction targets", text: "[]" }],
  };
  const receipt = (w as any).reactionInventory(
    JSON.stringify({ evidence: actual }),
    original,
  );
  assert.equal(receipt.reactionInventoryEqual, 0);
  assert.equal(receipt.reactionTargets, 0);
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE-KEY/);
});
