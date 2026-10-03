import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { Updates } from "../src/update/updates.js";
import { UpdateJournal } from "../src/update/journal.js";

const waitFor = async (predicate: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 2000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, "update barrier did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("HTTP queue acknowledgement precedes durable acceptance, never activation", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-accept-");
  const store = new Store(dir);
  await store.init();
  const installed = "b".repeat(40),
    target = "a".repeat(40);
  const journal = new UpdateJournal(dir);
  let release!: () => void,
    finish!: () => void,
    journalEntered = false,
    accepted = false,
    executions = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const activation = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const updates: Updates = new Updates(
    installed,
    async (sha) => {
      executions++;
      assert.equal(sha, target);
      assert.equal(updates.installed, installed);
      assert.equal(accepted, true, "activation must follow durable acceptance");
      const receipt = await new UpdateJournal(dir).read();
      assert.equal(receipt?.sha, target);
      assert.equal(receipt?.state, "applying");
      assert.equal(receipt?.id, updates.lastOperation?.id);
      await activation;
    },
    undefined,
    async (op) => {
      if (op.state === "applying") {
        journalEntered = true;
        await gate;
      }
      await journal.write(op);
      if (op.state === "applying") accepted = true;
    },
  );
  updates.latest = target;
  updates.checkedAt = Date.now();
  const app = await admin(store, 0, undefined, undefined, updates);
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  const snapshot = async () =>
    (await fetch(app.origin + "/api/update", { headers })).json();
  const apply = () =>
    fetch(app.origin + "/api/update/apply", {
      method: "POST",
      headers,
      body: JSON.stringify({ sha: target, confirm: true }),
    });
  try {
    const response = await apply();
    assert.equal(response.status, 202);
    const queued = await response.json();
    assert.equal(queued.ok, true);
    assert.equal(queued.queued, true);
    assert.equal(typeof queued.id, "string");
    await waitFor(() => journalEntered);
    let acceptanceResolved = false;
    const acceptance = updates.accepted.then(() => {
      acceptanceResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 70));
    const waiting = await snapshot();
    assert.equal(waiting.manualQueue.id, queued.id);
    assert.equal(waiting.manualQueue.sha, target);
    assert.equal(waiting.manualQueue.persistence, "process-local");
    assert.equal(waiting.manualQueue.phase, "installing");
    assert.equal(waiting.installed, installed);
    assert.equal(accepted, false);
    assert.equal(acceptanceResolved, false);
    assert.equal(executions, 0);
    assert.equal(await journal.read(), undefined);
    const duplicate = await apply();
    assert.equal(duplicate.status, 202);
    assert.equal(
      (await duplicate.json()).id,
      queued.id,
      "reuse the same queue",
    );
    assert.equal(executions, 0, "reconfirmation must not bypass the journal");
    release();
    await acceptance;
    await waitFor(
      async () => (await snapshot()).manualQueue.phase === "accepted",
    );
    const admitted = await snapshot();
    assert.equal(admitted.manualQueue.id, queued.id);
    assert.equal(
      admitted.installed,
      installed,
      "acceptance is not installation",
    );
    assert.equal(executions, 1);
    finish();
    await waitFor(async () => {
      const state = await snapshot();
      return !state.applying && state.installed === target;
    });
    const outcome = await new UpdateJournal(dir).read();
    assert.equal(outcome?.sha, target);
    assert.equal(outcome?.state, "succeeded");
    assert.equal(outcome?.id, admitted.lastOperation.id);
    assert.equal(executions, 1, "status reads never replay apply");
  } finally {
    release();
    finish();
    await app.close();
    await waitFor(() => !updates.applying);
    await rm(dir, { recursive: true, force: true });
  }
});
test("authenticated updater requires explicit pinned confirmation; asynchronous apply fences all mutations", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-update-api-");
  const store = new Store(dir);
  await store.init();
  let finish!: () => void;
  const sha = "e".repeat(40);
  const updates = new Updates(
    null,
    async () =>
      new Promise<void>((r) => {
        finish = r;
      }),
    async () => new Response(JSON.stringify({ object: { sha } })),
  );
  const app = await admin(store, 0, undefined, () => {}, updates);
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  const post = (path: string, body: unknown = {}) =>
    fetch(app.origin + "/api/" + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await fetch(app.origin + "/api/update")).status, 401);
    assert.equal(
      (
        await fetch(app.origin + "/api/update/apply", {
          method: "POST",
          headers: { ...headers, Origin: "https://evil.example" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal((await post("update/check")).status, 200);
    assert.equal((await post("update/apply", { sha })).status, 400);
    assert.equal(
      (
        await post("update/apply", {
          sha,
          confirm: true,
          url: "https://evil.example",
        })
      ).status,
      400,
    );
    assert.equal(
      (await post("update/apply", { sha, confirm: true })).status,
      202,
    );
    for (const path of [
      "run",
      "config",
      "rollback",
      "persona-restore",
      "preview",
      "shutdown",
      "update/apply",
    ])
      assert.equal((await post(path)).status, 409, path);
    const s = await (
      await fetch(app.origin + "/api/update", { headers })
    ).json();
    assert.equal(s.applying, true);
    finish();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(
      (await (await fetch(app.origin + "/api/update", { headers })).json())
        .installed,
      sha,
    );
  } finally {
    finish?.();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("catalog-incompatible preparation returns typed preacceptance denial", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-catalog-admission-");
  const store = new Store(dir);
  await store.init();
  const sha = "c".repeat(40);
  let applied = false;
  const updates = new Updates(
    null,
    async () => {
      applied = true;
    },
    undefined,
    undefined,
    async () => {
      throw new Error("LAUNCHER_UPGRADE_REQUIRED");
    },
  );
  updates.latest = sha;
  updates.checkedAt = Date.now();
  const app = await admin(store, 0, undefined, undefined, updates);
  try {
    const response = await fetch(app.origin + "/api/update/apply", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + store.secrets.admin,
        Origin: app.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sha, confirm: true }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "LAUNCHER_UPGRADE_REQUIRED");
    assert.equal(applied, false);
    assert.equal(updates.snapshot().lastOperation, undefined);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("manual restart support is explicit, never inferred from generic update support", async () => {
  const updates = new Updates(null, async () => {});
  assert.equal(updates.snapshot().manualRestartSupported, false);
});
