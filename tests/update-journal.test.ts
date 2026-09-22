import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readFile,
  stat,
  writeFile,
  symlink,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { UpdateJournal } from "../src/update/journal.js";

test("journal rejects unknown fields and malformed receipts without exposing their contents", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-journal-schema-"));
  try {
    const journal = new UpdateJournal(home);
    const entry = {
      id: randomUUID(),
      sha: "b".repeat(40),
      state: "failed" as const,
      at: Date.now(),
    };
    await journal.write(entry);
    const before = await readFile(join(home, "update-operation.json"), "utf8");
    for (const invalid of [
      { ...entry, message: "private-marker" },
      { ...entry, state: "private-marker" },
      { ...entry, id: "not-an-id" },
      { ...entry, sha: "B".repeat(40) },
      { ...entry, at: NaN },
    ]) {
      await assert.rejects(
        journal.write(invalid as any),
        /UPDATE_JOURNAL_INVALID/,
      );
      assert.equal(
        await readFile(join(home, "update-operation.json"), "utf8"),
        before,
      );
    }
    await writeFile(join(home, "update-operation.json"), '{"private-marker":');
    await assert.rejects(
      journal.read(),
      (error) =>
        error instanceof Error && error.message === "UPDATE_JOURNAL_INVALID",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("journal does not read through or overwrite a preexisting receipt symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "coach-journal-path-"));
  const home = join(root, "home"),
    outside = join(root, "outside.json");
  try {
    await mkdir(home);
    await writeFile(outside, "untouched");
    await symlink(outside, join(home, "update-operation.json"));
    const journal = new UpdateJournal(home);
    await assert.rejects(journal.read());
    await assert.rejects(
      journal.write({
        id: randomUUID(),
        sha: "c".repeat(40),
        state: "applying",
        at: Date.now(),
      }),
    );
    assert.equal(await readFile(outside, "utf8"), "untouched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepted update survives restart and interrupted recovery does not claim success", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-journal-"));
  try {
    const entry = {
      id: randomUUID(),
      sha: "a".repeat(40),
      state: "applying" as const,
      at: Date.now(),
      phase: "preparing" as const,
    };
    const journal = new UpdateJournal(home);
    assert.equal(await journal.read(), undefined);
    await journal.write(entry);
    assert.deepEqual(await new UpdateJournal(home).read(), entry);
    assert.equal(
      (await stat(join(home, "update-operation.json"))).mode & 0o777,
      0o600,
    );
    const recovered = await new UpdateJournal(home).recover(null);
    assert.equal(recovered?.state, "interrupted");
    assert.equal(recovered?.sha, entry.sha);
    assert.equal(recovered?.id, entry.id);
    assert.deepEqual(await journal.read(), recovered);
    await journal.write({ ...entry, phase: "activating" });
    assert.equal((await journal.recover(entry.sha))?.state, "succeeded");
    const bytes = await readFile(join(home, "update-operation.json"), "utf8");
    await journal.recover(entry.sha);
    assert.equal(
      await readFile(join(home, "update-operation.json"), "utf8"),
      bytes,
      "terminal outcomes stay durable and unchanged",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
