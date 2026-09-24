import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { Client } from "../src/katafit/client.js";
import {
  openOperatorTools,
  modelOperatorTools,
} from "../src/katafit/operatorTools.js";

const LIST = "studio_operator_list_dojo_checkins";
const IMAGE = "studio_operator_read_dojo_checkin_image";
export async function fixture(
  options: {
    advertised?: boolean;
    allowed?: boolean;
    malformed?: boolean;
    revoke?: boolean;
    two?: boolean;
    three?: boolean;
    hasMore?: boolean;
    twoPages?: boolean;
    memberDojoTools?: boolean;
    duplicateMorgan?: boolean;
  } = {},
) {
  const bytes = await sharp({
    create: { width: 3, height: 2, channels: 3, background: "#123456" },
  })
    .png()
    .toBuffer();
  const calls: string[] = [];
  const openings: any[] = [];
  let revoked = false;
  const row = {
    member_ref: "member-photo",
    display_name: "Alex",
    access: "shared",
    checkin_status: "completed_media",
    images: [
      { checkin_at: "2026-09-24T12:00:00.000Z", media_ref: "media-photo" },
    ],
  };
  const roster = {
    schema_version: 1,
    items: [
      row,
      ...(options.two
        ? [
            {
              member_ref: "member-two",
              display_name: "Morgan",
              access: "shared",
              checkin_status: "completed_media",
              images: [
                {
                  checkin_at: "2026-09-24T12:00:00.000Z",
                  media_ref: "media-two",
                },
              ],
            },
          ]
        : []),
      ...(options.duplicateMorgan
        ? [
            {
              member_ref: "member-four",
              display_name: "Morgan",
              access: "shared",
              checkin_status: "no_completed_media",
              images: [],
            },
          ]
        : []),
      ...(options.three
        ? [
            {
              member_ref: "member-three",
              display_name: "Taylor",
              access: "shared",
              checkin_status: "completed_media",
              images: [
                {
                  checkin_at: "2026-09-24T12:00:00.000Z",
                  media_ref: "media-three",
                },
              ],
            },
          ]
        : []),
      {
        member_ref: "member-denied",
        display_name: "Pat",
        access: "not_shared",
        checkin_status: "not_shared",
        images: [],
      },
    ],
    has_more: options.hasMore === true,
    next_cursor: options.hasMore ? "another-page" : null,
  };
  const metadata = {
    schema_version: 1,
    representation: "original",
    mime_type: "image/png",
    byte_count: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width: 3,
    height: 2,
  };
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/api/agents/coach.md") {
      res.end(
        "# Kata.fit external Coach agent v1\n## Chief-manager operator sessions and human Studio\nThe chief manages the Coach; read only authorized data.",
      );
      return;
    }
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw),
      name = body.params?.name;
    if (name) calls.push(name);
    if (name === "studio_operator_open_session")
      openings.push(body.params.arguments);
    let result: any = {};
    if (body.method === "initialize")
      result = { protocolVersion: "2025-03-26" };
    if (body.method === "tools/list")
      result = {
        tools: [
          "studio_operator_open_session",
          "studio_operator_read_member_coach_feed",
          "studio_operator_send_message",
          "studio_operator_get_action",
          "studio_operator_close_session",
          "studio_operator_list_members",
          LIST,
          ...(options.advertised === false ? [] : [IMAGE]),
        ].map((name) => ({ name })),
      };
    if (name === "studio_operator_open_session")
      result = ["dojo_read", "dojo_operator"].includes(
        body.params.arguments?.mode,
      )
        ? {
            schema_version: 1,
            mode: body.params.arguments.mode,
            session_id: "session-photo",
            status: "active",
            expires_at: new Date(Date.now() + 600000).toISOString(),
            allowed_tools:
              options.allowed === false
                ? ["studio_operator_list_members"]
                : body.params.arguments.mode === "dojo_operator"
                  ? [
                      "studio_operator_list_members",
                      "studio_operator_read_member_coach_feed",
                      "studio_operator_send_message",
                      LIST,
                      IMAGE,
                    ]
                  : [LIST, IMAGE],
          }
        : {
            schema_version: 1,
            member_ref: "member-anchor",
            session_id: "session-photo",
            status: "active",
            expires_at: new Date(Date.now() + 600000).toISOString(),
            allowed_tools: [
              "studio_operator_read_member_coach_feed",
              "studio_operator_send_message",
              ...(options.memberDojoTools ? [LIST, IMAGE] : []),
            ],
          };
    if (name === LIST)
      result = {
        structuredContent: revoked
          ? {
              ...roster,
              items: roster.items.map((item) => ({
                ...item,
                access: "not_shared",
                checkin_status: "not_shared",
                images: [],
              })),
            }
          : options.twoPages
            ? body.params.arguments?.cursor
              ? {
                  ...roster,
                  items: roster.items.slice(1),
                  has_more: false,
                  next_cursor: null,
                }
              : {
                  ...roster,
                  items: roster.items.slice(0, 1),
                  has_more: true,
                  next_cursor: "another-page",
                }
            : roster,
      };
    if (name === "studio_operator_list_members")
      result = {
        structuredContent: {
          schema_version: 1,
          members: roster.items.map(({ member_ref, display_name }) => ({
            member_ref,
            display_name,
          })),
          has_more: false,
          next_cursor: null,
        },
      };
    if (name === "studio_operator_read_member_coach_feed")
      result = {
        structuredContent: {
          schema_version: 1,
          member_ref: body.params.arguments.member_ref,
          items: [
            {
              text:
                body.params.arguments.member_ref === "member-photo"
                  ? "Authorized member feed: Alex completed two synthetic workouts this week."
                  : "Authorized member feed: Morgan completed one synthetic workout this week.",
            },
          ],
          has_more: false,
        },
      };
    if (name === "studio_operator_send_message")
      result = {
        schema_version: 1,
        session_id: "session-photo",
        status: "delivered",
        action_id: "action-photo",
        message_id: "message-photo",
        idempotent: false,
      };
    if (name === IMAGE)
      result =
        options.revoke || revoked
          ? { isError: true }
          : {
              structuredContent: {
                ...metadata,
                ...(options.malformed ? { sha256: "0".repeat(64) } : {}),
              },
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    ...metadata,
                    ...(options.malformed ? { sha256: "0".repeat(64) } : {}),
                  }),
                },
                {
                  type: "image",
                  mimeType: "image/png",
                  data: bytes.toString("base64"),
                },
              ],
            };
    if (name === "studio_operator_close_session")
      result = {
        structuredContent: {
          schema_version: 1,
          session_id: "session-photo",
          status: "closed",
        },
      };

    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result:
          name &&
          ![
            LIST,
            IMAGE,
            "studio_operator_close_session",
            "studio_operator_read_member_coach_feed",
            "studio_operator_list_members",
          ].includes(name)
            ? { structuredContent: result }
            : result,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    bytes,
    calls,
    openings,
    revokeSharing() {
      revoked = true;
    },
    origin: `http://127.0.0.1:${(server.address() as any).port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("session-advertised check-in roster and original image reach model as native image, without text bytes", async () => {
  const f = await fixture();
  try {
    const s = await openOperatorTools(
      new Client(f.origin, "synthetic-token", AbortSignal.timeout(5000)),
      undefined,
      { secrets: ["synthetic-token"], onAction: () => {} },
    );
    assert.deepEqual(
      s.tools.slice(-2).map((t) => t.name),
      [LIST, IMAGE],
    );
    const roster = await s.tools
      .find((t) => t.name === LIST)!
      .execute("roster", { limit: 10 });
    assert.match(roster.content[0].text, /not_shared/);
    const read = await s.tools
      .find((t) => t.name === IMAGE)!
      .execute("image", {
        member_ref: "member-photo",
        media_ref: "media-photo",
      });
    assert.equal(read.content[1].type, "image");
    assert.deepEqual(Buffer.from(read.content[1].data, "base64"), f.bytes);
    for (let i = 0; i < 3; i++)
      await s.tools
        .find((t) => t.name === IMAGE)!
        .execute("image-repeat", {
          member_ref: "member-photo",
          media_ref: "media-photo",
        });
    await assert.rejects(
      s.tools
        .find((t) => t.name === IMAGE)!
        .execute("image-fifth", {
          member_ref: "member-photo",
          media_ref: "media-photo",
        }),
      /TOOL_BUDGET_EXHAUSTED/,
    );
    assert.equal(
      f.calls.filter((name) => name === IMAGE).length,
      4,
      "fifth image is not fetched from backend",
    );
    assert.doesNotMatch(
      JSON.stringify(read.content[0]),
      new RegExp(f.bytes.toString("base64")),
    );
    await s.dispose();
  } finally {
    await f.close();
  }
});

test("unadvertised or unallowed image is omitted while authorized roster remains available", async () => {
  for (const options of [{ advertised: false }, { allowed: false }]) {
    const f = await fixture(options);
    try {
      const session = await openOperatorTools(
        new Client(f.origin, "synthetic-token", AbortSignal.timeout(5000)),
        undefined,
        { secrets: ["synthetic-token"], onAction: () => {} },
      );
      assert.ok(
        session.tools.some(
          (tool) => tool.name === "studio_operator_list_members",
        ),
      );
      assert.ok(!session.tools.some((tool) => tool.name === IMAGE));
      await session.dispose();
      assert.equal(f.calls.includes(IMAGE), false);
    } finally {
      await f.close();
    }
  }
});

test("revoked and malformed image returns no image to model", async () => {
  for (const options of [{ revoke: true }, { malformed: true }]) {
    const f = await fixture(options);
    try {
      const s = await openOperatorTools(
        new Client(f.origin, "synthetic-token", AbortSignal.timeout(5000)),
        undefined,
        { secrets: ["synthetic-token"], onAction: () => {} },
      );
      await s.tools.find((t) => t.name === LIST)!.execute("roster", {});
      await assert.rejects(
        s.tools
          .find((t) => t.name === IMAGE)!
          .execute("image", {
            member_ref: "member-photo",
            media_ref: "media-photo",
          }),
      );
      await s.dispose();
    } finally {
      await f.close();
    }
  }
});
