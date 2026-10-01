import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { SkillStore, stockSkills } from "../src/config/skills.js";

test("member messages are occurrences: exact words may repeat, delivered is not viewed, no replay", () => {
  const skill = stockSkills[0];
  assert.equal(skill.defaultVersion, 4);
  const text = skill.instructions;
  assert.doesNotMatch(
    text,
    /paraphrase their words|deduplication|trimmed text/i,
  );
  assert.match(text, /separately requested message is its own delivery/i);
  assert.match(text, /even when the words repeat/i);
  assert.match(text, /never supply idempotency_key/i);
  assert.match(
    text,
    /appended to the member's canonical Coach chat, not that they saw it/i,
  );
  assert.match(text, /NATIVE_DELIVERY_UNVERIFIED/);
  assert.match(text, /do not repeat the send or reword it/i);
  // Worker scope gains nothing: no generic REST for member jobs.
  assert.match(
    text,
    /background jobs do NOT gain this generic account transport/,
  );
});

test("current API guidance requires explicit panel delivery, not image acquisition alone", () => {
  const skill = stockSkills[0];
  assert.equal(skill.defaultVersion, 4);
  assert.match(skill.instructions, /send_to_operator/);
  assert.match(skill.instructions, /image_receipt/);
  assert.match(skill.instructions, /not proof.*display/i);
  assert.doesNotMatch(skill.instructions, /katafit_rest_get/);
});

for (const [from, customized] of [
  [1, false],
  [1, true],
  [3, false],
  [3, true],
] as const) {
  test(`API v${from} upgrade preserves archived content and custom state (${customized})`, async () => {
    const dir = await mkdtemp(tmpdir() + "/api-delivery-");
    try {
      await mkdir(dir + "/skills-history");
      const old = {
        ...stockSkills[0],
        defaultVersion: from,
        basedOnDefaultVersion: from,
        customized,
        enabled: !customized,
        instructions: `Saved API v${from} instructions`,
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
      assert.equal(current.defaultVersion, 4);
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
