import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, ledger, ada, ev } from "./helpers/exact-map-fixture.js";

// Retired subject-GPS/member-latest-pin and displaced-marker expectations are
// replaced by canonical event geometry in exact-event-map-browser.test.ts.
// This suite retains the date/DST, fit, empty, stale-date and independent roster seams.
for (const [date, start, end] of [
  ["2026-03-08", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"],
  ["2026-11-01", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
  ["2026-09-28", "2026-09-28T04:00:00.000Z", "2026-09-29T04:00:00.000Z"],
])
  test(`canonical map date ${date} uses device-local midnight boundaries`, async () => {
    const events = ledger().map((e, i) => ({
      ...e,
      occurred_at: new Date(
        Date.parse(start) + (i + 1) * 3600000,
      ).toISOString(),
    }));
    await fixture(
      async (page, { requests }) => {
        const request = requests.find((r) =>
          r.startsWith(`/api/dashboard/timeline?date=${date}`),
        );
        assert.ok(request);
        const q = new URL(request!, "http://fixture").searchParams;
        assert.equal(q.get("start"), start);
        assert.equal(q.get("end"), end);
        assert.equal(await page.locator(".dashboard-event-dot").count(), 7);
        assert.equal(
          await page
            .locator(
              ".dashboard-member-pin,.dashboard-map-anchor,.dashboard-map-pin-link",
            )
            .count(),
          0,
        );
        assert.equal(
          await page
            .locator(
              '#dashboardMap .leaflet-control-attribution a[href="https://www.openstreetmap.org/copyright"]',
            )
            .getAttribute("href"),
          "https://www.openstreetmap.org/copyright",
        );
        assert.ok(
          await page.evaluate(() => (window as any).fixtureMap.getZoom() <= 16),
        );
        assert.equal(await page.locator(".dashboard-timeline-mark").count(), 8);
      },
      { date, timezone: "America/New_York", events },
    );
  });

test("an empty authorized day retains independent roster filters and an honest complete empty map", async () =>
  fixture(
    async (page, { requests }) => {
      assert.equal(await page.locator(".dashboard-event-dot").count(), 0);
      assert.equal(await page.locator(".dashboard-map-group").count(), 0);
      assert.match(
        await page.locator("#dashboardMapStatus").innerText(),
        /0 of 0.*complete day/,
      );
      await page.waitForFunction(
        () =>
          document.querySelectorAll("#dashboardMemberCards button").length ===
          3,
      );
      assert.equal(
        await page.locator("#dashboardMemberCards button").count(),
        3,
      );
      assert.ok(!requests.some((r) => r.startsWith("/api/dashboard/map")));
    },
    { events: [] },
  ));

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
])
  test(`a singleton canonical location fits at the practical maximum zoom (${viewport.width}px)`, async () =>
    fixture(
      async (page) => {
        const geometry = await page.evaluate(async () => {
          // Complete a layout/ResizeObserver cycle and its following frame;
          // the status text alone can precede Leaflet's invalidateSize callback.
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
          const map = (window as any).fixtureMap;
          const size = map.getSize();
          const target = (window as any).L.latLng(40.7, -73.9);
          const delta = map
            .project(map.getCenter(), 16)
            .subtract(map.project(target, 16));
          return {
            zoom: map.getZoom(),
            size,
            renderedSize: {
              x: map.getContainer().clientWidth,
              y: map.getContainer().clientHeight,
            },
            delta,
            visible: map.getBounds().contains(target),
          };
        });
        assert.equal(geometry.zoom, 16);
        assert.deepEqual(geometry.size, geometry.renderedSize);
        // Leaflet rounds the pixel origin. invalidateSize clears the cached
        // LatLng, so getCenter then unprojects that rounded origin: <= half a
        // CSS pixel per axis, not exact floating-point coordinate equality.
        const halfPixel = 0.5 + 1e-6; // numerical projection round-trip margin
        assert.ok(
          Math.abs(geometry.delta.x) <= halfPixel,
          JSON.stringify(geometry),
        );
        assert.ok(
          Math.abs(geometry.delta.y) <= halfPixel,
          JSON.stringify(geometry),
        );
        assert.equal(geometry.visible, true);
        assert.equal(await page.locator(".dashboard-event-dot").count(), 1);
        assert.equal(
          await page
            .locator(".dashboard-event-dot")
            .getAttribute("data-event-id"),
          ev(1),
        );
      },
      { events: ledger().slice(0, 1), viewport },
    ));

test("roster cards and timeline remain independent when Leaflet is unavailable", async () =>
  fixture(
    async (page) => {
      await page.waitForFunction(
        () =>
          document.querySelectorAll("#dashboardMemberCards button").length ===
          3,
      );
      assert.equal(
        await page.locator("#dashboardMemberCards button").count(),
        3,
      );
      assert.equal(await page.locator(".dashboard-timeline-mark").count(), 8);
      await page
        .locator(`.dashboard-timeline-mark[data-event-id="${ev(1)}"]`)
        .focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardMapSelection")
          ?.textContent?.includes("Event access rechecked"),
      );
      assert.match(
        await page.locator("#dashboardMapSelection").innerText(),
        /Synthetic Ada/,
      );
    },
    { leaflet: false, ready: "unavailable" },
  ));

test("a held previous-date stream cannot resurrect points after a newer empty date", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let held = false;
  await fixture(
    async (page, { requests }) => {
      held = true;
      await page.locator("#dashboardMapDate").fill("2026-09-29");
      await page.locator("#dashboardMapDate").dispatchEvent("change");
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardMapStatus")
          ?.textContent?.includes("Loading"),
      );
      await page.locator("#dashboardMapDate").fill("2026-09-30");
      await page.locator("#dashboardMapDate").dispatchEvent("change");
      release();
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardMapStatus")
          ?.textContent?.includes("0 of 0"),
      );
      await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
      assert.equal(
        await page
          .locator(
            ".dashboard-event-dot,.dashboard-map-group,.dashboard-timeline-mark",
          )
          .count(),
        0,
      );
      assert.match(
        await page.locator("#dashboardMapStatus").innerText(),
        /2026-09-30.*complete day/,
      );
    },
    {
      override: (u, events) =>
        u.pathname === "/api/dashboard/timeline" && held
          ? {
              ...(u.searchParams.get("date") === "2026-09-29" ? { hold } : {}),
              body: {
                users: [{ _id: ada, display_name: "Synthetic Ada" }],
                events:
                  u.searchParams.get("date") === "2026-09-29"
                    ? events.map((e) => ({
                        ...e,
                        occurred_at: e.occurred_at.replace("09-28", "09-29"),
                      }))
                    : [],
                hasMore: false,
              },
            }
          : undefined,
    },
  );
});

test("served event timeline uses local DST occurrence scale without Leaflet", async () => {
  const { createServer } = await import("node:http");
  const { chromium } = await import("playwright-core");
  const { Store } = await import("../src/config/store.js");
  const { admin } = await import("../src/server/admin.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const home = await mkdtemp("/tmp/coach-timeline-dst-");
  const calls: string[] = [];
  const backend = createServer((req, res) => {
    calls.push(req.url!);
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/api/friends/dojo/day-events?")) {
      const params = new URL(req.url!, "http://fixture").searchParams;
      const start = params.get("start")!;
      res.end(
        JSON.stringify({
          users: [{ _id: ada, display_name: "Synthetic Ada" }],
          events: [0, 1, 2]
            .map((i) => ({
              id: ev(i + 1),
              user_id: ada,
              event_type: "workout.set_completed",
              occurred_at: new Date(Date.parse(start) + 9000000).toISOString(),
              subject: { type: "workout", id: ada },
              details: { set_index: i },
              actor_type: "member",
              source: "interactive",
            }))
            .filter(
              (e) => !params.has("event_id") || e.id === params.get("event_id"),
            ),
          hasMore: false,
        }),
      );
    } else
      res.end(
        JSON.stringify({
          members: [],
          users: [],
          activities: [],
          hasMore: false,
        }),
      );
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(backend.address() as any).port}`,
    token: "synthetic-token",
  });
  const app = await admin(store, 0);
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage({
      timezoneId: "America/New_York",
      viewport: { width: 1440, height: 900 },
    });
    await page.clock.setFixedTime(new Date("2026-12-01T12:00:00Z"));
    await page.goto(app.origin + "/dashboard");
    await page.evaluate(async (key) => {
      document.getElementById("studio")!.hidden = false;
      document.getElementById("login")!.hidden = true;
      (window as any).L = undefined;
      await (window as any).CoachDashboard.load(null, key);
    }, store.secrets.admin);
    for (const [day, hours, start, end] of [
      [
        "2026-11-01",
        25,
        "2026-11-01T04:00:00.000Z",
        "2026-11-02T05:00:00.000Z",
      ],
      [
        "2026-03-08",
        23,
        "2026-03-08T05:00:00.000Z",
        "2026-03-09T04:00:00.000Z",
      ],
      [
        "2026-11-02",
        24,
        "2026-11-02T05:00:00.000Z",
        "2026-11-03T05:00:00.000Z",
      ],
    ] as const) {
      await page.locator("#dashboardMapDate").fill(day);
      await page.locator("#dashboardMapDate").dispatchEvent("change");
      await page.waitForFunction(
        (day) =>
          document.querySelector<HTMLElement>("#dashboardTimeline")?.dataset
            .date === day &&
          document.querySelectorAll(".dashboard-timeline-mark").length === 3,
        day,
      );
      assert.ok(
        calls.some((c) =>
          c.includes(
            `day-events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
          ),
        ),
      );
      const geometry = await page
        .locator(".dashboard-timeline-mark")
        .evaluateAll((nodes) =>
          nodes.map((n) => ({
            left: (n as HTMLElement).style.left,
            top: (n as HTMLElement).style.top,
          })),
        );
      assert.equal(new Set(geometry.map((g) => g.top)).size, 1);
      assert.equal(
        await page.locator(".dashboard-timeline-mark:not([hidden])").count(),
        3,
      );
      assert.ok(
        Math.abs(parseFloat(geometry[0].left) - (2.5 / hours) * 100) < 0.001,
      );
      assert.equal(
        await page.locator(".dashboard-timeline-end").textContent(),
        "00:00",
      );
      const rects = await page
        .locator(".dashboard-timeline-tick")
        .evaluateAll((nodes) =>
          nodes.map((n) => {
            const r = n.getBoundingClientRect();
            return { left: r.left, right: r.right };
          }),
        );
      for (let i = 1; i < rects.length; i++)
        assert.ok(
          rects[i].left >= rects[i - 1].right,
          "tick labels do not overlap",
        );
      await page
        .locator(`.dashboard-timeline-mark[data-event-id="${ev(1)}"]`)
        .focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardMapSelection")
          ?.textContent?.includes("Event access rechecked"),
      );
      assert.equal(
        await page
          .locator(`.dashboard-timeline-mark[data-event-id="${ev(1)}"]`)
          .getAttribute("aria-pressed"),
        "true",
      );
      assert.match(
        await page.locator("#dashboardMapSelection").innerText(),
        /set index: 0/,
      );
    }
  } finally {
    await browser.close();
    await app.close();
    await new Promise<void>((r) => backend.close(() => r()));
    await rm(home, { recursive: true, force: true });
  }
});
