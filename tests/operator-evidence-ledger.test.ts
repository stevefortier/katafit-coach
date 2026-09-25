import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OperatorEvidenceLedger,
  type OperatorReadReceipt,
} from "../src/chat/operatorEvidence.js";
import { Client } from "../src/katafit/client.js";
import {
  openOperatorTools,
  modelOperatorTools,
} from "../src/katafit/operatorTools.js";
import { operatorBackend } from "./operator-tools.test.js";
import { fixture } from "./operator-checkins.test.js";

const feed = "studio_operator_read_member_coach_feed";
const checkins = "studio_operator_list_dojo_checkins";
const image = "studio_operator_read_dojo_checkin_image";

test("pagination needs every successful linked page, not just a successful first page", () => {
  const ledger = new OperatorEvidenceLedger();
  ledger.record({
    tool: feed,
    domain: "feed",
    member_ref: "m",
    cursor: null,
    status: "success",
    has_more: true,
    next_cursor: "next",
  });
  assert.equal(ledger.complete({ domain: "feed", member_ref: "m" }), false);
  ledger.record({
    tool: feed,
    domain: "feed",
    member_ref: "m",
    cursor: "next",
    status: "failure",
    reason: "READ_NOT_AUTHORIZED",
  });
  assert.equal(ledger.complete({ domain: "feed", member_ref: "m" }), false);
  ledger.record({
    tool: feed,
    domain: "feed",
    member_ref: "other",
    cursor: null,
    status: "success",
    has_more: false,
    next_cursor: null,
  });
  assert.equal(ledger.satisfies({ domain: "feed", member_ref: "m" }), false);
  ledger.record({
    tool: feed,
    domain: "feed",
    member_ref: "m",
    cursor: "next",
    status: "success",
    has_more: false,
    next_cursor: null,
  });
  assert.equal(ledger.complete({ domain: "feed", member_ref: "m" }), true);
});

test("target and domain are both required; group needs every requested member", () => {
  const ledger = new OperatorEvidenceLedger();
  ledger.record({
    tool: feed,
    domain: "feed",
    member_ref: "a",
    cursor: null,
    status: "success",
    has_more: false,
    next_cursor: null,
  });
  assert.equal(
    ledger.satisfies({ domain: "activities", member_ref: "a" }),
    false,
  );
  assert.equal(ledger.satisfies({ domain: "feed", member_ref: "b" }), false);
  ledger.record({
    tool: checkins,
    domain: "feed",
    member_ref: "b",
    cursor: null,
    status: "success",
    has_more: false,
    next_cursor: null,
  });
  assert.equal(ledger.satisfies({ domain: "feed", member_ref: "b" }), false);
  assert.equal(
    ledger.satisfiesGroup({ domain: "feed", member_refs: ["a", "b"] }),
    false,
  );
  ledger.record({
    tool: feed,
    domain: "feed",
    member_ref: "b",
    cursor: null,
    status: "success",
    has_more: false,
    next_cursor: null,
  });
  assert.equal(
    ledger.satisfiesGroup({ domain: "feed", member_refs: ["a", "b"] }),
    true,
  );
});

test("checkin metadata and text-only delivery are not visual evidence", () => {
  const ledger = new OperatorEvidenceLedger();
  ledger.record({
    tool: checkins,
    domain: "checkins",
    member_ref: "a",
    cursor: null,
    status: "success",
    has_more: false,
    next_cursor: null,
  });
  assert.equal(
    ledger.satisfies({
      domain: "image",
      member_ref: "a",
      media_ref: "photo",
      visual: true,
    }),
    false,
  );
  ledger.record({
    tool: image,
    domain: "image",
    member_ref: "a",
    media_ref: "photo",
    cursor: null,
    status: "success",
    image_to_model: false,
  });
  assert.equal(
    ledger.satisfies({
      domain: "image",
      member_ref: "a",
      media_ref: "photo",
      visual: true,
    }),
    false,
  );
  assert.equal(
    ledger.satisfies({ domain: "image", member_ref: "a", media_ref: "photo" }),
    true,
  );
  ledger.record({
    tool: image,
    domain: "image",
    member_ref: "a",
    media_ref: "photo",
    cursor: null,
    status: "success",
    image_to_model: true,
  });
  assert.equal(
    ledger.satisfies({
      domain: "image",
      member_ref: "a",
      media_ref: "photo",
      visual: true,
    }),
    true,
  );
});

test("operatorTools emits structured success and denial receipts while preserving legacy callbacks", async () => {
  const backend = await operatorBackend((name, result, body) => {
    if (name === feed && body.params.arguments.cursor === "next")
      return {
        ...result,
        has_more: false,
        next_cursor: null,
        member_ref: "wrong",
      };
    if (name === feed)
      return { ...result, has_more: true, next_cursor: "next" };
    return result;
  });
  const receipts: OperatorReadReceipt[] = [];
  const legacy: Array<[string, string[]]> = [];
  try {
    const session = await openOperatorTools(
      new Client(backend.origin, "token", AbortSignal.timeout(5000)),
      "member-fixture",
      {
        secrets: ["token"],
        onAction: () => {},
        onRead: (name, refs, receipt) => {
          legacy.push([name, refs]);
          if (receipt) receipts.push(receipt);
        },
        onFailure: (receipt) => receipts.push(receipt),
      },
    );
    const read = session.tools.find((t) => t.name === feed)!;
    await read.execute("first", {});
    await assert.rejects(
      read.execute("second", { cursor: "next" }),
      /RESULT_REJECTED/,
    );
    assert.deepEqual(legacy, [[feed, []]]);
    assert.deepEqual(
      receipts.map((r) => ({
        domain: r.domain,
        member_ref: r.member_ref,
        cursor: r.cursor,
        status: r.status,
        has_more: r.has_more,
        next_cursor: r.next_cursor,
      })),
      [
        {
          domain: "feed",
          member_ref: "member-fixture",
          cursor: null,
          status: "success",
          has_more: true,
          next_cursor: "next",
        },
        {
          domain: "feed",
          member_ref: "member-fixture",
          cursor: "next",
          status: "failure",
          has_more: undefined,
          next_cursor: undefined,
        },
      ],
    );
    await session.dispose().catch(() => {});
  } finally {
    await backend.close();
  }
});

test("image delivery receipt distinguishes model vision from a text-only Studio card", async () => {
  const backend = await fixture();
  try {
    for (const vision of [false, true]) {
      const ledger = new OperatorEvidenceLedger();
      const session = await openOperatorTools(
        new Client(
          backend.origin,
          "synthetic-token",
          AbortSignal.timeout(5000),
        ),
        undefined,
        {
          secrets: ["synthetic-token"],
          onAction: () => {},
          onRead: (_name, _refs, receipt) => {
            if (receipt) ledger.record(receipt);
          },
          onFailure: (receipt) => ledger.record(receipt),
        },
      );
      await session.tools.find((t) => t.name === checkins)!.execute("list", {});
      const tool = modelOperatorTools(session.tools, vision).find(
        (t) => t.name === image,
      )!;
      const result = await tool.execute("image", {
        member_ref: "member-photo",
        media_ref: "media-photo",
      });
      assert.equal(
        result.content.some((p) => p.type === "image"),
        vision,
      );
      assert.equal(
        ledger.satisfies({
          domain: "image",
          member_ref: "member-photo",
          media_ref: "media-photo",
          visual: true,
        }),
        vision,
      );
      assert.equal(
        ledger
          .receipts()
          .filter((r) => r.tool === image && r.image_to_model === vision)
          .length,
        1,
      );
      await session.dispose();
    }
  } finally {
    await backend.close();
  }
});
