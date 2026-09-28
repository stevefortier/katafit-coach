import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { StudioReads } from "../src/katafit/studio.js";

const charts = (weight: number, unit: string) => ({
  training: [{ date: "2026-09-20", completed_workouts: 2, completed_sets: 5 }],
  nutrition: [
    {
      date: "2026-09-20",
      logged_meals: 3,
      recorded_calories: 0,
      recorded_protein_g: 48,
    },
  ],
  body: [
    {
      date: "2026-09-20",
      type_id: "weight",
      value: weight,
      unit,
      unit_provenance: "measurement_unit",
    },
  ],
  limitations:
    "UTC completion-date activity counts (creation fallback), not adherence.",
});

test("bounded pages report partial roster rather than inventing a total", async () => {
  let page = 0;
  const reads = new StudioReads(
    {
      connect: async () => {},
      call: async (name: string, args: any) => {
        assert.equal(name, "studio_dashboard_overview");
        assert.equal(args.cursor, page ? `page-${page}` : undefined);
        page++;
        return {
          schema_version: 1,
          owner_type: "dojo",
          period_days: 30,
          members: Array.from({ length: 10 }, (_, i) => ({
            member_ref: `opaque-${page}-${i}`,
            display_name: `Synthetic ${page}-${i}`,
            category_access: {
              training: "not_shared",
              nutrition: "not_shared",
              body: "not_shared",
            },
            charts: {
              training: null,
              nutrition: null,
              body: null,
              limitations: null,
            },
            photo_access: "not_shared",
            photos: [],
          })),
          has_more: true,
          next_cursor: `page-${page}`,
        };
      },
    },
    [],
  );
  const snapshot = await reads.dashboard();
  assert.equal(page, 10);
  assert.equal(snapshot.members.length, 100);
  assert.deepEqual(snapshot.coverage, {
    roster_total: 100,
    media_shared: 0,
    category_shared: { training: 0, nutrition: 0, body: 0 },
    complete: false,
  });
  assert.deepEqual(snapshot.series, {
    training: [],
    nutrition: [],
    body_measurements: [],
  });
});

test("served authenticated dashboard follows pages, keeps units apart and reauthorizes photo bytes", async () => {
  const home = await mkdtemp(tmpdir() + "/studio-dashboard-");
  const bytes = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "#285884" },
  })
    .png()
    .toBuffer();
  const metadata = {
    schema_version: 1,
    representation: "original",
    mime_type: "image/png",
    byte_count: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width: 2,
    height: 2,
  };
  let shared = true,
    denied = false,
    slow = false,
    largeRoster = false;
  let release: (() => void) | undefined, entered: (() => void) | undefined;
  const calls: string[] = [];
  const backend = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    res.setHeader("Content-Type", "application/json");
    if (!request.id) {
      res.writeHead(202);
      res.end();
      return;
    }
    let result: any = { protocolVersion: "2025-03-26" };
    if (request.method === "tools/call") {
      const { name, arguments: args } = request.params;
      calls.push(name);
      assert.equal(
        req.headers.authorization,
        "Bearer synthetic-dashboard-token",
      );
      entered?.();
      if (slow)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (denied)
        result = {
          isError: true,
          content: [{ type: "text", text: "PRIVATE BACKEND DATA" }],
        };
      else if (name === "studio_dashboard_overview") {
        if (largeRoster) {
          const page = Number(args.cursor ?? 0);
          result = {
            structuredContent: {
              schema_version: 1,
              owner_type: "dojo",
              period_days: 30,
              members: Array.from({ length: 10 }, (_, i) => ({
                member_ref: `member-${page * 10 + i}`,
                display_name: "Synthetic",
                category_access: {
                  training: "not_shared",
                  nutrition: "not_shared",
                  body: "not_shared",
                },
                charts: {
                  training: null,
                  nutrition: null,
                  body: null,
                  limitations: null,
                },
                photo_access: "not_shared",
                photos: [],
              })),
              has_more: true,
              next_cursor: String(page + 1),
            },
          };
        } else {
          const first = !args.cursor;
          result = {
            structuredContent: {
              schema_version: 1,
              owner_type: "dojo",
              period_days: 30,
              members: first
                ? [
                    {
                      member_ref: "one",
                      display_name: "Synthetic Ada",
                      category_access: {
                        training: "shared",
                        nutrition: "shared",
                        body: "shared",
                      },
                      charts: charts(80, "kg"),
                      photo_access: shared ? "shared" : "not_shared",
                      photos: shared
                        ? [
                            {
                              media_ref: "media-one",
                              checkin_at: "2026-09-20T12:00:00Z",
                            },
                            {
                              media_ref: "media-two",
                              checkin_at: "2026-09-20T12:00:00Z",
                            },
                          ]
                        : [],
                    },
                    {
                      member_ref: "two",
                      display_name: "Synthetic Bea",
                      category_access: {
                        training: "not_shared",
                        nutrition: "not_shared",
                        body: "not_shared",
                      },
                      charts: {
                        training: null,
                        nutrition: null,
                        body: null,
                        limitations: null,
                      },
                      photo_access: "not_shared",
                      photos: [],
                    },
                  ]
                : [
                    {
                      member_ref: "three",
                      display_name: "Synthetic Cy",
                      category_access: {
                        training: "shared",
                        nutrition: "shared",
                        body: "shared",
                      },
                      charts: charts(180, "lb"),
                      photo_access: "shared",
                      photos: [],
                    },
                  ],
              has_more: first,
              next_cursor: first ? "second-page" : null,
            },
          };
        }
      } else if (
        name === "studio_dashboard_read_photo" &&
        shared &&
        (args.member_ref === "one" ||
          (largeRoster && args.member_ref === "member-100")) &&
        ["media-one", "media-two"].includes(args.media_ref)
      )
        result = {
          structuredContent: metadata,
          content: [
            { type: "text", text: JSON.stringify(metadata) },
            {
              type: "image",
              mimeType: "image/png",
              data: bytes.toString("base64"),
            },
          ],
        };
      else
        result = {
          isError: true,
          content: [{ type: "text", text: "PRIVATE DENIAL" }],
        };
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  let app: Awaited<ReturnType<typeof admin>> | undefined;
  try {
    const store = new Store(home);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin: `http://127.0.0.1:${(backend.address() as any).port}`,
      token: "synthetic-dashboard-token",
    });
    app = await admin(store, 0);
    const origin = app.origin;
    const headers = { Authorization: `Bearer ${store.secrets.admin}` };
    assert.equal((await fetch(origin + "/dashboard")).status, 200);
    assert.equal((await fetch(origin + "/dashboard.js")).status, 200);
    assert.equal((await fetch(origin + "/api/dashboard")).status, 401);
    assert.equal(
      (
        await fetch(origin + "/api/dashboard", {
          headers: { ...headers, Origin: "https://attacker.invalid" },
        })
      ).status,
      403,
    );
    const response = await fetch(origin + "/api/dashboard", { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const data = await response.json();
    assert.deepEqual(data.coverage, {
      roster_total: 3,
      media_shared: 2,
      category_shared: { training: 2, nutrition: 2, body: 2 },
      complete: true,
    });
    assert.equal(data.members[1].media, "not_shared");
    assert.deepEqual(data.members[1].category_access, {
      training: "not_shared",
      nutrition: "not_shared",
      body: "not_shared",
    });
    assert.deepEqual(data.members[0].photos, [
      { media_ref: "media-one", captured_at: "2026-09-20T12:00:00Z" },
      { media_ref: "media-two", captured_at: "2026-09-20T12:00:00Z" },
    ]);
    assert.deepEqual(data.members[2].photos, []);
    assert.deepEqual(
      data.series.body_measurements.map((s: any) => s.unit).sort(),
      ["kg", "lb"],
    );
    assert.deepEqual(data.series.training[0].points[0], {
      date: "2026-09-20",
      value: 4,
      contributor_count: 2,
    });
    assert.deepEqual(
      data.series.training.find((s: any) => s.label === "Completed sets")
        .points[0],
      {
        date: "2026-09-20",
        value: 10,
        contributor_count: 2,
      },
    );
    assert.deepEqual(
      data.series.nutrition.find((s: any) => s.label === "Recorded calories")
        .points[0],
      {
        date: "2026-09-20",
        value: 0,
        contributor_count: 2,
      },
    );
    assert.deepEqual(
      data.series.nutrition.find((s: any) => s.label === "Recorded protein")
        .points[0],
      {
        date: "2026-09-20",
        value: 96,
        contributor_count: 2,
      },
    );
    assert.doesNotMatch(
      JSON.stringify(data),
      /PRIVATE|synthetic-dashboard-token/,
    );
    assert.equal(
      calls.filter((name) => name === "studio_dashboard_overview").length,
      2,
    );
    for (const url of [
      "/api/dashboard?x=y",
      "/api/dashboard/photo?member_ref=one",
      "/api/dashboard/photo?member_ref=one&media_ref=media-one&extra=1",
    ])
      assert.notEqual((await fetch(origin + url, { headers })).status, 200);
    const photo = (member: string, ref: string) =>
      fetch(
        origin + `/api/dashboard/photo?member_ref=${member}&media_ref=${ref}`,
        { headers },
      );
    assert.equal((await photo("two", "media-one")).status, 404);
    const image = await photo("one", "media-one");
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("cache-control"), "no-store");
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
    const second = await photo("one", "media-two");
    assert.equal(second.status, 200);
    assert.deepEqual(Buffer.from(await second.arrayBuffer()), bytes);
    largeRoster = true;
    const capped = await fetch(origin + "/api/dashboard", { headers });
    assert.equal(capped.status, 200);
    const partial = await capped.json();
    assert.equal(partial.members.length, 100);
    assert.equal(partial.coverage.complete, false);
    assert.ok(!partial.members.some((m: any) => m.member_ref === "member-100"));
    const beforeLarge = calls.filter(
      (name) => name === "studio_dashboard_overview",
    ).length;
    const beyondSnapshot = await photo("member-100", "media-two");
    assert.equal(beyondSnapshot.status, 200);
    assert.deepEqual(Buffer.from(await beyondSnapshot.arrayBuffer()), bytes);
    assert.equal(
      calls.filter((name) => name === "studio_dashboard_overview").length,
      beforeLarge,
      "photo bytes must not trigger roster paging even when roster exceeds 100",
    );
    largeRoster = false;
    assert.ok(calls.includes("studio_dashboard_read_photo"));
    shared = false;
    assert.equal((await photo("one", "media-one")).status, 404);
    denied = true;
    const failure = await fetch(origin + "/api/dashboard", { headers });
    assert.notEqual(failure.status, 200);
    assert.doesNotMatch(await failure.text(), /PRIVATE/);
    denied = false;
    slow = true;
    const pendingReached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = fetch(origin + "/api/dashboard", { headers });
    await pendingReached;
    const saved = await fetch(origin + "/api/config", {
      method: "POST",
      headers: {
        ...headers,
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...store.publicConfig(),
        persona: {
          ...store.publicConfig().persona,
          voice: "synthetic changed revision",
        },
      }),
    });
    assert.equal(saved.status, 200);
    slow = false;
    release?.();
    assert.notEqual((await pending).status, 200);
  } finally {
    await app?.close();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

test("category authorization keeps partial graphs and independent media", async () => {
  const member = {
    member_ref: "partial",
    display_name: "Partial member",
    category_access: {
      training: "shared",
      nutrition: "not_shared",
      body: "shared",
    },
    charts: { ...charts(74, "kg"), nutrition: null },
    photo_access: "not_shared",
    photos: [],
  };
  const reads = new StudioReads(
    {
      connect: async () => {},
      call: async () => ({
        schema_version: 1,
        owner_type: "dojo",
        period_days: 30,
        members: [member],
        has_more: false,
        next_cursor: null,
      }),
    },
    [],
  );
  const data = await reads.dashboard();
  assert.deepEqual(data.coverage.category_shared, {
    training: 1,
    nutrition: 0,
    body: 1,
  });
  assert.deepEqual(data.members[0].category_access, member.category_access);
  assert.equal(data.members[0].media, "not_shared");
  assert.equal(data.series.training[0].points[0].contributor_count, 1);
  assert.equal(data.series.nutrition.length, 0);
  assert.equal(data.series.body_measurements.length, 1);
});

test("category access cannot disagree with individual chart availability", async () => {
  const member = {
    member_ref: "partial",
    display_name: "Partial member",
    category_access: {
      training: "shared",
      nutrition: "not_shared",
      body: "shared",
    },
    charts: { ...charts(74, "kg"), nutrition: null },
    photo_access: "shared",
    photos: [],
  };
  for (const invalid of [
    { ...member, charts: { ...member.charts, training: null } },
    { ...member, charts: { ...member.charts, nutrition: [] } },
    {
      ...member,
      category_access: { ...member.category_access, body: "not_shared" },
    },
    {
      ...member,
      category_access: { ...member.category_access, training: "unknown" },
    },
    { ...member, stats_access: "shared" },
  ]) {
    const reads = new StudioReads(
      {
        connect: async () => {},
        call: async () => ({
          schema_version: 1,
          owner_type: "dojo",
          period_days: 30,
          members: [invalid],
          has_more: false,
          next_cursor: null,
        }),
      },
      [],
    );
    await assert.rejects(() => reads.dashboard(), { code: "RESULT_REJECTED" });
  }
});
