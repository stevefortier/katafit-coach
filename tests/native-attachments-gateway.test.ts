import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  continuityFixture,
  CHECKINS,
  IMAGE,
  answer,
} from "./helpers/continuity.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";
import { AttachmentFailure } from "../src/sandbox/attachments.js";
import { gatewayHarness as open } from "./helpers/attachments.js";

const SEND = "send_to_operator";
const ROSTER = "studio_operator_list_members";

test("catalog advertises send_to_operator only with a host attachment owner; image reads mint opaque receipts", async () => {
  const plain = await continuityFixture({ images: true });
  try {
    const gateway = await openNativeGateway(plain.store);
    const catalog = await gateway.handle({ kind: "catalog" });
    assert.equal(
      catalog.tools.some((t: any) => t.name === SEND),
      false,
    );
    await gateway.handle({ kind: "tool", name: CHECKINS, args: {} });
    const image = await gateway.handle({
      kind: "tool",
      name: IMAGE,
      args: { member_ref: "fixture-member", media_ref: "media-1" },
    });
    assert.equal(
      Object.hasOwn(JSON.parse(image.content[0].text), "image_receipt"),
      false,
    );
    await gateway.close();
  } finally {
    await plain.close();
  }
  const g = await open();
  try {
    const catalog = await g.gateway.handle({ kind: "catalog" });
    const tool = catalog.tools.find((t: any) => t.name === SEND);
    assert.ok(tool);
    assert.equal(tool.parameters.additionalProperties, false);
    const id = await g.receipt();
    assert.match(id, /^ir_[a-f0-9]{32}$/);
    assert.equal(
      id.includes(g.f.state.session_id),
      false,
      "receipt is not a backend identifier",
    );
  } finally {
    await g.close();
  }
});

test("image receipt is accepted to the panel from retained bytes with a truthful receipt and no refetch", async () => {
  const g = await open();
  try {
    const id = await g.receipt();
    const reads = g.f.named(IMAGE).length;
    const authorizations = g.f.named(
      "studio_operator_authorize_context",
    ).length;
    const result = await g.tool(SEND, {
      image_receipt: id,
      caption: "Synthetic check-in\u202E photo",
    });
    const receipt = g.text(result);
    assert.equal(receipt.status, "accepted_to_operator_panel");
    assert.equal(receipt.operator_viewed, "not_confirmed");
    assert.equal(receipt.panel_connected, true);
    assert.equal(receipt.preview, "image");
    assert.equal(receipt.mime_type, "image/png");
    assert.match(receipt.attachment_id, /^at_[a-f0-9]{32}$/);
    assert.match(receipt.note, /does not confirm/);
    assert.deepEqual(receipt.remaining, {
      attachments: 15,
      bytes: 32 * 1024 * 1024 - receipt.byte_count,
    });
    assert.equal(g.f.named(IMAGE).length, reads, "no new backend image read");
    assert.equal(
      g.f.named("studio_operator_authorize_context").length,
      authorizations,
      "sending acquired image data does not reacquire the source",
    );
    assert.equal(g.published.length, 1);
    const item = g.published[0];
    assert.equal(item.source, "image_receipt");
    assert.equal(item.caption, "Synthetic check-in photo");
    assert.match(item.filename, /^checkin-[a-f0-9]{12}\.png$/);
    const served = await g.gateway.readAttachment(item.id);
    assert.equal(
      createHash("sha256").update(served.bytes).digest("hex"),
      item.sha256,
    );
    assert.deepEqual(g.gateway.attachments(), [item]);
    // Duplicate send is idempotent and consumes no further budget.
    const again = g.text(
      await g.tool(SEND, {
        image_receipt: id,
        caption: "Synthetic check-in\u202E photo",
      }),
    );
    assert.equal(again.attachment_id, receipt.attachment_id);
    assert.equal(again.duplicate, true);
    assert.equal(g.published.length, 1);
    assert.equal(
      JSON.stringify(result).includes(g.f.store.secrets.token!),
      false,
    );
  } finally {
    await g.close();
  }
});

test("arguments are refused before any read: forged/foreign receipts, URLs, host paths, traversal, reserved keys", async () => {
  const g = await open();
  const other = await open();
  try {
    const foreign = await other.receipt();
    await g.tool(CHECKINS, {});
    const cases: [any, string][] = [
      [{}, "ATTACHMENT_ARGUMENTS_REJECTED"],
      [
        { image_receipt: foreign, workspace_path: "a.txt" },
        "ATTACHMENT_ARGUMENTS_REJECTED",
      ],
      [
        { url: "https://example.invalid/a.png" },
        "ATTACHMENT_ARGUMENTS_REJECTED",
      ],
      [
        { image_receipt: foreign, session_id: g.f.state.session_id },
        "ATTACHMENT_ARGUMENTS_REJECTED",
      ],
      [
        { workspace_path: "a.txt", turn_generation: 0 },
        "ATTACHMENT_ARGUMENTS_REJECTED",
      ],
      [{ image_receipt: "media-1" }, "ATTACHMENT_ARGUMENTS_REJECTED"],
      [{ image_receipt: foreign }, "ATTACHMENT_RECEIPT_UNKNOWN"],
      [
        { image_receipt: "ir_" + randomBytes(16).toString("hex") },
        "ATTACHMENT_RECEIPT_UNKNOWN",
      ],
      [{ workspace_path: "../escape" }, "ATTACHMENT_PATH_REJECTED"],
      [{ workspace_path: "/etc/hostname" }, "ATTACHMENT_PATH_REJECTED"],
      [
        { workspace_path: "/tmp/native-config.json" },
        "ATTACHMENT_PATH_REJECTED",
      ],
      [
        { workspace_path: "a.txt", filename: 7 },
        "ATTACHMENT_ARGUMENTS_REJECTED",
      ],
      [
        { workspace_path: "a.txt", caption: "x".repeat(501) },
        "ATTACHMENT_ARGUMENTS_REJECTED",
      ],
    ];
    for (const [args, code] of cases)
      assert.deepEqual(
        await g.tool(SEND, args),
        { attachmentError: { code } },
        JSON.stringify(args),
      );
    assert.deepEqual(g.reads, [], "no workspace read was attempted");
    assert.deepEqual(g.published, []);
    assert.deepEqual(g.terminated, []);
  } finally {
    await g.close();
    await other.close();
  }
});

test("workspace files: safe classification, allowlisted reader failures and credential screening", async () => {
  const g = await open();
  try {
    g.files.set("out/summary.csv", Buffer.from("member,score\nA,1\n"));
    g.files.set(
      "chart.svg",
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>',
      ),
    );
    g.files.set("leak.txt", Buffer.from("token=" + g.f.store.secrets.token));
    g.files.set("private.txt", new Error("/host/private/path EACCES"));
    const csv = g.text(
      await g.tool(SEND, {
        workspace_path: "/workspace/out/summary.csv",
        filename: "../Summary<1>.csv",
      }),
    );
    assert.equal(csv.status, "accepted_to_operator_panel");
    assert.equal(csv.preview, "download");
    assert.equal(csv.mime_type, "application/octet-stream");
    assert.equal(csv.filename, "Summary_1_.csv");
    const svg = g.text(await g.tool(SEND, { workspace_path: "chart.svg" }));
    assert.equal(svg.preview, "download");
    assert.equal(svg.filename, "chart.svg");
    assert.deepEqual(await g.tool(SEND, { workspace_path: "leak.txt" }), {
      attachmentError: { code: "ATTACHMENT_REJECTED" },
    });
    assert.deepEqual(
      await g.tool(SEND, {
        workspace_path: "out/summary.csv",
        caption: "key " + g.f.store.secrets.apiKey,
      }),
      { attachmentError: { code: "ATTACHMENT_REJECTED" } },
    );
    assert.deepEqual(await g.tool(SEND, { workspace_path: "missing.txt" }), {
      attachmentError: { code: "ATTACHMENT_FILE_NOT_FOUND" },
    });
    const hidden = await g.tool(SEND, { workspace_path: "private.txt" });
    assert.deepEqual(hidden, {
      attachmentError: { code: "ATTACHMENT_FILE_UNAVAILABLE" },
    });
    assert.equal(g.published.length, 2);
    assert.deepEqual(
      g.published.map((p) => p.source),
      ["workspace", "workspace"],
    );
  } finally {
    await g.close();
  }
});

test("parallel send is not dispatched while another native request is pending", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const g = await open({
    provider: async () => {
      await gate;
      return answer("done");
    },
  });
  try {
    g.files.set("a.txt", Buffer.from("a"));
    const pending = g.gateway.handle({
      kind: "provider",
      body: { model: "approved-custom-model", messages: [] },
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(await g.tool(SEND, { workspace_path: "a.txt" }), {
      attachmentError: { code: "ATTACHMENT_BUSY" },
    });
    assert.deepEqual(g.reads, []);
    release();
    await pending;
  } finally {
    release();
    await g.close();
  }
});

test("serving acquired evidence is local; busy requests remain retryable", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const g = await open({
    provider: async () => {
      await gate;
      return answer("done");
    },
  });
  try {
    const id = await g.receipt();
    await g.tool(SEND, { image_receipt: id });
    const item = g.published[0];
    const before = g.f.named("studio_operator_authorize_context").length;
    await g.gateway.readAttachment(item.id);
    assert.equal(
      g.f.named("studio_operator_authorize_context").length,
      before,
      "delivery does not reauthorize the original source",
    );
    const roster = await g.tool(ROSTER, {});
    assert.ok(roster);
    assert.equal(g.f.named(ROSTER).length, 1);
    // A pending Pi request never races host delivery: retryable busy.
    const slow = g.gateway.handle({
      kind: "provider",
      body: { model: "approved-custom-model", messages: [] },
    });
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(
      g.gateway.readAttachment(item.id),
      /ATTACHMENT_AUTHORIZATION_BUSY/,
    );
    release();
    await slow;
    assert.deepEqual(g.terminated, []);
    // A source change is not retroactive authority over acquired bytes.
    g.f.state.revoked = true;
    const served = await g.gateway.readAttachment(item.id);
    assert.equal(
      createHash("sha256").update(served.bytes).digest("hex"),
      item.sha256,
    );
    assert.deepEqual(g.terminated, []);
  } finally {
    release();
    await g.close();
  }
});

test("configuration change and close revoke every attachment immediately", async () => {
  const g = await open();
  try {
    g.files.set("a.txt", Buffer.from("a"));
    await g.tool(SEND, { workspace_path: "a.txt" });
    const item = g.published[0];
    await g.gateway.readAttachment(item.id);
    await g.f.store.save({
      ...g.f.store.publicConfig(),
      persona: { ...g.f.store.publicConfig().persona, name: "Changed Coach" },
    });
    await assert.rejects(g.gateway.readAttachment(item.id), /REVOKED/);
    await assert.rejects(g.tool(SEND, { workspace_path: "a.txt" }));
  } finally {
    await g.close();
  }
  const h = await open();
  try {
    h.files.set("a.txt", Buffer.from("a"));
    await h.tool(SEND, { workspace_path: "a.txt" });
    await h.gateway.close();
    assert.deepEqual(h.gateway.attachments(), []);
    await assert.rejects(h.gateway.readAttachment(h.published[0].id));
  } finally {
    await h.close();
  }
});

test("legacy acquired image reads do not refetch a changed source", async () => {
  const g = await open({ continuity: false });
  try {
    const id = await g.receipt();
    await g.tool(SEND, { image_receipt: id });
    const reads = g.f.named(IMAGE).length;
    await g.gateway.readAttachment(g.published[0].id);
    assert.equal(g.f.named(IMAGE).length, reads);
    g.f.state.status = "closed";
    assert.equal(
      (await g.gateway.readAttachment(g.published[0].id)).item.id,
      g.published[0].id,
    );
  } finally {
    await g.close();
  }
});
