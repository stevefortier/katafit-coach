import { chromium } from "playwright-core";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

test("human activity BFF preserves typed details and original image; rejects mismatches", async () => {
  const home = await mkdtemp(tmpdir() + "/studio-activity-");
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
    "base64",
  );
  const metadata = {
    schema_version: 1,
    representation: "original",
    mime_type: "image/png",
    byte_count: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width: 1,
    height: 1,
  };
  const activity = {
    activity_ref: "opaque-activity",
    type: "workout",
    name: "Squat",
  };
  const set = {
    _id: "set1",
    exercise_instance_id: "exercise1",
    weight: 80,
    repetitions: 5,
    weight_unit: "kg",
    complete: true,
  };
  let corrupt = "";
  const calls: any[] = [];
  const backend = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const b = JSON.parse(raw);
    let result: any = { protocolVersion: "2025-03-26" };
    if (!b.id) {
      res.writeHead(202);
      res.end();
      return;
    }
    if (b.method === "tools/call") {
      calls.push(b.params);
      const name = b.params.name;
      const dto: any = {
        schema_version: 1,
        member_ref: "member",
        items: [],
        has_more: false,
        next_cursor: null,
      };
      if (name === "studio_list_member_activities") dto.items = [activity];
      if (name === "studio_read_member_activity") {
        dto.activity = activity;
        dto.section = b.params.arguments.section;
        dto.items = [set];
        if (corrupt === "field")
          dto.items[0] = { ...set, url: "https://private.invalid" };
      }
      if (name === "studio_read_member_coach_feed") {
        dto.coverage = "retained_main_coach_feed";
        dto.limitations = [];
        dto.items = [
          {
            id: "turn",
            type: "message",
            role: "user",
            text: "hello",
            created_at: new Date().toISOString(),
            activity_ref: "opaque-activity",
          },
        ];
      }
      result = { structuredContent: dto };
      if (name === "studio_read_member_media")
        result = {
          structuredContent: {
            ...metadata,
            ...(corrupt === "hash"
              ? { sha256: "0".repeat(64) }
              : corrupt === "dimensions"
                ? { width: 2 }
                : corrupt === "mime"
                  ? { mime_type: "image/jpeg" }
                  : {}),
          },
          content: [
            { type: "text", text: JSON.stringify(metadata) },
            {
              type: "image",
              mimeType: "image/png",
              data:
                corrupt === "bytes"
                  ? Buffer.from("not image").toString("base64")
                  : bytes.toString("base64"),
            },
          ],
        };
    }
    if (result.content)
      result.content[0].text = JSON.stringify(result.structuredContent);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: b.id, result }));
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  let app: any;
  try {
    const store = new Store(home);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin: `http://127.0.0.1:${(backend.address() as any).port}`,
      token: "synthetic-activity-token",
    });
    app = await admin(store, 0);
    const get = (p: string, auth = true) =>
      fetch(app.origin + p, {
        headers: auth ? { Authorization: "Bearer " + store.secrets.admin } : {},
      });
    assert.match(
      (await get("/")).headers.get("content-security-policy")!,
      /img-src 'self' blob:/,
    );
    const list = "/api/members/activities?member_ref=member";
    assert.equal((await get(list, false)).status, 401);
    let r = await get(list);
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).items, [activity]);
    r = await get(
      "/api/members/activity?member_ref=member&activity_ref=opaque-activity&section=workout_sets&exercise_instance_id=exercise1",
    );
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).items, [set]);
    assert.equal(
      (await (await get("/api/members/feed?member_ref=member")).json()).items[0]
        .activity_ref,
      "opaque-activity",
    );
    const media = "/api/members/media?member_ref=member&media_ref=opaque-media";
    r = await get(media);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/png");
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes);
    const browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await page.goto(app.origin);
      const image = await page.evaluate(
        async ({ media, admin }) => {
          const response = await fetch(media, {
            headers: { Authorization: "Bearer " + admin },
          });
          const blob = await response.blob(),
            url = URL.createObjectURL(blob),
            img = new Image();
          try {
            const loaded = await new Promise<boolean>((resolve) => {
              img.onload = () => resolve(true);
              img.onerror = () => resolve(false);
              img.src = url;
              document.body.append(img);
            });
            return {
              loaded,
              width: img.naturalWidth,
              height: img.naturalHeight,
              mime: blob.type,
            };
          } finally {
            img.remove();
            URL.revokeObjectURL(url);
          }
        },
        { media, admin: store.secrets.admin },
      );
      assert.deepEqual(image, {
        loaded: true,
        width: 1,
        height: 1,
        mime: "image/png",
      });
    } finally {
      await browser.close();
    }
    for (const bad of ["hash", "dimensions", "mime", "bytes"]) {
      corrupt = bad;
      assert.notEqual((await get(media)).status, 200, bad);
    }
    corrupt = "field";
    assert.notEqual(
      (
        await get(
          "/api/members/activity?member_ref=member&activity_ref=opaque-activity&section=workout_sets",
        )
      ).status,
      200,
    );
    const count = calls.length;
    for (const p of [
      list + "&url=https://evil.invalid",
      media + "&media_ref=other",
      "/api/members/activity?member_ref=member",
      "/api/members/activity?member_ref=member&activity_ref=a&section=invalid",
    ])
      assert.notEqual((await get(p)).status, 200);
    assert.equal(calls.length, count);
  } finally {
    await app?.close();
    backend.closeAllConnections();
    await new Promise<void>((r) => backend.close(() => r()));
    await rm(home, { recursive: true, force: true });
  }
});
