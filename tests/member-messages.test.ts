import { test } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readFile, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { Actions } from "../src/chat/actions.js";
import { openMemberMessages } from "../src/katafit/memberMessages.js";
import { memberBackend } from "./helpers/member-backend.js";

const OWNER = "64b7f0c2a1b2c3d4e5f60718";
const ALICE = "64b7f0c2a1b2c3d4e5f60799";
const BOB = "64b7f0c2a1b2c3d4e5f6079a";
const OTHER = "64b7f0c2a1b2c3d4e5f60000";

async function setup(accounts: Record<string, string> = { "token-a": OWNER }) {
  const backend = await memberBackend(accounts);
  const dir = await mkdtemp(tmpdir() + "/member-messages-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: backend.origin,
    token: Object.keys(accounts)[0],
  });
  return {
    backend,
    store,
    dir,
    async close() {
      await chmod(dir, 0o700).catch(() => {});
      await backend.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const unverified = { code: "DELIVERY_UNVERIFIED" };

test("first delivery posts once with a host key and resolves only on the exact receipt", async () => {
  const s = await setup();
  try {
    const service = openMemberMessages(s.store);
    const result = await service.deliver({
      occurrenceId: "event-1:slot-0",
      recipientId: ALICE,
      text: "  Keep going.  ",
    });
    assert.deepEqual(result, {
      status: "delivered",
      recipient_id: ALICE,
      occurrence_id: "event-1:slot-0",
      message_id: "message-1",
    });
    const [post] = s.backend.posts();
    assert.equal(post.path, `/api/coach/member-messages/${ALICE}`);
    assert.equal(post.auth, "Bearer token-a");
    assert.deepEqual(Object.keys(post.body).sort(), [
      "idempotency_key",
      "text",
    ]);
    // Exact words are delivered; the key is random, not derived from them.
    assert.equal(post.body.text, "  Keep going.  ");
    assert.match(post.body.idempotency_key, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(
      s.backend.calls.map((c) => c.method + " " + c.path),
      [
        "GET /api/coach/member-messages/context",
        `POST /api/coach/member-messages/${ALICE}`,
        `GET /api/coach/member-messages/${ALICE}/receipts/${post.body.idempotency_key}`,
      ],
    );
    const record = new Actions(s.store).memberDeliveries()[0];
    assert.equal(record.status, "delivered");
    assert.equal(record.account_owner_id, OWNER);
    assert.equal(record.origin, s.backend.origin);
  } finally {
    await s.close();
  }
});

test("the same occurrence never posts again; distinct occurrences may repeat exact words", async () => {
  const s = await setup();
  try {
    const service = openMemberMessages(s.store);
    const intent = { occurrenceId: "a", recipientId: ALICE, text: "Same" };
    const first = await service.deliver(intent);
    const before = s.backend.calls.length;
    assert.deepEqual(await service.deliver(intent), first);
    assert.deepEqual(
      await openMemberMessages(s.store).deliver(intent),
      first,
      "restart returns the already-verified result",
    );
    assert.equal(s.backend.calls.length, before, "no network for a replay");
    const second = await service.deliver({ ...intent, occurrenceId: "b" });
    assert.notEqual(second.message_id, first.message_id);
    assert.equal(s.backend.posts().length, 2);
    assert.notEqual(
      s.backend.posts()[0].body.idempotency_key,
      s.backend.posts()[1].body.idempotency_key,
    );
    assert.deepEqual(
      s.backend.messages.map((m) => m.text),
      ["Same", "Same"],
    );
    // Binding context was acquired once for this token and origin.
    assert.equal(s.backend.contexts().length, 1);
  } finally {
    await s.close();
  }
});

test("concurrent admissions of one occurrence produce one POST", async () => {
  const s = await setup();
  try {
    const a = openMemberMessages(s.store);
    const b = openMemberMessages(s.store);
    const intent = { occurrenceId: "c", recipientId: ALICE, text: "Once" };
    const results = await Promise.all([
      a.deliver(intent),
      b.deliver(intent),
      a.deliver(intent),
    ]);
    assert.equal(s.backend.posts().length, 1);
    assert.ok(results.every((r) => r.message_id === results[0].message_id));
  } finally {
    await s.close();
  }
});

test("payload conflicts and invalid inputs are rejected before any dispatch or fence", async () => {
  const s = await setup();
  try {
    const service = openMemberMessages(s.store);
    await service.deliver({ occurrenceId: "x", recipientId: ALICE, text: "A" });
    const before = s.backend.calls.length;
    await assert.rejects(
      service.deliver({ occurrenceId: "x", recipientId: ALICE, text: "B" }),
      { code: "OCCURRENCE_CONFLICT" },
    );
    await assert.rejects(
      service.deliver({ occurrenceId: "x", recipientId: BOB, text: "A" }),
      { code: "OCCURRENCE_CONFLICT" },
    );
    for (const bad of [
      { occurrenceId: "y", recipientId: ALICE.slice(1), text: "A" },
      { occurrenceId: "y", recipientId: ALICE + "/x", text: "A" },
      { occurrenceId: "y", recipientId: "zz" + ALICE.slice(2), text: "A" },
      { occurrenceId: "y", recipientId: ALICE, text: "   " },
      { occurrenceId: "y", recipientId: ALICE, text: "x".repeat(8001) },
      { occurrenceId: "y", recipientId: ALICE, text: "token-a" },
      { occurrenceId: "../y", recipientId: ALICE, text: "A" },
    ])
      await assert.rejects(service.deliver(bad as any), {
        code: "DELIVERY_REJECTED",
      });
    assert.equal(s.backend.calls.length, before);
    assert.equal(new Actions(s.store).memberDeliveries().length, 1);
  } finally {
    await s.close();
  }
});

test("a valid uppercase ObjectId is validated exactly, then dispatched canonically", async () => {
  const s = await setup();
  try {
    const result = await openMemberMessages(s.store).deliver({
      occurrenceId: "upper",
      recipientId: ALICE.toUpperCase(),
      text: "Hi",
    });
    assert.equal(result.recipient_id, ALICE);
    assert.equal(
      s.backend.posts()[0].path,
      `/api/coach/member-messages/${ALICE}`,
    );
  } finally {
    await s.close();
  }
});

test("lost POST acknowledgement recovers by exact receipt read, never a second POST", async () => {
  const s = await setup();
  try {
    s.backend.state.post = "destroy";
    const result = await openMemberMessages(s.store).deliver({
      occurrenceId: "lost",
      recipientId: ALICE,
      text: "Hello",
    });
    assert.equal(result.message_id, "message-1");
    assert.equal(s.backend.posts().length, 1);
    assert.equal(s.backend.messages.length, 1);
  } finally {
    await s.close();
  }
});

test("absent receipts keep the occurrence unknown and fenced until read-only recovery after restart", async () => {
  const s = await setup();
  try {
    s.backend.state.post = "destroy";
    s.backend.state.receiptsVisible = false;
    const service = openMemberMessages(s.store);
    const intent = { occurrenceId: "late", recipientId: ALICE, text: "Hello" };
    await assert.rejects(service.deliver(intent), unverified);
    assert.equal(new Actions(s.store).memberDeliveries()[0].status, "unknown");
    // Same occurrence: receipt read only. New occurrence: fenced, no POST.
    await assert.rejects(service.deliver(intent), unverified);
    await assert.rejects(
      service.deliver({ ...intent, occurrenceId: "other" }),
      unverified,
    );
    assert.equal(s.backend.posts().length, 1);
    s.backend.state.receiptsVisible = true;
    s.backend.state.post = "ok";
    const restarted = openMemberMessages(s.store);
    await restarted.reconcile();
    assert.equal(
      new Actions(s.store).memberDeliveries()[0].status,
      "delivered",
    );
    assert.equal((await restarted.deliver(intent)).message_id, "message-1");
    // A distinct later action is admitted once the uncertainty is resolved.
    await restarted.deliver({ ...intent, occurrenceId: "other" });
    assert.equal(s.backend.posts().length, 2);
  } finally {
    await s.close();
  }
});

test("denied sends and mismatched receipts never settle or replay", async () => {
  for (const mode of ["deny", "mismatch"] as const) {
    const s = await setup();
    try {
      if (mode === "deny") {
        s.backend.state.post = "deny";
        s.backend.state.receiptStatus = 403;
      } else s.backend.state.receiptMismatch = true;
      const service = openMemberMessages(s.store);
      const intent = { occurrenceId: mode, recipientId: ALICE, text: "Hi" };
      await assert.rejects(service.deliver(intent), unverified);
      await assert.rejects(service.deliver(intent), unverified);
      assert.equal(s.backend.posts().length, 1);
      assert.equal(
        new Actions(s.store).memberDeliveries()[0].status,
        "unknown",
      );
    } finally {
      await s.close();
    }
  }
});

test("cancellation after dispatch leaves an unknown outcome that is never retried", async () => {
  const s = await setup();
  try {
    s.backend.state.post = "hold";
    const abort = new AbortController();
    s.backend.state.onPost = () => setTimeout(() => abort.abort(), 20);
    const service = openMemberMessages(s.store);
    const intent = { occurrenceId: "cancel", recipientId: ALICE, text: "Hi" };
    await assert.rejects(service.deliver(intent, abort.signal), unverified);
    assert.equal(new Actions(s.store).memberDeliveries()[0].status, "unknown");
    s.backend.state.post = "ok";
    s.backend.state.onPost = undefined;
    const recovered = await service.deliver(intent);
    assert.equal(recovered.message_id, "message-1");
    assert.equal(s.backend.posts().length, 1);
  } finally {
    await s.close();
  }
});

test("completion-store failure after backend commit stays recoverable without a second POST", async () => {
  const s = await setup();
  try {
    // The journal becomes unwritable after admission, while the POST commits.
    s.backend.state.onPost = () => void chmod(s.dir, 0o500);
    const intent = { occurrenceId: "store", recipientId: ALICE, text: "Hi" };
    await assert.rejects(
      openMemberMessages(s.store).deliver(intent),
      unverified,
    );
    await chmod(s.dir, 0o700);
    assert.equal(new Actions(s.store).memberDeliveries()[0].status, "pending");
    s.backend.state.onPost = undefined;
    const reopened = openMemberMessages(s.store);
    await reopened.reconcile();
    assert.equal(
      new Actions(s.store).memberDeliveries()[0].status,
      "delivered",
    );
    assert.equal((await reopened.deliver(intent)).message_id, "message-1");
    assert.equal(s.backend.posts().length, 1);
  } finally {
    await s.close();
  }
});

test("a backend without the account context contract fails closed before any record", async () => {
  const s = await setup();
  try {
    const service = openMemberMessages(s.store);
    await s.store.save({ ...s.store.publicConfig(), token: "unknown-token" });
    await assert.rejects(
      openMemberMessages(s.store).deliver({
        occurrenceId: "n",
        recipientId: ALICE,
        text: "Hi",
      }),
      { code: "BINDING_UNAVAILABLE" },
    );
    assert.equal(s.backend.posts().length, 0);
    assert.equal(new Actions(s.store).memberDeliveries().length, 0);
    assert.ok(service);
  } finally {
    await s.close();
  }
});

test("account context is acquired once per token and origin and survives restart", async () => {
  const s = await setup({ "token-a": OWNER, "token-b": OWNER });
  try {
    await openMemberMessages(s.store).deliver({
      occurrenceId: "1",
      recipientId: ALICE,
      text: "Hi",
    });
    await openMemberMessages(s.store).deliver({
      occurrenceId: "2",
      recipientId: ALICE,
      text: "Hi",
    });
    assert.equal(s.backend.contexts().length, 1);
    await s.store.save({ ...s.store.publicConfig(), token: "token-b" });
    await openMemberMessages(s.store).deliver({
      occurrenceId: "3",
      recipientId: ALICE,
      text: "Hi",
    });
    assert.equal(s.backend.contexts().length, 2);
    assert.ok(
      new Actions(s.store)
        .memberDeliveries()
        .every((r) => r.account_owner_id === OWNER),
    );
  } finally {
    await s.close();
  }
});

/** Evict every member row with later completed generic writes; keep digests. */
async function evictMemberRows(s: Awaited<ReturnType<typeof setup>>) {
  const actions = new Actions(s.store);
  for (let i = 0; i < 40; i++)
    actions.save({
      session_id: "generic",
      idempotency_key: `generic-${i}`,
      tool_name: "katafit_rest_request",
      status: "completed",
    });
  assert.equal(new Actions(s.store).memberDeliveries().length, 0);
  const journal = await readFile(s.dir + "/operator-actions.json", "utf8");
  assert.match(journal, /member-delivery-retired-v1/);
  return journal;
}
const bindingFile = (s: { dir: string }) =>
  s.dir + "/member-message-binding.json";

test("binding-cache loss after full member-row eviction never reopens a consumed occurrence", async () => {
  const s = await setup();
  try {
    const intent = { occurrenceId: "e1", recipientId: ALICE, text: "Once" };
    await openMemberMessages(s.store).deliver(intent);
    await evictMemberRows(s);
    await rm(bindingFile(s));
    await assert.rejects(openMemberMessages(s.store).deliver(intent), {
      code: "OCCURRENCE_CONSUMED",
    });
    assert.equal(s.backend.posts().length, 1);
    assert.equal(s.backend.messages.length, 1);
    // The preserved namespace still admits a genuinely new occurrence.
    await openMemberMessages(s.store).deliver({
      ...intent,
      occurrenceId: "e2",
    });
    assert.equal(s.backend.posts().length, 2);
  } finally {
    await s.close();
  }
});

test("unprovable installation lineage fails closed instead of minting a new namespace", async () => {
  const s = await setup();
  try {
    const intent = { occurrenceId: "e1", recipientId: ALICE, text: "Once" };
    await openMemberMessages(s.store).deliver(intent);
    await evictMemberRows(s);
    // Older journal state: tombstones survive but no lineage metadata does.
    const rows = JSON.parse(
      await readFile(s.dir + "/operator-actions.json", "utf8"),
    );
    const at = rows.findIndex(
      (r: any) => r.role === "user" && r.text === "member-installation-v1",
    );
    if (at >= 0) rows.splice(at, 2);
    await writeFile(s.dir + "/operator-actions.json", JSON.stringify(rows));
    await rm(bindingFile(s));
    for (const occurrenceId of ["e1", "e-new"])
      await assert.rejects(
        openMemberMessages(s.store).deliver({ ...intent, occurrenceId }),
        { code: "BINDING_UNAVAILABLE" },
      );
    assert.equal(s.backend.posts().length, 1);
    assert.match(
      await readFile(s.dir + "/operator-actions.json", "utf8"),
      /member-delivery-retired-v1/,
    );
  } finally {
    await s.close();
  }
});

test("a binding cache whose installation contradicts the journal lineage fails closed", async () => {
  const s = await setup();
  try {
    const intent = { occurrenceId: "e1", recipientId: ALICE, text: "Once" };
    await openMemberMessages(s.store).deliver(intent);
    const cache = JSON.parse(await readFile(bindingFile(s), "utf8"));
    const other = "f".repeat(32);
    for (const row of cache)
      if (row.role === "assistant")
        row.text = row.text.replace(/[0-9a-f]{32}/, other);
    await writeFile(bindingFile(s), JSON.stringify(cache));
    await assert.rejects(
      openMemberMessages(s.store).deliver({ ...intent, occurrenceId: "e2" }),
      { code: "BINDING_UNAVAILABLE" },
    );
    assert.equal(s.backend.posts().length, 1);
  } finally {
    await s.close();
  }
});

test("a saturated ledger reports a fixed diagnostic without dispatching a new POST", async () => {
  const s = await setup();
  try {
    const diagnostics: any[] = [];
    const service = openMemberMessages(s.store, {
      onDiagnostic: (event) => diagnostics.push(event),
    });
    const bound = await service.binding();
    const actions = new Actions(s.store);
    let saturated = false;
    // Synthetic journal seed; no backend delivery is asserted for these rows.
    for (let i = 0; i < 1100; i++) {
      let admitted;
      try {
        admitted = actions.admitMemberDelivery(bound, {
          occurrence_id: "seed-" + i,
          recipient_id: ALICE,
          payload_sha256: "0".repeat(64),
        });
      } catch (error) {
        assert.match((error as Error).message, /MEMBER_DELIVERY_LEDGER_FULL/);
        saturated = true;
        break;
      }
      actions.settleMemberDelivery(admitted.record.idempotency_key, {
        status: "delivered",
        message_id: "synthetic-seed-" + i,
      });
    }
    assert.ok(saturated);
    const before = await readFile(s.dir + "/operator-actions.json", "utf8");
    await assert.rejects(
      service.deliver({
        occurrenceId: "new-event",
        recipientId: ALICE,
        text: "Must not send",
      }),
      { code: "MEMBER_DELIVERY_LEDGER_FULL" },
    );
    assert.equal(s.backend.posts().length, 0);
    assert.equal(
      await readFile(s.dir + "/operator-actions.json", "utf8"),
      before,
    );
    assert.equal(diagnostics.at(-1)?.ref, "MEMBER_DELIVERY_LEDGER_FULL");
  } finally {
    await s.close();
  }
});

test("pre-captured credentials bind legacy migration and recovery to their own scope, never the rotated store", async () => {
  for (const contextMissing of [false, true]) {
    const s = await setup({ "token-a": OWNER, "token-b": OTHER });
    try {
      s.backend.state.contextMissing = contextMissing;
      const [shared, own] = ["c".repeat(64), "d".repeat(64)];
      for (const key of [shared, own])
        await fetch(s.backend.origin + `/api/coach/member-messages/${ALICE}`, {
          method: "POST",
          headers: {
            authorization: "Bearer " + "token-a",
            "content-type": "application/json",
          },
          body: JSON.stringify({ text: "Same words", idempotency_key: key }),
        });
      const legacy = (key: string) => ({
        session_id: "legacy",
        tool_name: "katafit_rest_request",
        recipient_id: ALICE,
        idempotency_key: key,
        status: "unknown" as const,
      });
      new Actions(s.store).save(legacy(own));
      const captured = {
        // The supported option spelling with the root slash.
        origin: s.store.publicConfig().origin + "/",
        secrets: { ...s.store.secrets },
      };
      await s.store.save({ ...s.store.publicConfig(), token: "token-b" });
      new Actions(s.store).save(legacy(shared));
      await openMemberMessages(s.store, captured).reconcile();
      // Account A's view lists its own records; unresolved ones show anyway.
      await s.store.save({ ...s.store.publicConfig(), token: "token-a" });
      const records = new Actions(s.store).snapshot() as any[];
      const status = (key: string) =>
        records.find((r) => r.idempotency_key === key)?.status;
      assert.equal(status(own), "delivered", String(contextMissing));
      assert.equal(status(shared), "unknown", String(contextMissing));
      assert.ok(
        records.every((r) => r.idempotency_key !== shared || !r.legacy),
      );
      assert.equal(s.backend.posts().length, 2);
      assert.ok(
        s.backend.calls
          .filter((c) => c.method !== "POST")
          .every((c) => c.method === "GET" && c.auth === "Bearer token-a"),
      );
    } finally {
      await s.close();
    }
  }
});

test("equivalent backend origin spellings share one occurrence namespace; a different origin stays isolated", async () => {
  const s = await setup();
  const other = await memberBackend({ "token-a": OWNER });
  const original = globalThis.fetch;
  // "localhost" on the default port reaches the loopback fixture.
  globalThis.fetch = (input: any, init?: any) =>
    original(
      String(input).replace(/^http:\/\/localhost\//, s.backend.origin + "/"),
      init,
    );
  try {
    const intent = {
      occurrenceId: "event:stable:slot:0",
      recipientId: ALICE,
      text: "Synthetic same origin event",
    };
    const use = (origin: string) =>
      s.store.save({ ...s.store.publicConfig(), origin });
    await use("http://localhost:80");
    const first = await openMemberMessages(s.store).deliver(intent);
    for (const spelling of ["HTTP://LocalHost", "http://LOCALHOST:80"]) {
      await use(spelling);
      assert.deepEqual(
        await openMemberMessages(s.store).deliver(intent),
        first,
        spelling,
      );
    }
    // A supported pre-captured option may carry the trailing slash.
    assert.deepEqual(
      await openMemberMessages(s.store, {
        origin: "http://localhost/",
        secrets: { ...s.store.secrets },
      }).deliver(intent),
      first,
    );
    assert.equal(s.backend.posts().length, 1);
    assert.equal(s.backend.contexts().length, 1);
    // A genuinely different origin is its own namespace and backend.
    await use(other.origin);
    await openMemberMessages(s.store).deliver(intent);
    assert.equal(other.posts().length, 1);
    await use("http://localhost");
    assert.deepEqual(await openMemberMessages(s.store).deliver(intent), first);
    assert.equal(s.backend.posts().length, 1);
    assert.deepEqual(
      new Actions(s.store).memberDeliveries().map((r) => r.origin),
      ["http://localhost", other.origin],
    );
  } finally {
    globalThis.fetch = original;
    await other.close();
    await s.close();
  }
});

test("a failed journal directory sync closes admission before any POST", async () => {
  const s = await setup();
  const fsync = fs.fsyncSync;
  const failure = Object.assign(new Error("synthetic directory sync failure"), {
    code: "EIO",
  });
  try {
    const service = openMemberMessages(s.store);
    await service.deliver({
      occurrenceId: "dirsync:0",
      recipientId: ALICE,
      text: "Durable first",
    });
    const trace: string[] = [];
    s.backend.state.onPost = () => trace.push("POST");
    Object.assign(fs, {
      fsyncSync: (fd: number) => {
        const directory = fs.fstatSync(fd).isDirectory();
        trace.push(directory ? "fsync-directory" : "fsync-file");
        if (directory) throw failure;
        return fsync(fd);
      },
    });
    syncBuiltinESMExports();
    await assert.rejects(
      service.deliver({
        occurrenceId: "dirsync:1",
        recipientId: ALICE,
        text: "Never posted",
      }),
      unverified,
    );
    assert.deepEqual(trace, ["fsync-file", "fsync-directory"]);
    assert.equal(s.backend.posts().length, 1);
  } finally {
    Object.assign(fs, { fsyncSync: fsync });
    syncBuiltinESMExports();
    await s.close();
  }
});

test("journal and binding renames are directory-synced before the first POST", async () => {
  const s = await setup();
  const originals = { fsyncSync: fs.fsyncSync, renameSync: fs.renameSync };
  const trace: string[] = [];
  try {
    Object.assign(fs, {
      fsyncSync: (fd: number) => {
        if (fs.fstatSync(fd).isDirectory()) trace.push("fsync-directory");
        return originals.fsyncSync(fd);
      },
      renameSync: (from: any, to: any) => {
        trace.push("rename");
        return originals.renameSync(from, to);
      },
    });
    syncBuiltinESMExports();
    s.backend.state.onPost = () => trace.push("POST");
    await openMemberMessages(s.store).deliver({
      occurrenceId: "dirsync:order",
      recipientId: ALICE,
      text: "Ordered",
    });
    const beforePost = trace.slice(0, trace.indexOf("POST"));
    assert.ok(beforePost.length >= 6, trace.join());
    assert.equal(
      beforePost.join(),
      Array(beforePost.length / 2)
        .fill("rename,fsync-directory")
        .join(),
    );
  } finally {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
    await s.close();
  }
});

test("a stored origin that keeps a root slash still recovers its own legacy sends", async () => {
  const s = await setup();
  try {
    await s.store.save({
      ...s.store.publicConfig(),
      origin: s.backend.origin + "//",
    });
    assert.equal(s.store.publicConfig().origin, s.backend.origin + "/");
    const key = "e".repeat(64);
    await fetch(s.backend.origin + `/api/coach/member-messages/${ALICE}`, {
      method: "POST",
      headers: {
        authorization: "Bearer " + "token-a",
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "Old", idempotency_key: key }),
    });
    new Actions(s.store).save({
      session_id: "legacy",
      tool_name: "katafit_rest_request",
      recipient_id: ALICE,
      idempotency_key: key,
      status: "unknown",
    });
    await openMemberMessages(s.store).reconcile();
    const [record] = new Actions(s.store).snapshot() as any[];
    assert.equal(record.status, "delivered");
    assert.equal(record.legacy, true);
    assert.equal(s.backend.posts().length, 1);
  } finally {
    await s.close();
  }
});

test("lost cache and evicted rows cannot resend a pre-canonical opaque occurrence", async () => {
  const s = await setup();
  const intent = {
    occurrenceId: "historical-event",
    recipientId: ALICE,
    text: "Same",
  };
  try {
    const service = openMemberMessages(s.store);
    const bound = await service.binding();
    await service.deliver(intent);
    const file = s.dir + "/operator-actions.json";
    const source = JSON.parse(await readFile(file, "utf8"));
    const rows = [];
    for (let i = 0; i < source.length; i += 2) {
      if (JSON.parse(source[i + 1].text).format === "member-delivery-v2")
        continue;
      rows.push(source[i], source[i + 1]);
    }
    // Simulate the exact pre-canonical digest after older row retention.
    // The canonical fixture message above is real; this historical state is seeded.
    const old = createHash("sha256")
      .update(
        JSON.stringify([
          bound.installation_id,
          s.backend.origin.replace(/^http:/, "HTTP:"),
          bound.account_owner_id,
          intent.occurrenceId,
        ]),
      )
      .digest("hex")
      .slice(0, 32);
    rows.push(
      { role: "user", text: "member-delivery-retired-v1" },
      {
        role: "assistant",
        text: JSON.stringify({
          format: "member-delivery-retired-v1",
          occurrences: [old],
        }),
      },
    );
    await writeFile(file, JSON.stringify(rows), { mode: 0o600 });
    await rm(s.dir + "/member-message-binding.json");
    const before = await readFile(file, "utf8");
    const notices: any[] = [];
    await assert.rejects(
      openMemberMessages(s.store, {
        onDiagnostic: (event) => notices.push(event),
      }).deliver(intent),
      { code: "BINDING_UNAVAILABLE" },
    );
    assert.ok(
      notices.some(
        (event) => event.ref === "MEMBER_DELIVERY_NAMESPACE_UNVERIFIED",
      ),
    );
    assert.equal(s.backend.posts().length, 1);
    assert.equal(await readFile(file, "utf8"), before);
  } finally {
    await s.close();
  }
});
