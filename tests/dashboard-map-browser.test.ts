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

test("a singleton canonical location fits at the practical maximum zoom", async () =>
  fixture(
    async (page) => {
      assert.equal(
        await page.evaluate(() => (window as any).fixtureMap.getZoom()),
        16,
      );
      const center = await page.evaluate(() =>
        (window as any).fixtureMap.getCenter(),
      );
      assert.equal(center.lat, 40.7);
      assert.equal(center.lng, -73.9);
    },
    { events: ledger().slice(0, 1) },
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
      await page.locator(".dashboard-timeline-cluster").first().focus();
      await page.keyboard.press("Enter");
      await page
        .locator(`.dashboard-timeline-choice[data-event-id="${ev(1)}"]`)
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
