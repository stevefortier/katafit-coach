import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";
import { fixture as nativeFixture } from "./helpers/native.js";
import { fixture as workerFixture } from "./worker.test.js";
import canonical from "./fixtures/kata-persona-presets.json" with { type: "json" };

const custom = {
  name: "Synthetic Sensei",
  voice: "Quiet precision",
  principles: "Form first.",
  examples: "Hold the plank for one more breath.",
  boundaries: "No medical advice.",
  initiative: "Respond to the current request only.",
  verbosity: "Concise",
  markdown: "",
};
const mentor = canonical.presets.find((p) => p.id === "supportive_mentor")!;

async function settle(status: () => Promise<any>) {
  for (let i = 0; i < 500 && (await status()).transition; i++)
    await new Promise((r) => setTimeout(r, 10));
}

async function api(
  options: { origin?: string; infer?: Parameters<typeof admin>[2] } = {},
) {
  const dir = await mkdtemp(tmpdir() + "/persona-api-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    ...(options.origin ? { origin: options.origin } : {}),
    provider: { baseUrl: "https://provider.synthetic.invalid/v1", model: "m" },
    token: "synthetic-persona-token",
    apiKey: "synthetic-persona-key",
  });
  const app = await admin(store, 0, options.infer ?? (async () => "reply"));
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  const get = async (path: string) => {
    const r = await fetch(app.origin + "/api/" + path, { headers });
    return {
      status: r.status,
      body: (await r.json().catch(() => null)) as any,
    };
  };
  const post = async (path: string, body: unknown = {}) => {
    const r = await fetch(app.origin + "/api/" + path, {
      method: "POST",
      headers,
      body: JSON.stringify({
        // Only configuration writes carry the revision fence.
        ...(/^(personas|config)/.test(path)
          ? { expectedRevision: store.publicConfig().revision }
          : {}),
        ...(body as object),
      }),
    });
    return {
      status: r.status,
      body: (await r.json().catch(() => null)) as any,
    };
  };
  const status = async () => (await get("status")).body;
  return {
    dir,
    store,
    app,
    headers,
    get,
    post,
    status,
    async close() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("persona config API lists builtins and manages custom configs by saved ID", async () => {
  const h = await api();
  try {
    const anonymous = await fetch(h.app.origin + "/api/personas");
    assert.equal(anonymous.status, 401);
    const listed = await h.get("personas");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.active.id, "kata_default");
    assert.equal(listed.body.active.label, "Kata.fit default");
    assert.deepEqual(
      listed.body.builtins.map((b: any) => [b.id, b.label, b.instructions]),
      canonical.presets.map((p) => [p.id, p.label, p.instructions]),
    );
    assert.equal(listed.body.source.revision, canonical.source.revision);
    // The public configuration exposes the canonical reference only.
    const config = await h.get("config");
    assert.equal(config.body.personas.active, "kata_default");
    const created = await h.post("personas", {
      label: "Dawn patrol",
      persona: custom,
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.match(created.body.id, /^custom-[a-f0-9]{16}$/);
    const id = created.body.id;
    const copy = await h.post("personas/supportive_mentor/duplicate");
    assert.equal(copy.status, 200);
    assert.equal(
      (await h.get("personas")).body.custom.find(
        (p: any) => p.id === copy.body.id,
      ).persona.markdown,
      mentor.instructions,
    );
    const edit = await h.post("personas/" + id, {
      label: "Dawn patrol",
      persona: { ...custom, voice: "Bright" },
    });
    assert.equal(edit.status, 200);
    assert.equal((await h.post("personas/" + id + "/select")).status, 200);
    let view = (await h.get("personas")).body;
    assert.equal(view.active.id, id);
    assert.equal(view.active.label, "Dawn patrol");
    assert.equal((await h.get("config")).body.persona.voice, "Bright");
    // Deleting the active config would dangle the reference.
    const deleteActive = await h.post("personas/" + id + "/delete");
    assert.equal(deleteActive.status, 409);
    assert.equal(deleteActive.body.error, "PERSONA_ACTIVE");
    assert.equal(
      (await h.post("personas/" + copy.body.id + "/delete")).status,
      200,
    );
    view = (await h.get("personas")).body;
    assert.deepEqual(
      view.custom.map((p: any) => p.id),
      [id],
    );
    // Restart keeps the reference.
    const restarted = new Store(h.dir);
    await restarted.init();
    assert.equal(restarted.personaView().active.id, id);
  } finally {
    await h.close();
  }
});

test("builtins are immutable through the API and unknown IDs are rejected", async () => {
  const h = await api();
  try {
    const before = h.store.publicConfig();
    for (const [path, body, status, error] of [
      [
        "personas/kata_default",
        { label: "Mine", persona: custom },
        409,
        "PERSONA_IMMUTABLE",
      ],
      ["personas/kata_default/delete", {}, 409, "PERSONA_IMMUTABLE"],
      [
        "personas/drill_sergeant",
        { label: "Softer sergeant", persona: custom },
        409,
        "PERSONA_IMMUTABLE",
      ],
      ["personas/drill_sergeant/delete", {}, 409, "PERSONA_IMMUTABLE"],
      ["personas/custom-0123456789abcdef/select", {}, 404, "PERSONA_NOT_FOUND"],
      [
        "personas/custom-0123456789abcdef",
        { label: "X", persona: custom },
        404,
        "PERSONA_NOT_FOUND",
      ],
      ["personas/nope/duplicate", {}, 404, "PERSONA_NOT_FOUND"],
      ["personas/BAD%20ID/select", {}, 400, "INVALID_PERSONA_ID"],
      ["personas/kata_default/rename", {}, 404, "NOT_FOUND"],
      ["personas", { label: "", persona: custom }, 400, "INVALID_PERSONA"],
      [
        "personas",
        { label: "Kata.fit default", persona: custom },
        409,
        "PERSONA_NAME_TAKEN",
      ],
      [
        "personas",
        {
          label: "Leak",
          persona: { ...custom, markdown: "synthetic-persona-key" },
        },
        400,
        "SECRET_IN_CONFIG",
      ],
    ] as const) {
      const r = await h.post(path, body);
      assert.equal(r.status, status, path + " " + JSON.stringify(r.body));
      assert.equal(r.body?.error, error, path);
    }
    assert.deepEqual(h.store.publicConfig(), before);
    // The shared configuration save cannot rewrite persona state.
    const c = h.store.publicConfig();
    const shared = await h.post("config", {
      ...c,
      persona: { ...c.persona, name: "Smuggled" },
    });
    assert.equal(shared.status, 400);
    assert.equal(shared.body.error, "PERSONA_READ_ONLY");
    assert.deepEqual(h.store.publicConfig(), before);
  } finally {
    await h.close();
  }
});

test("persona revision guards, idempotency and retired history endpoints", async () => {
  const h = await api();
  try {
    const stale = h.store.publicConfig().revision;
    assert.equal((await h.post("personas/casual_buddy/select")).status, 200);
    await settle(h.status);
    const conflict = await h.post("personas/science_educator/select", {
      expectedRevision: stale,
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, "CONFIGURATION_CHANGED");
    assert.equal(h.store.personaView().active.id, "casual_buddy");
    const raw = JSON.stringify({
      label: "Once",
      persona: custom,
      operationId: "0123abcd-0123-4abc-8abc-0123456789ab",
      expectedRevision: h.store.publicConfig().revision,
    });
    const send = () =>
      fetch(h.app.origin + "/api/personas", {
        method: "POST",
        headers: h.headers,
        body: raw,
      });
    const first = await send();
    assert.equal(first.status, 200);
    const { id } = (await first.json()) as any;
    await settle(h.status);
    const revision = h.store.publicConfig().revision;
    // A retried operation replays its recorded outcome without a second write.
    const replay = await send();
    assert.equal(replay.status, 200);
    assert.equal(((await replay.json()) as any).id, id);
    assert.equal(h.store.publicConfig().revision, revision);
    assert.equal(h.store.personaView().custom.length, 1);
    for (const path of [
      "persona-history",
      "persona-history/1",
      "persona-defaults",
    ])
      assert.equal((await h.get(path)).status, 404, path);
    const restore = await fetch(h.app.origin + "/api/persona-restore", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ revision: 1 }),
    });
    assert.equal(restore.status, 404);
    assert.equal(existsSync(h.dir + "/persona-history"), false);
  } finally {
    await h.close();
  }
});

test("worker and preview prompts follow the active saved persona reference", async () => {
  const backend = await workerFixture();
  const systems: string[] = [];
  let seen!: () => void;
  let called = new Promise<void>((r) => (seen = r));
  const h = await api({
    origin: backend.origin,
    infer: async (_provider, system) => {
      systems.push(system);
      seen();
      return "Synthetic persona reply";
    },
  });
  try {
    const preview = async () =>
      (
        await fetch(h.app.origin + "/api/preview", {
          method: "POST",
          headers: h.headers,
          body: JSON.stringify({ text: "Synthetic preview" }),
        })
      ).json() as Promise<any>;
    let p = await preview();
    assert.ok(p.prompt.includes(canonical.presets[0].instructions), p.error);
    assert.equal(
      (await h.post("personas/supportive_mentor/select")).status,
      200,
    );
    await settle(h.status);
    p = await preview();
    assert.ok(p.prompt.includes(mentor.instructions));
    assert.ok(!p.prompt.includes(canonical.presets[0].instructions));
    const created = await h.post("personas", {
      label: "Worker sensei",
      persona: custom,
    });
    await settle(h.status);
    await h.post("personas/" + created.body.id + "/select");
    await settle(h.status);
    p = await preview();
    assert.ok(p.prompt.includes("name: Synthetic Sensei"));
    assert.ok(p.prompt.includes("voice: Quiet precision"));
    assert.ok(!p.prompt.includes(mentor.instructions));
    systems.length = 0;
    called = new Promise<void>((r) => (seen = r));
    backend.enqueue("Synthetic worker persona question");
    assert.equal((await h.post("run")).status, 200);
    await called;
    assert.ok(systems[0].includes("voice: Quiet precision"));
    // A persona action while running restarts the worker on the new reference.
    systems.length = 0;
    called = new Promise<void>((r) => (seen = r));
    assert.equal((await h.post("personas/demanding_coach/select")).status, 200);
    await settle(h.status);
    backend.enqueue("Second synthetic worker persona question");
    await called;
    const demanding = canonical.presets.find(
      (x) => x.id === "demanding_coach",
    )!;
    assert.ok(systems[0].includes(demanding.instructions));
    assert.ok(!systems[0].includes("Quiet precision"));
    // The Drill Sergeant builtin drives the running worker the same way.
    systems.length = 0;
    called = new Promise<void>((r) => (seen = r));
    assert.equal((await h.post("personas/drill_sergeant/select")).status, 200);
    await settle(h.status);
    backend.enqueue("Third synthetic worker persona question");
    await called;
    const drill = canonical.presets.find((x) => x.id === "drill_sergeant")!;
    assert.ok(systems[0].includes(drill.instructions));
    assert.ok(!systems[0].includes(demanding.instructions));
    p = await preview();
    assert.ok(p.prompt.includes(drill.instructions), p.error);
    await h.post("stop");
  } finally {
    await h.close();
    await backend.close();
  }
});

test("native operator catalog prompt follows the active saved persona reference", async () => {
  const f = await nativeFixture();
  try {
    let gateway = await openNativeGateway(f.store);
    try {
      const catalog: any = await gateway.handle({ kind: "catalog" });
      assert.ok(catalog.prompt.includes(canonical.presets[0].instructions));
    } finally {
      await gateway.close();
    }
    const id = await f.store.createPersona({
      label: "Native sensei",
      persona: custom,
    });
    await f.store.selectPersona(id);
    gateway = await openNativeGateway(f.store);
    try {
      const catalog: any = await gateway.handle({ kind: "catalog" });
      assert.ok(catalog.prompt.includes("voice: Quiet precision"));
      assert.ok(!catalog.prompt.includes(canonical.presets[0].instructions));
    } finally {
      await gateway.close();
    }
    // The Drill Sergeant persona keeps the operator framed as manager, not trainee.
    await f.store.selectPersona("drill_sergeant");
    gateway = await openNativeGateway(f.store);
    try {
      const catalog: any = await gateway.handle({ kind: "catalog" });
      const drill = canonical.presets.find((x) => x.id === "drill_sergeant")!;
      assert.ok(catalog.prompt.includes(drill.instructions));
      assert.ok(
        catalog.prompt.includes(
          "The operator is your manager and boss, not a trainee.",
        ),
      );
      assert.ok(!catalog.prompt.includes("voice: Quiet precision"));
    } finally {
      await gateway.close();
    }
  } finally {
    await f.close();
  }
});
