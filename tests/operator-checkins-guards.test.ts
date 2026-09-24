import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "../src/katafit/client.js";
import {
  openOperatorTools,
  modelOperatorTools,
} from "../src/katafit/operatorTools.js";
import { complete } from "../src/runtime/piAdapter.js";
import { fixture } from "./operator-checkins.test.js";
const LIST = "studio_operator_list_dojo_checkins";
const IMAGE = "studio_operator_read_dojo_checkin_image";
test("model cannot inspect check-in photo without declared vision", async () => {
  const f = await fixture();
  try {
    const s = await openOperatorTools(
      new Client(f.origin, "synthetic-token", AbortSignal.timeout(5000)),
      undefined,
      { secrets: ["synthetic-token"], onAction: () => {} },
    );
    assert.deepEqual(
      modelOperatorTools(s.tools, false)
        .map((t) => t.name)
        .includes(IMAGE),
      true,
    );
    assert.deepEqual(
      modelOperatorTools(s.tools, false)
        .map((t) => t.name)
        .includes(LIST),
      true,
    );
    assert.equal(
      modelOperatorTools(s.tools, true).some((t) => t.name === IMAGE),
      true,
    );
    await assert.rejects(
      complete(
        {
          baseUrl: "http://127.0.0.1:1/v1",
          model: "synthetic",
          apiKey: "synthetic-key",
          vision: false,
        },
        "operator",
        "photos",
        AbortSignal.timeout(5000),
        s.tools,
      ),
      /VISION_UNSUPPORTED/,
    );
    await s.dispose();
  } finally {
    await f.close();
  }
});
test("read rejects a photo not listed in the authorized roster", async () => {
  const f = await fixture();
  try {
    const s = await openOperatorTools(
      new Client(f.origin, "synthetic-token", AbortSignal.timeout(5000)),
      undefined,
      { secrets: ["synthetic-token"], onAction: () => {} },
    );
    await assert.rejects(
      s.tools
        .find((t) => t.name === IMAGE)!
        .execute("image", {
          member_ref: "member-photo",
          media_ref: "media-photo",
        }),
      /READ_NOT_AUTHORIZED/,
    );
    await s.tools.find((t) => t.name === LIST)!.execute("roster", {});
    await assert.rejects(
      s.tools
        .find((t) => t.name === IMAGE)!
        .execute("image", {
          member_ref: "member-denied",
          media_ref: "media-photo",
        }),
      /READ_NOT_AUTHORIZED/,
    );
    assert.equal(f.calls.includes(IMAGE), false);
    await s.dispose();
  } finally {
    await f.close();
  }
});

test("selected-member session rejects dojo-wide tool advertisement", async () => {
  const f = await fixture({ memberDojoTools: true });
  try {
    await assert.rejects(
      openOperatorTools(
        new Client(f.origin, "synthetic-token", AbortSignal.timeout(5000)),
        "member-anchor",
        { secrets: ["synthetic-token"], onAction: () => {} },
      ),
      /CAPABILITIES_REJECTED/,
    );
    assert.equal(f.calls.includes(LIST), false);
    assert.equal(f.calls.includes(IMAGE), false);
  } finally {
    await f.close();
  }
});
