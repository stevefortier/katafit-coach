import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readFile,
  stat,
  symlink,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as history from "../src/sandbox/sessionHistory.js";

const scope = "a".repeat(64);
const snapshot = {
  personaRevision: 3,
  skillsRevision: 2,
  model: "synthetic-model",
  prompt: "Synthetic Coach persona",
  skills: [{ name: "synthetic", body: "Synthetic skill" }],
};
function nativeEntries() {
  const manager = SessionManager.inMemory("/workspace");
  manager.appendMessage({
    role: "user",
    content: "Synthetic question",
    timestamp: 1,
  });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Synthetic answer" }],
    api: "openai-completions",
    provider: "katafit",
    model: "synthetic-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  });
  return JSON.parse(
    JSON.stringify([manager.getHeader()!, ...manager.getEntries()]),
  );
}

test("L2 confirmed delete removes its tombstone while stale writers still fail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "history-tombstone-"));
  try {
    const store = new history.NativeSessionHistory(dir, scope);
    const row = await store.create(snapshot);
    await store.delete(row.id);
    await store.confirmDelete(row.id);
    const manifest = JSON.parse(
      await readFile(
        join(dir, "operator-sessions", `native-history-${scope}.json`),
        "utf8",
      ),
    );
    assert.deepEqual(manifest.tombstones, []);
    await assert.rejects(
      store.checkpoint(row.id, nativeEntries()),
      /NATIVE_HISTORY_NOT_FOUND/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("host history checkpoint survives a new store instance with native structured entries and frozen snapshot", async () => {
  assert.equal(typeof history.NativeSessionHistory, "function");
  const dir = await mkdtemp(join(tmpdir(), "native-history-"));
  try {
    const store = new history.NativeSessionHistory(dir, scope);
    const created = await store.create(snapshot);
    const entries = nativeEntries();
    await store.checkpoint(created.id, entries);
    const reopened = new history.NativeSessionHistory(dir, scope);
    const loaded = await reopened.loadForHost(created.id);
    assert.deepEqual(loaded.entries, entries);
    assert.deepEqual(loaded.snapshot, snapshot);
    assert.equal(loaded.id, created.id);
    assert.equal(loaded.title, "New conversation");
    assert.equal((await reopened.list())[0].id, created.id);
    assert.equal(loaded.revision, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Stop preserves structured history; explicit delete removes it and late checkpoints cannot resurrect it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "native-history-"));
  try {
    const store = new history.NativeSessionHistory(dir, scope);
    const first = await store.create(snapshot);
    await store.checkpoint(first.id, nativeEntries());
    assert.equal(typeof store.stop, "function");
    await store.rename(first.id, "Synthetic renamed conversation");
    await store.stop(first.id);
    const restarted = new history.NativeSessionHistory(dir, scope);
    const saved = await restarted.loadForHost(first.id);
    assert.equal(saved.title, "Synthetic renamed conversation");
    assert.equal(saved.state, "stopped");
    assert.equal(saved.entries.length, 3);
    const second = await restarted.create({ ...snapshot, personaRevision: 4 });
    assert.equal((await restarted.list())[0].id, second.id);
    assert.equal(
      (await restarted.loadForHost(first.id)).snapshot.personaRevision,
      3,
    );
    assert.equal(
      (await restarted.loadForHost(second.id)).snapshot.personaRevision,
      4,
    );
    assert.equal(
      JSON.stringify(await restarted.list()).includes("Synthetic"),
      false,
    );
    assert.deepEqual(
      await new history.NativeSessionHistory(dir, "b".repeat(64)).list(),
      [],
    );
    await restarted.delete(first.id);
    await assert.rejects(
      restarted.checkpoint(first.id, nativeEntries()),
      /NATIVE_HISTORY_NOT_FOUND/,
    );
    await assert.rejects(
      restarted.loadForHost(first.id),
      /NATIVE_HISTORY_NOT_FOUND/,
    );
    assert.deepEqual(
      (await restarted.list()).map((row) => row.id),
      [second.id],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("secret-bearing snapshots, titles and native messages are rejected before durable writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "native-history-"));
  try {
    const store = new history.NativeSessionHistory(dir, scope, () => [
      "synthetic-credential",
    ]);
    await assert.rejects(
      store.create({ ...snapshot, prompt: "synthetic-credential" }),
      /NATIVE_HISTORY_SECRET/,
    );
    const record = await store.create(snapshot);
    const before = await readFile(
      join(dir, "operator-sessions", `native-history-${scope}.json`),
    );
    await assert.rejects(
      store.rename(record.id, "synthetic-credential"),
      /NATIVE_HISTORY_SECRET/,
    );
    const entries = nativeEntries();
    entries[1].message.content = "synthetic-credential";
    await assert.rejects(
      store.checkpoint(record.id, entries),
      /NATIVE_HISTORY_SECRET/,
    );
    await assert.rejects(
      store.create({ ...snapshot, apiKey: "extra" } as any),
      /NATIVE_HISTORY_SNAPSHOT/,
    );
    await assert.rejects(
      store.rename(record.id, "x".repeat(121)),
      /NATIVE_HISTORY_TITLE/,
    );
    assert.deepEqual(
      await readFile(
        join(dir, "operator-sessions", `native-history-${scope}.json`),
      ),
      before,
    );
    assert.equal(
      (
        await stat(
          join(dir, "operator-sessions", `native-history-${scope}.json`),
        )
      ).mode & 0o777,
      0o600,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("native compatibility is not authority: unknown formats and unfinished tool turns cannot be resumed", () => {
  assert.equal(typeof history.nativeResumeBlocker, "function");
  const entries = nativeEntries();
  assert.equal(history.nativeResumeBlocker(entries), null);
  assert.equal(
    history.nativeResumeBlocker([
      { ...entries[0], version: 999 },
      ...entries.slice(1),
    ]),
    "unsupported_format",
  );
  assert.equal(
    history.nativeResumeBlocker(entries.slice(0, 2)),
    "interrupted_turn",
  );
  const unfinished = structuredClone(entries);
  unfinished[2].message.content = [
    {
      type: "toolCall",
      id: "pending",
      name: "studio_operator_send_message",
      arguments: {},
    },
  ];
  unfinished[2].message.stopReason = "toolUse";
  assert.equal(history.nativeResumeBlocker(unfinished), "interrupted_turn");
  const aborted = structuredClone(entries);
  aborted[2].message.stopReason = "aborted";
  assert.equal(history.nativeResumeBlocker(aborted), "interrupted_turn");
  const duplicate = [...entries, entries[2]];
  assert.equal(history.nativeResumeBlocker(duplicate), "malformed_history");
  const custom = [
    ...entries,
    {
      type: "future_extension",
      id: "12345678",
      parentId: entries[2].id,
      timestamp: entries[2].timestamp,
    },
  ];
  assert.equal(history.nativeResumeBlocker(custom), "unsupported_entry");
});

test("native image bytes are refused by the text-only foundation instead of becoming durable attachments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "native-history-"));
  try {
    const store = new history.NativeSessionHistory(dir, scope);
    const record = await store.create(snapshot);
    const entries = nativeEntries();
    entries[1].message.content = [
      { type: "image", data: "U1lOVEhFVElD", mimeType: "image/png" },
    ];
    await assert.rejects(
      store.checkpoint(record.id, entries),
      /NATIVE_HISTORY_IMAGE_UNSUPPORTED/,
    );
    assert.equal((await store.loadForHost(record.id)).entries.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrupt manifests and symlinked ancestors are refused, and independent store instances serialize writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "native-history-"));
  try {
    const a = new history.NativeSessionHistory(dir, scope);
    const b = new history.NativeSessionHistory(dir, scope);
    const rows = await Promise.all([a.create(snapshot), b.create(snapshot)]);
    assert.equal((await a.list()).length, 2);
    const path = join(dir, "operator-sessions", `native-history-${scope}.json`);
    const valid = JSON.parse(await readFile(path, "utf8"));
    await writeFile(
      path,
      JSON.stringify({
        ...valid,
        sessions: [{ ...valid.sessions[0], createdAt: "not-a-date" }],
      }),
    );
    await assert.rejects(a.list(), /NATIVE_HISTORY_STORAGE/);
    await writeFile(path, JSON.stringify(valid));
    await mkdir(join(dir, "real"));
    await mkdir(join(dir, "real", "home"));
    await symlink(join(dir, "real"), join(dir, "link"));
    await assert.rejects(
      new history.NativeSessionHistory(join(dir, "link", "home"), scope).create(
        snapshot,
      ),
    );
    await a.stop(rows[0].id);
    await assert.rejects(
      a.checkpoint(rows[0].id, nativeEntries()),
      /NATIVE_HISTORY_STOPPED/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
