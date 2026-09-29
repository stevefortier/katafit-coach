import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { SkillStore, stockSkills } from "../src/config/skills.js";

test("current API guidance requires explicit panel delivery, not image acquisition alone", () => {
  const skill = stockSkills[0];
  assert.equal(skill.defaultVersion, 2);
  assert.match(skill.instructions, /send_to_operator/);
  assert.match(skill.instructions, /image_receipt/);
  assert.match(skill.instructions, /not proof.*display/i);
  assert.doesNotMatch(skill.instructions, /katafit_rest_get/);
});

for (const customized of [false, true]) {
  test(`API v1 upgrade preserves archived content and custom state (${customized})`, async () => {
    const dir = await mkdtemp(tmpdir() + "/api-delivery-");
    try {
      await mkdir(dir + "/skills-history");
      const old = {
        ...stockSkills[0],
        defaultVersion: 1,
        basedOnDefaultVersion: 1,
        customized,
        enabled: !customized,
        instructions: "Saved API v1 instructions",
      };
      const bytes = Buffer.from(
        JSON.stringify({
          version: 1,
          revision: 1,
          previous: null,
          savedAt: null,
          skills: [old],
        }),
      );
      const head =
        "skills-" + createHash("sha256").update(bytes).digest("hex") + ".json";
      await writeFile(dir + "/skills-history/" + head, bytes);
      await writeFile(
        dir + "/skills.json",
        JSON.stringify({ version: 1, revision: 1, head }),
      );
      const store = new SkillStore(dir, () => []);
      await store.init();
      const current = store.view().skills[0];
      assert.equal(current.defaultVersion, 2);
      assert.equal(current.enabled, old.enabled);
      assert.equal(
        current.instructions,
        customized ? old.instructions : stockSkills[0].instructions,
      );
      assert.equal(store.history(1).skills[0].instructions, old.instructions);
      assert.deepEqual(await readFile(dir + "/skills-history/" + head), bytes);
      const reload = new SkillStore(dir, () => []);
      await reload.init();
      assert.equal(reload.view().revision, store.view().revision);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
