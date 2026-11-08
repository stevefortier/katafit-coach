import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fixture,
  ada,
  bob,
  ev,
  gps,
  type Event,
} from "./helpers/exact-map-fixture.js";

const evidence = process.env.MEMBER_CENTER_EVIDENCE_DIR;
const stamp = "2026-09-28T06:00:00.000Z";
const latestStamp = "2026-10-01T06:00:00.000Z";
const users = [
  { _id: ada, display_name: "Synthetic Ada" },
  { _id: bob, display_name: "Synthetic Bob" },
];
type Fix = [number, number];
const latest: Fix = [40.71, -73.94];
const anchors: Fix[] = [
  [40.701, -73.92],
  [40.702, -73.91],
  [40.702, -73.91],
];
const rows = (fixes: Fix[]): Event[] =>
  fixes.map(([lat, lng], i) => ({
    id: ev(i + 1),
    user_id: ada,
    occurred_at: stamp,
    event_type: i === 0 ? "workout.set_completed" : "meal.food_added",
    subject: { type: i === 0 ? "workout" : "meal", id: ev(i + 10) },
    details: {},
    position: gps(lat, lng, stamp),
  }));
const body = (fix: Fix | null, status = "none") => ({
  members: [
    {
      user_id: ada,
      status: fix ? "located" : status,
      latest: fix
        ? {
            latitude: fix[0],
            longitude: fix[1],
            captured_at: latestStamp,
          }
        : null,
    },
    {
      user_id: bob,
      status: "located",
      latest: {
        latitude: -33.86,
        longitude: 151.21,
        captured_at: latestStamp,
      },
    },
  ],
});
const card = `.dashboard-member-card:has([data-member-id="${ada}"])`;
const camera = (page: any) =>
  page.evaluate(() => {
    const m = (window as any).fixtureMap;
    return { ...m.getCenter(), zoom: m.getZoom() };
  });
// Native Leaflet projection plus actual rendered dot/badge boxes. The oracle
// does not replicate the fit algorithm: it checks center, padding and rejects
// the next supported zoom if any extent is nondegenerate.
async function geometry(page: any, fix: Fix, points: Fix[]) {
  return page.evaluate(
    ({ fix, points }: { fix: Fix; points: Fix[] }) => {
      const m = (window as any).fixtureMap;
      const size = m.getSize(),
        c = m.getCenter(),
        z = m.getZoom();
      const near = ([lat, lng]: Fix) => [
        lat,
        lng + 360 * Math.round((c.lng - lng) / 360),
      ];
      const xy = (p: Fix) => {
        const q = m.latLngToContainerPoint(near(p));
        return { x: q.x, y: q.y };
      };
      const pad = { x: Math.min(48, size.x / 4), y: Math.min(48, size.y / 4) };
      const next = z + (m.options.zoomSnap || 1);
      const origin = m.project(near(fix), next);
      const nextOffsets = points.map((p) =>
        m.project(near(p), next).subtract(origin),
      );
      const mapNode = document.getElementById("dashboardMap")!;
      const rect = mapNode.getBoundingClientRect();
      const rendered = [
        ...document.querySelectorAll<HTMLElement>(
          ".dashboard-event-dot, .dashboard-map-group",
        ),
      ]
        .filter(
          (n) =>
            n.getClientRects().length &&
            !n.hidden &&
            !n.classList.contains("dashboard-filtered"),
        )
        .map((n) => {
          const r = n.getBoundingClientRect();
          return {
            id: n.dataset.eventId,
            count: Number(n.dataset.count || 1),
            x: r.left + r.width / 2 - rect.left - mapNode.clientLeft,
            y: r.top + r.height / 2 - rect.top - mapNode.clientTop,
          };
        });
      return {
        center: c,
        zoom: z,
        size,
        pad,
        latest: xy(fix),
        points: points.map(xy),
        rendered,
        nextOverflows: nextOffsets.some(
          (p) =>
            Math.abs(p.x) > size.x / 2 - pad.x ||
            Math.abs(p.y) > size.y / 2 - pad.y,
        ),
      };
    },
    { fix, points },
  );
}
async function assertGeometry(
  page: any,
  label: string,
  fix: Fix,
  points: Fix[],
  excludedIds: string[] = [],
) {
  const g = await geometry(page, fix, points);
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(
      join(evidence, `${label}.json`),
      JSON.stringify(g, null, 2),
    );
    await page
      .locator("#dashboardMap")
      .screenshot({ path: join(evidence, `${label}.png`) });
  }
  assert.ok(
    Math.abs(g.latest.x - g.size.x / 2) <= 1 &&
      Math.abs(g.latest.y - g.size.y / 2) <= 1,
    `latest centered: ${JSON.stringify(g)}`,
  );
  // The timeline category scopes focus, not the historical overlay itself.
  const represented = g.rendered.filter(
    (p: any) => !excludedIds.includes(p.id),
  );
  for (const p of [...g.points, ...represented]) {
    assert.ok(
      p.x >= g.pad.x - 1 && p.x <= g.size.x - g.pad.x + 1,
      `padded x: ${JSON.stringify(g)}`,
    );
    assert.ok(
      p.y >= g.pad.y - 1 && p.y <= g.size.y - g.pad.y + 1,
      `padded y: ${JSON.stringify(g)}`,
    );
  }
  assert.equal(
    represented.reduce((sum: number, p: any) => sum + p.count, 0),
    points.length,
    "every activity represented by a dot or exact-coordinate badge",
  );
  for (const p of represented)
    assert.ok(
      g.points.some((q: any) => Math.hypot(q.x - p.x, q.y - p.y) <= 1),
      "rendered anchor remains at native coordinate",
    );
  assert.ok(
    g.zoom <= 18 && (g.zoom === 18 || g.nextOverflows),
    `tight zoom: ${JSON.stringify(g)}`,
  );
  return g;
}
for (const width of [1440, 390]) {
  test(`member latest-centered asymmetric native geometry ${width}`, async () => {
    await fixture(
      async (page) => {
        await page.waitForSelector(
          `.dashboard-latest-pin[data-member-ids~="${ada}"]`,
        );
        const before = await camera(page);
        await page.locator(card).click();
        assert.deepEqual(
          await camera(page),
          before,
          "single selection is camera neutral",
        );
        await page.locator(card).dblclick();
        await assertGeometry(page, `asymmetric-${width}`, latest, anchors);
        assert.equal(
          await page
            .locator(`.dashboard-latest-pin[data-member-ids~="${bob}"]`)
            .count(),
          1,
          "other member still rendered, not part of fit",
        );
      },
      {
        events: rows(anchors),
        viewport: { width, height: 900 },
        override: (url) =>
          url.pathname === "/api/dashboard/latest-positions"
            ? { body: body(latest) }
            : undefined,
      },
    );
  });
}
for (const [label, fix, points] of [
  ["latest-only", latest, []],
  ["zero-extent", latest, [latest, latest]],
  [
    "dateline",
    [-17.2, 179.8],
    [
      [-17.3, -179.9],
      [-17.25, -179.7],
    ],
  ],
  [
    "high-latitude",
    [79, 10],
    [
      [80, 12],
      [80.5, 13],
    ],
  ],
] as [string, Fix, Fix[]][]) {
  test(`member fixed center ${label}`, async () => {
    await fixture(
      async (page) => {
        await page.waitForSelector(
          `.dashboard-latest-pin[data-member-ids~="${ada}"]`,
        );
        await page.locator(card).press("Shift+Enter");
        await assertGeometry(page, label, fix, points);
      },
      {
        events: rows(points),
        marks: null,
        override: (url) =>
          url.pathname === "/api/dashboard/latest-positions"
            ? { body: body(fix) }
            : undefined,
      },
    );
  });
}

test("latest stays independent of category and day; activity anchors follow both", async () => {
  const previous = rows([[48.85, 2.35]]).map((e) => ({
    ...e,
    occurred_at: "2026-09-27T06:00:00.000Z",
  }));
  await fixture(
    async (page) => {
      await page.waitForSelector(
        `.dashboard-latest-pin[data-member-ids~="${ada}"]`,
      );
      await page
        .locator('.dashboard-timeline-legend button[data-category="meal"]')
        .click();
      await page.locator(card).press("Shift+Enter");
      await assertGeometry(page, "meal-filter", latest, anchors.slice(1), [
        ev(1),
      ]);
      await page
        .locator('.dashboard-timeline-legend button[data-category=""]')
        .click();
      await page.locator("#dashboardMapDate").fill("2026-09-27");
      await page.locator("#dashboardMapDate").dispatchEvent("change");
      await page.waitForFunction(
        () => document.querySelectorAll(".dashboard-event-dot").length === 1,
      );
      await page.waitForSelector(
        `.dashboard-latest-pin[data-member-ids~="${ada}"]`,
        { state: "attached" },
      );
      await page.locator(card).press("Shift+Enter");
      await assertGeometry(page, "previous-day", latest, [[48.85, 2.35]]);
    },
    {
      events: rows(anchors),
      override: (url) =>
        url.pathname === "/api/dashboard/latest-positions"
          ? { body: body(latest) }
          : url.pathname === "/api/dashboard/timeline" &&
              url.searchParams.get("date") === "2026-09-27"
            ? { body: { users, events: previous, hasMore: false } }
            : undefined,
    },
  );
});

for (const status of ["none", "incomplete", "private"]) {
  test(`latest ${status}: activity fallback or truthful private no-op`, async () => {
    await fixture(
      async (page) => {
        await page.waitForSelector(
          `.dashboard-latest-pin[data-member-ids~="${bob}"]`,
          { state: "attached" },
        );
        const before = await camera(page);
        await page.locator(card).press("Shift+Enter");
        if (status === "private") {
          assert.deepEqual(await camera(page), before);
          assert.equal(await page.locator(".dashboard-event-dot").count(), 0);
          assert.match(
            await page.locator("#dashboardMapStatus").innerText(),
            /view was not changed/,
          );
        } else {
          const fit = await page.evaluate((points: Fix[]) => {
            const m = (window as any).fixtureMap,
              L = (window as any).L;
            const size = m.getSize();
            const want = m._getBoundsCenterZoom(L.latLngBounds(points), {
              padding: [Math.min(48, size.x / 4), Math.min(48, size.y / 4)],
              maxZoom: 18,
            });
            const c = m.getCenter();
            want.center.lng +=
              360 * Math.round((c.lng - want.center.lng) / 360);
            return {
              px: m
                .project(c, m.getZoom())
                .distanceTo(m.project(want.center, m.getZoom())),
              zoom: m.getZoom(),
              want: want.zoom,
            };
          }, anchors);
          assert.ok(fit.px < 1);
          assert.equal(fit.zoom, fit.want);
        }
        assert.equal(
          await page
            .locator(`.dashboard-latest-pin[data-member-ids~="${ada}"]`)
            .count(),
          0,
        );
      },
      {
        events: rows(anchors),
        marks: null,
        override: (url) =>
          url.pathname === "/api/dashboard/latest-positions"
            ? { body: body(null, status) }
            : undefined,
      },
    );
  });
}

test("neither latest nor activities is a truthful no-op", async () => {
  await fixture(
    async (page) => {
      await page.waitForSelector(
        `.dashboard-latest-pin[data-member-ids~="${bob}"]`,
      );
      const before = await camera(page);
      await page.locator(card).press("Shift+Enter");
      assert.deepEqual(await camera(page), before);
      assert.match(
        await page.locator("#dashboardMapStatus").innerText(),
        /view was not changed/,
      );
    },
    {
      events: [],
      marks: null,
      override: (url) =>
        url.pathname === "/api/dashboard/latest-positions"
          ? { body: body(null) }
          : undefined,
    },
  );
});

test("native touch double activation centers latest without page zoom", async () => {
  await fixture(
    async (page) => {
      await page.waitForSelector(
        `.dashboard-latest-pin[data-member-ids~="${ada}"]`,
      );
      await page.locator(card).scrollIntoViewIfNeeded();
      const box = await page.locator(card).boundingBox();
      const session = await page.context().newCDPSession(page);
      try {
        for (let i = 0; i < 2; i++) {
          await session.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [
              { x: box.x + box.width / 2, y: box.y + box.height / 2 },
            ],
          });
          await session.send("Input.dispatchTouchEvent", {
            type: "touchEnd",
            touchPoints: [],
          });
          await page.waitForTimeout(80);
        }
        await assertGeometry(page, "touch-390", latest, anchors);
        assert.equal(await page.evaluate(() => visualViewport!.scale), 1);
      } finally {
        await session.detach();
      }
    },
    {
      events: rows(anchors),
      touch: true,
      viewport: { width: 390, height: 900 },
      override: (url) =>
        url.pathname === "/api/dashboard/latest-positions"
          ? { body: body(latest) }
          : undefined,
    },
  );
});

test("minimum zoom discloses an impossible padded fit without moving anchors", async () => {
  const far: Fix[] = [
    [80, 170],
    [-80, -170],
  ];
  await fixture(
    async (page) => {
      await page.waitForSelector(
        `.dashboard-latest-pin[data-member-ids~="${ada}"]`,
      );
      await page.locator(card).press("Shift+Enter");
      const g = await geometry(page, [0, 0], far);
      assert.equal(
        g.zoom,
        await page.evaluate(() => (window as any).fixtureMap.getMinZoom()),
      );
      assert.ok(
        Math.abs(g.latest.x - g.size.x / 2) <= 1 &&
          Math.abs(g.latest.y - g.size.y / 2) <= 1,
      );
      assert.match(
        await page.locator("#dashboardMapStatus").innerText(),
        /cannot fit within the map padding at the minimum zoom/,
      );
      assert.equal(
        await page.locator(".dashboard-event-dot").count(),
        2,
        "offscreen anchors retained, never fabricated",
      );
      if (evidence)
        await writeFile(
          join(evidence, "minimum-zoom.json"),
          JSON.stringify(g, null, 2),
        );
    },
    {
      events: rows(far),
      viewport: { width: 320, height: 900 },
      override: (url) =>
        url.pathname === "/api/dashboard/latest-positions"
          ? { body: body([0, 0]) }
          : undefined,
    },
  );
});

test("fractional zoom snap and map maximum are respected", async () => {
  await fixture(
    async (page) => {
      await page.waitForSelector(
        `.dashboard-latest-pin[data-member-ids~="${ada}"]`,
      );
      await page.evaluate(() => {
        (window as any).fixtureMap.options.zoomSnap = 0.5;
      });
      await page.locator(card).press("Shift+Enter");
      const g = await assertGeometry(page, "fractional-snap", latest, anchors);
      assert.equal(g.zoom % 0.5, 0);
      await page.evaluate(() => (window as any).fixtureMap.setMaxZoom(10.5));
      await page.locator(card).press("Shift+Enter");
      const capped = await geometry(page, latest, anchors);
      assert.equal(capped.zoom, 10.5);
      assert.ok(Math.abs(capped.latest.x - capped.size.x / 2) <= 1);
      assert.ok(Math.abs(capped.latest.y - capped.size.y / 2) <= 1);
    },
    {
      events: rows(anchors),
      viewport: { width: 390, height: 900 },
      override: (url) =>
        url.pathname === "/api/dashboard/latest-positions"
          ? { body: body(latest) }
          : undefined,
    },
  );
});

test("native latest-centered dateline flight takes the nearest world copy", async () => {
  const fix: Fix = [-17.2, 179.8];
  const points: Fix[] = [
    [-17.3, -179.9],
    [-17.25, -179.7],
  ];
  await fixture(
    async (page) => {
      await page.waitForSelector(
        `.dashboard-latest-pin[data-member-ids~="${ada}"]`,
        { state: "attached" },
      );
      await page.evaluate(() => {
        const w = window as any,
          m = w.fixtureMap;
        m.setView([-17.2, -178.5], 8, { animate: false });
        w.datelineFrames = [];
        w.recordDateline = true;
        const frame = (t: number) => {
          if (!w.recordDateline) return;
          w.datelineFrames.push({ t, ...m.getCenter(), zoom: m.getZoom() });
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      await page.locator(card).press("Shift+Enter");
      await page.waitForTimeout(800);
      const frames = await page.evaluate(() => {
        const w = window as any;
        w.recordDateline = false;
        return w.datelineFrames;
      });
      const moving = frames.filter((f: any) => f.zoom % 1 !== 0);
      assert.ok(moving.length >= 5, "native fractional in-between frames");
      assert.ok(
        moving.at(-1).t - moving[0].t >= 300 &&
          moving.at(-1).t - moving[0].t <= 1100,
      );
      assert.ok(
        Math.max(...frames.map((f: any) => f.lng)) -
          Math.min(...frames.map((f: any) => f.lng)) <
          3,
        "short dateline flight",
      );
      const g = await assertGeometry(page, "native-dateline", fix, points);
      assert.ok(Math.abs(g.center.lng - -180.2) < 1e-9);
      if (evidence)
        await writeFile(
          join(evidence, "native-dateline-frames.json"),
          JSON.stringify(frames, null, 2),
        );
    },
    {
      events: rows(points),
      nativeClock: true,
      override: (url) =>
        url.pathname === "/api/dashboard/latest-positions"
          ? { body: body(fix) }
          : undefined,
    },
  );
});

test("a changed authorized latest fix re-aims the active member flight", async () => {
  let refresh = false,
    release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const changed: Fix = [40.73, -73.96];
  const retryBody = body(latest);
  retryBody.members[1] = { user_id: bob, status: "incomplete", latest: null };
  try {
    await fixture(
      async (page) => {
        await page.waitForSelector(
          `.dashboard-latest-pin[data-member-ids~="${ada}"]`,
          { state: "attached" },
        );
        refresh = true;
        await page
          .getByRole("button", { name: "Retry latest positions" })
          .click();
        await page.evaluate(() =>
          (window as any).fixtureMap.setView([40.72, -73.95], 12, {
            animate: false,
          }),
        );
        await page.exposeFunction("releaseChangedLatest", release);
        await page.evaluate(() => {
          const w = window as any,
            m = w.fixtureMap,
            fly = m.flyTo;
          w.changedFlights = [];
          m.flyTo = function (center: any, zoom: number, options: any) {
            w.changedFlights.push({ center, zoom, duration: options.duration });
            return fly.call(this, center, zoom, options);
          };
          m.once("move", () => void w.releaseChangedLatest());
        });
        await page.locator(card).press("Shift+Enter");
        await page.waitForFunction(
          () => (window as any).changedFlights.length === 2,
        );
        await page.waitForTimeout(800);
        await assertGeometry(page, "changed-latest", changed, anchors);
        const flights = await page.evaluate(
          () => (window as any).changedFlights,
        );
        assert.equal(flights[0].center.lat, latest[0]);
        assert.equal(flights[1].center.lat, changed[0]);
        if (evidence)
          await writeFile(
            join(evidence, "changed-latest-flights.json"),
            JSON.stringify(flights, null, 2),
          );
      },
      {
        events: rows(anchors),
        nativeClock: true,
        override: (url) =>
          url.pathname === "/api/dashboard/latest-positions"
            ? {
                body: refresh ? body(changed) : retryBody,
                ...(refresh ? { hold: held } : {}),
              }
            : undefined,
      },
    );
  } finally {
    release();
  }
});

test("pending day member focus centers latest only after publication", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  try {
    await fixture(
      async (page) => {
        await page.waitForSelector(
          `.dashboard-latest-pin[data-member-ids~="${ada}"]`,
        );
        const before = await camera(page);
        await page.locator(card).dblclick();
        assert.deepEqual(await camera(page), before);
        assert.match(
          await page.locator("#dashboardMapStatus").innerText(),
          /once this day's events load/,
        );
        release();
        await page.waitForFunction(
          () => document.querySelectorAll(".dashboard-event-dot").length === 3,
        );
        await assertGeometry(page, "pending-day", latest, anchors);
      },
      {
        events: rows(anchors),
        marks: null,
        ready: "Loading authorized event locations",
        override: (url) =>
          url.pathname === "/api/dashboard/latest-positions"
            ? { body: body(latest) }
            : url.pathname === "/api/dashboard/timeline" &&
                url.searchParams.get("date") === "2026-09-28"
              ? {
                  hold: held,
                  body: { users, events: rows(anchors), hasMore: false },
                }
              : undefined,
      },
    );
  } finally {
    release();
  }
});

for (const mode of ["active", "selection", "navigation", "private"] as const) {
  test(`held latest positive honors ${mode} member-focus intent`, async () => {
    let release!: () => void, deny!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const denial = new Promise<void>((r) => {
      deny = r;
    });
    try {
      await fixture(
        async (page) => {
          await page.evaluate(() =>
            (window as any).fixtureMap.setView([40.72, -73.95], 12, {
              animate: false,
            }),
          );
          if (mode === "private") {
            await page
              .locator(`.dashboard-timeline-mark[data-event-id="${ev(1)}"]`)
              .press("Enter");
            await page.waitForFunction(() =>
              document
                .querySelector("#dashboardMapSelection")
                ?.textContent?.includes("Checking current event access"),
            );
          }
          await page.exposeFunction("releaseCenterLatest", release);
          await page.evaluate((active: boolean) => {
            const w = window as any,
              m = w.fixtureMap,
              fly = m.flyTo;
            w.centerFlights = [];
            m.flyTo = function (center: any, zoom: number, options: any) {
              w.centerFlights.push({
                center,
                zoom,
                duration: options.duration,
              });
              return fly.call(this, center, zoom, options);
            };
            m.once("move", () => {
              w.centerMoved = true;
              if (active) void w.releaseCenterLatest();
            });
          }, mode === "active");
          await page.locator(card).press("Shift+Enter");
          await page.waitForFunction(() => (window as any).centerMoved);
          if (mode === "active") {
            await page.waitForFunction(
              () => (window as any).centerFlights.length === 2,
            );
            await page.waitForTimeout(800);
            await assertGeometry(page, "held-latest-active", latest, anchors);
            const flights = await page.evaluate(
              () => (window as any).centerFlights,
            );
            assert.ok(flights.every((f: any) => f.duration === 0.5));
            if (evidence)
              await writeFile(
                join(evidence, "held-latest-flights.json"),
                JSON.stringify(flights, null, 2),
              );
          } else {
            if (mode === "selection")
              await page
                .locator(
                  `.dashboard-member-card:has([data-member-id="${bob}"])`,
                )
                .click();
            if (mode === "navigation")
              await page.locator("#dashboardMap").press("ArrowLeft");
            if (mode === "private") {
              deny();
              await page.waitForFunction(
                () => !document.querySelector(".dashboard-event-dot"),
              );
            }
            await page.waitForTimeout(400);
            const stopped = await camera(page);
            release();
            await page.waitForSelector(
              `.dashboard-latest-pin[data-member-ids~="${bob}"]`,
              { state: "attached" },
            );
            await page.waitForTimeout(700);
            assert.deepEqual(
              await camera(page),
              stopped,
              "held positive never reclaims a retired intent",
            );
            assert.equal(
              await page.evaluate(() => (window as any).centerFlights.length),
              1,
            );
            if (mode === "private")
              assert.equal(
                await page
                  .locator(`.dashboard-latest-pin[data-member-ids~="${ada}"]`)
                  .count(),
                0,
              );
          }
        },
        {
          events: rows(anchors),
          nativeClock: true,
          override: (url) =>
            url.pathname === "/api/dashboard/latest-positions"
              ? { hold: held, body: body(latest) }
              : url.pathname === "/api/dashboard/event" && mode === "private"
                ? {
                    hold: denial,
                    body: {
                      users,
                      events: [
                        {
                          ...rows(anchors)[0],
                          position: {
                            availability: "unavailable",
                            reason: "private",
                          },
                        },
                      ],
                      hasMore: false,
                    },
                  }
                : undefined,
        },
      );
    } finally {
      release();
      deny();
    }
  });
}
