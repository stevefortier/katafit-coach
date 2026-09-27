import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  archiveTaskInvalidation,
  type TaskInvalidationRecord,
} from "../src/worker/taskInvalidationArchive.js";

const taskId = "a".repeat(24);
const record: TaskInvalidationRecord = {
  protocol: "coach.tasks.v1",
  attempted_result_sha256: "b".repeat(64),
  receipt: {
    task: { id: taskId, lease_generation: 7 },
    status: "invalidated",
  },
};

test("task invalidation archive preserves matching immutable records and rejects conflicts and symlinks", async () => {
  const home = await mkdtemp(join(tmpdir(), "task-invalidation-archive-"));
  const archive = join(home, "task-terminal-receipts");
  const final = join(archive, `${taskId}-7.json`);
  try {
    await archiveTaskInvalidation(home, record);
    const original = await readFile(final);
    assert.deepEqual(original, Buffer.from(JSON.stringify(record)));
    assert.equal((await lstat(final)).mode & 0o777, 0o600);

    await archiveTaskInvalidation(home, structuredClone(record));
    assert.deepEqual(await readFile(final), original);
    assert.deepEqual(await readdir(archive), [`${taskId}-7.json`]);

    await assert.rejects(
      archiveTaskInvalidation(home, {
        ...record,
        attempted_result_sha256: "c".repeat(64),
      }),
      /TASK_INVALIDATION_CONFLICT/,
    );
    assert.deepEqual(await readFile(final), original);

    await rm(final);
    const target = join(home, "target.json");
    await writeFile(target, "do not follow", { mode: 0o600 });
    await symlink(target, final);
    await assert.rejects(
      archiveTaskInvalidation(home, record),
      /UNSAFE_STORAGE/,
    );
    assert.equal(await readFile(target, "utf8"), "do not follow");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("task invalidation archive requires a protected nonsymlink home", async () => {
  const parent = await mkdtemp(join(tmpdir(), "task-invalidation-home-"));
  const home = join(parent, "home");
  const alias = join(parent, "alias");
  try {
    await mkdir(home, { mode: 0o700 });
    await chmod(home, 0o755);
    await assert.rejects(
      archiveTaskInvalidation(home, record),
      /UNSAFE_STORAGE/,
    );
    await chmod(home, 0o700);
    await symlink(home, alias);
    await assert.rejects(
      archiveTaskInvalidation(alias, record),
      /UNSAFE_PATH|UNSAFE_STORAGE|ELOOP|ENOTDIR/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("task invalidation archive removes an unsynced temporary record and retries cleanly", async () => {
  const home = await mkdtemp(join(tmpdir(), "task-invalidation-file-sync-"));
  const archive = join(home, "task-terminal-receipts");
  try {
    await assert.rejects(
      archiveTaskInvalidation(home, record, {
        sync: async (handle, path) => {
          if (basename(path).startsWith(".task-invalidation-"))
            throw new Error("INJECTED_FILE_SYNC_FAILURE");
          await handle.sync();
        },
      }),
      /INJECTED_FILE_SYNC_FAILURE/,
    );
    assert.deepEqual(await readdir(archive), []);
    await archiveTaskInvalidation(home, record);
    assert.deepEqual(await readdir(archive), [`${taskId}-7.json`]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("retry fsyncs a matching final record and directory after link succeeded but directory sync failed", async () => {
  const home = await mkdtemp(join(tmpdir(), "task-invalidation-dir-sync-"));
  const archive = join(home, "task-terminal-receipts");
  const final = join(archive, `${taskId}-7.json`);
  let failed = false;
  try {
    await assert.rejects(
      archiveTaskInvalidation(home, record, {
        sync: async (handle, path) => {
          if (path === archive && !failed) {
            failed = true;
            throw new Error("INJECTED_DIRECTORY_SYNC_FAILURE");
          }
          await handle.sync();
        },
      }),
      /INJECTED_DIRECTORY_SYNC_FAILURE/,
    );
    assert.deepEqual(
      await readFile(final),
      Buffer.from(JSON.stringify(record)),
    );
    assert.deepEqual(await readdir(archive), [`${taskId}-7.json`]);

    const synced: string[] = [];
    await archiveTaskInvalidation(home, record, {
      sync: async (handle, path) => {
        synced.push(path);
        await handle.sync();
      },
    });
    assert.ok(synced.includes(final), "retry fsyncs the matching record");
    assert.ok(
      synced.includes(archive),
      "retry fsyncs its containing directory",
    );
    assert.deepEqual(await readdir(archive), [`${taskId}-7.json`]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
