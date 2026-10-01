import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

test("served dashboard uses ordinary feed, social detail and binary media with backend denial", async () => {
  const home = await mkdtemp(tmpdir() + "/rest-dashboard-");
  const image = await sharp({
    create: { width: 341, height: 512, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const calls: string[] = [];
  let denied = false;
  const backend = createServer((req, res) => {
    calls.push(req.url!);
    assert.equal(req.headers.authorization, "Bearer synthetic-rest-token");
    res.setHeader("content-type", "application/json");
    if (denied) {
      res.writeHead(403);
      res.end('{"secret":"upstream-private"}');
      return;
    }
    if (req.url === "/api/friends/dojo/dashboard-members")
      res.end(
        JSON.stringify({
          members: [
            {
              _id: "member",
              display_name: "Ada",
              stats: null,
              last_position: null,
            },
          ],
        }),
      );
    else if (
      req.url === "/api/friends/feed/dojo?limit=20" ||
      req.url ===
        "/api/friends/dojo/positioned-activities?start=2026-09-28T04%3A00%3A00.000Z&end=2026-09-29T04%3A00%3A00.000Z&limit=100" ||
      req.url ===
        "/api/friends/dojo/positioned-activities?start=2026-09-28T04%3A00%3A00.000Z&end=2026-09-29T04%3A00%3A00.000Z&limit=100&cursor=opaque-cursor" ||
      req.url ===
        "/api/friends/dojo/positioned-activities?start=2026-11-01T04%3A00%3A00.000Z&end=2026-11-02T05%3A00%3A00.000Z&limit=100"
    )
      res.end(
        JSON.stringify({
          users: [{ _id: "member", display_name: "Ada" }],
          activities: [{ _id: "act", user_id: "member", type: "media" }],
          hasMore: false,
        }),
      );
    else if (req.url?.startsWith("/api/friends/dojo/day-events?"))
      res.end(
        JSON.stringify({
          users: [{ _id: "member", display_name: "Ada" }],
          events: [{ id: "act", user_id: "member", event_type: "food_added" }],
          hasMore: false,
          nextCursor: null,
        }),
      );
    else if (req.url === "/api/friends/activity/act")
      res.end(
        JSON.stringify({
          _id: "act",
          type: "media",
          data: { files: [{ _id: "file", type: "image/png" }] },
        }),
      );
    else if (
      req.url === "/api/media/act/files/file" ||
      req.url === "/api/users/aaaaaaaaaaaaaaaaaaaaaaaa/avatar/512"
    ) {
      res.setHeader("content-type", "image/png");
      res.end(image);
    } else {
      res.writeHead(404);
      res.end("{}");
    }
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(backend.address() as any).port}`,
    token: "synthetic-rest-token",
  });
  const server = await admin(store, 0);
  const base = server.origin;
  const headers = { Authorization: `Bearer ${store.secrets.admin}` };
  try {
    assert.equal((await fetch(base + "/api/dashboard")).status, 401);
    assert.equal(
      (await fetch(base + "/api/dashboard/map?date=2026-09-28")).status,
      401,
    );
    assert.equal((await fetch(base + "/leaflet.js")).status, 200);
    assert.match(
      await (await fetch(base + "/leaflet.css")).text(),
      /leaflet-container/,
    );
    const dashboardPage = await fetch(base + "/dashboard");
    assert.equal(
      dashboardPage.headers.get("referrer-policy"),
      "strict-origin-when-cross-origin",
    );
    assert.match(
      dashboardPage.headers.get("content-security-policy") || "",
      /https:\/\/tile\.openstreetmap\.org/,
    );
    assert.equal(
      (await fetch(base + "/api/dashboard/avatar?id=aaaaaaaaaaaaaaaaaaaaaaaa"))
        .status,
      401,
    );
    const avatar = await fetch(
      base + "/api/dashboard/avatar?id=aaaaaaaaaaaaaaaaaaaaaaaa",
      { headers },
    );
    assert.equal(avatar.status, 200);
    assert.equal(avatar.headers.get("content-type"), "image/png");
    const avatarBytes = Buffer.from(await avatar.arrayBuffer());
    assert.deepEqual(avatarBytes, image);
    const avatarMetadata = await sharp(avatarBytes).metadata();
    assert.deepEqual(
      [avatarMetadata.width, avatarMetadata.height],
      [341, 512],
      "avatar response preserves actual larger upstream bytes and aspect ratio",
    );
    const callsBeforeInvalidAvatars = calls.length;
    for (const query of [
      "",
      "?id=../x",
      "?id=" + "a".repeat(23),
      "?id=" + "a".repeat(25),
      "?id=" + "A".repeat(24),
      "?id=" + "g".repeat(24),
      "?id=aaaaaaaaaaaaaaaaaaaaaaaa&id=bbbbbbbbbbbbbbbbbbbbbbbb",
      "?id=aaaaaaaaaaaaaaaaaaaaaaaa&size=1024",
      "?id=aaaaaaaaaaaaaaaaaaaaaaaa&original=true",
      "?id=aaaaaaaaaaaaaaaaaaaaaaaa&redirect=https://example.org",
    ])
      assert.equal(
        (await fetch(base + "/api/dashboard/avatar" + query, { headers }))
          .status,
        400,
        `malformed avatar query must be rejected: ${query}`,
      );
    assert.equal(
      calls.length,
      callsBeforeInvalidAvatars,
      "malformed and caller-selected sizes never reach upstream",
    );
    assert.equal(
      (await fetch(base + "/api/dashboard/avatar?id=../x", { headers })).status,
      400,
    );
    const feed = await fetch(base + "/api/dashboard", { headers });
    assert.equal(feed.status, 200);
    assert.equal((await feed.json()).users[0].display_name, "Ada");
    assert.equal((await fetch(base + "/api/dashboard/members")).status, 401);
    const members = await fetch(base + "/api/dashboard/members", { headers });
    assert.equal(members.status, 200);
    assert.deepEqual(
      (await members.json()).members.map((member: any) => member._id),
      ["member"],
    );
    const mapDay =
      "date=2026-09-28&start=2026-09-28T04%3A00%3A00.000Z&end=2026-09-29T04%3A00%3A00.000Z";
    const map = await fetch(base + "/api/dashboard/map?" + mapDay, { headers });
    assert.equal(map.status, 200);
    assert.equal((await map.json()).users[0].display_name, "Ada");
    const timeline = await fetch(
      base + "/api/dashboard/timeline?" + mapDay + "&cursor=payload.signature",
      { headers },
    );
    assert.equal(timeline.status, 200);
    assert.equal((await timeline.json()).events[0].id, "act");
    const cursor = await fetch(
      base + "/api/dashboard/map?" + mapDay + "&cursor=opaque-cursor",
      { headers },
    );
    assert.equal(cursor.status, 200);
    assert.equal((await cursor.json()).activities[0]._id, "act");
    const dst = await fetch(
      base +
        "/api/dashboard/map?date=2026-11-01&start=2026-11-01T04%3A00%3A00.000Z&end=2026-11-02T05%3A00%3A00.000Z",
      { headers },
    );
    assert.equal(
      dst.status,
      200,
      "25-hour local day preserves exact backend bounds",
    );
    const detail = await fetch(base + "/api/dashboard/activity?id=act", {
      headers,
    });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).data.files.length, 1);
    const photo = await fetch(
      base + "/api/dashboard/photo?activity_id=act&file_id=file",
      { headers },
    );
    assert.equal(photo.status, 200);
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), image);
    assert.deepEqual(calls, [
      "/api/users/aaaaaaaaaaaaaaaaaaaaaaaa/avatar/512",
      "/api/friends/feed/dojo?limit=20",
      "/api/friends/dojo/dashboard-members",
      "/api/friends/dojo/positioned-activities?start=2026-09-28T04%3A00%3A00.000Z&end=2026-09-29T04%3A00%3A00.000Z&limit=100",
      "/api/friends/dojo/day-events?start=2026-09-28T04%3A00%3A00.000Z&end=2026-09-29T04%3A00%3A00.000Z&limit=100&cursor=payload.signature",
      "/api/friends/dojo/positioned-activities?start=2026-09-28T04%3A00%3A00.000Z&end=2026-09-29T04%3A00%3A00.000Z&limit=100&cursor=opaque-cursor",
      "/api/friends/dojo/positioned-activities?start=2026-11-01T04%3A00%3A00.000Z&end=2026-11-02T05%3A00%3A00.000Z&limit=100",
      "/api/friends/activity/act",
      "/api/media/act/files/file",
    ]);
    denied = true;
    const deniedPhoto = await fetch(
      base + "/api/dashboard/photo?activity_id=act&file_id=file",
      { headers },
    );
    assert.equal(deniedPhoto.status, 403);
    assert.ok(!(await deniedPhoto.text()).includes("upstream-private"));
    const deniedAvatar = await fetch(
      base + "/api/dashboard/avatar?id=aaaaaaaaaaaaaaaaaaaaaaaa",
      { headers },
    );
    assert.equal(deniedAvatar.status, 403);
    assert.ok(!(await deniedAvatar.text()).includes("upstream-private"));
    const deniedMap = await fetch(base + "/api/dashboard/map?" + mapDay, {
      headers,
    });
    assert.equal(deniedMap.status, 403);
    assert.ok(!(await deniedMap.text()).includes("upstream-private"));
    const deniedMembers = await fetch(base + "/api/dashboard/members", {
      headers,
    });
    assert.equal(deniedMembers.status, 403);
    assert.ok(!(await deniedMembers.text()).includes("upstream-private"));
    assert.ok(
      !calls.some(
        (p) =>
          p.startsWith("/api/activities/") ||
          p.includes("mcp") ||
          p.includes("users/me"),
      ),
    );
    for (const path of [
      "/api/dashboard/map?date=2026-02-30",
      "/api/dashboard/map?" + mapDay + "&cursor=!!!",
      "/api/dashboard/map?" + mapDay + "&cursor=payload.signature",
      "/api/dashboard/timeline?" + mapDay + "&cursor=!!!",
      "/api/dashboard/timeline?" + mapDay + "&cursor=" + "x".repeat(4097),
      "/api/dashboard/map?" + mapDay + "&cursor=" + "x".repeat(513),
      "/api/dashboard/map?" + mapDay + "&date=2026-09-27",
      "/api/dashboard/map?" + mapDay + "&redirect=https://example.org",
      "/api/dashboard/map?date=2026-09-28",
      "/api/dashboard/map?date=2026-09-28&start=2026-09-25T04%3A00%3A00.000Z&end=2026-09-26T04%3A00%3A00.000Z",
      "/api/dashboard/map?date=2026-09-28&start=2026-09-28T04%3A00%3A00.000Z&end=2026-09-30T04%3A00%3A00.000Z",
      "/api/dashboard/photo?activity_id=..&file_id=file",
      "/api/dashboard/activity?id=act&headers=x",
      "/api/dashboard/members?member_id=member",
    ])
      assert.equal((await fetch(base + path, { headers })).status, 400);
  } finally {
    await server.close();
    await new Promise<void>((r) => backend.close(() => r()));
    await rm(home, { recursive: true, force: true });
  }
});
