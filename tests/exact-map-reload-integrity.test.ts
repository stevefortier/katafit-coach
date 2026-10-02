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

// Authorization, independent roster stats, and transient-versus-denied refresh
// assertions carried forward from the former subject-coordinate map fixture.
test("roster transient and denied reads retain or remove stats without substituting latest subject GPS", async () => {
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
    async (page) => {
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardMemberCards")
          ?.textContent?.includes("68 kg"),
      );
      assert.match(
        await page.locator("#dashboardMemberCards").innerText(),
        /Height: 170 cm.*Body fat \(photo estimate\): 21 %.*Age: 30/s,
      );
      assert.equal(await page.locator(".dashboard-member-pin").count(), 0);
      status = 503;
      await page.evaluate(() =>
        document
          .querySelector("#dashboardMapDate")!
          .dispatchEvent(new Event("change")),
      );
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardMapStatus")
          ?.textContent?.includes("refresh failed (503)"),
      );
      assert.match(
        await page.locator("#dashboardMemberCards").innerText(),
        /68 kg/,
      );
      assert.equal(await page.locator(".dashboard-event-dot").count(), 7);
      status = 403;
      await page.evaluate(() =>
        document
          .querySelector("#dashboardMapDate")!
          .dispatchEvent(new Event("change")),
      );
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardMapStatus")
          ?.textContent?.includes("roster access denied (403)"),
      );
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
