import { test } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { History, type Message } from "../src/chat/history.js";

const privateTurn: Message[] = [
  { role: "user", text: "SYNTHETIC_PRIVATE_FAILED_TURN" },
  { role: "assistant", text: "synthetic reply" },
];

for (const operation of ["writeFileSync", "fsyncSync"] as const) {
  test(`history removes private temporary data after ${operation} failure and Clear`, () => {
    const dir = mkdtempSync(tmpdir() + "/operator-history-failure-");
    const original = fs[operation];
    const failure = Object.assign(new Error("synthetic persistence failure"), {
      code: "ENOSPC",
    });
    try {
      const history = new History(dir);
      history.save([]);
      Object.assign(fs, {
        [operation]: (fd: number) => {
          // Model a partial write, not a failure before any private bytes exist.
          if (operation === "writeFileSync")
            originalWrite(fd, "SYNTHETIC_PRIVATE_FAILED_TURN");
          assert.equal(fs.fstatSync(fd).mode & 0o777, 0o600);
          throw failure;
        },
      });
      syncBuiltinESMExports();
      assert.throws(
        () => history.save(privateTurn),
        (e) => e === failure,
      );
      const afterFailure = fs.readdirSync(dir);
      Object.assign(fs, { [operation]: original });
      syncBuiltinESMExports();
      assert.deepEqual(history.load(), []);
      history.save([]);
      assert.deepEqual(history.load(), []);
      assert.deepEqual(fs.readdirSync(dir), ["operator-chat.json"]);
      assert.deepEqual(afterFailure, ["operator-chat.json"]);
      assert.equal(
        fs.statSync(dir + "/operator-chat.json").mode & 0o777,
        0o600,
      );
    } finally {
      Object.assign(fs, { [operation]: original });
      syncBuiltinESMExports();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("history preserves the persistence exception when close and unlink also fail, then Clear retries cleanup", () => {
  const dir = mkdtempSync(tmpdir() + "/operator-history-cleanup-failure-");
  const originals = {
    fsyncSync: fs.fsyncSync,
    closeSync: fs.closeSync,
    unlinkSync: fs.unlinkSync,
  };
  const failure = new Error("original fsync failure");
  const cleanupFailure = Object.assign(new Error("synthetic unlink failure"), {
    code: "EACCES",
  });
  let failedFd: number | undefined;
  let closed = false;
  let unlinked = false;
  try {
    const history = new History(dir);
    history.save([]);
    fs.fsyncSync = (fd) => {
      failedFd = fd;
      throw failure;
    };
    fs.closeSync = (fd) => {
      originals.closeSync(fd);
      if (fd === failedFd) {
        closed = true;
        throw new Error("synthetic close failure");
      }
    };
    fs.unlinkSync = () => {
      unlinked = true;
      throw cleanupFailure;
    };
    syncBuiltinESMExports();
    assert.throws(
      () => history.save(privateTurn),
      (e) => e === failure,
    );
    assert.equal(closed, true);
    assert.equal(unlinked, true);
    Object.assign(fs, {
      fsyncSync: originals.fsyncSync,
      closeSync: originals.closeSync,
    });
    syncBuiltinESMExports();
    assert.throws(
      () => history.save([]),
      (e) => e === cleanupFailure,
    );
    assert.throws(
      () => new History(dir).load(),
      (e) => e === cleanupFailure,
    );
    Object.assign(fs, originals);
    syncBuiltinESMExports();
    history.save([]);
    assert.deepEqual(history.load(), []);
    assert.deepEqual(fs.readdirSync(dir), ["operator-chat.json"]);
  } finally {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("history cleans temporary data if rename fails without replacing canonical history", () => {
  const dir = mkdtempSync(tmpdir() + "/operator-history-rename-failure-");
  const original = fs.renameSync;
  const failure = new Error("synthetic rename failure");
  try {
    const history = new History(dir);
    history.save([]);
    fs.renameSync = () => {
      throw failure;
    };
    syncBuiltinESMExports();
    assert.throws(
      () => history.save(privateTurn),
      (e) => e === failure,
    );
    assert.deepEqual(fs.readdirSync(dir), ["operator-chat.json"]);
    assert.deepEqual(history.load(), []);
  } finally {
    fs.renameSync = original;
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});

const originalWrite = fs.writeFileSync;
const abandonedName = "operator-chat.json.12345678-1234-4123-8123-123456789abc";

for (const action of ["load", "clear"] as const) {
  test(`history ${action} removes only recognized abandoned regular temp files`, () => {
    const dir = mkdtempSync(tmpdir() + "/operator-history-stale-");
    try {
      const history = new History(dir);
      history.save(privateTurn);
      writeFileSync(dir + "/" + abandonedName, JSON.stringify(privateTurn), {
        mode: 0o600,
      });
      const unrelated = [
        "operator-chat.json.backup",
        abandonedName + ".backup",
        "other.12345678-1234-4123-8123-123456789abc",
      ];
      for (const name of unrelated)
        writeFileSync(dir + "/" + name, "unrelated");
      if (action === "load")
        assert.deepEqual(new History(dir).load(), privateTurn);
      else history.save([]);
      assert.deepEqual(
        fs.readdirSync(dir).sort(),
        ["operator-chat.json", ...unrelated].sort(),
      );
      assert.deepEqual(history.load(), action === "load" ? privateTurn : []);
      for (const name of unrelated)
        assert.equal(readFileSync(dir + "/" + name, "utf8"), "unrelated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const kind of ["symlink", "directory", "fifo", "hardlink"] as const) {
  test(`history fails closed on recognized ${kind} temp paths`, () => {
    const dir = mkdtempSync(tmpdir() + "/operator-history-unsafe-temp-");
    try {
      const history = new History(dir);
      history.save(privateTurn);
      const target = dir + "/private";
      const stale = dir + "/" + abandonedName;
      writeFileSync(target, "do not touch", { mode: 0o640 });
      if (kind === "symlink") symlinkSync(target, stale);
      if (kind === "directory") mkdirSync(stale);
      if (kind === "fifo") execFileSync("mkfifo", [stale]);
      if (kind === "hardlink") fs.linkSync(target, stale);
      assert.throws(() => new History(dir).load(), /UNSAFE_STORAGE/);
      assert.throws(() => history.save([]), /UNSAFE_STORAGE/);
      assert.ok(fs.lstatSync(stale));
      assert.equal(readFileSync(target, "utf8"), "do not touch");
      assert.equal(fs.statSync(target).mode & 0o777, 0o640);
      assert.deepEqual(
        JSON.parse(readFileSync(dir + "/operator-chat.json", "utf8")),
        privateTurn,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("history rejects symlinks, nonregular targets, malformed and oversized records without touching targets", () => {
  const dir = mkdtempSync(tmpdir() + "/operator-history-");
  const path = dir + "/operator-chat.json";
  try {
    const history = new History(dir);
    const target = dir + "/private";
    writeFileSync(target, "do not touch");
    symlinkSync(target, path);
    assert.throws(() => history.load());
    assert.throws(() => history.save([]));
    assert.equal(readFileSync(target, "utf8"), "do not touch");
    rmSync(path);
    execFileSync("mkfifo", [path]);
    assert.throws(() => history.load());
    assert.throws(() => history.save([]));
    rmSync(path);
    mkdirSync(path);
    assert.throws(() => history.load());
    assert.throws(() => history.save([]));
    rmSync(path, { recursive: true });
    for (const raw of [
      "not json",
      "{}",
      '[{"role":"system","text":"bad"}]',
      '[{"role":"user","text":"unpaired"}]',
      " ".repeat(131073),
    ]) {
      writeFileSync(path, raw);
      assert.throws(() => history.load());
    }
    rmSync(path);
    symlinkSync(dir, dir + "/alias");
    assert.throws(() => new History(dir + "/alias").save([]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
