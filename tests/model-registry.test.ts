import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { Store } from "../src/config/store.js";

const A = "https://a.synthetic.invalid/v1";
const B = "http://127.0.0.1:9/v1";
const keyA = "synthetic-registry-key-alpha";
const keyB = "synthetic-registry-key-bravo";

async function withStore(fn: (s: Store, dir: string) => Promise<void>) {
  const dir = await mkdtemp(tmpdir() + "/coach-registry-");
  try {
    const s = new Store(dir);
    await s.init();
    await fn(s, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function reopen(dir: string) {
  const s = new Store(dir);
  await s.init();
  return s;
}
// Editable registry input from the public view, as the Studio sends it.
function draft(s: Store) {
  const r = s.modelRegistry();
  return {
    active: { ...r.active },
    providers: r.providers.map(({ hasCredential, ...p }) => ({
      ...p,
      models: p.models.map((m) => ({ ...m })),
    })) as any[],
  };
}
function body(s: Store, models: unknown, extra: Record<string, unknown> = {}) {
  const { origin, persona } = s.publicConfig();
  return { origin, persona, models, ...extra };
}
function twoProviders() {
  return {
    active: { provider: "alpha", model: "a1" },
    providers: [
      {
        id: "alpha",
        name: "Alpha",
        baseUrl: A,
        apiKey: keyA,
        models: [
          { id: "a1", name: "Alpha one", model: "alpha-1", vision: false },
          { id: "a2", name: "Alpha two", model: "alpha-2", vision: true },
        ],
      },
      {
        id: "bravo",
        name: "Bravo local",
        baseUrl: B,
        apiKey: keyB,
        models: [{ id: "b1", name: "Bravo", model: "bravo-1", vision: true }],
      },
    ],
  };
}
async function files(dir: string) {
  const out: Record<string, string> = {};
  for (const name of await readdir(dir))
    if (name.endsWith(".json"))
      out[name] = await readFile(dir + "/" + name, "utf8");
  for (const name of await readdir(dir + "/persona-history"))
    out["persona-history/" + name] = await readFile(
      dir + "/persona-history/" + name,
      "utf8",
    );
  return out;
}
function exported(s: Store, dir: string, all: Record<string, string>) {
  return [
    JSON.stringify(s.publicConfig()),
    JSON.stringify(s.modelRegistry()),
    JSON.stringify(s.personaHistory()),
    ...Object.entries(all)
      .filter(([n]) => n !== "secrets.json")
      .map(([, v]) => v),
  ].join("\n");
}

test("legacy provider/model/key loads as the active registered entry without rewriting", async () => {
  await withStore(async (s, dir) => {
    const c = s.publicConfig();
    await s.save({
      ...c,
      provider: { baseUrl: A, model: "legacy-model", vision: true },
      apiKey: keyA,
      persona: { ...c.persona, name: "Legacy two" },
    });
    // Reproduce a pre-registry installation: no `models`, flat three-key secrets.
    const legacy = JSON.parse(await readFile(dir + "/config.json", "utf8"));
    for (const k of ["current", "previous"]) delete legacy[k].models;
    await writeFile(dir + "/config.json", JSON.stringify(legacy));
    await writeFile(
      dir + "/secrets.json",
      JSON.stringify({ token: "", apiKey: keyA, admin: s.secrets.admin }),
    );
    const before = await files(dir);
    const t = await reopen(dir);
    assert.deepEqual(await files(dir), before, "load must not migrate on disk");
    assert.deepEqual(t.modelRegistry().active, {
      provider: "default",
      model: "default",
    });
    const [p] = t.modelRegistry().providers;
    assert.equal(p.baseUrl, A);
    assert.equal(p.hasCredential, true);
    assert.deepEqual(p.models, [
      {
        id: "default",
        name: "legacy-model",
        model: "legacy-model",
        vision: true,
      },
    ]);
    assert.equal(t.secrets.apiKey, keyA);
    // First save materializes the registry and keeps all persona history.
    const d = draft(t);
    d.providers[0].name = "Renamed";
    await t.save(body(t, d));
    const u = await reopen(dir);
    assert.equal(u.modelRegistry().providers[0].name, "Renamed");
    assert.equal(u.modelRegistry().providers[0].hasCredential, true);
    assert.equal(u.secrets.apiKey, keyA);
    assert.deepEqual(u.publicConfig().provider, {
      baseUrl: A,
      model: "legacy-model",
      vision: true,
    });
    assert.equal(u.personaHistory().total, 3);
    assert.equal(u.personaRevision(2).persona.name, "Legacy two");
    assert.equal(u.personaRevision(1).persona.name, "Coach");
  });
});

test("A to B to A keeps keys, models and vision across restarts and retains inactive providers", async () => {
  await withStore(async (s, dir) => {
    await s.save(body(s, twoProviders(), { token: "synthetic-kata-token" }));
    let t = await reopen(dir);
    assert.equal(t.secrets.apiKey, keyA);
    assert.deepEqual(t.publicConfig().provider, {
      baseUrl: A,
      model: "alpha-1",
      vision: false,
    });
    let d = draft(t);
    d.active = { provider: "bravo", model: "b1" };
    await t.save(body(t, d));
    t = await reopen(dir);
    assert.equal(t.secrets.apiKey, keyB);
    assert.deepEqual(t.publicConfig().provider, {
      baseUrl: B,
      model: "bravo-1",
      vision: true,
    });
    assert.deepEqual(
      t.modelRegistry().providers.map((p) => [p.id, p.hasCredential]),
      [
        ["alpha", true],
        ["bravo", true],
      ],
    );
    d = draft(t);
    d.active = { provider: "alpha", model: "a2" };
    await t.save(body(t, d));
    t = await reopen(dir);
    assert.equal(t.secrets.apiKey, keyA);
    assert.deepEqual(t.publicConfig().provider, {
      baseUrl: A,
      model: "alpha-2",
      vision: true,
    });
    assert.equal(t.secrets.token, "synthetic-kata-token");
    // Flat private slots: every value remains a string and includes inactive keys.
    const values = Object.values(t.secrets);
    assert.ok(values.every((v) => typeof v === "string"));
    assert.ok(values.includes(keyB));
    const raw = JSON.parse(await readFile(dir + "/secrets.json", "utf8"));
    assert.ok(Object.values(raw).every((v) => typeof v === "string"));
    const all = await files(dir);
    const text = exported(t, dir, all);
    for (const secret of [keyA, keyB, "synthetic-kata-token"])
      assert.equal(text.includes(secret), false);
    assert.equal(
      JSON.stringify(t.modelRegistry()).includes("credential"),
      false,
    );
  });
});

test("blank credential is retained only for the same provider identity and endpoint", async () => {
  await withStore(async (s) => {
    await s.save(body(s, twoProviders()));
    const d = draft(s);
    d.providers[1].baseUrl = "https://exfiltrate.synthetic.invalid/v1";
    const before = s.modelRegistry();
    const secrets = { ...s.secrets };
    await assert.rejects(s.save(body(s, d)), /CREDENTIAL_REQUIRED/);
    assert.deepEqual(s.modelRegistry(), before);
    assert.deepEqual(s.secrets, secrets);
    // Explicit removal is an accepted intent.
    d.providers[1].clearApiKey = true;
    await s.save(body(s, d));
    assert.equal(s.modelRegistry().providers[1].hasCredential, false);
    assert.equal(
      Object.values(s.secrets).includes(keyB),
      true,
      "rollback window",
    );
    // Re-entry binds a new key to the new endpoint.
    const e = draft(s);
    e.providers[1].apiKey = "synthetic-registry-key-charlie";
    await s.save(body(s, e));
    assert.equal(s.modelRegistry().providers[1].hasCredential, true);
    assert.equal(Object.values(s.secrets).includes(keyB), false, "purged");
    // A new provider id never inherits a deleted provider's key.
    const f = draft(s);
    f.providers[1] = { ...f.providers[1], id: "bravo2" };
    await s.save(body(s, f));
    assert.equal(s.modelRegistry().providers[1].hasCredential, false);
    // Endpoint trailing slash normalization is the same identity.
    const g = draft(s);
    g.providers[0].baseUrl = A + "/";
    await s.save(body(s, g));
    assert.equal(s.modelRegistry().providers[0].hasCredential, true);
    assert.equal(s.secrets.apiKey, keyA);
    await assert.rejects(
      s.save(
        body(s, {
          ...draft(s),
          providers: draft(s).providers.map((p: any, i: number) =>
            i ? p : { ...p, apiKey: "x-new", clearApiKey: true },
          ),
        }),
      ),
      /INVALID_REGISTRY/,
    );
  });
});

test("legacy save mode edits the active entry and enforces endpoint credential intent", async () => {
  await withStore(async (s) => {
    await s.save(body(s, twoProviders()));
    const c = s.publicConfig();
    await assert.rejects(
      s.save({ ...c, provider: { ...c.provider, baseUrl: B + "/other" } }),
      /CREDENTIAL_REQUIRED/,
    );
    await s.save({
      ...c,
      provider: { ...c.provider, model: "alpha-1b", vision: true },
    });
    assert.equal(s.secrets.apiKey, keyA);
    assert.deepEqual(s.modelRegistry().providers[0].models[0], {
      id: "a1",
      name: "Alpha one",
      model: "alpha-1b",
      vision: true,
    });
    await s.save({
      ...s.publicConfig(),
      provider: { ...s.publicConfig().provider, baseUrl: B + "/new" },
      apiKey: "synthetic-registry-key-delta",
    });
    assert.equal(s.secrets.apiKey, "synthetic-registry-key-delta");
    assert.equal(s.modelRegistry().providers[0].baseUrl, B + "/new");
    // Inactive provider untouched by legacy saves.
    assert.equal(s.modelRegistry().providers[1].hasCredential, true);
    assert.ok(Object.values(s.secrets).includes(keyB));
  });
});

test("legacy save cannot create an oversized registry URL that fails on restart", async () => {
  await withStore(async (s, dir) => {
    const before = await files(dir);
    const c = s.publicConfig();
    await assert.rejects(
      s.save({
        ...c,
        provider: { ...c.provider, baseUrl: A + "/" + "x".repeat(2048) },
      }),
      /INVALID_REGISTRY/,
    );
    assert.deepEqual(await files(dir), before);
    const restarted = await reopen(dir);
    assert.deepEqual(restarted.publicConfig(), c);
  });
});

test("active provider/model deletion requires another valid active selection", async () => {
  await withStore(async (s) => {
    await s.save(body(s, twoProviders()));
    const d = draft(s);
    d.providers = d.providers.filter((p: any) => p.id !== "alpha");
    const revision = s.publicConfig().revision;
    await assert.rejects(s.save(body(s, d)), /ACTIVE_MODEL_REQUIRED/);
    const m = draft(s);
    m.providers[0].models = m.providers[0].models.filter(
      (x: any) => x.id !== "a1",
    );
    await assert.rejects(s.save(body(s, m)), /ACTIVE_MODEL_REQUIRED/);
    assert.equal(s.publicConfig().revision, revision);
    d.active = { provider: "bravo", model: "b1" };
    await s.save(body(s, d));
    assert.equal(s.secrets.apiKey, keyB);
    assert.deepEqual(
      s.modelRegistry().providers.map((p) => p.id),
      ["bravo"],
    );
    await s.save(body(s, draft(s)));
    assert.equal(Object.values(s.secrets).includes(keyA), false);
  });
});

test("registry ids, bounds and mode conflicts are validated with fixed codes", async () => {
  await withStore(async (s) => {
    const base = twoProviders();
    const cases: [any, RegExp][] = [
      [{ ...base, providers: [] }, /REGISTRY_LIMIT/],
      [
        {
          ...base,
          providers: [base.providers[0], { ...base.providers[1], id: "alpha" }],
        },
        /INVALID_REGISTRY/,
      ],
      [
        {
          ...base,
          providers: [
            { ...base.providers[0], id: "Bad Id" },
            base.providers[1],
          ],
        },
        /INVALID_REGISTRY/,
      ],
      [
        {
          ...base,
          providers: [{ ...base.providers[0], name: " " }, base.providers[1]],
        },
        /INVALID_REGISTRY/,
      ],
      [
        {
          ...base,
          providers: [{ ...base.providers[0], models: [] }, base.providers[1]],
        },
        /REGISTRY_LIMIT/,
      ],
      [
        {
          ...base,
          providers: [
            {
              ...base.providers[0],
              models: [
                base.providers[0].models[0],
                base.providers[0].models[0],
              ],
            },
            base.providers[1],
          ],
        },
        /INVALID_REGISTRY/,
      ],
      [
        {
          ...base,
          providers: [
            {
              ...base.providers[0],
              models: [{ ...base.providers[0].models[0], vision: "yes" }],
            },
            base.providers[1],
          ],
        },
        /INVALID_REGISTRY/,
      ],
      [
        {
          ...base,
          providers: [
            { ...base.providers[0], baseUrl: "ftp://x.invalid" },
            base.providers[1],
          ],
        },
        /INVALID_URL/,
      ],
      [
        {
          ...base,
          providers: [
            { ...base.providers[0], apiKey: "bad\nkey" },
            base.providers[1],
          ],
        },
        /INVALID_SECRET/,
      ],
      [
        {
          ...base,
          providers: Array.from({ length: 17 }, (_, i) => ({
            ...base.providers[1],
            id: "p" + i,
            apiKey: undefined,
          })),
          active: { provider: "p0", model: "b1" },
        },
        /REGISTRY_LIMIT/,
      ],
      [
        {
          ...base,
          providers: [
            {
              ...base.providers[0],
              models: Array.from({ length: 33 }, (_, i) => ({
                id: "m" + i,
                name: "M",
                model: "m",
                vision: false,
              })),
            },
          ],
          active: { provider: "alpha", model: "m0" },
        },
        /REGISTRY_LIMIT/,
      ],
      [{ ...base, extra: true }, /INVALID_REGISTRY/],
    ];
    for (const [models, error] of cases)
      await assert.rejects(s.save(body(s, models)), error);
    await assert.rejects(
      s.save(body(s, base, { apiKey: "ambiguous-top-level" })),
      /INVALID_CONFIG/,
    );
    await assert.rejects(
      s.save(
        body(s, base, {
          provider: { baseUrl: B, model: "bravo-1", vision: true },
        }),
      ),
      /INVALID_CONFIG/,
    );
    await s.save(
      body(s, base, {
        provider: { baseUrl: A, model: "alpha-1", vision: false },
      }),
    );
    assert.equal(s.publicConfig().revision, 2);
    assert.equal(s.personaHistory().total, 2);
  });
});

test("inactive and incoming keys are checked against config, previous and history", async () => {
  await withStore(async (s, dir) => {
    const c = s.publicConfig();
    await s.save({
      ...c,
      persona: { ...c.persona, markdown: "old text synthetic-history-secret" },
    });
    await s.save({ ...c });
    const d = twoProviders();
    d.providers[1].apiKey = "synthetic-history-secret";
    await assert.rejects(s.save(body(s, d)), /SECRET_IN_CONFIG/);
    const e = twoProviders();
    e.providers[1].name = keyB;
    await assert.rejects(s.save(body(s, e)), /SECRET_IN_CONFIG/);
    await s.save(body(s, twoProviders()));
    const f = draft(s);
    f.providers[1].models[0].name = "leak " + keyB;
    await assert.rejects(s.save(body(s, f)), /SECRET_IN_CONFIG/);
    await assert.rejects(
      s.save({
        ...body(s, draft(s)),
        persona: { ...s.publicConfig().persona, markdown: keyB },
      }),
      /SECRET_IN_CONFIG/,
    );
    // A tampered config holding an inactive key fails closed on load.
    const raw = JSON.parse(await readFile(dir + "/config.json", "utf8"));
    raw.current.models.providers[0].name = keyB;
    await writeFile(dir + "/config.json", JSON.stringify(raw));
    await assert.rejects(reopen(dir), /SECRET_IN_CONFIG/);
  });
});

test("persona restore never rewinds registry or credentials; every save adds a revision", async () => {
  await withStore(async (s, dir) => {
    const c = s.publicConfig();
    await s.save({ ...c, persona: { ...c.persona, name: "Persona two" } });
    await s.save(body(s, twoProviders()));
    const d = draft(s);
    d.active = { provider: "bravo", model: "b1" };
    await s.save(body(s, d));
    const registry = s.modelRegistry();
    const secrets = await readFile(dir + "/secrets.json", "utf8");
    await s.restorePersona(1);
    assert.equal(s.publicConfig().persona.name, "Coach");
    assert.deepEqual(s.modelRegistry(), registry);
    assert.equal(await readFile(dir + "/secrets.json", "utf8"), secrets);
    assert.equal(s.secrets.apiKey, keyB);
    // Unchanged saves still add persona revisions.
    const total = s.personaHistory().total;
    await s.save(body(s, draft(s)));
    await s.save({ ...s.publicConfig() });
    assert.equal(s.personaHistory().total, total + 2);
    const t = await reopen(dir);
    assert.deepEqual(t.modelRegistry(), registry);
    assert.equal(t.secrets.apiKey, keyB);
  });
});

test("legacy rollback restores the previous registry with consistent bound credentials", async () => {
  await withStore(async (s, dir) => {
    await s.save(body(s, twoProviders()));
    const d = draft(s);
    d.active = { provider: "bravo", model: "b1" };
    d.providers = d.providers.filter((p: any) => p.id !== "alpha");
    await s.save(body(s, d));
    assert.equal(s.secrets.apiKey, keyB);
    await s.rollback();
    assert.equal(s.modelRegistry().active.provider, "alpha");
    assert.equal(s.modelRegistry().providers.length, 2);
    assert.equal(s.modelRegistry().providers[0].hasCredential, true);
    assert.equal(s.secrets.apiKey, keyA);
    assert.deepEqual(s.publicConfig().provider, {
      baseUrl: A,
      model: "alpha-1",
      vision: false,
    });
    const t = await reopen(dir);
    assert.equal(t.secrets.apiKey, keyA);
  });
});

test("rollback to a legacy revision keeps the key only for an identical endpoint", async () => {
  for (const moved of [false, true])
    await withStore(async (u, dir) => {
      const c = u.publicConfig();
      await writeFile(
        dir + "/secrets.json",
        JSON.stringify({ token: "", apiKey: keyA, admin: u.secrets.admin }),
      );
      const legacy = await reopen(dir);
      const d = draft(legacy);
      if (moved) {
        d.providers[0].baseUrl = B;
        d.providers[0].apiKey = keyB;
      }
      d.providers[0].models[0].vision = true;
      await legacy.save(body(legacy, d));
      assert.equal(legacy.secrets.apiKey, moved ? keyB : keyA);
      await legacy.rollback();
      assert.deepEqual(legacy.publicConfig().provider, c.provider);
      assert.equal(legacy.secrets.apiKey, moved ? "" : keyA);
      assert.equal(legacy.modelRegistry().providers[0].hasCredential, !moved);
      const t = await reopen(dir);
      assert.equal(t.secrets.apiKey, moved ? "" : keyA);
      assert.deepEqual(t.modelRegistry(), legacy.modelRegistry());
    });
});

test("persistence failures never pair a new key with an old endpoint", async () => {
  await withStore(async (s, dir) => {
    await s.save(body(s, twoProviders()));
    const original = s.atomic.bind(s);
    const move = () => {
      const d = draft(s);
      d.active = { provider: "bravo", model: "b1" };
      d.providers[1].baseUrl = B + "/moved";
      d.providers[1].apiKey = "synthetic-registry-key-moved";
      return d;
    };
    for (const fail of ["secrets", "config"]) {
      const before = await files(dir);
      s.atomic = async (file, data) => {
        if (file === fail) throw new Error("synthetic " + fail);
        await original(file, data);
      };
      await assert.rejects(s.save(body(s, move())), /synthetic/);
      assert.deepEqual(await files(dir), before);
      assert.equal(s.secrets.apiKey, keyA);
    }
    // Crash model: config publication fails AND the secrets restore fails.
    let calls = 0;
    s.atomic = async (file, data) => {
      calls++;
      if (file === "config" || calls > 2) throw new Error("synthetic crash");
      await original(file, data);
    };
    await assert.rejects(s.save(body(s, move())), /synthetic/);
    s.atomic = original;
    const t = await reopen(dir);
    const pair = [t.publicConfig().provider.baseUrl, t.secrets.apiKey];
    assert.ok(
      (pair[0] === A && (pair[1] === keyA || pair[1] === "")) ||
        (pair[0] === B + "/moved" &&
          pair[1] === "synthetic-registry-key-moved"),
      JSON.stringify(pair),
    );
    // Old registry entries only resolve keys bound to their own references.
    assert.equal(t.modelRegistry().providers[1].baseUrl, B);
    const raw = JSON.parse(await readFile(dir + "/secrets.json", "utf8"));
    assert.equal(raw.apiKey, "", "staged write cleared legacy mirror first");
    // Legacy readers see either an empty mirror or the matching pair.
    await t.save(body(t, draft(t)));
    const u = await reopen(dir);
    assert.equal(u.secrets.apiKey, keyA);
  });
});

test("concurrent registry saves serialize without losing or mixing credentials", async () => {
  await withStore(async (s, dir) => {
    await s.save(body(s, twoProviders()));
    const toB = draft(s);
    toB.active = { provider: "bravo", model: "b1" };
    const rekeyA = draft(s);
    rekeyA.providers[0].apiKey = "synthetic-registry-key-rekeyed";
    await Promise.all([
      s.save(body(s, toB)),
      s.save(body(s, rekeyA)),
      s.restorePersona(1),
    ]);
    assert.equal(s.publicConfig().revision, 5);
    // The last save wins wholesale: A active again with its rotated key.
    assert.equal(s.secrets.apiKey, "synthetic-registry-key-rekeyed");
    assert.equal(s.publicConfig().provider.baseUrl, A);
    const t = await reopen(dir);
    assert.deepEqual(t.secrets, s.secrets);
    assert.deepEqual(t.modelRegistry(), s.modelRegistry());
  });
});

test("serialized configuration and secrets stay below storage caps", async () => {
  await withStore(async (s, dir) => {
    const long = "x".repeat(2000);
    const providers = Array.from({ length: 16 }, (_, i) => ({
      id: "p" + i,
      name: "N".repeat(100),
      baseUrl: "https://p" + i + ".synthetic.invalid/" + long,
      apiKey: String(i).padStart(4, "0") + "k".repeat(4092),
      models: Array.from({ length: 4 }, (_, j) => ({
        id: "m" + j,
        name: "M".repeat(100),
        model: "q".repeat(200),
        vision: j % 2 === 0,
      })),
    }));
    const c = s.publicConfig();
    const persona = Object.fromEntries(
      Object.keys(c.persona).map((k) => [k, "\u0001".repeat(8000)]),
    );
    await s.save({
      ...body(s, { active: { provider: "p0", model: "m0" }, providers }),
      persona: { ...persona, name: "Big" },
    });
    await s.save(body(s, draft(s)));
    for (const [name, limit] of [
      ["config.json", 4 * 1024 * 1024],
      ["secrets.json", 256 * 1024],
    ] as const)
      assert.ok(
        Buffer.byteLength(await readFile(dir + "/" + name)) < limit,
        name,
      );
    const t = await reopen(dir);
    assert.equal(t.modelRegistry().providers.length, 16);
    const tooMany = draft(t);
    tooMany.providers[0].models = Array.from({ length: 32 }, (_, j) => ({
      id: "x" + j,
      name: "x",
      model: "x",
      vision: false,
    }));
    tooMany.providers[1].models = tooMany.providers[0].models;
    tooMany.active = { provider: "p0", model: "x0" };
    await assert.rejects(t.save(body(t, tooMany)), /REGISTRY_LIMIT/);
  });
});

test("the previous release's Store reads, saves and rolls back registry files safely", async (t) => {
  // Exact pre-registry owner from the base commit (downgrade/rollback target).
  let source: string;
  try {
    source = execFileSync("git", ["show", "4764225:src/config/store.ts"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return t.skip("base commit unavailable in this checkout");
  }
  const legacyDir = await mkdtemp(tmpdir() + "/coach-legacy-owner-");
  try {
    await writeFile(legacyDir + "/store.ts", source);
    const { Store: LegacyStore } = await import(legacyDir + "/store.ts");
    await withStore(async (s, dir) => {
      const d = twoProviders();
      d.active = { provider: "bravo", model: "b1" };
      await s.save(body(s, d));
      const old = new LegacyStore(dir);
      await old.init();
      assert.deepEqual(old.publicConfig().provider, {
        baseUrl: B,
        model: "bravo-1",
        vision: true,
      });
      assert.equal(old.secrets.apiKey, keyB);
      assert.ok(Object.values(old.secrets).every((v) => typeof v === "string"));
      // Old owner saves its legacy shape; the new owner reads it as legacy.
      const c = old.publicConfig();
      await old.save({
        ...c,
        persona: { ...c.persona, name: "Old owner" },
      });
      const back = await reopen(dir);
      assert.equal(back.secrets.apiKey, keyB);
      assert.equal(back.modelRegistry().providers.length, 1);
      assert.equal(back.modelRegistry().providers[0].baseUrl, B);
      assert.equal(back.personaHistory().total, 3);
      // Old owner's rollback republishes the registry revision intact.
      const again = new LegacyStore(dir);
      await again.init();
      await again.rollback();
      const restored = await reopen(dir);
      assert.equal(restored.modelRegistry().providers.length, 2);
      assert.equal(restored.secrets.apiKey, keyB);
      assert.equal(restored.modelRegistry().providers[0].hasCredential, true);
      assert.equal(restored.personaHistory().total, 4);
    });
  } finally {
    await rm(legacyDir, { recursive: true, force: true });
  }
});
