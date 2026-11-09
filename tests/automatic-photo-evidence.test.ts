import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import sharp from "sharp";
import { complete } from "../src/runtime/piAdapter.js";
import { Worker } from "../src/worker/runner.js";
import { answer } from "./helpers/continuity.js";
import { taskFixture } from "./task-fixtures.js";
import { AGENT_TOKEN } from "./helpers/native.js";

// Actual Worker task -> InvocationCapability -> authenticated loopback REST
// (canonical backend activity/media shapes, binary image bytes) -> real Pi
// adapter -> HTTP provider request. Only the model is scripted: this proves
// the provider receives the photo bytes, not live model visual quality.

const REQUESTER = "2".repeat(24);
const PRINCIPAL = "c".repeat(24);
const DOJO = "d".repeat(24);
const AS_OF = "2026-10-09T18:00:00.000Z";
const DAY = "2026-10-09";
const TOKEN = "synthetic-worker-credential";
const oid = (prefix: string, n: number) =>
  prefix.repeat(22) + String(n).padStart(2, "0");
const M = (n: number) => oid("a", n);
const P = (n: number) => oid("e", n);
const F = (n: number) => oid("f", n);
const insight = {
  general_advice: "Synthetic photo-grounded advice.",
  meal_recommendations: [],
  recovery_recommendations: [],
  workout_directives: [],
};

/** Distinct, already bounded PNGs: prepareModelImage forwards them unchanged. */
async function png(n: number) {
  return sharp({
    create: {
      width: 3 + n,
      height: 2,
      channels: 3,
      background: { r: 20 * n, g: 200 - 10 * n, b: 7 * n },
    },
  })
    .png()
    .toBuffer();
}
const imagePart = (bytes: Buffer) => ({
  status: 200,
  bytes,
  contentType: "image/png",
});

function currentDay(media: any[], categories?: string[]) {
  const all = ["meal", "workout", "metric", "media", "survey", "status_change"];
  const included = categories ?? all;
  return {
    timezone: "UTC",
    observations: [
      {
        label: "Current status",
        text: JSON.stringify({ day: DAY, status: "good", note: "Synthetic" }),
      },
      {
        label: "Current local day",
        text: JSON.stringify({
          protocol: "coach.current-day.v1",
          subject: "requester",
          user_id: REQUESTER,
          local_day: DAY,
          timezone: "UTC",
          as_of: AS_OF,
          coverage: {
            status: "complete",
            categories: included,
            excluded_categories: all.filter((c) => !included.includes(c)),
          },
          limitations:
            "Counts summarize completion, not photo inspection or detailed review.",
        }),
      },
      {
        label: "Current local day activities 1",
        text: JSON.stringify(media),
      },
      {
        label: "Result limitations",
        text: "Seed evidence omits photos, strategy and detailed workout prescriptions.",
      },
    ],
    conversation: [],
  };
}
const seedMedia = (id: string, files = 4, completedAt = AS_OF) => ({
  activity_id: id,
  type: "media",
  name: "Weekly check-in",
  status: "completed",
  saved_status: "complete",
  created_at: "2026-10-09T08:00:00.000Z",
  completed_at: completedAt,
  due_at: null,
  summary: { media_count: files, detail: "not_loaded" },
});
const mediaDoc = (
  id: string,
  files: any[],
  extra: any = {},
  owner = REQUESTER,
) => ({
  _id: id,
  user_id: owner,
  type: "media",
  name: "Weekly check-in",
  status: "complete",
  created_at: "2026-10-09T08:00:00.000Z",
  completed_at: "2026-10-09T08:05:00.000Z",
  data: { files },
  ...extra,
});
const file = (id: string, type = "image/png") => ({
  _id: id,
  type,
  inferenceStatus: "completed",
});

const text = (m: any) =>
  typeof m.content === "string"
    ? m.content
    : (m.content ?? []).map((p: any) => p.text ?? "").join("");
/** Decoded image bytes of every image part in one provider request body. */
const images = (body: any) =>
  body.messages.flatMap((m: any) =>
    Array.isArray(m.content)
      ? m.content
          .filter((p: any) => p.type === "image_url")
          .map((p: any) => {
            const [meta, data] = p.image_url.url.split(",");
            assert.equal(meta, "data:image/png;base64");
            return Buffer.from(data, "base64");
          })
      : [],
  );
function envelope(body: any) {
  const user = body.messages.find(
    (m: any) => m.role === "user" && text(m).includes("generation_task"),
  );
  assert.ok(user, "provider received the task envelope");
  return JSON.parse(text(user));
}
const system = (body: any) =>
  body.messages
    .filter((m: any) => m.role === "system")
    .map(text)
    .join("\n");

async function run(
  fixtureOptions: any,
  enqueue: { kind: string; patch?: any },
  reply: (n: number) => string,
  vision = true,
) {
  let f: Awaited<ReturnType<typeof taskFixture>> | undefined;
  let w: Worker | undefined;
  const bodies: any[] = [];
  const readsAtFirstTurn: string[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw));
    if (bodies.length === 1)
      readsAtFirstTurn.push(...f!.restCalls.map((c: any) => c.path));
    res.setHeader("Content-Type", "text/event-stream");
    res.end(reply(bodies.length));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  try {
    f = await taskFixture({ negotiate: true, ...fixtureOptions });
    w = new Worker({
      origin: f.origin,
      token: TOKEN,
      system: "Synthetic Coach persona",
      vision,
      complete: (context, signal, sys, tools, _ref, budget) =>
        complete(
          {
            baseUrl,
            model: "synthetic-vision-model",
            apiKey: "synthetic-provider-credential",
            vision,
            secrets: [TOKEN],
          },
          sys,
          context,
          signal,
          tools,
          budget,
        ),
    });
    f.enqueue(enqueue.kind, enqueue.patch);
    const error = await w.pollOnce().then(
      () => undefined,
      (e: Error) => e,
    );
    return {
      error,
      state: w.state,
      bodies,
      saved: [...f.saved],
      reads: f.restCalls.map((c: any) => c.path),
      readsAtFirstTurn,
      authorizations: f.restCalls.map((c: any) => c.authorization),
    };
  } finally {
    await w?.stop();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await f?.close();
  }
}

test("daily insight sends the four seeded check-in photos and one prior comparable to the provider on the initial and correction attempts", async () => {
  const shots = await Promise.all([1, 2, 3, 4, 5].map(png));
  const current = mediaDoc(
    M(1),
    [1, 2, 3, 4].map((n) => file(F(n))),
  );
  // Legacy statusless media is a valid prior: only file/owner/date/name count.
  const prior = mediaDoc(P(1), [file(F(9)), file(F(8))], {
    status: undefined,
    created_at: "2026-10-02T08:00:00.000Z",
    completed_at: "2026-10-02T08:05:00.000Z",
  });
  const pendingUpload = mediaDoc(
    P(4),
    [{ ...file(F(6)), isPlaceholder: true }],
    { status: "pending", created_at: "2026-10-06T08:00:00.000Z" },
  );
  const r = await run(
    {
      evidence: currentDay([seedMedia(M(1))]),
      rest: async (c: any) => {
        if (c.path === `/api/activities/${M(1)}`)
          return { status: 200, body: current };
        for (const n of [1, 2, 3, 4])
          if (c.path === `/api/media/${M(1)}/files/${F(n)}?size=1mp`)
            return imagePart(shots[n - 1]);
        if (c.path === "/api/activities?type=media&limit=10")
          return {
            status: 200,
            body: {
              activities: [
                current,
                pendingUpload,
                mediaDoc(P(2), [file(F(7))], {
                  name: "Progress selfie",
                  created_at: "2026-10-05T08:00:00.000Z",
                }),
                prior,
              ],
            },
          };
        if (c.path === `/api/activities/${P(1)}`)
          return { status: 200, body: prior };
        if (c.path === `/api/media/${P(1)}/files/${F(9)}?size=1mp`)
          return imagePart(shots[4]);
      },
    },
    { kind: "daily_insight" },
    // The first output fails local validation; the correction must still see the photos.
    (n) => answer(n === 1 ? "Not JSON at all" : JSON.stringify(insight)),
  );
  assert.equal(r.error, undefined, String(r.error));
  assert.equal(r.state, "task-result-stored");
  assert.deepEqual(r.saved[0].result, insight);
  assert.equal(r.bodies.length, 2, "initial attempt plus one correction");
  const expectedReads = [
    `/api/activities/${M(1)}`,
    ...[1, 2, 3, 4].map((n) => `/api/media/${M(1)}/files/${F(n)}?size=1mp`),
    "/api/activities?type=media&limit=10",
    `/api/activities/${P(1)}`,
    `/api/media/${P(1)}/files/${F(9)}?size=1mp`,
  ];
  assert.deepEqual(r.readsAtFirstTurn, expectedReads);
  assert.deepEqual(r.reads, expectedReads, "correction reuses acquired reads");
  assert.ok(r.authorizations.every((a) => a === `Bearer ${AGENT_TOKEN}`));
  for (const body of r.bodies) {
    // Actual bytes, in image_index order, on both attempts.
    assert.deepEqual(images(body), shots);
    assert.match(system(body), /carries 5 attached images/);
  }
  assert.match(system(r.bodies[1]), /failed local validation/);
  const acquired = envelope(r.bodies[0]).acquired_photo_evidence;
  assert.deepEqual(envelope(r.bodies[1]).acquired_photo_evidence, acquired);
  assert.equal(acquired.subject, "self");
  assert.equal(acquired.seed_as_of, AS_OF);
  assert.equal(acquired.images_attached, 5);
  const [today, before] = acquired.activities;
  assert.equal(today.role, "current");
  assert.equal(today.activity_id, M(1));
  assert.equal(today.file_count, 4);
  assert.deepEqual(
    today.files.map((x: any) => [x.file_id, x.read, x.image_index]),
    [1, 2, 3, 4].map((n) => [F(n), "ok", n]),
  );
  assert.equal(before.role, "prior_comparable");
  assert.equal(before.activity_id, P(1));
  assert.deepEqual(
    before.files.map((x: any) => [x.file_id, x.read, x.image_index]),
    [
      [F(9), "ok", 5],
      [F(8), "unattempted_image_budget", undefined],
    ],
  );
  assert.deepEqual(acquired.prior_comparable, {
    source: "/api/activities?type=media&limit=10",
    read: "ok",
    activity_id: P(1),
  });
});

test("unknown, denied, missing, empty, non-image and unavailable photo outcomes stay distinct and no pixels or visual claim are implied", async () => {
  const r = await run(
    {
      evidence: currentDay([
        seedMedia(M(1), 1, "2026-10-09T17:00:00.000Z"),
        seedMedia(M(2), 1, "2026-10-09T16:00:00.000Z"),
        seedMedia(M(3), 0, "2026-10-09T15:00:00.000Z"),
        seedMedia(M(4), 4, "2026-10-09T14:00:00.000Z"),
        seedMedia(M(5), 1, "2026-10-09T13:00:00.000Z"),
      ]),
      rest: async (c: any) => {
        if (c.path === `/api/activities/${M(1)}`)
          return { status: 403, body: { error: "Forbidden" } };
        if (c.path === `/api/activities/${M(2)}`)
          return { status: 404, body: { error: "Activity not found." } };
        if (c.path === `/api/activities/${M(3)}`)
          return { status: 200, body: mediaDoc(M(3), []) };
        if (c.path === `/api/activities/${M(4)}`)
          return {
            status: 200,
            body: mediaDoc(M(4), [
              file(F(1), "video/mp4"),
              file(F(2)),
              file(F(3)),
              file(F(4)),
            ]),
          };
        if (c.path.startsWith(`/api/media/${M(4)}/files/${F(2)}`))
          return { status: 500, body: { error: "Synthetic outage" } };
        if (c.path.startsWith(`/api/media/${M(4)}/files/${F(3)}`))
          return { status: 403, body: { error: "Forbidden" } };
        // A JSON answer at the bytes route is never pixels.
        if (c.path.startsWith(`/api/media/${M(4)}/files/${F(4)}`))
          return { status: 200, body: { not: "an image" } };
      },
    },
    { kind: "daily_insight" },
    () => answer(JSON.stringify(insight)),
  );
  assert.equal(r.error, undefined, String(r.error));
  assert.equal(r.state, "task-result-stored");
  assert.equal(images(r.bodies[0]).length, 0);
  assert.match(system(r.bodies[0]), /no image pixels are attached/);
  assert.doesNotMatch(system(r.bodies[0]), /attached images? that this host/);
  // No video bytes, no prior search without a delivered current photo.
  assert.ok(!r.reads.some((p) => p.includes(F(1))));
  assert.ok(!r.reads.some((p) => p.includes("type=media")));
  const acquired = envelope(r.bodies[0]).acquired_photo_evidence;
  const byId = Object.fromEntries(
    acquired.activities.map((a: any) => [a.activity_id, a]),
  );
  assert.equal(byId[M(1)].read, "denied");
  assert.equal(byId[M(1)].status_code, 403);
  assert.equal(byId[M(2)].read, "missing");
  assert.equal(byId[M(3)].read, "ok");
  assert.equal(byId[M(3)].photos, "empty");
  assert.deepEqual(byId[M(3)].files, []);
  assert.deepEqual(
    byId[M(4)].files.map((x: any) => [x.file_id, x.read, x.status_code]),
    [
      [F(1), "not_image", undefined],
      [F(2), "unavailable", 500],
      [F(3), "denied", 403],
      [F(4), "not_image", undefined],
    ],
  );
  // Beyond the bounded activity reads: explicitly unattempted, never empty.
  assert.deepEqual(byId[M(5)], {
    activity_id: M(5),
    role: "current",
    read: "unattempted",
    reason: "read_budget",
  });
  assert.deepEqual(acquired.prior_comparable, {
    read: "not_attempted",
    reason: "no_current_photo",
  });
  assert.equal(acquired.images_attached, 0);
});

test("a non-vision provider gets no photo bytes or VISION_UNSUPPORTED failure, only the explicit not-read status", async () => {
  const r = await run(
    {
      evidence: currentDay([seedMedia(M(1), 2)]),
      rest: async (c: any) => {
        if (c.path === `/api/activities/${M(1)}`)
          return {
            status: 200,
            body: mediaDoc(M(1), [file(F(1)), file(F(2))]),
          };
      },
    },
    { kind: "daily_insight" },
    () => answer(JSON.stringify(insight)),
    false,
  );
  assert.equal(r.error, undefined, String(r.error));
  assert.equal(r.state, "task-result-stored");
  assert.deepEqual(r.reads, [`/api/activities/${M(1)}`]);
  assert.equal(images(r.bodies[0]).length, 0);
  const acquired = envelope(r.bodies[0]).acquired_photo_evidence;
  assert.equal(acquired.provider_vision, false);
  assert.deepEqual(
    acquired.activities[0].files.map((x: any) => x.read),
    ["not_read_vision_disabled", "not_read_vision_disabled"],
  );
  assert.deepEqual(acquired.prior_comparable, {
    read: "not_attempted",
    reason: "vision_disabled",
  });
});

test("Dojo requester current photos use nested peer detail; the feed prior comparable is withheld until a membership bound exists and wrong-owner detail is never read", async () => {
  const shot = await png(1);
  const peer = (doc: any) => ({
    activity: doc,
    owner: { _id: doc.user_id, display_name: "Synthetic member" },
  });
  // A same-named comparable from before the member joined the Dojo: the feed
  // route applies no membership floor, so it must never be looked up.
  const old = mediaDoc(P(1), [file(F(9))], {
    created_at: "2020-01-02T08:00:00.000Z",
  });
  const r = await run(
    {
      evidence: currentDay([
        seedMedia(M(1), 1, "2026-10-09T17:00:00.000Z"),
        seedMedia(M(2), 1, "2026-10-09T16:00:00.000Z"),
      ]),
      rest: async (c: any) => {
        if (c.path === `/api/friends/activity/${M(1)}`)
          return { status: 200, body: peer(mediaDoc(M(1), [file(F(1))])) };
        // Same ID answered for another owner: never attributed or read.
        if (c.path === `/api/friends/activity/${M(2)}`)
          return {
            status: 200,
            body: peer(mediaDoc(M(2), [file(F(2))], {}, PRINCIPAL)),
          };
        if (c.path === `/api/media/${M(1)}/files/${F(1)}?size=1mp`)
          return imagePart(shot);
        if (c.path.startsWith("/api/friends/feed"))
          return {
            status: 200,
            body: { users: [], inDojo: true, activities: [old] },
          };
        if (c.path === `/api/friends/activity/${P(1)}`)
          return { status: 200, body: peer(old) };
        if (c.path === `/api/media/${P(1)}/files/${F(9)}?size=1mp`)
          return imagePart(await png(9));
        if (c.path.startsWith("/api/activities"))
          return { status: 404, body: { error: "Activity not found." } };
      },
    },
    {
      kind: "daily_insight",
      patch: { owner_type: "dojo", owner_id: DOJO, requester_id: REQUESTER },
    },
    () => answer(JSON.stringify(insight)),
  );
  assert.equal(r.error, undefined, String(r.error));
  assert.equal(r.state, "task-result-stored");
  assert.deepEqual(r.readsAtFirstTurn, [
    `/api/friends/activity/${M(1)}`,
    `/api/media/${M(1)}/files/${F(1)}?size=1mp`,
    `/api/friends/activity/${M(2)}`,
  ]);
  assert.ok(!r.reads.some((p) => p.includes("/api/friends/feed")));
  assert.ok(!r.reads.some((p) => p.includes(P(1))));
  assert.ok(!r.reads.some((p) => p.includes(M(2) + "/files")));
  assert.deepEqual(images(r.bodies[0]), [shot]);
  const acquired = envelope(r.bodies[0]).acquired_photo_evidence;
  assert.equal(acquired.subject, "dojo_requester");
  assert.deepEqual(
    acquired.activities.map((a: any) => [a.activity_id, a.role, a.read]),
    [
      [M(1), "current", "ok"],
      [M(2), "current", "subject_mismatch"],
    ],
  );
  assert.deepEqual(acquired.prior_comparable, {
    read: "not_attempted",
    reason: "membership_bound_unavailable",
  });
  assert.match(system(r.bodies[0]), /carries 1 attached image\b/);
});

test("Dojo policy without the media category acquires no photos at all", async () => {
  const r = await run(
    {
      evidence: currentDay([seedMedia(M(1), 1)], ["meal", "workout"]),
      rest: async () => ({ status: 500, body: {} }),
    },
    {
      kind: "daily_insight",
      patch: { owner_type: "dojo", owner_id: DOJO, requester_id: REQUESTER },
    },
    () => answer(JSON.stringify(insight)),
  );
  assert.equal(r.error, undefined, String(r.error));
  assert.deepEqual(r.reads, []);
  assert.equal(images(r.bodies[0]).length, 0);
  assert.equal(envelope(r.bodies[0]).acquired_photo_evidence, undefined);
});

test("an individual media activity reaction reads the triggering activity's photos before generation", async () => {
  const shot = await png(6);
  const reaction = {
    activity_feedback: { reaction: "check", reply_worthwhile: true },
    general_advice: "Synthetic reaction to the attached photo.",
  };
  const r = await run(
    {
      evidence: {
        timezone: "UTC",
        observations: [
          {
            label: "Activity lifecycle event",
            text: JSON.stringify({
              category: "media",
              event_type: "completed",
              activity_id: M(7),
              name: "Weekly check-in",
              occurred_at: AS_OF,
              summary: { media_count: 1 },
            }),
          },
          // Unrelated same-day media the member did not just log.
          {
            label: "Current local day activities 1",
            text: JSON.stringify([
              seedMedia(M(1), 1, "2026-10-09T17:59:00.000Z"),
            ]),
          },
          {
            label: "Result limitations",
            text: "Photos, plans and historical detail were not seeded.",
          },
        ],
        conversation: [],
      },
      rest: async (c: any) => {
        if (c.path === `/api/activities/${M(1)}`)
          return { status: 200, body: mediaDoc(M(1), [file(F(2))]) };
        if (c.path === `/api/activities/${M(7)}`)
          return { status: 200, body: mediaDoc(M(7), [file(F(1))]) };
        if (c.path === `/api/media/${M(7)}/files/${F(1)}?size=1mp`)
          return imagePart(shot);
        if (c.path === "/api/activities?type=media&limit=10")
          return { status: 200, body: { activities: [] } };
      },
    },
    { kind: "activity_reaction" },
    () => answer(JSON.stringify(reaction)),
  );
  assert.equal(r.error, undefined, String(r.error));
  assert.equal(r.state, "task-result-stored");
  assert.deepEqual(r.saved[0].result, reaction);
  assert.deepEqual(images(r.bodies[0]), [shot]);
  assert.deepEqual(r.readsAtFirstTurn, [
    `/api/activities/${M(7)}`,
    `/api/media/${M(7)}/files/${F(1)}?size=1mp`,
    "/api/activities?type=media&limit=10",
  ]);
  const acquired = envelope(r.bodies[0]).acquired_photo_evidence;
  assert.deepEqual(
    acquired.activities.map((a: any) => [a.activity_id, a.role, a.read]),
    [[M(7), "current", "ok"]],
  );
  assert.deepEqual(acquired.prior_comparable, {
    source: "/api/activities?type=media&limit=10",
    read: "none_found",
  });
});

test("a non-media activity reaction on a mixed day never inspects unrelated same-day photos", async () => {
  const reaction = {
    activity_feedback: { reaction: "check", reply_worthwhile: true },
    general_advice: "Synthetic reaction to the logged activity.",
  };
  for (const category of ["meal", "workout", "metric", "survey"]) {
    const r = await run(
      {
        evidence: {
          timezone: "UTC",
          observations: [
            {
              label: "Activity lifecycle event",
              text: JSON.stringify({
                category,
                event_type: "completed",
                activity_id: M(8),
                name: "Synthetic " + category,
                occurred_at: AS_OF,
              }),
            },
            {
              label: "Current local day activities 1",
              text: JSON.stringify([seedMedia(M(1), 2)]),
            },
          ],
          conversation: [],
        },
        rest: async (c: any) => {
          if (c.path === `/api/activities/${M(1)}`)
            return {
              status: 200,
              body: mediaDoc(M(1), [file(F(1)), file(F(2))]),
            };
          if (c.path.startsWith(`/api/media/${M(1)}/`))
            return imagePart(await png(1));
        },
      },
      { kind: "activity_reaction" },
      () => answer(JSON.stringify(reaction)),
    );
    assert.equal(r.error, undefined, `${category}: ${r.error}`);
    assert.equal(r.state, "task-result-stored");
    assert.deepEqual(r.reads, [], category);
    assert.equal(images(r.bodies[0]).length, 0, category);
    assert.equal(
      envelope(r.bodies[0]).acquired_photo_evidence,
      undefined,
      category,
    );
    assert.doesNotMatch(system(r.bodies[0]), /Acquired photo evidence/);
  }
});

// ---------------------------------------------------------------------------
// Request plane: real Worker -> discovered request-scoped MCP read tools
// (fence, handle aliasing, budgets) -> real Pi adapter -> HTTP provider.
// ---------------------------------------------------------------------------
const fenced = (properties: Record<string, any>) => ({
  type: "object",
  properties: {
    request_id: { type: "string" },
    lease_generation: { type: "integer" },
    ...properties,
  },
  required: ["request_id", "lease_generation"],
  additionalProperties: false,
});
const READ_SCHEMAS: Record<string, any> = {
  coach_list_activities: fenced({
    types: { type: "array", items: { type: "string" } },
    statuses: { type: "array", items: { type: "string" } },
    from: { type: "string" },
    to: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 50 },
  }),
  coach_read_activity: fenced({
    activity_id: { type: "string" },
    section: { type: "string" },
  }),
  coach_read_media: fenced({ media_ref: { type: "string" } }),
};
const mcpError = (code: string) => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ code }) }],
});

async function requestRun(
  message: string,
  reads: (name: string, args: any) => any,
  vision = true,
  attachments = 0,
) {
  const created = "2026-10-09T18:05:00.000Z";
  const calls: Array<{ name: string; args: any }> = [];
  let current: any = {
    id: "r".repeat(24),
    requester_id: REQUESTER,
    scope: "personal",
    message,
    text: message,
    created_at: created,
    attachment_count: attachments,
    lease_generation: 0,
    status: "queued",
    timeout_at: new Date(Date.now() + 180000).toISOString(),
  };
  let published: string | undefined;
  const backend = createServer(async (req, res) => {
    if (req.method === "GET") {
      res.end(
        "# Kata.fit external Coach agent v1\nUse server-authorized context.",
      );
      return;
    }
    let raw = "";
    for await (const c of req) raw += c;
    const msg = JSON.parse(raw);
    if (msg.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    const name = msg.params?.name;
    const a = msg.params?.arguments ?? {};
    let value: any = {};
    let result: any;
    if (msg.method === "initialize") value = { protocolVersion: "2025-03-26" };
    else if (msg.method === "tools/list")
      value = {
        tools: [
          { name: "coach_get_capabilities" },
          ...Object.entries(READ_SCHEMAS).map(([n, inputSchema]) => ({
            name: n,
            description: n,
            inputSchema,
          })),
          {
            name: "coach_list_requests",
            inputSchema: {
              type: "object",
              properties: { request_id: { type: "string" } },
            },
          },
        ],
      };
    else if (name in READ_SCHEMAS) {
      calls.push({ name, args: a });
      assert.equal(a.request_id, current.id);
      assert.equal(a.lease_generation, current.lease_generation);
      result = reads(name, a);
    } else
      switch (name) {
        case "coach_get_capabilities":
          value = {
            contract_version: 2,
            allowed_tools: Object.keys(READ_SCHEMAS),
            domains: { media: { available: true } },
            limits: {},
          };
          break;
        case "coach_list_requests":
          value = {
            requests:
              !a.statuses || a.statuses.includes(current.status)
                ? [current]
                : [],
          };
          break;
        case "coach_claim_request":
          if (current.status === "queued") {
            current = {
              ...current,
              status: "claimed",
              lease_generation: current.lease_generation + 1,
              lease_expires_at: new Date(Date.now() + 120000).toISOString(),
            };
            value = { request: current };
          } else value = { request: null };
          break;
        case "coach_start_request":
          current.status = "working";
          value = { request: current };
          break;
        case "coach_read_context":
          value = { request: current, conversation: [] };
          break;
        case "coach_respond":
          published = a.text;
          current.status = "completed";
          current.reply = { text: a.text };
          value = { request: current };
          break;
        case "coach_fail_request":
          current.status = "failed";
          current.failure_code = a.code;
          value = { request: current };
      }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result:
          result ??
          (["initialize", "tools/list"].includes(msg.method)
            ? value
            : { structuredContent: value }),
      }),
    );
  });
  const bodies: any[] = [];
  let callsAtFirstTurn = -1;
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw));
    if (callsAtFirstTurn < 0) callsAtFirstTurn = calls.length;
    res.setHeader("Content-Type", "text/event-stream");
    res.end(answer("Synthetic photo feedback."));
  });
  for (const s of [backend, provider])
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s: any) => s.address().port;
  const w = new Worker({
    origin: `http://127.0.0.1:${port(backend)}`,
    token: TOKEN,
    system: "Synthetic Coach persona",
    vision,
    complete: (context, signal, sys, tools, _ref, budget) =>
      complete(
        {
          baseUrl: `http://127.0.0.1:${port(provider)}/v1`,
          model: "synthetic-vision-model",
          apiKey: "synthetic-provider-credential",
          vision,
          secrets: [TOKEN],
        },
        sys,
        context,
        signal,
        tools,
        budget,
      ),
  });
  try {
    await w.pollOnce();
    return {
      calls,
      callsAtFirstTurn,
      bodies,
      published,
      status: current.status,
      failure: current.failure_code,
    };
  } finally {
    await w.stop();
    for (const s of [backend, provider]) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
  }
}
const requestEvidence = (body: any) => {
  const user = body.messages.find(
    (m: any) =>
      m.role === "user" && text(m).includes("acquired_photo_evidence"),
  );
  assert.ok(user, "request context carries acquired_photo_evidence");
  return JSON.parse(text(user)).acquired_photo_evidence;
};
const listed = (id: string, name: string, created: string) => ({
  _id: id,
  type: "media",
  name,
  status: "complete",
  created_at: created,
  completed_at: created,
});

test("a photo-review chat request reads the newest media through the exact backend handles and the provider receives the pixels on its first turn", async () => {
  const shots = await Promise.all([7, 8, 9].map(png));
  const handles: Record<string, Buffer> = {
    "orig-handle-1": shots[0],
    "orig-handle-2": shots[1],
    "orig-prior-1": shots[2],
  };
  const r = await requestRun("Please review my check-in photos", (name, a) => {
    if (name === "coach_list_activities")
      return {
        structuredContent: {
          schema_version: 1,
          items: [
            listed(M(2), "Weekly check-in", "2026-10-09T08:00:00.000Z"),
            listed(P(2), "Progress selfie", "2026-10-06T08:00:00.000Z"),
            listed(P(1), "Weekly check-in", "2026-10-02T08:00:00.000Z"),
          ],
          has_more: false,
          next_cursor: null,
        },
      };
    if (name === "coach_read_activity" && a.activity_id === M(2))
      return {
        structuredContent: {
          items: [
            { type: "image", media_ref: "orig-handle-1" },
            {
              type: "image",
              media_unavailable: "Original media consent required",
            },
            { type: "video", media_ref: "orig-video" },
            { type: "image", media_ref: "orig-handle-2" },
          ],
          has_more: false,
        },
      };
    if (name === "coach_read_activity" && a.activity_id === P(1))
      return {
        structuredContent: {
          items: [{ type: "image", media_ref: "orig-prior-1" }],
          has_more: false,
        },
      };
    if (name === "coach_read_media" && handles[a.media_ref])
      return {
        content: [
          {
            type: "image",
            data: handles[a.media_ref].toString("base64"),
            mimeType: "image/png",
          },
        ],
      };
    return mcpError("READ_NOT_FOUND");
  });
  assert.equal(r.status, "completed");
  assert.equal(r.published, "Synthetic photo feedback.");
  const strip = ({ request_id, lease_generation, ...rest }: any) => rest;
  assert.deepEqual(
    r.calls.map((c) => [c.name, strip(c.args)]),
    [
      // No statuses or dates: the backend's default, request-anchored window.
      ["coach_list_activities", { types: ["media"], limit: 10 }],
      ["coach_read_activity", { activity_id: M(2), section: "media_files" }],
      ["coach_read_media", { media_ref: "orig-handle-1" }],
      ["coach_read_media", { media_ref: "orig-handle-2" }],
      ["coach_read_activity", { activity_id: P(1), section: "media_files" }],
      ["coach_read_media", { media_ref: "orig-prior-1" }],
    ],
  );
  assert.equal(
    r.callsAtFirstTurn,
    r.calls.length,
    "all reads precede the model",
  );
  assert.deepEqual(images(r.bodies[0]), shots);
  assert.match(system(r.bodies[0]), /already read 3 authorized images/);
  const acquired = requestEvidence(r.bodies[0]);
  assert.equal(acquired.request_created_at, "2026-10-09T18:05:00.000Z");
  assert.equal(acquired.images_attached, 3);
  const [today, before] = acquired.activities;
  assert.deepEqual(
    today.files.map((f: any) => [f.read, f.image_index]),
    [
      ["ok", [1]],
      ["consent_required", undefined],
      ["not_image", undefined],
      ["ok", [2]],
    ],
  );
  assert.equal(before.role, "prior_comparable");
  assert.equal(before.activity_id, P(1));
  assert.deepEqual(before.files[0].image_index, [3]);
  // Backend originals and host aliases never reach the provider.
  assert.doesNotMatch(JSON.stringify(r.bodies), /orig-handle|mr:[a-f0-9]{16}/);
});

test("request photo denial and unavailability stay distinct and the model is told nothing was inspected", async () => {
  const r = await requestRun(
    "Can you look at my progress photos?",
    (name, a) => {
      if (name === "coach_list_activities")
        return {
          structuredContent: {
            items: [
              listed(M(3), "Check-in", "2026-10-09T08:00:00.000Z"),
              listed(M(4), "Check-in", "2026-10-08T08:00:00.000Z"),
              listed(M(5), "Check-in", "2026-10-07T08:00:00.000Z"),
            ],
            has_more: false,
          },
        };
      if (name === "coach_read_activity" && a.activity_id === M(3))
        return mcpError("READ_NOT_AUTHORIZED");
      if (name === "coach_read_activity" && a.activity_id === M(4))
        return {
          structuredContent: {
            items: [
              { type: "image", media_ref: "denied-handle" },
              { type: "image", media_ref: "gone-handle" },
            ],
          },
        };
      if (name === "coach_read_activity" && a.activity_id === M(5))
        return { structuredContent: { items: [] } };
      if (name === "coach_read_media" && a.media_ref === "denied-handle")
        return mcpError("READ_NOT_AUTHORIZED");
      if (name === "coach_read_media" && a.media_ref === "gone-handle")
        return mcpError("SOMETHING_ELSE");
    },
  );
  assert.equal(r.status, "completed");
  assert.equal(images(r.bodies[0]).length, 0);
  assert.match(system(r.bodies[0]), /no image pixels were delivered/);
  const acquired = requestEvidence(r.bodies[0]);
  assert.deepEqual(
    acquired.activities.map((x: any) => [
      x.activity_id,
      x.read,
      x.photos,
      x.files?.map((f: any) => f.read),
    ]),
    [
      [M(3), "denied", undefined, undefined],
      [M(4), "ok", "listed", ["denied", "unavailable"]],
      [M(5), "ok", "empty", []],
    ],
  );
  assert.deepEqual(acquired.prior_comparable, {
    read: "not_attempted",
    reason: "no_current_photo",
  });
});

test("request photo acquisition is skipped for non-photo or attachment-carrying requests and reads nothing when provider vision is off", async () => {
  const none = await requestRun("How was my meal yesterday?", () =>
    assert.fail("no host photo read for a non-photo request"),
  );
  assert.equal(none.status, "completed");
  assert.deepEqual(none.calls, []);
  assert.doesNotMatch(
    JSON.stringify(none.bodies[0]),
    /acquired_photo_evidence/,
  );
  const attached = await requestRun(
    "Please review these photos",
    () => assert.fail("message attachments keep the model-read image budget"),
    true,
    2,
  );
  assert.equal(attached.status, "completed");
  assert.deepEqual(attached.calls, []);
  assert.doesNotMatch(
    JSON.stringify(attached.bodies[0]),
    /acquired_photo_evidence/,
  );
  const blind = await requestRun(
    "Please review my check-in photos",
    () => assert.fail("no host photo read without provider vision"),
    false,
  );
  assert.equal(blind.status, "completed");
  assert.deepEqual(blind.calls, []);
  assert.equal(images(blind.bodies[0]).length, 0);
  assert.equal(
    requestEvidence(blind.bodies[0]).read,
    "not_read_vision_disabled",
  );
});

test("the Pi adapter never silently drops acquired images for a provider without vision", async () => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(
      complete(
        {
          baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
          model: "synthetic-text-model",
          apiKey: "synthetic-provider-credential",
          vision: false,
        },
        "system",
        "context",
        AbortSignal.timeout(5000),
        [],
        {
          images: [
            {
              type: "image",
              data: (await png(1)).toString("base64"),
              mimeType: "image/png",
            },
          ],
        },
      ),
      /VISION_UNSUPPORTED/,
    );
    assert.equal(requests, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
