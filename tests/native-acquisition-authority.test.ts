import test from "node:test";
import assert from "node:assert/strict";
import { continuityFixture, GENERIC } from "./helpers/continuity.js";
import { openNativeGateway } from "./helpers/legacy-gateway.js";
import { gatewayHarness } from "./helpers/attachments.js";

const provider = (text: string) => ({
  kind: "provider",
  body: {
    model: "approved-custom-model",
    messages: [{ role: "user", content: text }],
  },
});

test("fetched context stays usable inside Coach without backend source reauthorization", async () => {
  const f = await continuityFixture();
  const g = await openNativeGateway(f.store);
  try {
    await g.handle({ kind: "tool", name: GENERIC, args: { topic: "private" } });
    await g.handle(provider("first"));
    g.noteHumanInput("second\r");
    await g.handle(provider("second"));
    assert.equal(f.providerCalls(), 2);
    assert.equal(f.named("studio_operator_authorize_context").length, 0);
    assert.equal(f.named(GENERIC).length, 1, "never replay an old read");
  } finally {
    await g.close();
    await f.close();
  }
});

test("an acquisition denial remains a denial even with retained context", async () => {
  let denied = false;
  const f = await continuityFixture({
    response(name, _args, value) {
      if (name === GENERIC && denied)
        return {
          isError: true,
          content: [{ type: "text", text: "OPERATOR_NOT_AUTHORIZED" }],
        };
      return value;
    },
  });
  const g = await openNativeGateway(f.store);
  try {
    await g.handle({ kind: "tool", name: GENERIC, args: { topic: "first" } });
    denied = true;
    await assert.rejects(
      g.handle({ kind: "tool", name: GENERIC, args: { topic: "new" } }),
    );
    await g.handle(provider("use previously acquired context"));
    assert.equal(f.providerCalls(), 1);
    assert.equal(f.named("studio_operator_authorize_context").length, 0);
  } finally {
    await g.close();
    await f.close();
  }
});

test("already-fetched attachment bytes and reconnect metadata remain inside authenticated Coach", async () => {
  const h = await gatewayHarness();
  try {
    await h.tool("send_to_operator", { image_receipt: await h.receipt() });
    const item = h.published[0];
    h.f.state.revoked = true; // Original source changed after acquisition.
    const first = await h.gateway.readAttachment(item.id);
    const second = await h.gateway.readAttachment(item.id);
    assert.deepEqual(first.bytes, second.bytes);
    assert.equal((await h.gateway.snapshot()).items[0].id, item.id);
    assert.equal(h.f.named("studio_operator_authorize_context").length, 0);
    await assert.rejects(
      h.gateway.readAttachment("foreign-runtime-id"),
      /NOT_FOUND/,
    );
  } finally {
    await h.close();
  }
});
