import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "../src/katafit/client.js";
import {
  openOperatorTools,
  modelOperatorTools,
} from "../src/katafit/operatorTools.js";
import { fixture } from "./operator-checkins.test.js";

test("text-only operator can deliver a card without exposing pixels to the model", async () => {
  const f = await fixture();
  const captured: string[] = [];
  try {
    const s = await openOperatorTools(
      new Client(f.origin, "synthetic-token", AbortSignal.timeout(5000)),
      undefined,
      {
        secrets: ["synthetic-token"],
        onAction: () => {},
        onImage: (image) => captured.push(image.display_name),
      },
    );
    const tools = modelOperatorTools(s.tools, false);
    assert.deepEqual(
      tools.map((t) => t.name),
      [
        "studio_operator_list_members",
        "studio_operator_read_member_coach_feed",
        "studio_operator_send_message",
        "studio_operator_list_dojo_checkins",
        "studio_operator_read_dojo_checkin_image",
      ],
    );
    await tools[3].execute("roster", { limit: 10 });
    const result = await tools[4].execute("image", {
      member_ref: "member-photo",
      media_ref: "media-photo",
    });
    assert.deepEqual(captured, ["Alex"]);
    assert.deepEqual(
      result.content.map((part) => part.type),
      ["text"],
    );
    assert.match((result.content[0] as any).text, /not visually assessed/);
    assert.doesNotMatch(
      JSON.stringify(result),
      new RegExp(f.bytes.toString("base64")),
    );
    await s.dispose();
  } finally {
    await f.close();
  }
});
