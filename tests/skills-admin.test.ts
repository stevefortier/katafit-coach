import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { taskFixture } from "./task-fixtures.js";

const input = (skill: any) => ({
  enabled: skill.enabled,
  purpose: skill.purpose,
  triggers: skill.triggers,
  instructions: skill.instructions,
});

test("Skills API rejects stale, unauthenticated, busy, and update-locked mutation without changing disk", async () => {
  const dir = await mkdtemp(tmpdir() + "/skills-admin-");
  const store = new Store(dir);
  await store.init();
  const backend = createServer((_req, response) =>
    response.end("# Kata.fit external Coach agent v1\nSynthetic policy"),
  );
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(backend.address() as any).port}`,
  });
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (entered = resolve));
  const app = await admin(store, 0, async () => {
    entered();
    await gate;
    return "Synthetic preview";
  });
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  const post = (path: string, body: unknown) =>
    fetch(app.origin + "/api/" + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  try {
    const skill: any = (store.skills.view() as any).skills[0];
    assert.equal(
      (
        await fetch(app.origin + "/api/skills/" + skill.id, {
          method: "POST",
          headers: { Origin: app.origin, "Content-Type": "application/json" },
          body: JSON.stringify({ expectedRevision: 1, ...input(skill) }),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await post("skills/" + skill.id, {
          expectedRevision: 99,
          ...input(skill),
        })
      ).status,
      409,
    );
    assert.equal((store.skills.view() as any).revision, 1);

    const preview = post("preview", { text: "synthetic" });
    await started;
    assert.equal(
      (
        await post("skills/" + skill.id, {
          expectedRevision: 1,
          ...input(skill),
        })
      ).status,
      409,
    );
    assert.equal((store.skills.view() as any).revision, 1);
    release();
    await preview;
  } finally {
    release();
    await app.close();
  }

  const updateLocked = {
    applying: true,
    recovering: false,
    snapshot: () => ({ supported: false }),
  } as any;
  const lockedApp = await admin(store, 0, undefined, undefined, updateLocked);
  try {
    const skill: any = (store.skills.view() as any).skills[0];
    const response = await fetch(lockedApp.origin + "/api/skills/" + skill.id, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + store.secrets.admin,
        Origin: lockedApp.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expectedRevision: 1, ...input(skill) }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "UPDATE_IN_PROGRESS");
    assert.equal((store.skills.view() as any).revision, 1);
  } finally {
    await lockedApp.close();
    backend.closeAllConnections();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("confirmed Skills mutation restarts a running Coach with the new pinned revision", async () => {
  const dir = await mkdtemp(tmpdir() + "/skills-lifecycle-");
  const fixture = await taskFixture();
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: fixture.origin,
    token: "synthetic-worker-token",
    apiKey: "synthetic-provider-key",
  });
  const app = await admin(store, 0, async () => "Synthetic reply");
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
    assert.equal((await post("run")).status, 200);
    const skill: any = (store.skills.view() as any).skills[0];
    const changed = {
      ...input(skill),
      purpose: skill.purpose + " Synthetic lifecycle edit.",
      expectedRevision: 1,
    };
    const unconfirmed = await post("skills/" + skill.id, changed);
    assert.equal(unconfirmed.status, 409);
    assert.equal(
      (await unconfirmed.json()).error,
      "RESTART_CONFIRMATION_REQUIRED",
    );
    assert.equal(store.skills.runtime().revision, 1);
    const initialConnections = fixture.calls.filter(
      (call) => call.name === "initialize",
    ).length;

    const confirmed = await post("skills/" + skill.id, {
      ...changed,
      confirmRestart: true,
    });
    assert.equal(confirmed.status, 200, await confirmed.clone().text());
    const result = await confirmed.json();
    assert.equal(result.lifecycle.applied, true);
    assert.equal(result.lifecycle.resumed, true);
    assert.equal(store.skills.runtime().revision, 2);
    assert.ok(
      fixture.calls.filter((call) => call.name === "initialize").length >
        initialConnections,
    );
    const status = await fetch(app.origin + "/api/status", { headers });
    assert.equal((await status.json()).skillsRevision, 2);
  } finally {
    await app.close();
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});
