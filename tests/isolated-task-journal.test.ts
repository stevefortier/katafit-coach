import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { taskFixture } from "./task-fixtures.js";
import {
  IsolatedTaskJournal,
  taskBinding,
} from "../src/worker/isolatedTaskJournal.js";

for (const field of ["binding", "digest"] as const)
  test(`persisted ${field} must be a string, not a coercible array`, async () => {
    const home = await mkdtemp(tmpdir() + "/isolated-shape-");
    const f = await taskFixture();
    try {
      const task = f.enqueue();
      const journal = await IsolatedTaskJournal.open(home);
      const record = {
        task,
        digest: "a".repeat(64),
        reason: "TASK_SOURCE_CHANGED",
        binding: taskBinding(f.origin, "original"),
      };
      await journal.preserve(record);
      const invalid = { ...record, [field]: [record[field]] };
      await writeFile(
        home + "/isolated-tasks/state.json",
        JSON.stringify({ protocol: "isolated.tasks.v1", records: [invalid] }),
      );
      await assert.rejects(
        IsolatedTaskJournal.open(home),
        /ISOLATED_TASK_JOURNAL_INVALID/,
      );
      assert.throws(
        () => journal.preserve(invalid as any),
        /ISOLATED_TASK_JOURNAL_INVALID/,
      );
    } finally {
      await f.close();
      await rm(home, { recursive: true, force: true });
    }
  });

test("isolated metadata survives reopen without secrets and repeated preservation deduplicates", async () => {
  const home = await mkdtemp(tmpdir() + "/isolated-journal-");
  const f = await taskFixture();
  try {
    const task = f.enqueue();
    const journal = await IsolatedTaskJournal.open(home);
    const record = {
      task,
      digest: "a".repeat(64),
      reason: "TASK_SOURCE_CHANGED",
      binding: taskBinding(f.origin, "private-original-token"),
    };
    await journal.preserve(record);
    await journal.preserve(structuredClone(record));
    const reopened = await IsolatedTaskJournal.open(home);
    assert.deepEqual(reopened.snapshot(), [record]);
    const bytes = await readFile(home + "/isolated-tasks/state.json", "utf8");
    assert.equal(bytes.includes("private-original-token"), false);
    assert.equal(taskBinding(f.origin, "different") === record.binding, false);
  } finally {
    await f.close();
    await rm(home, { recursive: true, force: true });
  }
});
