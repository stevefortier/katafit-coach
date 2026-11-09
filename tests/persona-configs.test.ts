import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import * as storeModule from "../src/config/store.js";
import {
  Store,
  compile,
  compileOperator,
  compileComposer,
  compileAutonomy,
} from "../src/config/store.js";
import * as personas from "../src/config/personas.js";
import canonical from "./fixtures/kata-persona-presets.json" with { type: "json" };

const legacyStock = {
  name: "Coach",
  voice: "Warm, direct and practical",
  principles: "Sustainable progress. Ask when context is missing.",
  examples: "Offer one achievable next step.",
  boundaries: "Do not diagnose or prescribe medical treatment.",
  initiative: "Respond to the current request only.",
  verbosity: "Concise",
  markdown: "",
};
const custom = {
  name: "Iron Warden",
  voice: "Stern and clipped",
  principles: "Discipline before comfort.",
  examples: "Finish your sets.",
  boundaries: "No medical advice.",
  initiative: "Demand accountability.",
  verbosity: "Concise",
  markdown: "Synthetic custom markdown",
};
const mandate = {
  mode: "observe",
  instructions: "",
  timezone: null,
  delegated_actions: [],
};

async function home(prefix: string) {
  return mkdtemp(tmpdir() + "/" + prefix);
}
async function legacyHome(
  persona: Record<string, string>,
  extra: Record<string, unknown> = {},
) {
  const dir = await home("persona-legacy-");
  await writeFile(
    dir + "/config.json",
    JSON.stringify({
      current: {
        revision: 3,
        origin: "https://kata.fit",
        provider: {
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4.1-mini",
          vision: false,
        },
        persona,
      },
      ...extra,
    }),
    { mode: 0o600 },
  );
  return dir;
}

test("builtin personas are exactly the canonical Kata.fit presets and immutable", () => {
  assert.deepEqual(
    personas.builtinPersonas.map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description,
      instructions: p.instructions,
    })),
    canonical.presets,
  );
  assert.deepEqual(personas.personaSource, canonical.source);
  // Frontend labels for the same IDs match the hosted backend labels.
  assert.deepEqual(
    canonical.frontendLabels,
    canonical.presets.map(({ id, label }) => ({ id, label })),
  );
  assert.equal(personas.defaultPersonaId, "kata_default");
  // No invented personas: no Kata.fit "custom" mode or local stock entry.
  assert.ok(personas.builtinPersonas.every((p) => p.id !== "custom"));
  assert.ok(Object.isFrozen(personas.builtinPersonas));
  for (const builtin of personas.builtinPersonas) {
    assert.ok(Object.isFrozen(builtin));
    assert.throws(() => {
      (builtin as any).instructions = "mutated";
    });
  }
});

test("canonical parity against immutable base and six-preset source commits", (t) => {
  // Any regimen checkout containing the pinned commits works; HEAD and dirty
  // worktree contents deliberately do not participate in provenance.
  const checkout = process.env.KATAFIT_REGIMEN_CHECKOUT;
  if (!checkout || !existsSync(checkout + "/.git")) {
    t.skip("KATAFIT_REGIMEN_CHECKOUT not set; fixture parity still enforced");
    return;
  }
  const { source } = canonical;
  const ext = source.committedExtension;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: checkout, encoding: "utf8" });
  const presetsIn = (code: string) => {
    const module = { exports: {} as any };
    new Function("module", "exports", code)(module, module.exports);
    return Object.entries(
      module.exports.COACH_PERSONALITY_PRESETS as Record<string, any>,
    )
      .filter(([id]) => id !== "custom")
      .map(([id, p]) => ({
        id,
        label: p.label,
        description: p.description,
        instructions: p.instructions,
      }));
  };
  const frontendLabels = (code: string) => {
    const list = code.split("AI_COACH_PERSONALITY_PRESETS = [")[1];
    assert.ok(list, "frontend preset list not found");
    return [
      ...list
        .slice(0, list.indexOf("];"))
        .matchAll(/\{ id: '([a-z_]+)', label: '([^']+)'/g),
    ]
      .map(([, id, label]) => ({ id, label }))
      .filter(({ id }) => id !== "custom");
  };

  // The five upstream presets come verbatim from the committed base blobs.
  const at = (path: string) => `${source.revision}:${path}`;
  assert.equal(git("rev-parse", at(source.path)).trim(), source.blob);
  assert.equal(
    git("rev-parse", at(source.frontendPath)).trim(),
    source.frontendBlob,
  );
  const base = canonical.presets.filter((p) => source.baseIds.includes(p.id));
  assert.deepEqual(presetsIn(git("show", at(source.path))), base);
  assert.deepEqual(
    frontendLabels(git("show", at(source.frontendPath))),
    canonical.frontendLabels.filter((p) => source.baseIds.includes(p.id)),
  );

  // Verify every preset and frontend label from committed blobs, never a branch.
  assert.match(ext.revision, /^[0-9a-f]{40}$/);
  const committed = (path: string) => `${ext.revision}:${path}`;
  assert.equal(git("rev-parse", committed(source.path)).trim(), ext.blob);
  assert.equal(
    git("rev-parse", committed(source.frontendPath)).trim(),
    ext.frontendBlob,
  );
  assert.notEqual(ext.blob, source.blob);
  assert.deepEqual(
    presetsIn(git("show", committed(source.path))),
    canonical.presets,
  );
  assert.deepEqual(
    frontendLabels(git("show", committed(source.frontendPath))),
    canonical.frontendLabels,
  );
  // Recovered wording really is historical; the added safeguards are not.
  const recovered = git(
    "show",
    `${ext.recovered.revision}:${ext.recovered.path}`,
  );
  assert.ok(recovered.includes(`instructions: '${ext.recovered.text}'`));
  assert.ok(
    git(
      "show",
      `${ext.recovered.revision}:${ext.recovered.frontendPath}`,
    ).includes(
      `{ id: 'drill_sergeant', label: 'Drill Sergeant', description: '${ext.recovered.frontendDescription}' }`,
    ),
  );
  assert.ok(!recovered.includes("minimal pep talk"));
});

test("adding the Drill Sergeant leaves the five existing builtins byte-identical", () => {
  const { baseIds } = canonical.source;
  const pinned = (list: readonly { id: string }[]) =>
    createHash("sha256")
      .update(JSON.stringify(list.filter((p) => baseIds.includes(p.id))))
      .digest("hex");
  // Digest of the five presets as qualified before the addition.
  const before =
    "c9744b79f8ee74db07b80664ce796a27a5a121b0728cfa88699a2356d72c3239";
  assert.equal(pinned(canonical.presets), before);
  assert.equal(
    pinned(
      personas.builtinPersonas.map(
        ({ id, label, description, instructions }) => ({
          id,
          label,
          description,
          instructions,
        }),
      ),
    ),
    before,
  );
});

test("the Drill Sergeant is a distinct, maximum-intensity builtin with safeguards", () => {
  const ids = personas.builtinPersonas.map((p) => p.id);
  assert.equal(
    ids.indexOf("drill_sergeant"),
    ids.indexOf("demanding_coach") + 1,
  );
  const drill = personas.builtinPersona("drill_sergeant")!;
  const demanding = personas.builtinPersona("demanding_coach")!;
  assert.equal(drill.label, "Drill Sergeant");
  assert.equal(drill.description, "Tough love, no excuses, military style.");
  assert.notEqual(drill.instructions, demanding.instructions);
  assert.ok(Object.isFrozen(drill));
  assert.ok(
    drill.instructions.includes(
      canonical.source.committedExtension.recovered.text,
    ),
  );
  for (const required of [
    /most intense/,
    /short, forceful commands/,
    /minimal pep talk/,
    /pain, injury, illness, and recovery/,
    /never push through medical warning signs/,
    /do not diagnose/,
    /Never humiliate, insult, or threaten/,
    /respectful toward anyone who manages or operates the coach/,
  ])
    assert.match(drill.instructions, required);
  assert.equal(
    personas.renderPersona({
      version: 1,
      active: "drill_sergeant",
      custom: [],
    }),
    `persona: Drill Sergeant (built-in drill_sergeant)\nCOACH PERSONALITY, ROLE, AND COMMUNICATION STYLE:\n${drill.instructions}`,
  );
});

test("the Drill Sergeant is selectable, read-only, persisted and migrated back from its projection", async () => {
  const drill = canonical.presets.find((p) => p.id === "drill_sergeant")!;
  const dir = await home("persona-drill-");
  try {
    const s = new Store(dir);
    await s.init();
    const listed = s
      .personaView()
      .builtins.find((b: any) => b.id === "drill_sergeant");
    assert.equal(listed.label, "Drill Sergeant");
    assert.equal(listed.readOnly, true);
    await s.selectPersona("drill_sergeant");
    await assert.rejects(
      s.updatePersona("drill_sergeant", { label: "Softer", persona: custom }),
      /PERSONA_IMMUTABLE/,
    );
    await assert.rejects(
      s.deletePersona("drill_sergeant"),
      /PERSONA_IMMUTABLE/,
    );
    await assert.rejects(
      s.createPersona({ label: "drill sergeant", persona: custom }),
      /PERSONA_NAME_TAKEN/,
    );
    const restarted = new Store(dir);
    await restarted.init();
    assert.equal(restarted.personaView().active.id, "drill_sergeant");
    assert.ok(compile(restarted.publicConfig()).includes(drill.instructions));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  // An older owner's rewrite of the Drill Sergeant projection maps back to it.
  const legacy = await legacyHome({
    ...legacyStock,
    voice: "",
    principles: "",
    examples: "",
    boundaries: "",
    initiative: "",
    verbosity: "",
    markdown: drill.instructions,
  });
  try {
    const s = new Store(legacy);
    await s.init();
    assert.equal(s.personaView().active.id, "drill_sergeant");
    assert.deepEqual(s.personaView().custom, []);
  } finally {
    await rm(legacy, { recursive: true, force: true });
  }
});

test("fresh install references the Kata.fit default builtin and creates no history", async () => {
  const dir = await home("persona-fresh-");
  try {
    const s = new Store(dir);
    await s.init();
    const view = s.personaView();
    assert.equal(view.active.id, "kata_default");
    assert.equal(view.active.kind, "builtin");
    assert.equal(view.active.label, "Kata.fit default");
    assert.deepEqual(
      view.builtins.map((b: any) => b.id),
      canonical.presets.map((p) => p.id),
    );
    assert.ok(view.builtins.every((b: any) => b.readOnly === true));
    for (const preset of canonical.presets) {
      const entry = view.builtins.find((b) => b.id === preset.id)!;
      assert.deepEqual(entry.persona, {
        name: "Coach",
        voice: "",
        verbosity: "",
        initiative: "",
        principles: "",
        examples: "",
        boundaries: "",
        markdown: preset.instructions,
      });
      entry.persona.name = "Changed returned DTO only";
      assert.equal(
        s.personaView().builtins.find((b) => b.id === preset.id)!.persona.name,
        "Coach",
      );
    }
    assert.deepEqual(view.custom, []);
    const disk = JSON.parse(await readFile(dir + "/config.json", "utf8"));
    assert.deepEqual(disk.current.personas, {
      version: 1,
      active: "kata_default",
      custom: [],
    });
    assert.equal(disk.history, undefined);
    assert.equal(existsSync(dir + "/persona-history"), false);
    // The active reference drives every runtime prompt.
    const c = s.publicConfig();
    for (const prompt of [
      compile(c),
      compileOperator(c),
      compileComposer(c, "member"),
      compileAutonomy(c, mandate),
    ]) {
      assert.ok(prompt.includes(canonical.presets[0].instructions));
      assert.ok(prompt.includes("Kata.fit default"));
      assert.ok(!prompt.includes("Warm, direct and practical"));
    }
    // Retired stock persona API is gone.
    assert.equal((storeModule as any).stockPersona, undefined);
    assert.equal((s as any).personaHistory, undefined);
    assert.equal((s as any).restorePersona, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("custom configs persist, duplicate, edit, select and delete without dangling", async () => {
  const dir = await home("persona-custom-");
  try {
    const s = new Store(dir);
    await s.init();
    await s.save({ ...s.publicConfig(), token: "synthetic-kept-token" });
    const before = s.publicConfig();
    const id = await s.createPersona({
      label: "Evening coach",
      persona: custom,
    });
    assert.match(id, /^custom-[a-f0-9]{16}$/);
    assert.equal(s.publicConfig().revision, before.revision + 1);
    // Creating does not change the active reference or shared settings.
    assert.equal(s.personaView().active.id, "kata_default");
    assert.equal(s.publicConfig().origin, before.origin);
    assert.equal(s.secrets.token, "synthetic-kept-token");
    const copy = await s.duplicatePersona("supportive_mentor");
    const copied = s.personaView().custom.find((p: any) => p.id === copy);
    assert.equal(copied.label, "Supportive mentor copy");
    assert.equal(
      copied.persona.markdown,
      canonical.presets.find((p) => p.id === "supportive_mentor")!.instructions,
    );
    const second = await s.duplicatePersona(id);
    assert.equal(
      s.personaView().custom.find((p: any) => p.id === second).label,
      "Evening coach copy",
    );
    await assert.rejects(
      s.createPersona({ label: "evening COACH", persona: custom }),
      /PERSONA_NAME_TAKEN/,
    );
    await assert.rejects(
      s.createPersona({ label: "Kata.fit default", persona: custom }),
      /PERSONA_NAME_TAKEN/,
    );
    await s.updatePersona(id, {
      label: "Evening coach",
      persona: { ...custom, voice: "Calm" },
    });
    await s.selectPersona(id);
    assert.equal(s.personaView().active.id, id);
    assert.equal(s.publicConfig().persona.voice, "Calm");
    assert.ok(compile(s.publicConfig()).includes("voice: Calm"));
    // The active configuration cannot be deleted out from under the reference.
    await assert.rejects(s.deletePersona(id), /PERSONA_ACTIVE/);
    await s.deletePersona(second);
    const restarted = new Store(dir);
    await restarted.init();
    assert.equal(restarted.personaView().active.id, id);
    assert.deepEqual(
      restarted.personaView().custom.map((p: any) => p.label),
      ["Evening coach", "Supportive mentor copy"],
    );
    assert.equal(restarted.publicConfig().persona.voice, "Calm");
    assert.equal(restarted.secrets.token, "synthetic-kept-token");
    await restarted.selectPersona("demanding_coach");
    await restarted.deletePersona(id);
    assert.equal(restarted.personaView().active.id, "demanding_coach");
    assert.equal(existsSync(dir + "/persona-history"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("builtins are immutable and unknown or malformed IDs fail without mutation", async () => {
  const dir = await home("persona-ids-");
  try {
    const s = new Store(dir);
    await s.init();
    const before = await readFile(dir + "/config.json", "utf8");
    await assert.rejects(
      s.updatePersona("kata_default", { label: "Mine", persona: custom }),
      /PERSONA_IMMUTABLE/,
    );
    await assert.rejects(s.deletePersona("kata_default"), /PERSONA_IMMUTABLE/);
    for (const id of ["custom-0123456789abcdef", "custom", "nope"]) {
      await assert.rejects(s.selectPersona(id), /PERSONA_NOT_FOUND/);
      await assert.rejects(s.duplicatePersona(id), /PERSONA_NOT_FOUND/);
      await assert.rejects(s.deletePersona(id), /PERSONA_NOT_FOUND/);
    }
    for (const id of ["", "../x", "A", "x".repeat(80), 7 as any])
      await assert.rejects(s.selectPersona(id), /INVALID_PERSONA_ID/);
    for (const bad of [
      {},
      { label: "", persona: custom },
      { label: "x".repeat(101), persona: custom },
      { label: "Ok", persona: { ...custom, name: " " } },
      { label: "Ok", persona: { ...custom, voice: "x".repeat(8001) } },
      { label: "Ok", persona: { ...custom, extra: "" } },
      { label: "Ok", persona: custom, active: true },
      { label: "Bad\u0007", persona: custom },
    ])
      await assert.rejects(s.createPersona(bad as any), /INVALID_PERSONA/);
    assert.equal(await readFile(dir + "/config.json", "utf8"), before);
    // A stored reference to a missing config fails closed at startup.
    const disk = JSON.parse(before);
    disk.current.personas.active = "custom-0123456789abcdef";
    await writeFile(dir + "/config.json", JSON.stringify(disk));
    await assert.rejects(new Store(dir).init(), /INVALID_PERSONA_CONFIG/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the shared settings save treats persona state as a read-only echo", async () => {
  const dir = await home("persona-shared-");
  try {
    const s = new Store(dir);
    await s.init();
    const id = await s.createPersona({ label: "Echo", persona: custom });
    await s.selectPersona(id);
    const c = s.publicConfig();
    // Echoing the derived projection and canonical state is accepted.
    await s.save({ ...c, origin: "http://localhost:9" });
    assert.equal(s.personaView().active.id, id);
    await assert.rejects(
      s.save({ ...s.publicConfig(), persona: { ...c.persona, name: "Other" } }),
      /PERSONA_READ_ONLY/,
    );
    await assert.rejects(
      s.save({
        ...s.publicConfig(),
        personas: { ...c.personas, active: "kata_default" },
      }),
      /PERSONA_READ_ONLY/,
    );
    // Omitting persona entirely is the normal shared Save shape.
    const { persona: _p, personas: _ps, ...rest } = s.publicConfig() as any;
    await s.save(rest);
    assert.equal(s.personaView().active.id, id);
    // A tampered derived projection on disk never overrides the reference.
    const disk = JSON.parse(await readFile(dir + "/config.json", "utf8"));
    disk.current.persona.name = "Tampered";
    await writeFile(dir + "/config.json", JSON.stringify(disk));
    const reloaded = new Store(dir);
    await reloaded.init();
    assert.equal(reloaded.publicConfig().persona.name, "Iron Warden");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("customized legacy persona migrates to an active custom config across restart", async () => {
  const dir = await legacyHome(custom);
  try {
    const original = await readFile(dir + "/config.json", "utf8");
    const s = new Store(dir);
    await s.init();
    const view = s.personaView();
    assert.equal(view.active.kind, "custom");
    assert.equal(view.active.label, "Iron Warden");
    assert.deepEqual(view.custom[0].persona, custom);
    // Prompt persona lines are byte-identical to the legacy rendering.
    assert.ok(
      compile(s.publicConfig()).includes(
        Object.entries(custom)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n"),
      ),
    );
    // Migration is synthesized in memory: loading never rewrites legacy files.
    assert.equal(await readFile(dir + "/config.json", "utf8"), original);
    const again = new Store(dir);
    await again.init();
    assert.equal(again.personaView().active.id, view.active.id);
    await again.save({ ...again.publicConfig(), origin: "http://localhost:7" });
    const disk = JSON.parse(await readFile(dir + "/config.json", "utf8"));
    assert.equal(disk.current.personas.active, view.active.id);
    assert.deepEqual(disk.current.personas.custom[0].persona, custom);
    const restarted = new Store(dir);
    await restarted.init();
    assert.equal(restarted.personaView().active.id, view.active.id);
    assert.equal(restarted.publicConfig().persona.name, "Iron Warden");
    // Rollback to the legacy previous revision keeps a valid reference.
    await restarted.rollback();
    assert.equal(restarted.personaView().active.label, "Iron Warden");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default legacy persona maps to the stock Kata.fit builtin", async () => {
  const dir = await legacyHome(legacyStock);
  try {
    const s = new Store(dir);
    await s.init();
    assert.equal(s.personaView().active.id, "kata_default");
    assert.deepEqual(s.personaView().custom, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an older owner's rewrite of a builtin projection maps back to that builtin", async () => {
  // Older owners drop `personas` and save only the derived eight fields.
  const mentor = canonical.presets.find((p) => p.id === "supportive_mentor")!;
  const dir = await legacyHome({
    ...legacyStock,
    voice: "",
    principles: "",
    examples: "",
    boundaries: "",
    initiative: "",
    verbosity: "",
    markdown: mentor.instructions,
  });
  try {
    const s = new Store(dir);
    await s.init();
    assert.equal(s.personaView().active.id, "supportive_mentor");
    assert.deepEqual(s.personaView().custom, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy history is retired but preserved and still screened for credentials", async () => {
  const dir = await home("persona-retired-");
  try {
    // Produce a legacy history chain with the previous on-disk format.
    const record = (revision: number, persona: object, previous: any) =>
      Buffer.from(
        JSON.stringify(
          {
            version: 1,
            revision,
            savedAt: "2026-01-01T00:00:00.000Z",
            persona,
            previous,
          },
          null,
          2,
        ),
      );
    const name = (bytes: Buffer) =>
      "persona-" + createHash("sha256").update(bytes).digest("hex") + ".json";
    await mkdir(dir + "/persona-history", { mode: 0o700 });
    const first = record(
      1,
      { ...legacyStock, markdown: "old synthetic-retired-secret" },
      null,
    );
    await writeFile(dir + "/persona-history/" + name(first), first);
    const second = record(2, custom, name(first));
    await writeFile(dir + "/persona-history/" + name(second), second);
    await writeFile(
      dir + "/config.json",
      JSON.stringify({
        current: {
          revision: 2,
          origin: "https://kata.fit",
          provider: {
            baseUrl: "https://api.openai.com/v1",
            model: "gpt-4.1-mini",
            vision: false,
          },
          persona: custom,
        },
        history: { version: 1, head: name(second) },
      }),
    );
    const files = async () =>
      Object.fromEntries(
        await Promise.all(
          (await readdir(dir + "/persona-history")).map(async (f) => [
            f,
            await readFile(dir + "/persona-history/" + f, "utf8"),
          ]),
        ),
      );
    const kept = await files();
    const s = new Store(dir);
    await s.init();
    await s.save({ ...s.publicConfig(), origin: "http://localhost:8" });
    await s.selectPersona("science_educator");
    // A future credential found in retired history is still refused.
    await assert.rejects(
      s.save({ ...s.publicConfig(), apiKey: "synthetic-retired-secret" }),
      /SECRET_IN_CONFIG/,
    );
    const restarted = new Store(dir);
    await restarted.init();
    await assert.rejects(
      restarted.save({
        ...restarted.publicConfig(),
        token: "synthetic-retired-secret",
      }),
      /SECRET_IN_CONFIG/,
    );
    // No snapshot written, none removed; config no longer carries a head.
    assert.deepEqual(await files(), kept);
    const disk = JSON.parse(await readFile(dir + "/config.json", "utf8"));
    assert.equal(disk.history, undefined);
    assert.deepEqual(disk.retiredPersonaHistory, {
      version: 1,
      head: name(second),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persona content and future credentials are screened across inactive configs", async () => {
  const dir = await home("persona-secrets-");
  try {
    const s = new Store(dir);
    await s.init();
    await s.save({ ...s.publicConfig(), apiKey: "synthetic-current-key" });
    await assert.rejects(
      s.createPersona({
        label: "Leaky",
        persona: { ...custom, markdown: "use synthetic-current-key" },
      }),
      /SECRET_IN_CONFIG/,
    );
    await assert.rejects(
      s.createPersona({ label: "synthetic-current-key", persona: custom }),
      /SECRET_IN_CONFIG/,
    );
    const inactive = await s.createPersona({
      label: "Inactive",
      persona: { ...custom, examples: "synthetic-rotated-key later" },
    });
    assert.equal(s.personaView().active.id, "kata_default");
    const before = s.publicConfig();
    for (const change of [
      { apiKey: "synthetic-rotated-key" },
      { token: "synthetic-rotated-key" },
    ])
      await assert.rejects(
        s.save({ ...s.publicConfig(), ...change }),
        /SECRET_IN_CONFIG/,
      );
    const registry = s.modelRegistry();
    await assert.rejects(
      s.save({
        origin: before.origin,
        models: {
          active: registry.active,
          providers: [
            ...registry.providers.map(({ hasCredential, ...p }: any) => p),
            {
              id: "spare",
              name: "Spare",
              baseUrl: "https://spare.synthetic.invalid/v1",
              apiKey: "synthetic-rotated-key",
              models: [{ id: "s1", name: "Spare", model: "spare-1" }],
            },
          ],
        },
      }),
      /SECRET_IN_CONFIG/,
    );
    assert.deepEqual(s.publicConfig(), before);
    await s.updatePersona(inactive, {
      label: "Inactive",
      persona: { ...custom, examples: "clean" },
    });
    // Previous revision still retains the text until it ages out.
    await s.save({ ...s.publicConfig() });
    await s.save({ ...s.publicConfig(), apiKey: "synthetic-rotated-key" });
    assert.equal(s.secrets.apiKey, "synthetic-rotated-key");
    // A loaded unsafe inactive config fails closed.
    const disk = JSON.parse(await readFile(dir + "/config.json", "utf8"));
    disk.current.personas.custom[0].persona.boundaries =
      "synthetic-rotated-key";
    await writeFile(dir + "/config.json", JSON.stringify(disk));
    await assert.rejects(new Store(dir).init(), /SECRET_IN_CONFIG/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persona actions are serialized and fenced by the revision they started from", async () => {
  const dir = await home("persona-serial-");
  try {
    const s = new Store(dir);
    await s.init();
    const results = await Promise.allSettled([
      s.createPersona({ label: "One", persona: custom }),
      s.createPersona({ label: "Two", persona: custom }),
      s.createPersona({ label: "One", persona: custom }),
      s.selectPersona("casual_buddy"),
    ]);
    assert.deepEqual(
      results.map((r) => r.status),
      ["fulfilled", "fulfilled", "rejected", "fulfilled"],
    );
    assert.equal(s.publicConfig().revision, 4);
    assert.equal(s.personaView().custom.length, 2);
    assert.equal(s.personaView().active.id, "casual_buddy");
    // Bounded custom count.
    for (let i = s.personaView().custom.length; i < 16; i++)
      await s.createPersona({ label: "Extra " + i, persona: custom });
    await assert.rejects(
      s.createPersona({ label: "Overflow", persona: custom }),
      /PERSONA_LIMIT/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
