import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  stat,
  writeFile,
  readFile,
  mkdir,
  chmod,
  appendFile,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Updates } from "../src/update/updates.js";
import { PreparationJournal } from "../src/update/preparation.js";
import { Store } from "../src/config/store.js";
import { UpdateJournal } from "../src/update/journal.js";
import { pathToFileURL } from "node:url";
import {
  activateLegacyFixture,
  supervise,
} from "./helpers/legacy-supervisor.js";

test("failed preparation journal blocks staging and reports a non-durable bounded reason", async () => {
  let staged = 0;
  const updates = new Updates(
    null,
    async () => {},
    fetch,
    undefined,
    async () => {
      staged++;
    },
    undefined,
    async () => {
      throw new Error("private storage path sentinel");
    },
  );
  updates.latest = "a".repeat(40);
  updates.checkedAt = Date.now();
  await assert.rejects(updates.prepare(updates.latest));
  assert.equal(staged, 0);
  assert.equal(updates.preparationAttempt?.state, "failed");
  assert.equal(
    updates.preparationAttempt?.reason,
    "PREPARATION_JOURNAL_UNAVAILABLE",
  );
  assert.equal(updates.preparationAttempt?.durable, false);
  assert.equal(updates.preparing, false);
  assert.doesNotMatch(
    JSON.stringify(updates.snapshot()),
    /private storage|sentinel/,
  );
});

test("owner hydration preserves completed preparation without inferring installation from a lost reservation", async () => {
  const home = await mkdtemp(join(tmpdir(), "preparation-interrupted-"));
  try {
    const journal = new PreparationJournal(home);
    const attempt = {
      id: "12345678-1234-1234-1234-123456789abc",
      sha: "a".repeat(40),
      stage: "artifact" as const,
      state: "ready" as const,
      at: Date.now(),
      durable: true,
    };
    await journal.write(attempt);
    const recovered = await journal.recover();
    assert.equal(recovered?.state, "completed");
    assert.equal(recovered?.at, attempt.at);
    assert.equal(recovered?.id, attempt.id);
    assert.equal(recovered?.sha, attempt.sha);
    assert.deepEqual(await journal.recover(), recovered);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("cancellation records a terminal preparation observation independently from install acceptance", async () => {
  const home = await mkdtemp(join(tmpdir(), "preparation-cancelled-"));
  try {
    const journal = new PreparationJournal(home);
    const updates = new Updates(
      null,
      async () => {},
      fetch,
      undefined,
      async () => {},
      async () => {},
      (a) => journal.write(a),
    );
    updates.latest = "a".repeat(40);
    updates.checkedAt = Date.now();
    await updates.prepare(updates.latest);
    const id = updates.preparationAttempt!.id;
    await updates.cancelPreparation(
      updates.latest,
      updates.preparationAttempt!.id,
    );
    assert.equal(updates.preparationAttempt?.state, "cancelled");
    assert.equal(updates.preparationAttempt?.id, id);
    assert.deepEqual(await journal.recover(), updates.preparationAttempt);
    assert.equal(updates.lastOperation, undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("authenticated prepare denial survives RPC, reload and owner restart without replacing accepted receipt or child", async () => {
  const home = await mkdtemp(join(tmpdir(), "preparation-attempt-"));
  const sha = "a".repeat(40);
  const store = new Store(home);
  let owner: Awaited<ReturnType<typeof supervise>> | undefined;
  try {
    await store.init();
    const receipt = {
      id: "12345678-1234-1234-1234-123456789abc",
      sha: "1".repeat(40),
      state: "succeeded" as const,
      at: Date.now(),
    };
    await new UpdateJournal(home).write(receipt);
    let sourceCalls = 0,
      preparations = 0;
    const boundary = {
      request: async () => {
        sourceCalls++;
        return new Response(JSON.stringify({ object: { sha } }));
      },
      prepare: async () => {
        preparations++;
        throw new Error("EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED");
      },
    };
    owner = await supervise(store, 0, undefined, boundary);
    const headers = {
      Authorization: "Bearer " + store.secrets.admin,
      Origin: owner.origin,
      "Content-Type": "application/json",
    };
    const post = (path: string, body = {}) =>
      fetch(owner!.origin + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    assert.equal((await post("/api/update/check")).status, 200);
    const pid = owner.pid;
    const installed = owner.updates.installed;
    assert.equal(
      (await post("/api/update/apply", { sha, confirm: true })).status,
      409,
    );
    const state = await (
      await fetch(owner.origin + "/api/update", { headers })
    ).json();
    assert.equal(state.preparationAttempt?.state, "failed");
    assert.equal(state.preparationAttempt.sha, sha);
    assert.equal(state.preparationAttempt.stage, "source");
    assert.equal(
      state.preparationAttempt.reason,
      "EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED",
    );
    assert.equal(state.preparationAttempt.durable, true);
    assert.deepEqual(state.lastOperation, receipt);
    assert.equal(state.preparing, false);
    assert.doesNotMatch(state.guidance, /^Preparing/);
    assert.equal(owner.pid, pid);
    assert.equal(owner.updates.installed, installed);
    assert.equal(preparations, 1);
    assert.equal(sourceCalls, 1); // denial performs no extra source discovery
    assert.equal(
      (await stat(join(home, "update-preparation.json"))).mode & 0o777,
      0o600,
    );
    await owner.close();
    owner = await supervise(store, 0, undefined, boundary);
    const reloaded = await (
      await fetch(owner.origin + "/api/update", {
        headers: { Authorization: headers.Authorization },
      })
    ).json();
    assert.deepEqual(reloaded.preparationAttempt, state.preparationAttempt);
    assert.deepEqual(reloaded.lastOperation, receipt);
    assert.equal(preparations, 1);
  } finally {
    await owner?.close();
    await rm(home, { recursive: true, force: true });
  }
});

for (const damage of [
  "corrupt",
  "oversized",
  "directory",
  "unreadable",
] as const) {
  test(`diagnostic ${damage} journal preserves existing runtime and blocks source preparation`, async () => {
    const home = await mkdtemp(join(tmpdir(), "preparation-damage-"));
    const store = new Store(home);
    let owner: Awaited<ReturnType<typeof supervise>> | undefined;
    const path = join(home, "update-preparation.json");
    let staged = 0;
    try {
      await store.init();
      const receipt = {
        id: "12345678-1234-1234-1234-123456789abc",
        sha: "1".repeat(40),
        state: "succeeded" as const,
        at: Date.now(),
      };
      await new UpdateJournal(home).write(receipt);
      const bytes =
        damage === "oversized" ? "x".repeat(2049) : "private corrupt sentinel";
      if (damage === "directory") await mkdir(path);
      else
        await writeFile(path, bytes, {
          mode: damage === "unreadable" ? 0 : 0o600,
        });
      owner = await supervise(store, 0, undefined, {
        prepare: async () => {
          staged++;
          throw Error("must not stage");
        },
      });
      const headers = { Authorization: "Bearer " + store.secrets.admin };
      assert.equal(
        (await fetch(owner.origin + "/api/status", { headers })).status,
        200,
      );
      const pid = owner.pid;
      owner.updates.latest = "a".repeat(40);
      owner.updates.checkedAt = Date.now();
      await assert.rejects(
        owner.updates.prepare(owner.updates.latest),
        /PREPARATION_JOURNAL_UNAVAILABLE/,
      );
      assert.equal(staged, 0);
      assert.equal(owner.pid, pid);
      assert.equal(owner.updates.installed, receipt.sha);
      assert.deepEqual(owner.updates.lastOperation, receipt);
      assert.equal(
        (owner.updates.snapshot() as any).preparationJournalIssue,
        "PREPARATION_JOURNAL_UNAVAILABLE",
      );
      assert.doesNotMatch(
        JSON.stringify(owner.updates.snapshot()),
        /private corrupt sentinel/,
      );
      if (damage === "directory")
        assert.equal((await stat(path)).isDirectory(), true);
      else {
        await chmod(path, 0o600);
        assert.equal(await readFile(path, "utf8"), bytes);
      }
    } finally {
      await owner?.close();
      await chmod(path, 0o700).catch(() => {});
      await rm(home, { recursive: true, force: true });
    }
  });
}

test("failed diagnostic recovery write is process-local and can recover durable storage", async () => {
  const home = await mkdtemp(join(tmpdir(), "preparation-write-recovery-"));
  try {
    const journal = new PreparationJournal(home);
    await journal.write({
      id: "12345678-1234-1234-1234-123456789abc",
      sha: "a".repeat(40),
      state: "preparing",
      stage: "source",
      at: Date.now(),
      durable: true,
    });
    await chmod(home, 0o500);
    const attempt = await journal.recover();
    assert.equal(attempt?.state, "interrupted");
    assert.equal(attempt?.durable, false);
    assert.equal((journal as any).issue, "PREPARATION_JOURNAL_UNAVAILABLE");
    await assert.rejects(journal.write(attempt!));
    await chmod(home, 0o700);
    await journal.write(attempt!);
    assert.equal((journal as any).issue, undefined);
    assert.equal((await journal.recover())?.durable, true);
  } finally {
    await chmod(home, 0o700);
    await rm(home, { recursive: true, force: true });
  }
});

async function candidate(home: string, sha: string) {
  const root = join(home, "versions", sha);
  await mkdir(join(root, "dist/config"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "dist/server"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(
    join(root, "dist/build.json"),
    JSON.stringify({ revision: sha, protocol: 1 }),
  );
  await writeFile(
    join(root, "dist/config/store.js"),
    `export {Store} from ${JSON.stringify(pathToFileURL(resolve("dist/config/store.js")).href)};`,
  );
  await writeFile(
    join(root, "dist/server/admin.js"),
    `export {admin, updatePreparationProtocol} from ${JSON.stringify(pathToFileURL(resolve("dist/server/admin.js")).href)};`,
  );
  return root;
}

test("authenticated waiting cancellation reaches owner journal and survives restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "preparation-rpc-cancel-"));
  const store = new Store(home);
  let owner: Awaited<ReturnType<typeof supervise>> | undefined;
  const sha = "a".repeat(40);
  try {
    await store.init();
    await activateLegacyFixture(home);
    await appendFile(
      join(home, "versions", "1".repeat(40), "dist/server/terminal.js"),
      '\nObject.defineProperty(NativeTerminal.prototype, "idle", {get(){return false;}});\n',
    );
    const receipt = {
      id: "12345678-1234-1234-1234-123456789abc",
      sha: "1".repeat(40),
      state: "succeeded" as const,
      at: Date.now(),
    };
    await new UpdateJournal(home).write(receipt);
    owner = await supervise(store, 0, undefined, {
      prepare: (s) => candidate(home, s),
      request: async () => new Response(JSON.stringify({ object: { sha } })),
    });
    const headers = {
      Authorization: "Bearer " + store.secrets.admin,
      Origin: owner.origin,
      "Content-Type": "application/json",
    };
    const post = (path: string, body = {}) =>
      fetch(owner!.origin + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    await post("/api/update/check");
    const queued = await post("/api/update/apply", { sha, confirm: true });
    assert.equal(queued.status, 202, await queued.clone().text());
    const { id } = await queued.json();
    const attempt = owner.updates.preparationAttempt!;
    assert.equal(attempt.state, "ready");
    assert.equal((await post("/api/update/cancel", { id })).status, 200);
    assert.equal(owner.updates.preparationAttempt?.state, "cancelled");
    assert.equal(owner.updates.preparationAttempt?.id, attempt.id);
    await assert.rejects(access(join(home, "versions", sha)), {
      code: "ENOENT",
    });
    assert.deepEqual(owner.updates.lastOperation, receipt);
    await owner.close();
    owner = await supervise(store, 0);
    assert.equal(owner.updates.preparationAttempt?.state, "cancelled");
    assert.equal(owner.updates.preparationAttempt?.id, attempt.id);
    assert.deepEqual(owner.updates.lastOperation, receipt);
  } finally {
    await owner?.close();
    await rm(home, { recursive: true, force: true });
  }
});

async function until(check: () => Promise<boolean>) {
  for (let n = 0; n < 300; n++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("fixture did not reach held command");
}

for (const phase of ["source", "probe"] as const) {
  test(`owner shutdown cancels actual spawned ${phase} command and cleans candidate`, async () => {
    const home = await mkdtemp(join(tmpdir(), "preparation-command-"));
    const store = new Store(home);
    const marker = join(home, "command-started");
    let owner: Awaited<ReturnType<typeof supervise>> | undefined;
    const sha = "a".repeat(40);
    const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(()=>{},1000);`;
    try {
      await store.init();
      owner = await supervise(store, 0, undefined, {
        prepare: async (target, signal) => {
          if (phase === "source") {
            const { command } = await import("../src/update/managed.js");
            await command(process.execPath, ["-e", script], home, home, signal);
          }
          const root = await candidate(home, target);
          if (phase === "probe")
            await writeFile(
              join(root, "dist/server/admin.js"),
              `import fs from 'node:fs'; export async function admin(){ fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid)); await new Promise(()=>{}); }`,
            );
          return root;
        },
      });
      owner.updates.latest = sha;
      owner.updates.checkedAt = Date.now();
      const preparation = owner.updates.prepare(sha);
      const rejected = assert.rejects(preparation, /BUILD_CANCELLED/);
      void rejected.catch(() => {});
      await until(async () =>
        access(marker).then(
          () => true,
          () => false,
        ),
      );
      const pid = Number(await readFile(marker, "utf8"));
      assert.equal(await owner.close(), true);
      await rejected;
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      assert.equal(owner.updates.preparationAttempt?.state, "cancelled");
      assert.equal(owner.updates.lastOperation, undefined);
      assert.equal(
        (await new PreparationJournal(home).recover())?.state,
        "cancelled",
      );
      await assert.rejects(access(join(home, "versions", sha)), {
        code: "ENOENT",
      });
    } finally {
      await owner?.close();
      await rm(home, { recursive: true, force: true });
    }
  });
}

test("real command failure remains a failure when signal aborts after exit", async () => {
  const home = await mkdtemp(join(tmpdir(), "command-failure-"));
  const controller = new AbortController();
  try {
    const { command } = await import("../src/update/managed.js");
    await assert.rejects(
      command(
        process.execPath,
        ["-e", "process.exit(7)"],
        home,
        home,
        controller.signal,
      ),
      /BUILD_FAILED/,
    );
    controller.abort();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("duplicate authenticated HTTP confirmation cannot release the first owner reservation", async () => {
  const home = await mkdtemp(join(tmpdir(), "preparation-duplicate-"));
  const store = new Store(home);
  let owner: Awaited<ReturnType<typeof supervise>> | undefined;
  const sha = "a".repeat(40);
  const held = join(home, "admission-held"),
    release = join(home, "admission-release");
  try {
    await store.init();
    await activateLegacyFixture(home);
    const active = join(home, "versions", "1".repeat(40));
    await appendFile(
      join(active, "dist/autonomy/host.js"),
      `
      const fixtureFS = await import('node:fs');
      const fixtureReconcile = AutonomyHost.prototype.reconcile;
      AutonomyHost.prototype.reconcile = async function(){
        const p = ${JSON.stringify(join(home, "update-preparation.json"))};
        if(fixtureFS.existsSync(p) && JSON.parse(fixtureFS.readFileSync(p)).state === 'ready') {
          fixtureFS.writeFileSync(${JSON.stringify(held)}, 'held');
          while(!fixtureFS.existsSync(${JSON.stringify(release)})) await new Promise(r=>setTimeout(r,10));
        }
        return fixtureReconcile.call(this);
      };
    `,
    );
    await appendFile(
      join(active, "dist/server/terminal.js"),
      '\nObject.defineProperty(NativeTerminal.prototype, "idle", {get(){return false;}});\n',
    );
    let preparations = 0;
    owner = await supervise(store, 0, undefined, {
      prepare: (s) => {
        preparations++;
        return candidate(home, s);
      },
      request: async () => new Response(JSON.stringify({ object: { sha } })),
    });
    const headers = {
      Authorization: "Bearer " + store.secrets.admin,
      Origin: owner.origin,
      "Content-Type": "application/json",
    };
    const post = (path: string, body = {}) =>
      fetch(owner!.origin + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    await post("/api/update/check");
    const first = post("/api/update/apply", { sha, confirm: true });
    void first.catch(() => {});
    await until(async () =>
      access(held).then(
        () => true,
        () => false,
      ),
    );
    const attempt = structuredClone(owner.updates.preparationAttempt);
    const duplicate = await post("/api/update/apply", { sha, confirm: true });
    // Inspect the owner before asserting the status, so RED proves the destructive race.
    await access(join(home, "versions", sha));
    assert.deepEqual(owner.updates.preparationAttempt, attempt);
    assert.equal(duplicate.status, 409);
    assert.equal(preparations, 1);
    await writeFile(release, "release");
    const accepted = await first;
    assert.equal(accepted.status, 202, await accepted.clone().text());
    assert.equal(owner.updates.lastOperation, undefined);
    const { id } = await accepted.json();
    assert.equal((await post("/api/update/cancel", { id })).status, 200);
    assert.equal(owner.updates.preparationAttempt?.state, "cancelled");
  } finally {
    await writeFile(release, "release");
    await owner?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("same-SHA stale cancellation cannot release another preparation token", async () => {
  const updates = new Updates(
    null,
    async () => {},
    fetch,
    undefined,
    async () => {},
  );
  const sha = "a".repeat(40),
    first = "12345678-1234-1234-1234-123456789abc",
    second = "22345678-1234-1234-1234-123456789abc";
  updates.latest = sha;
  updates.checkedAt = Date.now();
  await updates.prepare(sha, first);
  await updates.cancelPreparation(sha, first);
  await updates.prepare(sha, second);
  await assert.rejects(
    updates.cancelPreparation(sha, first),
    /TARGET_REJECTED/,
  );
  assert.equal(updates.preparationAttempt?.state, "ready");
  assert.equal(updates.preparationAttempt?.id, second);
});

test("owner retains cancellation cleanup ownership on failure and drains on shutdown", async () => {
  const home = await mkdtemp(join(tmpdir(), "preparation-cancel-cleanup-"));
  const store = new Store(home);
  let owner: Awaited<ReturnType<typeof supervise>> | undefined;
  const sha = "a".repeat(40),
    versions = join(home, "versions");
  try {
    await store.init();
    await activateLegacyFixture(home);
    await appendFile(
      join(versions, "1".repeat(40), "dist/server/terminal.js"),
      '\nObject.defineProperty(NativeTerminal.prototype, "idle", {get(){return false;}});\n',
    );
    let preparations = 0;
    owner = await supervise(store, 0, undefined, {
      prepare: (s) => {
        preparations++;
        return candidate(home, s);
      },
      request: async () => new Response(JSON.stringify({ object: { sha } })),
    });
    const headers = {
      Authorization: "Bearer " + store.secrets.admin,
      Origin: owner.origin,
      "Content-Type": "application/json",
    };
    const post = (path: string, body = {}) =>
      fetch(owner!.origin + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    await post("/api/update/check");
    const queued = await post("/api/update/apply", { sha, confirm: true });
    assert.equal(queued.status, 202);
    const { id } = await queued.json();
    const token = owner.updates.preparationAttempt!.id;
    await chmod(versions, 0o500);
    await post("/api/update/cancel", { id });
    assert.equal(owner.updates.cleanupWarning, true);
    assert.equal(owner.updates.preparationAttempt?.state, "failed");
    assert.equal(
      owner.updates.preparationAttempt?.reason,
      "UPDATE_CLEANUP_PENDING",
    );
    assert.equal(owner.updates.preparationAttempt?.id, token);
    assert.equal(owner.updates.lastOperation, undefined);
    assert.notEqual(
      (await post("/api/update/apply", { sha, confirm: true })).status,
      202,
    );
    assert.equal(preparations, 1);
    assert.equal(await owner.close(), false);
    await chmod(versions, 0o700);
    assert.equal(await owner.close(), true);
    await assert.rejects(access(join(versions, sha)), { code: "ENOENT" });
  } finally {
    await chmod(versions, 0o700).catch(() => {});
    await owner?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("owner preparation failure after reserving candidate cleans only its own reservation", async () => {
  const home = await mkdtemp(join(tmpdir(), "preparation-ready-write-"));
  const store = new Store(home);
  let owner: Awaited<ReturnType<typeof supervise>> | undefined;
  const sha = "a".repeat(40),
    journal = join(home, "update-preparation.json");
  try {
    await store.init();
    owner = await supervise(store, 0, undefined, {
      prepare: async (s) => {
        const root = await candidate(home, s);
        // Re-export wrapper: fail only the final diagnostic write, after real probe readiness.
        await writeFile(
          join(root, "dist/server/admin.js"),
          `
        import {admin as base} from ${JSON.stringify(pathToFileURL(resolve("dist/server/admin.js")).href)};
        import {chmod} from 'node:fs/promises';
        export async function admin(...args) { const app = await base(...args); const close = app.close; app.close = async () => {await close(); await chmod(${JSON.stringify(journal)},0);}; return app; }
      `,
        );
        return root;
      },
      request: async () => new Response(JSON.stringify({ object: { sha } })),
    });
    const headers = {
      Authorization: "Bearer " + store.secrets.admin,
      Origin: owner.origin,
      "Content-Type": "application/json",
    };
    const post = (path: string, body = {}) =>
      fetch(owner!.origin + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    await post("/api/update/check");
    const pid = owner.pid;
    assert.equal(
      (await post("/api/update/apply", { sha, confirm: true })).status,
      503,
    );
    await assert.rejects(access(join(home, "versions", sha)), {
      code: "ENOENT",
    });
    assert.equal(owner.pid, pid);
    assert.equal(owner.updates.lastOperation, undefined);
    assert.equal(
      owner.updates.preparationAttempt?.reason,
      "PREPARATION_JOURNAL_UNAVAILABLE",
    );
  } finally {
    await chmod(journal, 0o600).catch(() => {});
    await owner?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("cleanup failure during intentional abort remains failed and owned", async () => {
  const home = await mkdtemp(join(tmpdir(), "preparation-abort-cleanup-"));
  const store = new Store(home);
  const sha = "a".repeat(40),
    versions = join(home, "versions");
  let owner: Awaited<ReturnType<typeof supervise>> | undefined,
    held = false;
  try {
    await store.init();
    owner = await supervise(store, 0, undefined, {
      prepare: (s) => candidate(home, s),
      preflight: async (root, _home, signal) => {
        if (!root.endsWith(sha)) return undefined;
        await chmod(versions, 0o500);
        held = true;
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
        return undefined;
      },
    });
    owner.updates.latest = sha;
    owner.updates.checkedAt = Date.now();
    const result = owner.updates.prepare(sha).catch((e) => e);
    await until(async () => held);
    assert.equal(await owner.close(), false);
    assert.match((await result).message, /UPDATE_CLEANUP_PENDING/);
    assert.equal(owner.updates.preparationAttempt?.state, "failed");
    assert.equal(
      owner.updates.preparationAttempt?.reason,
      "UPDATE_CLEANUP_PENDING",
    );
    await chmod(versions, 0o700);
    assert.equal(await owner.close(), true);
    await assert.rejects(access(join(versions, sha)), { code: "ENOENT" });
  } finally {
    await chmod(versions, 0o700).catch(() => {});
    await owner?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("actual supervisor starts existing runtime when diagnostic recovery persistence fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "preparation-recovery-write-"));
  const store = new Store(home);
  let owner: Awaited<ReturnType<typeof supervise>> | undefined;
  let restore = () => {};
  try {
    await store.init();
    await activateLegacyFixture(home);
    const receipt = {
      id: "12345678-1234-1234-1234-123456789abc",
      sha: "1".repeat(40),
      state: "succeeded" as const,
      at: Date.now(),
    };
    await new UpdateJournal(home).write(receipt);
    await new PreparationJournal(home).write({
      ...receipt,
      sha: "a".repeat(40),
      state: "preparing",
      stage: "source",
      durable: true,
    });
    // The copied real supervisor imports this same class. Fault only diagnostic IO;
    // installation/resume/publication journals keep their production behavior.
    const { PreparationJournal: OwnerJournal } = await import(
      pathToFileURL(
        join(home, "legacy-bootstrap-fixture/src/update/preparation.ts"),
      ).href
    );
    const write = OwnerJournal.prototype.write;
    OwnerJournal.prototype.write = async function () {
      this.issue = "PREPARATION_JOURNAL_UNAVAILABLE";
      throw Error("private storage failure");
    };
    restore = () => {
      OwnerJournal.prototype.write = write;
    };
    let staged = 0;
    owner = await supervise(store, 0, undefined, {
      prepare: async () => {
        staged++;
        throw Error("BUILD_FAILED");
      },
    });
    const headers = { Authorization: "Bearer " + store.secrets.admin };
    assert.equal(
      (await fetch(owner.origin + "/api/status", { headers })).status,
      200,
    );
    const state = await (
      await fetch(owner.origin + "/api/update", { headers })
    ).json();
    assert.equal(state.preparationAttempt.state, "interrupted");
    assert.equal(state.preparationAttempt.durable, false);
    assert.equal(
      state.preparationJournalIssue,
      "PREPARATION_JOURNAL_UNAVAILABLE",
    );
    owner.updates.latest = "a".repeat(40);
    owner.updates.checkedAt = Date.now();
    await assert.rejects(
      owner.updates.prepare(owner.updates.latest),
      /PREPARATION_JOURNAL_UNAVAILABLE/,
    );
    assert.equal(staged, 0);
    assert.equal(owner.updates.installed, receipt.sha);
    assert.deepEqual(owner.updates.lastOperation, receipt);
    restore();
    await assert.rejects(
      owner.updates.prepare(owner.updates.latest),
      /BUILD_FAILED/,
    );
    assert.equal(
      staged,
      1,
      "preparation may resume after durable writes recover",
    );
    assert.equal(owner.updates.preparationAttempt?.durable, true);
    assert.equal(owner.updates.preparationJournalIssue, undefined);
  } finally {
    restore();
    await owner?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("owner IPC rejects a stale same-SHA token without releasing current reservation", async () => {
  const home = await mkdtemp(join(tmpdir(), "preparation-owner-token-"));
  const store = new Store(home);
  let owner: Awaited<ReturnType<typeof supervise>> | undefined;
  const sha = "a".repeat(40);
  const first = "12345678-1234-1234-1234-123456789abc",
    second = "22345678-1234-1234-1234-123456789abc";
  try {
    await store.init();
    await activateLegacyFixture(home);
    await writeFile(
      join(home, "versions", "1".repeat(40), "dist/server/admin.js"),
      `
      import {createServer} from 'node:http';
      export const updatePreparationProtocol = 2;
      export async function admin(store, port, infer, close, updates) {
        const server = createServer(async (req,res) => {
          const send = (code, body) => {res.writeHead(code, {'Content-Type':'application/json'});res.end(JSON.stringify(body));};
          if(req.headers.authorization !== 'Bearer ' + store.secrets.admin) return send(401,{});
          if(req.url === '/api/status') return send(200,{state:'stopped'});
          let raw=''; for await(const part of req) raw+=part;
          const {sha,token}=JSON.parse(raw || '{}');
          try {
            if(req.url === '/check') await updates.check();
            if(req.url === '/prepare') await updates.prepare(sha,token);
            if(req.url === '/cancel') await updates.cancelPreparation(sha,token);
            return send(200,updates.snapshot());
          } catch(e) {send(409,{error:e.message});}
        });
        await new Promise(r=>server.listen(port,'127.0.0.1',r));
        return {origin:'http://127.0.0.1:'+server.address().port, async close(){server.closeAllConnections();await new Promise(r=>server.close(r));}};
      }
    `,
    );
    owner = await supervise(store, 0, undefined, {
      prepare: (s) => candidate(home, s),
      request: async () => new Response(JSON.stringify({ object: { sha } })),
    });
    const headers = {
      Authorization: "Bearer " + store.secrets.admin,
      "Content-Type": "application/json",
    };
    const post = (path: string, token = first) =>
      fetch(owner!.origin + path, {
        method: "POST",
        headers,
        body: JSON.stringify({ sha, token }),
      });
    await post("/check");
    assert.equal((await post("/prepare")).status, 200);
    assert.equal((await post("/cancel")).status, 200);
    assert.equal((await post("/prepare", second)).status, 200);
    const attempt = structuredClone(owner.updates.preparationAttempt);
    assert.equal((await post("/prepare", first)).status, 409);
    assert.equal((await post("/cancel", first)).status, 409);
    await access(join(home, "versions", sha));
    assert.deepEqual(owner.updates.preparationAttempt, attempt);
    assert.equal((await post("/cancel", second)).status, 200);
    assert.equal(owner.updates.preparationAttempt?.state, "cancelled");
    assert.equal(owner.updates.lastOperation, undefined);
  } finally {
    await owner?.close();
    await rm(home, { recursive: true, force: true });
  }
});
