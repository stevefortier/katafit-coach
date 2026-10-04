import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, ev, ada, bob } from "./helpers/exact-map-fixture.js";

for (const fault of ["invalid-event", "invalid-cursor"] as const)
  test(`a malformed first-page ${fault} reload cannot undo Position withholding`, async () => {
    let malformed = false;
    await fixture(
      async (page) => {
        await page
          .locator(`.dashboard-event-dot[data-event-id="${ev(3)}"]`)
          .click();
        await page.waitForFunction(() =>
          document
            .querySelector("#dashboardMapSelection")
            ?.textContent?.includes("No shared location"),
        );
        malformed = true;
        await page.evaluate(() =>
          document
            .querySelector("#dashboardMapDate")!
            .dispatchEvent(new Event("change")),
        );
        await page.getByText(/Timeline unavailable; try again/).waitFor();
        await page.evaluate(
          () =>
            new Promise((r) =>
              requestAnimationFrame(() => requestAnimationFrame(r)),
            ),
        );
        const index = await page
          .locator(".dashboard-timeline-cluster")
          .evaluateAll(
            (nodes: HTMLElement[], id: string) =>
              nodes.findIndex((n) =>
                JSON.parse(n.dataset.eventIds!).includes(id),
              ),
            ev(1),
          );
        if (index >= 0) {
          await page.locator(".dashboard-timeline-cluster").nth(index).focus();
          await page.keyboard.press("Enter");
          await page
            .locator(`.dashboard-timeline-choice[data-event-id="${ev(1)}"]`)
            .focus();
        } else
          await page
            .locator(`.dashboard-timeline-mark[data-event-id="${ev(1)}"]`)
            .focus();
        await page.keyboard.press("Enter");
        await page.waitForFunction(() =>
          document
            .querySelector("#dashboardMapSelection")
            ?.textContent?.includes("Event access rechecked"),
        );
        assert.doesNotMatch(
          await page.locator("#dashboardMapSelection").innerText(),
          /40\.7|73\.9|8 m/,
        );
        assert.match(
          await page.locator("#dashboardMapSelection").innerText(),
          /No shared location/,
        );
        assert.equal(
          await page
            .locator(`.dashboard-event-dot[data-member-id="${ada}"]`)
            .count(),
          0,
        );
      },
      {
        override: (url, events) => {
          if (url.pathname === "/api/dashboard/event")
            return {
              body: {
                users: [],
                events: events
                  .filter((e) => e.id === url.searchParams.get("event_id"))
                  .map((e) =>
                    e.id === ev(3)
                      ? {
                          ...e,
                          position: {
                            availability: "unavailable",
                            reason: "private",
                          },
                        }
                      : e,
                  ),
                hasMore: false,
              },
            };
          if (url.pathname === "/api/dashboard/timeline" && malformed)
            return {
              body: {
                users: [],
                events:
                  fault === "invalid-event"
                    ? [
                        ...events,
                        { ...events[0], id: ev(99), occurred_at: "not-a-time" },
                      ]
                    : events,
                hasMore: fault === "invalid-cursor",
              },
            };
          return undefined;
        },
      },
    );
  });

// Roster inventory belongs to a dashboard scope, not the selected day.
// Explicit reload starts a fresh scope even when its roster read fails.
for (const denial of [401, 403])
  test(`day reuse retains stats but explicit transient/denied (${denial}) reloads remove prior-scope stats without substituting latest subject GPS`, async () => {
    let status = 200;
    const members = [
      {
        _id: ada,
        display_name: "Synthetic Ada",
        stats: {
          weight: { value: 68, unit: "kg" },
          height_cm: 170,
          body_fat_percent: 21,
          body_fat_estimate: { source: "ai", estimated: true, value: 21 },
          age_years: 30,
        },
        last_position: { position: { latitude: 1, longitude: 2 } },
      },
      { _id: bob, display_name: "Synthetic Bob", stats: {} },
    ];
    await fixture(
      async (page, { requests }) => {
        const rosterReads = () =>
          requests.filter((url) => url.startsWith("/api/dashboard/members"))
            .length;
        const reload = () =>
          page.evaluate(async () => {
            await (window as any).CoachDashboard.load(null, "synthetic");
            // Dashboard reload initializes Today; restore this fixture's day
            // without causing a second roster read.
            const input =
              document.querySelector<HTMLInputElement>("#dashboardMapDate")!;
            input.value = "2026-09-28";
            input.dispatchEvent(new Event("change"));
          });
        await page.waitForFunction(() =>
          document
            .querySelector("#dashboardMemberCards")
            ?.textContent?.includes("68 kg"),
        );
        assert.match(
          await page.locator("#dashboardMemberCards").innerText(),
          /Height: 170 cm.*Body fat: 21 %.*Age: 30/s,
        );
        assert.equal(
          await page
            .getByRole("button", {
              name: "About body fat estimate for Synthetic Ada",
            })
            .count(),
          1,
        );
        assert.equal(
          await page.locator(`#dashboard-bodyfat-${ada}`).textContent(),
          "Body fat is estimated from progress photos.",
        );
        assert.equal(await page.locator(".dashboard-member-pin").count(), 0);
        const initialReads = rosterReads();
        status = 503;
        // Even the native fallback's forced same-date ledger refresh reuses
        // the roster; it is not an explicit dashboard-scope reload.
        await page.locator("#dashboardMapDate").dispatchEvent("change");
        await page.waitForFunction(() =>
          document
            .querySelector("#dashboardMapStatus")
            ?.textContent?.includes("complete day"),
        );
        assert.equal(
          rosterReads(),
          initialReads,
          "day navigation performs zero roster reads",
        );
        assert.match(
          await page.locator("#dashboardMemberCards").innerText(),
          /68 kg/,
        );
        assert.equal(await page.locator(".dashboard-event-dot").count(), 7);
        await reload();
        await page.waitForFunction(() =>
          document
            .querySelector("#dashboardMapStatus")
            ?.textContent?.includes("roster unavailable (503)"),
        );
        // Roster failure can be reported while the independently authorized
        // timeline is still loading; assert only after that read publishes.
        await page.waitForFunction(() =>
          document
            .querySelector("#dashboardMapStatus")
            ?.textContent?.includes("complete day"),
        );
        assert.equal(rosterReads(), initialReads + 1);
        assert.doesNotMatch(
          await page.locator("#dashboardMemberCards").innerText(),
          /68 kg|Height: 170|Body fat: 21|Age: 30/,
        );
        assert.equal(
          await page
            .getByRole("button", {
              name: "About body fat estimate for Synthetic Ada",
            })
            .count(),
          0,
        );
        assert.equal(await page.locator(".dashboard-member-pin").count(), 0);
        assert.equal(
          await page.locator(".dashboard-event-dot").count(),
          7,
          "transient roster failure does not erase the independently authorized ledger",
        );
        // Recover with a fresh authorized scope before testing denial cleanup.
        status = 200;
        await reload();
        await page.waitForFunction(() =>
          document
            .querySelector("#dashboardMemberCards")
            ?.textContent?.includes("68 kg"),
        );
        assert.equal(rosterReads(), initialReads + 2);
        status = denial;
        await reload();
        await page.waitForFunction(
          (status) =>
            document
              .querySelector("#dashboardMapStatus")
              ?.textContent?.includes(`roster access denied (${status})`),
          denial,
        );
        await page.waitForFunction(() =>
          document
            .querySelector("#dashboardMapStatus")
            ?.textContent?.includes("complete day"),
        );
        assert.equal(rosterReads(), initialReads + 3);
        assert.equal(await page.locator(".dashboard-member-pin").count(), 0);
        assert.doesNotMatch(
          await page.locator("#dashboardMemberCards").innerText(),
          /68 kg/,
        );
        assert.equal(
          await page.locator(".dashboard-event-dot").count(),
          7,
          "separately authorized ledger remains independent",
        );
      },
      {
        override: (url) =>
          url.pathname === "/api/dashboard/members"
            ? { status, body: status === 200 ? { members } : {} }
            : undefined,
      },
    );
  });
