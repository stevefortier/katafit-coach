import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

test("Skills save travels through authenticated Studio, immutable disk history, and restart", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-skills-vertical-");
  const first = new Store(dir);
  const editedPurpose =
    "Give the operator a concise, evidence-bound activity review.";
  await first.init();
  const app = await admin(first, 0);
  const headers = {
    Authorization: "Bearer " + first.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  const call = (path: string, body?: unknown) =>
    fetch(app.origin + "/api/" + path, {
      headers,
      method: body === undefined ? "GET" : "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    assert.equal((await fetch(app.origin + "/api/skills")).status, 401);
    const initial = await (await call("skills")).json();
    assert.equal(initial.revision, 1);
    assert.deepEqual(
      initial.skills.map((skill: any) => [
        skill.id,
        skill.name,
        skill.enabled,
        skill.status,
      ]),
      [
        ["review-activity", "Review an activity", true, "default"],
        [
          "understand-progress",
          "Understand a member's progress",
          true,
          "default",
        ],
        ["change-plan", "Make and verify a plan change", true, "default"],
      ],
    );
    const edited = {
      ...initial.skills[0],
      purpose: editedPurpose,
    };
    const saved = await call("skills/review-activity", {
      expectedRevision: initial.revision,
      enabled: edited.enabled,
      purpose: edited.purpose,
      triggers: edited.triggers,
      instructions: edited.instructions,
    });
    assert.equal(saved.status, 200);
    const result = await saved.json();
    assert.equal(result.revision, 2);
    assert.equal(result.skill.status, "customized");
    const history = await (await call("skills/history/2")).json();
    assert.equal(history.revision, 2);
    assert.equal(history.skills[0].purpose, edited.purpose);
  } finally {
    await app.close();
  }

  const restarted = new Store(dir);
  try {
    await restarted.init();
    const second = await admin(restarted, 0);
    try {
      const response = await fetch(second.origin + "/api/skills", {
        headers: {
          Authorization: "Bearer " + restarted.secrets.admin,
          Origin: second.origin,
        },
      });
      assert.equal(response.status, 200);
      const disk = await response.json();
      assert.equal(disk.revision, 2);
      assert.equal(disk.skills[0].purpose, editedPurpose);
      assert.equal(disk.skills[0].status, "customized");
    } finally {
      await second.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
