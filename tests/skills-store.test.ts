import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { skillForTask, stockSkills } from "../src/config/skills.js";

const exec = promisify(execFile);
const content = (skill: any) => ({
  enabled: skill.enabled,
  purpose: skill.purpose,
  triggers: skill.triggers,
  instructions: skill.instructions,
});

test("day closure maps to the updated ordinary REST progress skill", () => {
  const progress = stockSkills.find((skill) => skill.id === "katafit-api")!;
  assert.equal(progress.defaultVersion, 6);
  assert.equal(progress.basedOnDefaultVersion, 6);
  assert.deepEqual(
    skillForTask(
      {
        revision: 1,
        skills: stockSkills.map((skill) => structuredClone(skill)),
      },
      "day_closure",
    ).map((skill) => skill.id),
    ["katafit-api"],
  );
});

test("default catalog upgrades preserve customization and expose the reviewable new default", async () => {
  const dir = await mkdtemp(tmpdir() + "/skills-upgrade-");
  const builtin = stockSkills[0] as any;
  const original = structuredClone(builtin);
  try {
    const store = new Store(dir);
    await store.init();
    await store.skills.save(
      builtin.id,
      { ...content(builtin), purpose: "Synthetic customized purpose" },
      1,
    );
    builtin.defaultVersion++;
    builtin.basedOnDefaultVersion = builtin.defaultVersion;
    builtin.purpose = "Synthetic upgraded stock purpose";

    const restarted = new Store(dir);
    await restarted.init();
    const view: any = restarted.skills.view(builtin.id);
    assert.equal(
      view.revision,
      3,
      "default upgrade appends an immutable revision",
    );
    assert.equal(view.skill.purpose, "Synthetic customized purpose");
    assert.equal(view.skill.status, "customized");
    assert.equal(view.skill.defaultUpdateAvailable, true);
    assert.equal(
      view.skill.default.purpose,
      "Synthetic upgraded stock purpose",
    );
    assert.equal(view.skill.basedOnDefaultVersion, original.defaultVersion);
    await restarted.skills.restoreDefault(builtin.id, view.revision);
    const restored: any = restarted.skills.view(builtin.id);
    assert.equal(restored.skill.status, "default");
    assert.equal(restored.skill.purpose, "Synthetic upgraded stock purpose");
  } finally {
    Object.assign(builtin, original);
    await rm(dir, { recursive: true, force: true });
  }
});

test("skill inputs are strict, secret-screened now and against future credential changes", async () => {
  const dir = await mkdtemp(tmpdir() + "/skills-secret-");
  try {
    const store = new Store(dir);
    await store.init();
    const skill: any = (store.skills.view() as any).skills[0];
    await assert.rejects(
      store.skills.save(
        skill.id,
        { ...content(skill), extra: "not accepted" },
        1,
      ),
      /INVALID_SKILL/,
    );
    await assert.rejects(
      store.skills.save(skill.id, { ...content(skill), purpose: "" }, 1),
      /INVALID_SKILL/,
    );
    store.secrets.token = "synthetic-current-credential";
    await assert.rejects(
      store.skills.save(
        skill.id,
        {
          ...content(skill),
          purpose: "contains synthetic-current-credential",
        },
        1,
      ),
      /SECRET_IN_CONFIG/,
    );
    await assert.rejects(
      store.skills.save(
        skill.id,
        { ...content(skill), purpose: "Bearer fabricated-credential" },
        1,
      ),
      /SECRET_IN_CONFIG/,
    );
    store.secrets.token = "";
    await store.skills.save(
      skill.id,
      { ...content(skill), purpose: "synthetic-future-credential" },
      1,
    );
    await assert.rejects(
      store.save({
        ...store.publicConfig(),
        apiKey: "synthetic-future-credential",
      }),
      /SECRET_IN_CONFIG/,
    );
    assert.equal(store.publicConfig().revision, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("future credentials present only in historical Skills snapshots are rejected", async () => {
  const dir = await mkdtemp(tmpdir() + "/skills-historical-secret-");
  try {
    const store = new Store(dir);
    await store.init();
    const skill: any = (store.skills.view() as any).skills[0];
    const future = "synthetic-history-only-credential";
    await store.skills.save(
      skill.id,
      { ...content(skill), purpose: future },
      1,
    );
    await store.skills.restoreDefault(skill.id, 2);
    const restarted = new Store(dir);
    await restarted.init();
    assert.ok(!JSON.stringify(restarted.skills.view()).includes(future));
    assert.ok(JSON.stringify(restarted.skills.history(2)).includes(future));
    const beforeConfig = await readFile(dir + "/config.json");
    const beforeSecrets = await readFile(dir + "/secrets.json");
    await assert.rejects(
      restarted.save({ ...restarted.publicConfig(), apiKey: future }),
      /SECRET_IN_CONFIG/,
    );
    assert.deepEqual(await readFile(dir + "/config.json"), beforeConfig);
    assert.deepEqual(await readFile(dir + "/secrets.json"), beforeSecrets);
    assert.equal(restarted.publicConfig().revision, 1);
    assert.equal((restarted.skills.view() as any).revision, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Skills history is append-only and rejects symlink, FIFO, and oversize manifests", async (t) => {
  const dir = await mkdtemp(tmpdir() + "/skills-storage-");
  try {
    const store = new Store(dir);
    await store.init();
    const originalFiles = await readdir(dir + "/skills-history");
    assert.equal(originalFiles.length, 1);
    const original = await readFile(
      dir + "/skills-history/" + originalFiles[0],
    );
    const skill: any = (store.skills.view() as any).skills[0];
    await store.skills.save(skill.id, { ...content(skill), enabled: false }, 1);
    assert.deepEqual(
      await readFile(dir + "/skills-history/" + originalFiles[0]),
      original,
      "committed snapshot was never rewritten",
    );

    for (const kind of ["symlink", "fifo", "oversize"] as const) {
      await t.test(kind, async () => {
        const unsafe = await mkdtemp(tmpdir() + "/skills-unsafe-");
        try {
          const seed = new Store(unsafe);
          await seed.init();
          await unlink(unsafe + "/skills.json");
          if (kind === "symlink")
            await symlink(unsafe + "/secrets.json", unsafe + "/skills.json");
          else if (kind === "fifo")
            await exec("mkfifo", [unsafe + "/skills.json"]);
          else
            await writeFile(
              unsafe + "/skills.json",
              Buffer.alloc(16 * 1024, 65),
            );
          await assert.rejects(new Store(unsafe).init(), /UNSAFE_STORAGE/);
        } finally {
          await rm(unsafe, { recursive: true, force: true });
        }
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("starter skill bodies branch by scope and preserve authorization and member isolation", () => {
  for (const skill of stockSkills) {
    assert.match(skill.instructions, /Operator scope:/);
    assert.match(skill.instructions, /Worker scope:/);
    assert.match(skill.instructions, /Guidance is not permission/);
    assert.match(skill.instructions, /Never open an Operator session/i);
    assert.match(skill.instructions, /members isolated/i);
    assert.doesNotMatch(
      skill.instructions,
      /synthetic|customer evidence|secret/i,
    );
  }
  assert.match(
    stockSkills.find((skill) => skill.id === "katafit-api")!.instructions,
    /Never retry automatically/i,
  );
});
