import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Updates } from "../src/update/updates.js";
import { UpdateJournal } from "../src/update/journal.js";

for (const [message, reason] of [
  [
    "EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED",
    "EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED",
  ],
  ["INSUFFICIENT_DISK", "INSUFFICIENT_DISK"],
  ["BUILD_FAILED", "BUILD_FAILED"],
  ["ACTIVATION_ROLLED_BACK", "ACTIVATION_ROLLED_BACK"],
  ["private-output https://user:secret@example.invalid", "UPGRADE_FAILED"],
]) {
  test(`failed upgrade retains safe reason ${reason} through check and restart`, async () => {
    const home = await mkdtemp(join(tmpdir(), "coach-update-reason-"));
    try {
      const journal = new UpdateJournal(home);
      const sha = "b".repeat(40);
      const updates = new Updates(
        "a".repeat(40),
        async () => {
          throw new Error(message);
        },
        async () => new Response(JSON.stringify({ object: { sha } })),
        (operation) => journal.write(operation),
      );
      await updates.check();
      await assert.rejects(updates.apply(sha), /^Error: UPGRADE_FAILED$/);
      const operation = updates.snapshot().lastOperation;
      assert.equal((operation as any)?.reason, reason);
      updates.checkedAt = 0;
      await updates.check();
      assert.match(updates.guidance, /New source available/);
      assert.deepEqual(updates.snapshot().lastOperation, operation);
      assert.deepEqual(
        await new UpdateJournal(home).recover(updates.installed),
        operation,
      );
      assert.equal(
        (await readFile(join(home, "update-operation.json"), "utf8")).includes(
          "private-output",
        ),
        false,
      );
      // Old receipts without a reason still load; non-allowlisted reasons fail closed.
      const { reason: ignored, ...legacy } = operation as any;
      await journal.write(legacy);
      assert.deepEqual(await journal.read(), legacy);
      await assert.rejects(
        journal.write({ ...legacy, reason: "private-output" } as any),
        /UPDATE_JOURNAL_INVALID/,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}
