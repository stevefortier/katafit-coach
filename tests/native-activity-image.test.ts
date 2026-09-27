import test from "node:test";
import assert from "node:assert/strict";
import { gatewayHarness } from "./helpers/attachments.js";
import { ACTIVITY_IMAGE, ACTIVITIES, DETAIL } from "./helpers/continuity.js";

const pair = {
  member_ref: "fixture-member",
  activity_ref: "activity-1",
  media_ref: "activity-media-1",
};
const list = (g: Awaited<ReturnType<typeof gatewayHarness>>) =>
  g.tool(ACTIVITIES, { member_ref: pair.member_ref });
const detail = (g: Awaited<ReturnType<typeof gatewayHarness>>) =>
  g.tool(DETAIL, {
    member_ref: pair.member_ref,
    activity_ref: pair.activity_ref,
    section: "media_files",
  });

test("unnegotiated activity image tool is absent and cannot dispatch", async () => {
  const g = await gatewayHarness();
  try {
    const catalog = await g.gateway.handle({ kind: "catalog" });
    assert.equal(
      catalog.tools.some((tool: any) => tool.name === ACTIVITY_IMAGE),
      false,
    );
    await assert.rejects(
      g.tool(ACTIVITY_IMAGE, pair),
      (error: any) => error.code === "NATIVE_REQUEST_REJECTED",
    );
    assert.equal(
      g.f.calls.some((c) => c.name === ACTIVITY_IMAGE),
      false,
    );
  } finally {
    await g.close();
  }
});

test("negotiated completed activity image requires exact list and media detail; receipt sends original bytes to panel", async () => {
  const g = await gatewayHarness({ activityImages: true });
  try {
    const catalog = await g.gateway.handle({ kind: "catalog" });
    const tool = catalog.tools.find((t: any) => t.name === ACTIVITY_IMAGE);
    assert.ok(tool);
    for (const key of ["session_id", "turn_generation", "idempotency_key"])
      assert.equal(tool.parameters.properties[key], undefined);
    const count = () =>
      g.f.calls.filter((c) => c.name === ACTIVITY_IMAGE).length;
    assert.equal(
      (await g.tool(ACTIVITY_IMAGE, pair)).imageReadError.code,
      "ACTIVITY_PROOF_REQUIRED",
    );
    assert.equal(count(), 0);
    await list(g);
    assert.equal(
      (await g.tool(ACTIVITY_IMAGE, pair)).imageReadError.code,
      "ACTIVITY_PROOF_REQUIRED",
    );
    assert.equal(count(), 0);
    await detail(g);
    for (const args of [
      { ...pair, media_ref: "media-1" },
      { ...pair, activity_ref: "other" },
      { ...pair, session_id: g.f.state.session_id },
    ]) {
      assert.ok((await g.tool(ACTIVITY_IMAGE, args)).imageReadError);
    }
    assert.equal(count(), 0);
    const result = await g.tool(ACTIVITY_IMAGE, pair);
    const receipt = g.text(result).image_receipt;
    assert.match(receipt, /^ir_[0-9a-f]{32}$/);
    assert.equal(result.content[1].type, "image");
    assert.equal(count(), 1);
    assert.deepEqual(g.f.calls.find((c) => c.name === ACTIVITY_IMAGE)?.args, {
      ...pair,
      session_id: g.f.state.session_id,
      turn_generation: 0,
    });
    const sent = g.text(
      await g.tool("send_to_operator", { image_receipt: receipt }),
    );
    assert.equal(sent.status, "accepted_to_operator_panel");
    assert.equal(g.published.length, 1);
    const item = await g.gateway.readAttachment(sent.attachment_id);
    assert.equal(item.bytes.equals(g.f.activityBytes!), true);
    assert.equal(item.item.source, "image_receipt");
    assert.ok(
      g.f.calls.filter((c) => c.name === "studio_operator_authorize_context")
        .length >= 2,
    );
  } finally {
    await g.close();
  }
});

test("activity image requires the listing to precede the matching media detail", async () => {
  const g = await gatewayHarness({ activityImages: true });
  try {
    // A previously held activity_ref may permit a detail read before this
    // context lists the activity. That reverse order is not a host proof.
    await detail(g);
    await list(g);
    const before = g.f.calls.filter(
      (call) => call.name === ACTIVITY_IMAGE,
    ).length;
    assert.equal(
      (await g.tool(ACTIVITY_IMAGE, pair)).imageReadError?.code,
      "ACTIVITY_PROOF_REQUIRED",
    );
    assert.equal(
      g.f.calls.filter((call) => call.name === ACTIVITY_IMAGE).length,
      before,
    );
    assert.equal(g.published.length, 0);

    await detail(g);
    assert.match(
      g.text(await g.tool(ACTIVITY_IMAGE, pair)).image_receipt,
      /^ir_[0-9a-f]{32}$/,
    );
  } finally {
    await g.close();
  }
});

test("generic image rejects forged or changed multipart and does not mint receipt", async () => {
  for (const corruption of ["hash", "mime", "bytes", "dimensions", "size"]) {
    const g = await gatewayHarness({
      activityImages: true,
      activityCorruption: corruption,
    });
    try {
      await list(g);
      await detail(g);
      const result = await g.tool(ACTIVITY_IMAGE, pair);
      assert.deepEqual(
        result.imageReadError?.code,
        "IMAGE_RESULT_REJECTED",
        corruption,
      );
      assert.equal(
        (
          await g.tool("send_to_operator", {
            image_receipt: "activity-media-1",
          })
        ).attachmentError.code,
        "ATTACHMENT_ARGUMENTS_REJECTED",
      );
      assert.equal(g.published.length, 0);
    } finally {
      await g.close();
    }
  }
});

test("ordinary backend image denial is read-only, while definite revocation tears down", async () => {
  const denied = await gatewayHarness({
    activityImages: true,
    activityDeny: true,
  });
  try {
    await list(denied);
    await detail(denied);
    assert.equal(
      (await denied.tool(ACTIVITY_IMAGE, pair)).imageReadError.code,
      "IMAGE_BACKEND_FAILED",
    );
    assert.equal(denied.terminated.length, 0);
    assert.equal(denied.published.length, 0);
    assert.ok((await list(denied)).content);
  } finally {
    await denied.close();
  }
  const revoked = await gatewayHarness({ activityImages: true });
  try {
    await list(revoked);
    await detail(revoked);
    revoked.f.state.revoked = true;
    await assert.rejects(revoked.tool(ACTIVITY_IMAGE, pair));
    assert.equal(revoked.published.length, 0);
    assert.ok(revoked.terminated.length > 0);
  } finally {
    await revoked.close();
  }
});

test("revoked source after proof prevents generic pixels and attachment disclosure", async () => {
  const g = await gatewayHarness({ activityImages: true });
  try {
    await list(g);
    await detail(g);
    const receipt = g.text(await g.tool(ACTIVITY_IMAGE, pair)).image_receipt;
    g.f.state.revoked = true;
    await assert.rejects(
      g.tool("send_to_operator", { image_receipt: receipt }),
    );
    assert.equal(g.published.length, 0);
    assert.deepEqual(g.gateway.attachments(), []);
  } finally {
    await g.close();
  }
});
