import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeContext } from "../src/katafit/context.js";
test("original message occurs once with stable request anchor and authorized peer context intact", () => {
  const context = {
    request: {
      id: "anchor",
      message: "Unique original question",
      timeout_at: "original-deadline",
    },
    conversation: [
      { role: "assistant", text: "Prior feedback" },
      { role: "user", text: "Unique original question" },
    ],
    authorized_members: [{ owner: "peer", shared: true }],
  };
  const text = serializeContext(context);
  assert.equal(text.split("Unique original question").length - 1, 1);
  assert.equal(JSON.parse(text).request.id, "anchor");
  assert.equal(JSON.parse(text).request.timeout_at, "original-deadline");
  assert.deepEqual(
    JSON.parse(text).authorized_members,
    context.authorized_members,
  );
  assert.equal(context.request.message, "Unique original question");
});
test("message remains available when canonical conversation does not contain current turn", () => {
  const c = {
    request: { id: "anchor", message: "Original" },
    conversation: [{ role: "assistant", text: "Prior" }],
  };
  assert.equal(JSON.parse(serializeContext(c)).request.message, "Original");
});
