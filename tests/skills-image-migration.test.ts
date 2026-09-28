import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { SkillStore, stockSkills } from "../src/config/skills.js";

const legacyIds = ["review-activity", "understand-progress", "change-plan"];
async function seed(dir: string, sets: any[][]) {
  await mkdir(dir + "/skills-history");
  let previous: string | null = null;
  const files = new Map<string, string>();
  for (const [index, skills] of sets.entries()) {
    const record = JSON.stringify({
      version: 1,
      revision: index + 1,
      savedAt: null,
      previous,
      skills,
    });
    const name =
      "skills-" + createHash("sha256").update(record).digest("hex") + ".json";
    await writeFile(dir + "/skills-history/" + name, record);
    files.set(name, record);
    previous = name;
  }
  await writeFile(
    dir + "/skills.json",
    JSON.stringify({ version: 1, revision: sets.length, head: previous }),
  );
  return files;
}

test("default image fetching skill is enabled and teaches bounded authorized pixel reads", () => {
  const skill = stockSkills.find((s) => s.id === "fetch-checkin-images");
  assert.ok(skill);
  assert.equal(skill.enabled, true);
  assert.match(skill.instructions, /sequentially, one call at a time/);
  for (const pattern of [
    /katafit_rest_get/,
    /friends\/feed\/dojo/,
    /friends\/activity/,
    /api\/media/,
    /actual.*pixels/i,
    /Worker scope/,
  ])
    assert.match(skill.instructions, pattern);
});

test("known three-skill stores migrate append-only with customization and disabled state intact", async () => {
  const dir = await mkdtemp(tmpdir() + "/skills-image-upgrade-");
  try {
    const defaults = structuredClone(
      stockSkills.filter((s) => legacyIds.includes(s.id)),
    );
    const customized = structuredClone(defaults);
    customized[0].instructions = "Synthetic private customization.";
    customized[0].customized = true;
    customized[1].enabled = false;
    customized[1].customized = true;
    const files = await seed(dir, [defaults, customized]);
    const store = new SkillStore(dir, () => []);
    await store.init();
    const view: any = store.view();
    assert.equal(view.revision, 3);
    assert.deepEqual(
      view.skills.map((s: any) => s.id),
      [...legacyIds, "fetch-checkin-images"],
    );
    assert.equal(view.skills[0].instructions, customized[0].instructions);
    assert.equal(view.skills[0].status, "customized");
    assert.equal(view.skills[1].enabled, false);
    assert.equal(view.skills[3].enabled, true);
    for (const [name, original] of files)
      assert.equal(
        await readFile(dir + "/skills-history/" + name, "utf8"),
        original,
      );
    const manifest = await readFile(dir + "/skills.json", "utf8");
    const reloaded = new SkillStore(dir, () => []);
    await reloaded.init();
    assert.deepEqual(reloaded.view(), store.view());
    assert.equal(await readFile(dir + "/skills.json", "utf8"), manifest);
    assert.equal((await readdir(dir + "/skills-history")).length, 3);
    assert.deepEqual(reloaded.history(2), store.history(2));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saved v1 image guidance upgrades without enabling a disabled skill", async () => {
  const dir = await mkdtemp(tmpdir() + "/skills-image-v2-");
  try {
    const prior = structuredClone([...stockSkills]);
    const image = prior.find((s) => s.id === "fetch-checkin-images")!;
    image.defaultVersion = 1;
    image.basedOnDefaultVersion = 1;
    image.instructions = "Old saved image workflow.";
    image.enabled = false;
    await seed(dir, [prior]);
    const store = new SkillStore(dir, () => []);
    await store.init();
    const upgraded: any = store
      .view()
      .skills.find((s: any) => s.id === image.id);
    assert.equal(upgraded.defaultVersion, 3);
    assert.equal(upgraded.enabled, false);
    assert.ok(upgraded.instructions.includes("katafit_rest_get"));
    assert.equal(store.view().revision, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migration rejects a legacy catalog appearing after a modern catalog", async () => {
  const dir = await mkdtemp(tmpdir() + "/skills-history-downgrade-");
  try {
    const modern = structuredClone([...stockSkills]);
    const legacy = modern.filter((s) => legacyIds.includes(s.id));
    await seed(dir, [modern, legacy]);
    await assert.rejects(
      new SkillStore(dir, () => []).init(),
      /INVALID_SKILL_STORAGE/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restoring the pre-upgrade manifest leaves the legacy hash chain intact despite orphan modern snapshots", async () => {
  const dir = await mkdtemp(tmpdir() + "/skills-manifest-rollback-");
  try {
    const legacy = structuredClone(
      stockSkills.filter((s) => legacyIds.includes(s.id)),
    );
    const files = await seed(dir, [legacy]);
    const backup = await readFile(dir + "/skills.json");
    await new SkillStore(dir, () => []).init();
    assert.equal((await readdir(dir + "/skills-history")).length, 2);
    // Root-file rollback restores the old pointer, not the append-only directory.
    await writeFile(dir + "/skills.json", backup);
    let head = JSON.parse(backup.toString()).head;
    while (head) {
      const bytes = await readFile(dir + "/skills-history/" + head);
      assert.equal(
        "skills-" + createHash("sha256").update(bytes).digest("hex") + ".json",
        head,
      );
      const record = JSON.parse(bytes.toString());
      assert.deepEqual(
        record.skills.map((s: any) => s.id),
        legacyIds,
      );
      assert.equal(bytes.toString(), files.get(head));
      head = record.previous;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migration rejects arbitrary missing defaults, duplicates, and unknown skills", async () => {
  const legacy = structuredClone(
    stockSkills.filter((s) => legacyIds.includes(s.id)),
  );
  for (const set of [
    legacy.slice(0, 2),
    [legacy[0], legacy[0], legacy[2]],
    [legacy[0], legacy[1], { ...legacy[2], id: "unknown" }],
  ]) {
    const dir = await mkdtemp(tmpdir() + "/skills-invalid-upgrade-");
    try {
      await seed(dir, [set]);
      await assert.rejects(
        new SkillStore(dir, () => []).init(),
        /INVALID_SKILL_STORAGE/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
