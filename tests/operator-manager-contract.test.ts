import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, compileOperator } from "../src/config/store.js";
import { Client } from "../src/katafit/client.js";
import { openOperatorTools } from "../src/katafit/operatorTools.js";
import { fixture } from "./operator-checkins.test.js";

test("manager persona retains identity and delegates capability permissions to backend", () => {
  const store = new Store("/unused");
  const config = store.publicConfig();
  config.persona.name = "Coach Granite";
  config.persona.principles =
    "Demand disciplined training; refuse excuses from trainees.";
  const prompt = compileOperator(config);
  assert.match(prompt, /Coach Granite/);
  assert.match(prompt, /same.*identity/i);
  assert.match(prompt, /operator is your manager and boss, not a trainee/i);
  assert.match(
    prompt,
    /manager relationship takes precedence over trainee-facing discipline/i,
  );
  assert.match(prompt, /backend.*capabilit/i);
  assert.doesNotMatch(prompt, /do not otherwise mutate records/);
});

test("image acquisition is backend-authorized but retained pixels are not refetched", async () => {
  const f = await fixture();
  try {
    const session = await openOperatorTools(
      new Client(f.origin, "synthetic-token", AbortSignal.timeout(5000)),
      undefined,
      { secrets: ["synthetic-token"], onAction: () => {} },
    );
    try {
      await session.tools
        .find((t) => t.name === "studio_operator_list_dojo_checkins")!
        .execute("list", {});
      await session.tools
        .find((t) => t.name === "studio_operator_read_dojo_checkin_image")!
        .execute("image", {
          member_ref: "member-photo",
          media_ref: "media-photo",
        });
      f.revokeSharing();
      await session.authorize();
      assert.equal(
        f.calls.filter(
          (name) => name === "studio_operator_read_dojo_checkin_image",
        ).length,
        1,
      );
      await assert.rejects(
        session.tools
          .find((t) => t.name === "studio_operator_read_dojo_checkin_image")!
          .execute("new-image", {
            member_ref: "member-photo",
            media_ref: "media-photo",
          }),
        /MCP_TOOL_FAILED/,
      );
    } finally {
      await session.dispose();
    }
  } finally {
    await f.close();
  }
});
