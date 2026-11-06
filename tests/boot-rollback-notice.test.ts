// The bootstrap's rollback marker reaches Studio through the real supervisor:
// its startup recovery reads boot-rollback.json, the update snapshot crosses
// IPC to the application, and an exact admin dismissal removes the file.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/config/store.js";
import { sandboxModeFile } from "../src/sandbox/mode.js";
// A fixed fixture build, launchable from a dirty checkout as from CI.
import { supervise } from "./helpers/legacy-supervisor.js";

const failed = "a".repeat(40);
const previous = "b".repeat(40);
const at = 1762400000000;
const notice = { revision: failed, restored: previous, at };
const dismissPath = "/api/update/rollback-notice/dismiss";

// Workspace mode runs the current build without a Pi image; source checks
// never leave the host.
async function coachHome(prefix: string) {
  const home = await mkdtemp(join(tmpdir(), prefix));
  const store = new Store(home);
  await store.init();
  await writeFile(sandboxModeFile(home), '{"mode":"workspace"}');
  return { home, store };
}
const offline = async () => new Response("", { status: 503 });
const start = (store: Store) =>
  supervise(store, 0, undefined, { request: offline });
// Exactly what src/boot.ts writes.
const writeMarker = (home: string, value: unknown) =>
  writeFile(join(home, "boot-rollback.json"), JSON.stringify(value), {
    mode: 0o600,
  });
const markerBytes = (home: string) =>
  readFile(join(home, "boot-rollback.json"), "utf8");

function client(owner: { origin: string }, store: Store) {
  return async (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(owner.origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + store.secrets.admin,
        ...(body === undefined
          ? {}
          : { Origin: owner.origin, "Content-Type": "application/json" }),
        ...headers,
      },
      body:
        body === undefined
          ? undefined
          : typeof body === "string"
            ? body
            : JSON.stringify(body),
    });
    return { status: response.status, data: (await response.json()) as any };
  };
}

test("startup recovery exposes the rollback; only the exact notice is dismissed, once, with no update side effect", async () => {
  const { home, store } = await coachHome("coach-rollback-notice-");
  await writeMarker(home, notice);
  let owner = await start(store);
  try {
    assert.deepEqual(owner.updates.snapshot().bootRollback, notice);
    let api = client(owner, store);
    const exposed = await api("/api/update");
    assert.equal(exposed.status, 200);
    assert.deepEqual(exposed.data.bootRollback, notice);

    // Reading is not consuming: a restart shows the same notice.
    await owner.close();
    owner = await start(store);
    api = client(owner, store);
    assert.deepEqual((await api("/api/update")).data.bootRollback, notice);
    const before = await markerBytes(home);
    const homeBefore = (await readdir(home)).sort();

    // Authentication, origin and body guards leave the marker alone.
    const rejected: [Record<string, string>, unknown, number, string][] = [
      [{ Authorization: "Bearer wrong" }, notice, 401, "UNAUTHORIZED"],
      [{ Origin: "http://evil.invalid" }, notice, 403, "ORIGIN_REJECTED"],
      [{ "Content-Type": "text/plain" }, notice, 415, "JSON_REQUIRED"],
      [{}, { ...notice, extra: 1 }, 400, "ARGUMENTS_REJECTED"],
      [{}, { revision: failed, at }, 400, "ARGUMENTS_REJECTED"],
      [{}, { ...notice, at: String(at) }, 400, "ARGUMENTS_REJECTED"],
      [{}, { ...notice, at: at + 0.5 }, 400, "ARGUMENTS_REJECTED"],
      [{}, { ...notice, revision: "A".repeat(40) }, 400, "ARGUMENTS_REJECTED"],
      [{}, { ...notice, restored: "" }, 400, "ARGUMENTS_REJECTED"],
      [{}, [notice], 400, "ARGUMENTS_REJECTED"],
    ];
    for (const [headers, body, status, error] of rejected) {
      const result = await api(dismissPath, body, headers);
      assert.equal(result.status, status, JSON.stringify([headers, body]));
      assert.equal(result.data.error, error);
    }
    const noOrigin = await fetch(owner.origin + dismissPath, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + store.secrets.admin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(notice),
    });
    assert.equal(noOrigin.status, 403);
    assert.equal(((await noOrigin.json()) as any).error, "ORIGIN_REQUIRED");

    // Any field differing from the shown notice is stale.
    for (const stale of [
      { ...notice, at: at + 1 },
      { ...notice, restored: null },
      { ...notice, restored: "c".repeat(40) },
      { ...notice, revision: "c".repeat(40) },
    ]) {
      const result = await api(dismissPath, stale);
      assert.equal(result.status, 409);
      assert.equal(result.data.error, "ROLLBACK_NOTICE_STALE");
    }
    assert.equal(await markerBytes(home), before);
    assert.deepEqual((await api("/api/update")).data.bootRollback, notice);

    const dismissed = await api(dismissPath, notice);
    assert.equal(dismissed.status, 200);
    assert.equal(dismissed.data.bootRollback, null);
    await assert.rejects(lstat(join(home, "boot-rollback.json")), {
      code: "ENOENT",
    });
    assert.equal((await api("/api/update")).data.bootRollback, null);
    assert.equal(owner.updates.snapshot().bootRollback, null);
    // A repeated (lost-reply) dismissal finds nothing to remove.
    const again = await api(dismissPath, notice);
    assert.equal(again.status, 409);
    assert.equal(again.data.error, "ROLLBACK_NOTICE_STALE");

    // Dismissal is not an update operation.
    const state = owner.updates.snapshot();
    assert.equal(state.installed, owner.updates.installed);
    assert.equal(state.lastOperation, undefined);
    assert.equal(state.preparationAttempt, undefined);
    assert.equal(state.applying, false);
    assert.equal(state.preparing, false);
    assert.deepEqual(
      (await readdir(home)).sort(),
      homeBefore.filter((name) => name !== "boot-rollback.json"),
    );

    // Absence persists across restart.
    await owner.close();
    owner = await start(store);
    assert.equal(owner.updates.snapshot().bootRollback, null);
    assert.equal(
      (await client(owner, store)("/api/update")).data.bootRollback,
      null,
    );
  } finally {
    await owner.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a rollback to the bootstrap's own package has no restored revision", async () => {
  const { home, store } = await coachHome("coach-rollback-seed-");
  const seed = { revision: failed, restored: null, at };
  await writeMarker(home, seed);
  const owner = await start(store);
  try {
    assert.deepEqual(owner.updates.snapshot().bootRollback, seed);
    const api = client(owner, store);
    assert.deepEqual((await api("/api/update")).data.bootRollback, seed);
    assert.equal((await api(dismissPath, seed)).status, 200);
    await assert.rejects(lstat(join(home, "boot-rollback.json")), {
      code: "ENOENT",
    });
  } finally {
    await owner.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("absent, malformed, oversized or linked markers expose nothing and are never removed", async () => {
  const { home, store } = await coachHome("coach-rollback-invalid-");
  const marker = join(home, "boot-rollback.json");
  const outside = join(home, "outside.json");
  const cases: [string, () => Promise<void>][] = [
    ["absent", async () => {}],
    ["not JSON", () => writeFile(marker, "{not json")],
    ["null", () => writeFile(marker, "null")],
    ["array", () => writeFile(marker, JSON.stringify([notice]))],
    ["extra field", () => writeMarker(home, { ...notice, path: "/etc" })],
    ["missing field", () => writeMarker(home, { revision: failed, at })],
    ["short SHA", () => writeMarker(home, { ...notice, revision: "abc" })],
    [
      "uppercase SHA",
      () => writeMarker(home, { ...notice, restored: "B".repeat(40) }),
    ],
    ["string time", () => writeMarker(home, { ...notice, at: String(at) })],
    ["fractional time", () => writeMarker(home, { ...notice, at: at + 0.5 })],
    ["zero time", () => writeMarker(home, { ...notice, at: 0 })],
    ["invalid date", () => writeMarker(home, { ...notice, at: 9e15 })],
    [
      "oversized",
      () => writeFile(marker, JSON.stringify(notice) + " ".repeat(4096)),
    ],
    [
      "symlink",
      async () => {
        await writeFile(outside, JSON.stringify(notice));
        await symlink(outside, marker);
      },
    ],
    ["directory", () => mkdir(marker)],
  ];
  let owner: Awaited<ReturnType<typeof start>> | undefined;
  try {
    for (const [name, prepare] of cases) {
      await rm(marker, { recursive: true, force: true });
      await rm(outside, { force: true });
      await prepare();
      const before = await lstat(marker).catch(() => undefined);
      owner = await start(store);
      assert.equal(owner.updates.snapshot().bootRollback, null, name);
      const api = client(owner, store);
      assert.equal((await api("/api/update")).data.bootRollback, null, name);
      const result = await api(dismissPath, notice);
      assert.equal(result.status, 409, name);
      assert.equal(result.data.error, "ROLLBACK_NOTICE_STALE", name);
      const after = await lstat(marker).catch(() => undefined);
      assert.equal(after?.ino, before?.ino, name);
      if (name === "symlink")
        assert.equal(await readFile(outside, "utf8"), JSON.stringify(notice));
      await owner.close();
      owner = undefined;
    }
  } finally {
    await owner?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a stale dismissal never removes a newer or replaced rollback marker", async () => {
  const { home, store } = await coachHome("coach-rollback-stale-");
  await writeMarker(home, notice);
  let owner = await start(store);
  try {
    // The bootstrap writes only while no supervisor runs: a repeat failure of
    // the same upgrade, between two supervisors, differs only in time.
    await owner.close();
    const newer = { ...notice, at: at + 60000 };
    await writeMarker(home, newer);
    owner = await start(store);
    let api = client(owner, store);
    assert.deepEqual((await api("/api/update")).data.bootRollback, newer);
    const stale = await api(dismissPath, notice);
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error, "ROLLBACK_NOTICE_STALE");
    assert.equal(await markerBytes(home), JSON.stringify(newer));

    // A file replaced behind the supervisor is not the one it read, even with
    // identical content (a new file) or identical identity (rewritten).
    const replacement = join(home, "replacement.tmp");
    await writeFile(replacement, JSON.stringify(newer), { mode: 0o600 });
    await rename(replacement, join(home, "boot-rollback.json"));
    const replaced = await api(dismissPath, newer);
    assert.equal(replaced.status, 409);
    assert.equal(replaced.data.error, "ROLLBACK_NOTICE_STALE");
    assert.equal(await markerBytes(home), JSON.stringify(newer));

    await owner.close();
    owner = await start(store);
    api = client(owner, store);
    const rewritten = { ...newer, at: newer.at + 1 };
    await writeFile(
      join(home, "boot-rollback.json"),
      JSON.stringify(rewritten),
    );
    const changed = await api(dismissPath, newer);
    assert.equal(changed.status, 409);
    assert.equal(changed.data.error, "ROLLBACK_NOTICE_STALE");
    assert.equal(await markerBytes(home), JSON.stringify(rewritten));
  } finally {
    await owner.close();
    await rm(home, { recursive: true, force: true });
  }
});

test(
  "a failed removal keeps the notice until a later dismissal succeeds",
  { skip: process.getuid?.() === 0 && "root ignores directory permissions" },
  async () => {
    const { home, store } = await coachHome("coach-rollback-failure-");
    await writeMarker(home, notice);
    const owner = await start(store);
    try {
      const api = client(owner, store);
      await chmod(home, 0o500);
      let result;
      try {
        result = await api(dismissPath, notice);
      } finally {
        await chmod(home, 0o700);
      }
      assert.equal(result.status, 503);
      assert.equal(result.data.error, "ROLLBACK_NOTICE_DISMISS_FAILED");
      assert.equal(await markerBytes(home), JSON.stringify(notice));
      assert.deepEqual((await api("/api/update")).data.bootRollback, notice);
      assert.equal((await api(dismissPath, notice)).status, 200);
      await assert.rejects(lstat(join(home, "boot-rollback.json")), {
        code: "ENOENT",
      });
    } finally {
      await owner.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("an upgrade in progress refuses dismissal", async () => {
  const { home, store } = await coachHome("coach-rollback-applying-");
  await writeMarker(home, notice);
  const owner = await start(store);
  try {
    const api = client(owner, store);
    owner.updates.applying = true;
    const deadline = Date.now() + 3000;
    while (!(await api("/api/update")).data.applying) {
      assert.ok(Date.now() < deadline, "applying state never reached Studio");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const result = await api(dismissPath, notice);
    assert.equal(result.status, 409);
    assert.equal(result.data.error, "UPDATE_IN_PROGRESS");
    assert.equal(await markerBytes(home), JSON.stringify(notice));
    owner.updates.applying = false;
  } finally {
    await owner.close();
    await rm(home, { recursive: true, force: true });
  }
});
