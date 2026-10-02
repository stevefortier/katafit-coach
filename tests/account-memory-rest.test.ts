import test from "node:test";
import assert from "node:assert/strict";
import {
  AccountMemory,
  AccountMemoryFailure,
  accountItem,
} from "../src/memory/account.js";
import { startAccountMemoryBackend } from "./helpers/account-memory-backend.js";

const client = (origin: string, token = "synthetic-account-bearer") =>
  new AccountMemory(origin, token, new AbortController().signal, [
    token,
    "synthetic-provider-secret",
  ]);
const code = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof AccountMemoryFailure, String(error));
    return error.code;
  }
  assert.fail("expected failure");
};

test("account memory CRUD uses the host-held ordinary bearer with mandatory keys and revisions", async () => {
  const backend = await startAccountMemoryBackend();
  try {
    const memory = client(backend.origin);
    const created = await memory.create(
      { kind: "preference", text: "Prefers short morning workouts." },
      "ui:create:0001",
    );
    assert.equal(created.item.audience, "account_private");
    assert.equal(created.item.provenance.type, "manual_assertion");
    assert.equal(created.operation.kind, "create");
    const listed = await memory.list({ status: "active" });
    assert.deepEqual(
      listed.items.map((i) => i.id),
      [created.item.id],
    );
    assert.equal(listed.has_more, false);
    const pinned = await memory.update(
      created.item.id,
      { pinned: true },
      1,
      "ui:pin:00000001",
    );
    assert.equal(pinned.item.pinned, true);
    assert.equal(pinned.item.revision, 2);
    const archived = await memory.update(
      created.item.id,
      { status: "archived" },
      2,
      "ui:archive:0001",
    );
    assert.equal(archived.item.status, "archived");
    const got = await memory.get(created.item.id);
    assert.equal(got.item.revision, 3);
    assert.ok(Array.isArray(got.history));
    const forgotten = await memory.forget(
      created.item.id,
      3,
      "ui:forget:00001",
    );
    assert.equal(forgotten.status, "forgotten");
    for (const request of backend.requests) {
      assert.equal(request.auth, "Bearer synthetic-account-bearer");
      assert.ok(request.path.startsWith("/api/coach/memory"));
      assert.ok(!JSON.stringify(request.body ?? {}).includes("bearer"));
    }
    const writes = backend.requests.filter((r) => r.method !== "GET");
    assert.ok(writes.every((r) => typeof r.body.idempotency_key === "string"));
    assert.deepEqual(
      writes.slice(1).map((r) => r.body.expected_revision),
      [1, 2, 3],
    );
    // Unprotect is unsupported by the contract and never offered.
    await assert.rejects(
      () =>
        memory.update(
          created.item.id,
          { protected: false } as any,
          4,
          "ui:unprotect:01",
        ),
      /MEMORY_INVALID/,
    );
  } finally {
    await backend.close();
  }
});

test("account memory classifies auth, denial, unsupported, conflict and outage distinctly", async () => {
  const backend = await startAccountMemoryBackend();
  try {
    assert.equal(
      await code(client(backend.origin, "revoked-bearer").list({})),
      "MEMORY_AUTH_EXPIRED",
    );
    assert.equal(
      await code(client(backend.origin).get("aaaaaaaaaaaaaaaaaaaaaaaa")),
      "MEMORY_NOT_AUTHORIZED",
    );
    const created = await client(backend.origin).create(
      { kind: "fact", text: "Owns adjustable dumbbells." },
      "ui:create:0002",
    );
    assert.equal(
      await code(
        client(backend.origin).update(
          created.item.id,
          { text: "stale" },
          9,
          "ui:stale:00001",
        ),
      ),
      "MEMORY_CONFLICT",
    );
    assert.equal(
      await code(
        client(backend.origin).create(
          { kind: "fact", text: "different body" },
          "ui:create:0002",
        ),
      ),
      "MEMORY_IDEMPOTENCY_CONFLICT",
    );
    backend.hooks.before = () => ({
      status: 404,
      type: "text/html",
      body: "<pre>Cannot GET</pre>",
    });
    assert.equal(
      await code(client(backend.origin).list({})),
      "MEMORY_UNSUPPORTED",
    );
    backend.hooks.before = () => ({
      status: 503,
      body: { code: "MEMORY_UNAVAILABLE", message: "x" },
    });
    assert.equal(
      await code(client(backend.origin).list({})),
      "MEMORY_UNAVAILABLE",
    );
    backend.hooks.before = () => ({
      status: 302,
      body: "",
      type: "text/plain",
    });
    assert.equal(
      await code(client(backend.origin).list({})),
      "MEMORY_RESULT_REJECTED",
    );
  } finally {
    await backend.close();
  }
});

test("a lost write response is unknown, never replayed, and reconciles by exact receipt read", async () => {
  const backend = await startAccountMemoryBackend();
  try {
    const memory = client(backend.origin);
    backend.hooks.afterCommit = (r) =>
      r.method === "POST" ? "drop" : undefined;
    assert.equal(
      await code(
        memory.create(
          { kind: "goal", text: "Run a 10k in May." },
          "nl:key:0003",
        ),
      ),
      "MEMORY_OUTCOME_UNKNOWN",
    );
    backend.hooks.afterCommit = undefined;
    const posts = backend.requests.filter((r) => r.method === "POST");
    assert.equal(posts.length, 1, "the client never re-sent the write");
    const receipt = await memory.operation("nl:key:0003");
    assert.equal(receipt?.operation.kind, "create");
    assert.equal(receipt?.operation.status, "committed");
    assert.equal(receipt?.item?.text, "Run a 10k in May.");
    assert.equal(await memory.operation("nl:never:0004"), null);
  } finally {
    await backend.close();
  }
});

test("recall reads active pinned core plus query page and excludes archived or unavailable rows", async () => {
  const backend = await startAccountMemoryBackend();
  try {
    const pinned = backend.seed({
      kind: "preference",
      text: "Prefers evening sessions.",
      pinned: true,
    });
    backend.seed({
      kind: "fact",
      text: "Has a knee brace.",
      status: "archived",
    });
    const knee = backend.seed({
      kind: "fact",
      text: "Reported a temporary knee strain.",
      review_at: new Date(Date.now() - 86400000).toISOString(),
      needs_review: true,
    });
    const recalled = await client(backend.origin).recall("knee pain today");
    assert.deepEqual(
      recalled.map((i) => i.id).sort(),
      [pinned.id, knee.id].sort(),
    );
    const paths = backend.requests.map((r) => r.path);
    assert.ok(paths.some((p) => p.includes("pinned=true")));
    assert.ok(paths.some((p) => p.includes("query=knee")));
    assert.ok(paths.every((p) => p.includes("status=active")));
  } finally {
    await backend.close();
  }
});

test("pending recovery scans through empty continuation pages and settings are account-owned", async () => {
  const backend = await startAccountMemoryBackend();
  try {
    const memory = client(backend.origin);
    const capture = await memory.capture({
      idempotency_key: "native:turn:0001",
      human_text: "I train best in the morning.",
      assistant_text: "Noted.",
      tool_results: [],
      recalled: [],
    });
    const pending = await memory.pending();
    assert.deepEqual(
      pending.captures.map((c) => c.capture_id),
      [capture.capture_id],
    );
    assert.ok(
      backend.requests.filter((r) => r.path.includes("/pending")).length >= 2,
    );
    const settings = await memory.settings();
    assert.equal(settings.learning_paused, false);
    const paused = await memory.setLearning(
      true,
      settings.revision,
      "ui:pause:00001",
    );
    assert.equal(paused.settings.learning_paused, true);
    assert.equal(
      await code(
        memory.capture({
          idempotency_key: "native:turn:0002",
          human_text: "x",
          assistant_text: "y",
          tool_results: [],
          recalled: [],
        }),
      ),
      "MEMORY_LEARNING_PAUSED",
    );
  } finally {
    await backend.close();
  }
});

test("item validation keeps unavailable rows prose-free and rejects foreign audiences or secret echoes", () => {
  const base = {
    id: "aaaaaaaaaaaaaaaaaaaaaaaa",
    revision: 1,
    kind: "fact",
    text: "Synthetic fact.",
    availability: "available",
    status: "active",
    audience: "account_private",
    subject: null,
    confidence: 1,
    importance: 0.5,
    goal_relevance: null,
    review_at: null,
    needs_review: false,
    pinned: false,
    protected: true,
    provenance: {
      type: "manual_assertion",
      origin: "studio",
      created_by: "account_owner",
      producer: "external_coach",
      on_behalf_of: "account_owner",
      corrected: false,
      persona_revision: null,
    },
    sources: [],
    observed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  assert.equal(accountItem(base, []).text, "Synthetic fact.");
  assert.throws(
    () => accountItem({ ...base, audience: "operator_private" }, []),
    /MEMORY_RESULT_REJECTED/,
  );
  assert.throws(
    () =>
      accountItem(
        { ...base, availability: "unavailable", unavailable_code: "X" },
        [],
      ),
    /MEMORY_RESULT_REJECTED/,
  );
  assert.throws(
    () =>
      accountItem({ ...base, text: "leak synthetic-secret" }, [
        "synthetic-secret",
      ]),
    /SECRET|MEMORY_RESULT_REJECTED/,
  );
  assert.throws(
    () =>
      accountItem(
        {
          ...base,
          provenance: { ...base.provenance, producer: "model_said_so" },
        },
        [],
      ),
    /MEMORY_RESULT_REJECTED/,
  );
});
