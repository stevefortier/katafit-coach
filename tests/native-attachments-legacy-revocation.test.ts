import test from "node:test";
import assert from "node:assert/strict";
import { gatewayHarness as open } from "./helpers/attachments.js";
import { answer } from "./helpers/continuity.js";

for (const path of ["provider", "provider-after", "send"] as const) {
  test(`legacy retained authority denial on ${path} erases attachments immediately`, async () => {
    let denyAfterProvider = false;
    let closeAuthority = () => {};
    const g = await open({
      continuity: false,
      provider: () => {
        if (denyAfterProvider) closeAuthority();
        return answer("synthetic final answer");
      },
    });
    closeAuthority = () => {
      g.f.state.status = "closed";
    };
    try {
      const receipt = await g.receipt();
      await g.tool("send_to_operator", { image_receipt: receipt });
      assert.equal(g.gateway.attachments().length, 1);
      if (path === "provider-after") denyAfterProvider = true;
      else closeAuthority();
      await assert.rejects(
        path === "send"
          ? g.tool("send_to_operator", { image_receipt: receipt })
          : g.gateway.handle({
              kind: "provider",
              body: { model: "approved-custom-model", messages: [] },
            }),
      );
      assert.equal(g.terminated.length, 1);
      assert.deepEqual(g.gateway.attachments(), []);
      await assert.rejects(g.gateway.readAttachment(g.published[0].id));
    } finally {
      await g.close();
    }
  });
}
