import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

import { SkillStore, stockSkills } from "../src/config/skills.js";

const old = JSON.parse(
  await readFile(
    new URL("./fixtures/legacy-stock-skills.json", import.meta.url),
    "utf8",
  ),
);

test("one API skill archives exact legacy custom content and disabled state, survives reload and rollback", async () => {
  assert.deepEqual(
    stockSkills.map((s) => s.id),
    ["katafit-api"],
  );
  const dir = await mkdtemp(tmpdir() + "/skills-api-");
  try {
    await mkdir(dir + "/skills-history");
    old[0].customized = true;
    old[0].instructions = "My irreplaceable custom instructions";
    old[1].enabled = false;
    const bytes = Buffer.from(
      JSON.stringify({
        version: 1,
        revision: 7,
        previous: null,
        savedAt: null,
        skills: old,
      }),
    );
    const head =
      "skills-" + createHash("sha256").update(bytes).digest("hex") + ".json";
    await writeFile(dir + "/skills-history/" + head, bytes);
    const manifest = JSON.stringify({ version: 1, revision: 7, head });
    await writeFile(dir + "/skills.json", manifest);
    const store = new SkillStore(dir, () => []);
    await store.init();
    assert.deepEqual(store.runtime().skills, []); // Changed/disabled policies require explicit enable.
    assert.equal(store.view().skills[0].id, "katafit-api");
    assert.equal((store.view() as any).migration.archivedRevision, 7);
    assert.match((store.view() as any).migration.notice, /history/i);
    assert.equal(store.history(7).skills[0].instructions, old[0].instructions);
    assert.equal(store.history(7).skills[1].enabled, false);
    assert.deepEqual(await readFile(dir + "/skills-history/" + head), bytes);
    const reload = new SkillStore(dir, () => []);
    await reload.init();
    assert.equal(reload.view().revision, 8);
    await writeFile(dir + "/skills.json", manifest);
    const rollback = new SkillStore(dir, () => []);
    await rollback.init();
    assert.equal(rollback.view().revision, 8);
    assert.equal(
      rollback.history(7).skills[0].instructions,
      old[0].instructions,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
