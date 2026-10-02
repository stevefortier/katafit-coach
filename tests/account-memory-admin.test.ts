import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import {
  startAccountMemoryBackend,
  type AccountMemoryBackend,
} from "./helpers/account-memory-backend.js";

async function fixture(backend: AccountMemoryBackend, token = backend.token) {
  const dir = await mkdtemp(tmpdir() + "/account-memory-admin-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: backend.origin,
    token,
    apiKey: "synthetic-provider-secret",
  });
  const app = await admin(store, 0);
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(app.origin + "/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + store.secrets.admin,
        Origin: app.origin,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    store,
    request,
    close: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("default Memories management is the ordinary account REST collection, never legacy Studio MCP", async () => {
  const backend = await startAccountMemoryBackend();
  const f = await fixture(backend);
  try {
    const empty = await f.request("memories");
    assert.equal(empty.status, 200);
    assert.equal(empty.body.collection, "account");
    assert.deepEqual(empty.body.items, []);
    const created = await f.request("memories", {
      idempotency_key: "ui:create:a0001",
      kind: "preference",
      text: "Prefers short morning workouts.",
    });
    assert.equal(created.status, 200);
    const id = created.body.item.id;
    assert.equal(created.body.item.provenance.type, "manual_assertion");
    const pinned = await f.request("memories/" + id, {
      idempotency_key: "ui:pin:a000002",
      expected_revision: 1,
      pinned: true,
    });
    assert.equal(pinned.body.item.pinned, true);
    const archived = await f.request("memories/" + id, {
      idempotency_key: "ui:arch:a00003",
      expected_revision: 2,
      status: "archived",
    });
    assert.equal(archived.body.item.status, "archived");
    const restored = await f.request("memories/" + id, {
      idempotency_key: "ui:rest:a00004",
      expected_revision: 3,
      status: "active",
    });
    assert.equal(restored.body.item.status, "active");
    const edited = await f.request("memories/" + id, {
      idempotency_key: "ui:edit:a00005",
      expected_revision: 4,
      text: "Prefers 30-minute morning workouts.",
    });
    assert.equal(edited.body.item.protected, true);
    const detail = await f.request("memories/" + id);
    assert.equal(detail.body.item.revision, 5);
    const searched = await f.request(
      "memories?status=all&kind=preference&query=morning&limit=10",
    );
    assert.deepEqual(
      searched.body.items.map((i: any) => i.id),
      [id],
    );
    const forgotten = await f.request("memories/" + id + "/forget", {
      idempotency_key: "ui:forg:a00006",
      expected_revision: 5,
    });
    assert.equal(forgotten.body.status, "forgotten");
    assert.ok(
      backend.requests.every(
        (r) =>
          r.path.startsWith("/api/coach/memory") &&
          r.auth === "Bearer " + backend.token,
      ),
      "only ordinary account REST with the host-held bearer",
    );
    assert.deepEqual(
      backend.requests
        .filter((r) => r.method !== "GET")
        .map((r) => [r.method, r.body.idempotency_key]),
      [
        ["POST", "ui:create:a0001"],
        ["PATCH", "ui:pin:a000002"],
        ["PATCH", "ui:arch:a00003"],
        ["PATCH", "ui:rest:a00004"],
        ["PATCH", "ui:edit:a00005"],
        ["DELETE", "ui:forg:a00006"],
      ],
    );
  } finally {
    await f.close();
    await backend.close();
  }
});

test("writes require a client key and exact expected revision; unsupported fields are refused locally", async () => {
  const backend = await startAccountMemoryBackend();
  const f = await fixture(backend);
  try {
    const seeded = backend.seed({ kind: "fact", text: "Synthetic fact." });
    for (const [path, body] of [
      ["memories", { kind: "fact", text: "missing key" }],
      [
        "memories/" + seeded.id,
        { idempotency_key: "ui:edit:b0001", text: "x" },
      ],
      [
        "memories/" + seeded.id + "/forget",
        { idempotency_key: "ui:forg:b0002" },
      ],
      [
        "memories/" + seeded.id,
        {
          idempotency_key: "ui:prot:b0003",
          expected_revision: 1,
          protected: false,
        },
      ],
      [
        "memories",
        {
          idempotency_key: "ui:aud:b00004",
          kind: "fact",
          text: "x",
          audience: "operator_private",
        },
      ],
      ["memories?scope=boss", undefined],
    ] as const) {
      const result = await f.request(path, body);
      assert.equal(result.status, 400, path + JSON.stringify(body));
    }
    assert.equal(
      backend.requests.filter((r) => r.method !== "GET").length,
      0,
      "nothing malformed reached the backend",
    );
  } finally {
    await f.close();
    await backend.close();
  }
});

test("auth expiry, denial, unsupported backend, conflict and outage are distinct actionable states", async () => {
  const backend = await startAccountMemoryBackend();
  const revoked = await fixture(backend, "revoked-synthetic-bearer");
  const f = await fixture(backend);
  try {
    const expired = await revoked.request("memories");
    assert.equal(expired.status, 403);
    assert.equal(expired.body.error, "MEMORY_AUTH_EXPIRED");
    assert.match(expired.body.hint, /Reconnect/i);
    const denied = await f.request("memories/aaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(denied.body.error, "MEMORY_NOT_AUTHORIZED");
    assert.doesNotMatch(denied.body.hint, /Refresh/i);
    const seeded = backend.seed({ kind: "fact", text: "Synthetic fact." });
    const conflict = await f.request("memories/" + seeded.id, {
      idempotency_key: "ui:conf:c0001",
      expected_revision: 7,
      text: "stale draft",
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, "MEMORY_CONFLICT");
    backend.hooks.before = () => ({
      status: 404,
      type: "text/html",
      body: "<pre>Cannot GET</pre>",
    });
    const unsupported = await f.request("memories");
    assert.equal(unsupported.status, 501);
    assert.equal(unsupported.body.error, "MEMORY_UNSUPPORTED");
    backend.hooks.before = () => ({
      status: 503,
      body: { code: "MEMORY_UNAVAILABLE", message: "x" },
    });
    const outage = await f.request("memories");
    assert.equal(outage.status, 503);
    assert.equal(outage.body.error, "MEMORY_UNAVAILABLE");
  } finally {
    await revoked.close();
    await f.close();
    await backend.close();
  }
});

test("lost UI write is reported unknown and reconciled read-only by its exact key", async () => {
  const backend = await startAccountMemoryBackend();
  const f = await fixture(backend);
  try {
    backend.hooks.afterCommit = (r) =>
      r.method === "POST" ? "drop" : undefined;
    const lost = await f.request("memories", {
      idempotency_key: "ui:lost:d0001",
      kind: "goal",
      text: "Run a 10k in May.",
    });
    assert.equal(lost.body.error, "MEMORY_OUTCOME_UNKNOWN");
    backend.hooks.afterCommit = undefined;
    const receipt = await f.request("memories/operations/ui:lost:d0001");
    assert.equal(receipt.status, 200);
    assert.equal(receipt.body.operation.status, "committed");
    assert.equal(receipt.body.item.text, "Run a 10k in May.");
    const missing = await f.request("memories/operations/ui:none:d0002");
    assert.equal(missing.status, 200);
    assert.equal(missing.body.operation, null);
    assert.equal(
      backend.requests.filter((r) => r.method === "POST").length,
      1,
      "reconciliation never re-sends the write",
    );
  } finally {
    await f.close();
    await backend.close();
  }
});

test("pause learning is account-owned and survives a host restart", async () => {
  const backend = await startAccountMemoryBackend();
  let f = await fixture(backend);
  try {
    const initial = await f.request("memories/settings");
    assert.equal(initial.body.settings.learning_paused, false);
    const paused = await f.request("memories/settings", {
      idempotency_key: "ui:pause:e0001",
      expected_revision: initial.body.settings.revision,
      learning_paused: true,
    });
    assert.equal(paused.body.settings.learning_paused, true);
    await f.close();
    f = await fixture(backend);
    const after = await f.request("memories/settings");
    assert.equal(after.body.settings.learning_paused, true);
  } finally {
    await f.close();
    await backend.close();
  }
});

test("legacy Studio notes stay a separately labeled, opt-in collection", async () => {
  const backend = await startAccountMemoryBackend();
  const f = await fixture(backend);
  try {
    const legacy = await f.request("legacy-memories");
    // The synthetic backend has no MCP endpoint; the failure is legacy-scoped
    // and the default collection never consulted it.
    assert.notEqual(legacy.status, 200);
    assert.ok(
      backend.requests.every((r) => !r.path.startsWith("/api/coach/memory")),
    );
  } finally {
    await f.close();
    await backend.close();
  }
});

test("a replaced connection fences an in-flight account read before disclosing prose", async () => {
  const backend = await startAccountMemoryBackend();
  const f = await fixture(backend);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let entered!: () => void;
  const waiting = new Promise<void>((r) => (entered = r));
  try {
    backend.seed({ kind: "fact", text: "prior-owner-private-prose" });
    backend.hooks.wait = () => {
      entered();
      return held;
    };
    const request = f.request("memories");
    await waiting;
    await f.store.save({
      ...f.store.publicConfig(),
      token: "synthetic-replacement-bearer",
    });
    release();
    const response = await request;
    assert.notEqual(response.status, 200);
    assert.doesNotMatch(
      JSON.stringify(response.body),
      /prior-owner-private-prose/,
    );
  } finally {
    release();
    await f.close();
    await backend.close();
  }
});

test("account writes refuse every configured secret before dispatch", async () => {
  const backend = await startAccountMemoryBackend();
  const f = await fixture(backend);
  try {
    const seeded = backend.seed({ kind: "fact", text: "Synthetic fact." });
    for (const secret of Object.values(f.store.secrets)) {
      if (!secret) continue;
      for (const [path, body] of [
        [
          "memories",
          {
            idempotency_key: "ui:sec:f00001",
            kind: "fact",
            text: "Remember " + secret,
          },
        ],
        [
          "memories/" + seeded.id,
          {
            idempotency_key: "ui:sec:f00002",
            expected_revision: 1,
            text: "Remember " + secret,
          },
        ],
      ] as const) {
        const response = await f.request(path, body);
        assert.notEqual(response.status, 200);
      }
    }
    assert.equal(backend.requests.filter((r) => r.method !== "GET").length, 0);
  } finally {
    await f.close();
    await backend.close();
  }
});
