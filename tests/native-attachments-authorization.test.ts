import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gatewayHarness as open } from "./helpers/attachments.js";
import { answer } from "./helpers/continuity.js";

const SEND = "send_to_operator";
const AUTHORIZE = "studio_operator_authorize_context";
const IMAGE = "studio_operator_read_dojo_checkin_image";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

test("acquired image bytes remain available without rechecking the changed source", async () => {
  const g = await open();
  try {
    await g.tool(SEND, { image_receipt: await g.receipt() });
    const item = g.published[0];
    const authorizations = g.f.named(AUTHORIZE).length;
    const images = g.f.named(IMAGE).length;
    g.f.state.revoked = true; // source changed after acquisition, not session revocation
    for (const _ of [1, 2]) {
      const delivered = await g.gateway.readAttachment(item.id);
      assert.equal(sha(delivered.bytes), item.sha256);
    }
    assert.equal(g.f.named(AUTHORIZE).length, authorizations);
    assert.equal(g.f.named(IMAGE).length, images);
    assert.deepEqual(g.terminated, []);
  } finally {
    await g.close();
  }
});

test("disclosure during a pending provider request is busy, then preserves acquired bytes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const g = await open({
    provider: async () => {
      await gate;
      return answer("done");
    },
  });
  try {
    g.files.set("a.txt", Buffer.from("synthetic"));
    await g.tool(SEND, { workspace_path: "a.txt" });
    const item = g.published[0];
    const pending = g.gateway.handle({
      kind: "provider",
      body: { model: "approved-custom-model", messages: [] },
    });
    await tick(100);
    await assert.rejects(
      g.gateway.readAttachment(item.id),
      /ATTACHMENT_AUTHORIZATION_BUSY/,
    );
    await assert.rejects(g.gateway.snapshot(), /ATTACHMENT_AUTHORIZATION_BUSY/);
    release();
    await pending;
    assert.equal(
      sha((await g.gateway.readAttachment(item.id)).bytes),
      item.sha256,
    );
    assert.deepEqual(g.terminated, []);
  } finally {
    release();
    await g.close();
  }
});

test("backend outage after acquisition does not invalidate already acquired workspace bytes", async () => {
  let outage = false;
  const g = await open({
    httpFailure: (name) => (outage && name === AUTHORIZE ? 503 : undefined),
  });
  try {
    g.files.set("a.txt", Buffer.from("synthetic"));
    await g.tool(SEND, { workspace_path: "a.txt" });
    const item = g.published[0];
    outage = true;
    assert.equal(
      sha((await g.gateway.readAttachment(item.id)).bytes),
      item.sha256,
    );
    assert.equal((await g.gateway.snapshot()).items.length, 1);
    assert.deepEqual(g.terminated, []);
  } finally {
    await g.close();
  }
});

test("expired command requires a new turn but leaves retained evidence recoverable", async () => {
  const g = await open({ commandTtlMs: 1200 });
  try {
    g.files.set("a.txt", Buffer.from("synthetic"));
    await g.tool(SEND, { workspace_path: "a.txt" });
    await tick(1300);
    await assert.rejects(
      g.gateway.readAttachment(g.published[0].id),
      /ATTACHMENT_TURN_REQUIRED/,
    );
    assert.deepEqual(g.terminated, []);
    assert.equal(g.gateway.attachments().length, 1);
  } finally {
    await g.close();
  }
});

test("legacy acquired image bytes also survive a later source denial without refetch", async () => {
  const g = await open({ continuity: false });
  try {
    await g.tool(SEND, { image_receipt: await g.receipt() });
    const item = g.published[0];
    const reads = g.f.named(IMAGE).length;
    g.f.state.status = "closed";
    assert.equal(
      sha((await g.gateway.readAttachment(item.id)).bytes),
      item.sha256,
    );
    assert.equal(g.f.named(IMAGE).length, reads);
    assert.deepEqual(g.terminated, []);
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

test("a workspace file containing the configured credential is neither stored nor published", async () => {
  const g = await open();
  try {
    g.files.set("a.txt", Buffer.from("token=" + g.f.store.secrets.token));
    assert.deepEqual(await g.tool(SEND, { workspace_path: "a.txt" }), {
      attachmentError: { code: "ATTACHMENT_REJECTED" },
    });
    assert.deepEqual(g.published, []);
    assert.deepEqual(g.gateway.attachments(), []);
  } finally {
    await g.close();
  }
});

test("metadata snapshots reuse acquired permission; empty snapshots expose no item", async () => {
  const g = await open();
  try {
    const empty = await g.gateway.snapshot();
    assert.deepEqual(empty.items, []);
    assert.equal(
      empty.context_expires_at,
      g.gateway.continuity()!.context_expires_at,
    );
    g.files.set("a.txt", Buffer.from("synthetic"));
    await g.tool(SEND, { workspace_path: "a.txt", caption: "Synthetic" });
    const before = g.f.named(AUTHORIZE).length;
    g.f.state.revoked = true;
    const listed = await g.gateway.snapshot();
    assert.deepEqual(
      listed.items.map((i: any) => i.caption),
      ["Synthetic"],
    );
    assert.equal(g.f.named(AUTHORIZE).length, before);
    assert.deepEqual(g.terminated, []);
  } finally {
    await g.close();
  }
});
