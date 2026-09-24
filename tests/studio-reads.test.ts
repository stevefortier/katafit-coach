import test from "node:test";
import assert from "node:assert/strict";
import { StudioReads } from "../src/katafit/studio.js";
import { READ_NAMES } from "../src/katafit/readTools.js";

const roster = {
  schema_version: 1,
  owner_type: "dojo",
  members: [
    {
      member_ref: "opaque-member",
      display_name: "Synthetic member",
      access: "granted",
    },
  ],
  has_more: false,
  next_cursor: null,
};
const fake = (result: unknown, calls: unknown[]) => ({
  connect: async () => {},
  call: async (name: string, args: unknown) => {
    calls.push({ name, args });
    return result;
  },
});
const feed = {
  schema_version: 1,
  member_ref: "opaque-member",
  coverage: "retained_main_coach_feed",
  items: [
    {
      id: "message-1",
      type: "message",
      role: "user",
      text: "Synthetic question",
      created_at: "2026-09-22T12:00:00.000Z",
      status: "completed",
      attachments_omitted: false,
    },
  ],
  has_more: false,
  next_cursor: null,
  limitations: ["Attachment content is not included."],
};
test("Studio feed is exact-member read-only and drops executable fields", async () => {
  const calls: unknown[] = [];
  const reads = new StudioReads(
    fake(
      {
        ...feed,
        items: [
          {
            ...feed.items[0],
            actions: [{ url: "https://example.invalid/private" }],
          },
        ],
      },
      calls,
    ),
    [],
  );
  assert.deepEqual(await reads.feed({ member_ref: "opaque-member" }), feed);
  assert.deepEqual(calls, [
    {
      name: "studio_read_member_coach_feed",
      args: { member_ref: "opaque-member", limit: 25 },
    },
  ]);
});
test("Main chat view is explicitly bound and rejects activity rows", async () => {
  const calls: unknown[] = [];
  const main = { ...feed, coverage: "retained_main_coach_conversation" };
  assert.deepEqual(
    await new StudioReads(fake(main, calls), []).feed({
      member_ref: "opaque-member",
      view: "main_conversation",
    }),
    main,
  );
  assert.deepEqual(calls, [
    {
      name: "studio_read_member_coach_feed",
      args: {
        member_ref: "opaque-member",
        limit: 25,
        view: "main_conversation",
      },
    },
  ]);
  for (const value of [
    feed,
    { ...main, items: [{ ...feed.items[0], activity_ref: "private-workout" }] },
    { ...main, items: [{ ...feed.items[0], type: "activity_event" }] },
  ])
    await assert.rejects(
      new StudioReads(fake(value, []), []).feed({
        member_ref: "opaque-member",
        view: "main_conversation",
      }),
    );
});
test("Studio responses reject cross-member data, malformed pages and known secrets", async () => {
  for (const value of [
    { ...feed, member_ref: "different-member" },
    { ...feed, has_more: true, next_cursor: null },
    { ...feed, items: [{ ...feed.items[0], role: "system" }] },
    {
      ...feed,
      items: [{ ...feed.items[0], status: "raw-secret-provider-error" }],
    },
    { ...feed, items: [{ ...feed.items[0], text: "x".repeat(262144) }] },
    {
      ...feed,
      items: [{ ...feed.items[0], text: "synthetic-private-credential" }],
    },
  ])
    await assert.rejects(
      new StudioReads(fake(value, []), ["synthetic-private-credential"]).feed({
        member_ref: "opaque-member",
      }),
    );
  for (const value of [
    { ...roster, has_more: false, next_cursor: "unexpected" },
    { ...roster, members: [{ ...roster.members[0], access: "maybe" }] },
  ])
    await assert.rejects(new StudioReads(fake(value, []), []).members({}));
});
test("Studio accepts canonical backend delivery and activity states", async () => {
  for (const status of ["timedout", "generated", "skipped"]) {
    const value = { ...feed, items: [{ ...feed.items[0], status }] };
    assert.equal(
      (
        await new StudioReads(fake(value, []), []).feed({
          member_ref: "opaque-member",
        })
      ).items[0].status,
      status,
    );
  }
});
test("Studio roster uses only dedicated read tools and returns no extra fields", async () => {
  const calls: unknown[] = [];
  const reads = new StudioReads(
    fake(
      {
        ...roster,
        private: "hidden",
        members: [{ ...roster.members[0], email: "private@example.invalid" }],
      },
      calls,
    ),
    [],
  );
  assert.deepEqual(await reads.members({}), roster);
  assert.deepEqual(calls, [
    { name: "studio_list_members", args: { limit: 25 } },
  ]);
  assert.equal(READ_NAMES.has("studio_list_members"), false);
  assert.equal(READ_NAMES.has("studio_read_member_coach_feed"), false);
});
