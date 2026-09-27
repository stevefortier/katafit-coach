import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gatewayHarness as open } from "./helpers/attachments.js";

// Shipped defaults only: no freshness/cache knobs exist. Every explicit
// disclosure of retained evidence (bytes or metadata snapshot) must be backed
// by a backend authorization that started after that disclosure was admitted.
const SEND = "send_to_operator";
const AUTHORIZE = "studio_operator_authorize_context";
const IMAGE = "studio_operator_read_dojo_checkin_image";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

test("each byte delivery is separately authorized; revocation after a prior allow is never served", async () => {
  const g = await open();
  try {
    await g.tool(SEND, { image_receipt: await g.receipt() });
    const id = g.published[0].id;
    const before = g.f.named(AUTHORIZE).length;
    await g.gateway.readAttachment(id);
    await g.gateway.readAttachment(id);
    assert.equal(g.f.named(AUTHORIZE).length, before + 2);
    // Immediately after a successful allow (no time elapses) the backend
    // revokes: the next delivery must ask and be refused, then tear down.
    g.f.state.revoked = true;
    await assert.rejects(g.gateway.readAttachment(id), /REVOKED/);
    assert.equal(g.f.named(AUTHORIZE).length, before + 3);
    assert.equal(g.terminated.length, 1);
    assert.deepEqual(g.gateway.attachments(), []);
    await assert.rejects(g.gateway.readAttachment(id));
  } finally {
    await g.close();
  }
});

test("an authorization in flight at admission never serves; later admissions coalesce onto one fresh authorization", async () => {
  let hold: Promise<void> | undefined;
  const g = await open({ authorizeGate: () => hold });
  try {
    g.files.set("a.txt", Buffer.from("synthetic"));
    await g.tool(SEND, { workspace_path: "a.txt" });
    const id = g.published[0].id;
    const before = g.f.named(AUTHORIZE).length;
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    const first = g.gateway.readAttachment(id);
    await tick();
    assert.equal(g.f.named(AUTHORIZE).length, before + 1);
    const order: string[] = [];
    const later = [1, 2].map((n) =>
      g.gateway.readAttachment(id).then((v) => {
        order.push(`later${n}@${g.f.named(AUTHORIZE).length - before}`);
        return v;
      }),
    );
    await tick();
    hold = undefined;
    release();
    await first;
    await Promise.all(later);
    assert.equal(g.f.named(AUTHORIZE).length, before + 2);
    assert.deepEqual(order, ["later1@2", "later2@2"]);
  } finally {
    await g.close();
  }
});

test("busy is retryable and performs no authorization, image read or budget use", async () => {
  let hold: Promise<void> | undefined;
  const g = await open({ authorizeGate: () => hold });
  try {
    await g.tool(SEND, { image_receipt: await g.receipt() });
    const id = g.published[0].id;
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    const slow = g.gateway.handle({
      kind: "provider",
      body: { model: "approved-custom-model", messages: [] },
    });
    await tick();
    const authorizations = g.f.named(AUTHORIZE).length;
    const images = g.f.named(IMAGE).length;
    await assert.rejects(
      g.gateway.readAttachment(id),
      /ATTACHMENT_AUTHORIZATION_BUSY/,
    );
    await assert.rejects(g.gateway.snapshot(), /ATTACHMENT_AUTHORIZATION_BUSY/);
    assert.equal(g.f.named(AUTHORIZE).length, authorizations);
    assert.equal(g.f.named(IMAGE).length, images);
    hold = undefined;
    release();
    await slow;
    const settled = g.f.named(AUTHORIZE).length;
    const served = await g.gateway.readAttachment(id);
    assert.equal(sha(served.bytes), g.published[0].sha256);
    assert.equal(g.f.named(AUTHORIZE).length, settled + 1);
    assert.equal(g.f.named(IMAGE).length, images);
    assert.deepEqual(g.terminated, []);
  } finally {
    hold = undefined;
    await g.close();
  }
});

test("failed authorizations never leave an allow; transient and turn-required are recoverable, not revocation", async () => {
  let flaky = false;
  const g = await open({
    httpFailure: (name) => (flaky && name === AUTHORIZE ? 503 : undefined),
  });
  try {
    g.files.set("a.txt", Buffer.from("synthetic"));
    await g.tool(SEND, { workspace_path: "a.txt" });
    const id = g.published[0].id;
    flaky = true;
    await assert.rejects(
      g.gateway.readAttachment(id),
      /ATTACHMENT_AUTHORIZATION_UNAVAILABLE/,
    );
    await assert.rejects(
      g.gateway.readAttachment(id),
      /ATTACHMENT_AUTHORIZATION_UNAVAILABLE/,
    );
    assert.deepEqual(g.terminated, []);
    assert.equal(g.gateway.attachments().length, 1);
    flaky = false;
    await g.gateway.readAttachment(id);
  } finally {
    await g.close();
  }
  const t = await open({ commandTtlMs: 1200 });
  try {
    t.files.set("a.txt", Buffer.from("synthetic"));
    await t.tool(SEND, { workspace_path: "a.txt" });
    await tick(1300);
    const before = t.f.named(AUTHORIZE).length;
    await assert.rejects(
      t.gateway.readAttachment(t.published[0].id),
      /ATTACHMENT_TURN_REQUIRED/,
    );
    assert.equal(t.f.named(AUTHORIZE).length, before);
    assert.deepEqual(t.terminated, []);
    assert.equal(t.gateway.attachments().length, 1);
  } finally {
    await t.close();
  }
});

test("legacy sessions reauthorize per delivery; definite denial fails closed, outages are retryable", async () => {
  let flaky = false;
  const g = await open({
    continuity: false,
    httpFailure: (name) => (flaky && name === IMAGE ? 503 : undefined),
  });
  try {
    await g.tool(SEND, { image_receipt: await g.receipt() });
    const id = g.published[0].id;
    const reads = g.f.named(IMAGE).length;
    await g.gateway.readAttachment(id);
    await g.gateway.readAttachment(id);
    assert.equal(g.f.named(IMAGE).length, reads + 2, "recheck per delivery");
    flaky = true;
    await assert.rejects(
      g.gateway.readAttachment(id),
      /ATTACHMENT_AUTHORIZATION_UNAVAILABLE/,
    );
    assert.deepEqual(g.terminated, []);
    flaky = false;
    g.f.state.status = "closed";
    await assert.rejects(g.gateway.readAttachment(id), /REVOKED/);
    assert.equal(g.terminated.length, 1);
    assert.deepEqual(g.gateway.attachments(), []);
  } finally {
    await g.close();
  }
});

test("delivered bytes are a private copy that concurrent teardown cannot zero", async () => {
  const g = await open();
  try {
    await g.tool(SEND, { image_receipt: await g.receipt() });
    const item = g.published[0];
    const served = await g.gateway.readAttachment(item.id);
    await g.gateway.close();
    assert.equal(sha(served.bytes), item.sha256);
  } finally {
    await g.close();
  }
});

test("a receipt failing its final secret screen is neither stored nor published", async () => {
  const g = await open({}, {}, async (f) => {
    await f.store.save({
      ...f.store.publicConfig(),
      apiKey: "operator_viewed",
    });
  });
  try {
    g.files.set("a.txt", Buffer.from("synthetic"));
    const result = await g.tool(SEND, { workspace_path: "a.txt" });
    assert.deepEqual(result, {
      attachmentError: { code: "ATTACHMENT_REJECTED" },
    });
    assert.deepEqual(g.published, []);
    assert.deepEqual(g.gateway.attachments(), []);
  } finally {
    await g.close();
  }
});

test("metadata snapshots of retained items are freshly authorized; empty snapshots only carry the expiry", async () => {
  const g = await open();
  try {
    const before = g.f.named(AUTHORIZE).length;
    const empty = await g.gateway.snapshot();
    assert.deepEqual(empty.items, []);
    assert.equal(
      empty.context_expires_at,
      g.gateway.continuity()!.context_expires_at,
    );
    assert.equal(g.f.named(AUTHORIZE).length, before);
    g.files.set("a.txt", Buffer.from("synthetic"));
    await g.tool(SEND, { workspace_path: "a.txt", caption: "Synthetic" });
    const after = g.f.named(AUTHORIZE).length;
    const listed = await g.gateway.snapshot();
    assert.equal(g.f.named(AUTHORIZE).length, after + 1);
    assert.deepEqual(
      listed.items.map((i: any) => i.caption),
      ["Synthetic"],
    );
    g.f.state.revoked = true;
    await assert.rejects(g.gateway.snapshot(), /REVOKED/);
    assert.equal(g.terminated.length, 1);
  } finally {
    await g.close();
  }
});
