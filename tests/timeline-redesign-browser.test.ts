import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

test("timeline supports dense clusters, real-time zoom, filters, inspectors and related live detail without losing history", async () => {
  const home = await mkdtemp("/tmp/coach-timeline-redesign-");
  const member = "aaaaaaaaaaaaaaaaaaaaaaaa",
    peer = "bbbbbbbbbbbbbbbbbbbbbbbb";
  const activity = "cccccccccccccccccccccccc";
  let liveStatus = 200,
    reads = 0;
  let collisionFixture = false;
  const backend = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/friends/dojo/day-events") {
      const start = Date.parse(url.searchParams.get("start")!);
      const events = Array.from({ length: 321 }, (_, i) => ({
        id: (i + 1).toString(16).padStart(24, "0"),
        user_id: member,
        occurred_at: new Date(start + 12 * 3600000).toISOString(),
        event_type: i === 320 ? "future.unknown" : "workout.set_completed",
        subject: { type: "workout", id: activity },
        details: {
          exercise_index: 0,
          set_index: i,
          changed_fields: ["complete"],
          name: "<img onerror=alert(1)>",
        },
        actor_type: "member",
        source: "interactive",
      }));
      events.push({
        ...events[0],
        id: "000000000000000000001001",
        occurred_at: new Date(start + 12 * 3600000 + 120000).toISOString(),
      });
      events.push({
        ...events[0],
        id: "000000000000000000001002",
        user_id: peer,
        event_type: "meal.deleted",
        occurred_at: new Date(start + 18 * 3600000).toISOString(),
      });
      if (collisionFixture) {
        events.length = 0;
        for (const [group, size] of [321, 102, 7].entries())
          for (let i = 0; i < size; i++)
            events.push({
              id: (2000 + group * 1000 + i).toString(16).padStart(24, "0"),
              user_id: member,
              occurred_at: new Date(
                start + 3600000 + group * 75 * 60000 + (i % 3) * 1000,
              ).toISOString(),
              event_type: [
                "workout.set_completed",
                "meal.food_updated",
                "media.completed",
                "metric.completed",
              ][i % 4],
              subject: { type: "workout", id: activity },
              details: {
                exercise_index: 0,
                set_index: i,
                changed_fields: ["complete"],
                name: "<img onerror=alert(1)>",
              },
              actor_type: "member",
              source: "interactive",
            });
      }
      res.end(
        JSON.stringify({
          users: [
            { _id: member, display_name: "Fixture Ada" },
            { _id: peer, display_name: "Fixture Bea" },
          ],
          events: url.searchParams.has("event_id")
            ? events.filter((e) => e.id === url.searchParams.get("event_id"))
            : events,
          hasMore: false,
        }),
      );
    } else if (url.pathname === "/api/friends/dojo/dashboard-members")
      res.end(
        JSON.stringify({
          members: [
            { _id: member, display_name: "Fixture Ada" },
            { _id: peer, display_name: "Fixture Bea" },
          ],
        }),
      );
    else if (url.pathname.startsWith("/api/friends/activity/")) {
      reads++;
      res.statusCode = liveStatus;
      res.end(
        JSON.stringify({
          owner: { _id: member },
          activity: {
            _id: activity,
            user_id: member,
            type: "workout",
            name: "Current authorized workout",
            status: "complete",
            created_at: new Date().toISOString(),
            data: {},
            position: { latitude: 42, longitude: -71 },
          },
        }),
      );
    } else if (url.pathname === "/api/friends/dojo/positioned-activities")
      res.end(
        JSON.stringify({
          users: [{ _id: member, display_name: "Fixture Ada" }],
          activities: [
            {
              _id: activity,
              user_id: member,
              type: "workout",
              status: "complete",
              name: "Current authorized workout",
              created_at: new Date().toISOString(),
              position: { latitude: 42, longitude: -71 },
            },
          ],
          hasMore: false,
        }),
      );
    else res.end(JSON.stringify({ users: [], activities: [], hasMore: false }));
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(backend.address() as any).port}`,
    token: "fixture-token",
  });
  const app = await admin(store, 0);
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  });
  try {
    const evidence = process.env.EVENT_TIMELINE_EVIDENCE || `${home}/evidence`;
    await mkdir(evidence, { recursive: true });
    const page = await browser.newPage({
      timezoneId: "UTC",
      viewport: { width: 1440, height: 1000 },
      hasTouch: true,
    });
    await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (route) =>
      route.abort(),
    );
    await page.goto(app.origin + "/dashboard");
    await page.evaluate(async (key) => {
      document.getElementById("studio")!.hidden = false;
      document.getElementById("login")!.hidden = true;

      await (window as any).CoachDashboard.load(null, key);
    }, store.secrets.admin);
    await page.waitForFunction(() =>
      document
        .querySelector(".dashboard-timeline-count")
        ?.textContent?.includes("323 loaded"),
    );
    await page.setViewportSize({ width: 320, height: 900 });
    await page.waitForTimeout(100);
    const ruler = await page
      .locator(".dashboard-timeline-tick")
      .evaluateAll((nodes) =>
        nodes.map((n) => ({
          left: n.getBoundingClientRect().left,
          right: n.getBoundingClientRect().right,
        })),
      );
    for (let i = 1; i < ruler.length; i++)
      assert.ok(
        ruler[i].left >= ruler[i - 1].right,
        "hour labels must not overlap at 320px",
      );
    assert.equal(
      await page
        .locator("#dashboardTimeline")
        .getByRole("button", { name: "Zoom in", exact: true })
        .evaluate((n) => getComputedStyle(n).backgroundColor),
      "rgb(23, 23, 23)",
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForTimeout(100);
    await page.locator("#dashboardTimeline").scrollIntoViewIfNeeded();
    const beforeHover = await page
      .locator("#dashboardTimeline")
      .evaluate((n) => ({
        height: n.getBoundingClientRect().height,
        top: n.getBoundingClientRect().top + scrollY,
      }));
    await page.locator(".dashboard-timeline-cluster").hover();
    const afterHover = await page
      .locator("#dashboardTimeline")
      .evaluate((n) => ({
        height: n.getBoundingClientRect().height,
        top: n.getBoundingClientRect().top + scrollY,
      }));
    assert.deepEqual(
      afterHover,
      beforeHover,
      "hover preview must float without moving the detail/map layout",
    );
    await page
      .locator(".dashboard-timeline-inspector")
      .screenshot({ path: `${evidence}/redesign-floating-hover.png` });
    const floating = await page
      .locator(".dashboard-timeline-inspector")
      .boundingBox();
    assert.ok(
      floating &&
        floating.x >= 0 &&
        floating.x + floating.width <= 1440 &&
        floating.y >= 0 &&
        floating.y + floating.height <= 1000,
    );
    await page.locator(".dashboard-timeline-cluster").click();
    await page.keyboard.press("ArrowRight");
    assert.equal(
      await page
        .locator(".dashboard-timeline-choice:focus")
        .getAttribute("data-event-id"),
      "000000000000000000000002",
      "arrows navigate individual occurrences inside a cluster",
    );
    await page
      .locator(
        '.dashboard-timeline-choice[data-event-id="000000000000000000000001"]',
      )
      .click();
    // Selecting an activity-backed occurrence automatically reauthorizes live detail, preserving history.
    await page
      .getByText("Current authorized workout", { exact: true })
      .waitFor();
    assert.match(
      await page.locator("#dashboardMapSelection").innerText(),
      /Exercise 1 · Set 1/,
    );
    assert.equal(reads, 1);
    assert.equal(
      await page
        .locator(
          '.dashboard-timeline-mark[data-event-id="000000000000000000000001"]',
        )
        .getAttribute("aria-pressed"),
      "true",
    );
    const recordedLeft = await page
      .locator(
        '.dashboard-timeline-mark[data-event-id="000000000000000000001001"]',
      )
      .evaluate((n) => (n as HTMLElement).style.left);
    for (let i = 0; i < 7; i++) {
      const zoom = page
        .locator("#dashboardTimeline")
        .getByRole("button", { name: "Zoom in", exact: true });
      if (await zoom.isEnabled()) await zoom.click();
    }
    assert.equal(
      await page
        .locator(
          '.dashboard-timeline-mark[data-event-id="000000000000000000001001"]',
        )
        .getAttribute("hidden"),
      null,
      "zoom must separate nearby occurrences without changing their recorded time",
    );
    assert.equal(
      await page
        .locator(
          '.dashboard-timeline-mark[data-event-id="000000000000000000001001"]',
        )
        .evaluate((n) => (n as HTMLElement).style.left),
      recordedLeft,
    );
    assert.equal(
      await page.locator(".dashboard-timeline-cluster").innerText(),
      "321",
    );
    await page
      .locator("#dashboardTimeline")
      .screenshot({ path: `${evidence}/redesign-time-zoom.png` });
    await page
      .locator(
        '.dashboard-timeline-mark[data-event-id="000000000000000000001001"]',
      )
      .focus();
    assert.match(
      await page.locator(".dashboard-timeline-inspector").innerText(),
      /Fixture Ada.*workout set completed/s,
    );
    assert.match(
      await page.locator(".dashboard-timeline-inspector").innerText(),
      /Exercise 1 · Set 1/,
    );
    assert.equal(reads, 1, "hover and focus must not read live activities");
    await page
      .locator(".dashboard-timeline-inspector")
      .screenshot({ path: `${evidence}/redesign-floating-focus.png` });
    await page.keyboard.press("Escape");
    assert.equal(
      await page.locator(".dashboard-timeline-inspector").isVisible(),
      false,
    );
    await page.keyboard.press("Enter");
    assert.match(
      await page.locator("#dashboardMapSelection").innerText(),
      /workout set completed/,
    );
    await page.getByRole("button", { name: "meal", exact: true }).click();
    assert.equal(
      await page.locator("#dashboardMapSelection").innerText(),
      "",
      "category filtering clears hidden selection",
    );
    assert.match(
      await page.locator(".dashboard-timeline-count").innerText(),
      /1 visible · 323 loaded/,
    );
    await page
      .locator("#dashboardTimeline")
      .screenshot({ path: `${evidence}/redesign-category-filter.png` });
    await page.getByRole("button", { name: "All events", exact: true }).click();
    await page
      .locator(".dashboard-member-card")
      .filter({
        has: page.locator(
          `.dashboard-member-portrait[data-member-id="${peer}"]`,
        ),
      })
      .click();
    assert.match(
      await page.locator(".dashboard-timeline-count").innerText(),
      /1 visible · 323 loaded/,
    );
    await page.getByRole("button", { name: "Select All", exact: true }).click();
    assert.match(
      await page.locator(".dashboard-timeline-count").innerText(),
      /323 visible · 323 loaded/,
    );
    await page.getByRole("button", { name: "Full day", exact: true }).click();
    assert.equal(
      await page.locator(".dashboard-timeline-zoom-label").innerText(),
      "Full day",
    );

    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForTimeout(100);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      assert.ok(
        (await page.locator(".dashboard-timeline-track").boundingBox())!
          .height < 110,
      );
      await page.locator("#dashboardTimeline").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `${evidence}/redesign-dense-page-${width}.png`,
        fullPage: true,
      });
      // Isolated panel captures suppress sticky chrome only during capture so it
      // cannot paint over the element screenshot; production layout is unchanged.
      const captureStyle = await page.addStyleTag({
        content:
          "header, .dashboard-member-cards, #notice { position: static !important; }",
      });
      await page
        .locator("#dashboardTimeline")
        .screenshot({ path: `${evidence}/redesign-dense-track-${width}.png` });
      await page.locator(".dashboard-timeline-cluster").tap();
      assert.equal(
        await page.locator(".dashboard-timeline-choice").count(),
        322,
      );
      assert.equal(
        await page
          .locator(
            '.dashboard-timeline-choice[data-event-id="000000000000000000000141"] .dashboard-timeline-choice-snapshot',
          )
          .isVisible(),
        true,
        "same-time choices expose snapshot differences without hover",
      );
      await page
        .locator("#dashboardTimeline")
        .screenshot({ path: `${evidence}/redesign-chooser-${width}.png` });
      await page
        .locator(
          '.dashboard-timeline-choice[data-event-id="000000000000000000000141"]',
        )
        .click();
      assert.match(
        await page.locator("#dashboardMapSelection").innerText(),
        /future unknown/,
      );
      await page.locator("#dashboardMapSelection").screenshot({
        path: `${evidence}/redesign-unknown-detail-${width}.png`,
      });
      await captureStyle.evaluate((n) => n.remove());
    }
    await page.getByRole("button", { name: "All events", exact: true }).click();
    await page.locator(".dashboard-timeline-cluster").click();
    liveStatus = 404;
    await page
      .locator(
        '.dashboard-timeline-choice[data-event-id="000000000000000000000001"]',
      )
      .click();
    await page
      .getByText(/Current subject activity unavailable \(404\)/)
      .waitFor();
    assert.match(
      await page.locator("#dashboardMapSelection").innerText(),
      /Exercise 1 · Set 1/,
    );
    assert.equal(await page.locator(".dashboard-timeline-mark").count(), 323);
    await page.locator(".dashboard-timeline-cluster").click();
    liveStatus = 403;
    await page
      .locator(
        '.dashboard-timeline-choice[data-event-id="000000000000000000000001"]',
      )
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll(".dashboard-timeline-mark").length === 1,
    );
    assert.match(
      await page.locator("#dashboardMapSelection").innerText(),
      /Activity access denied \(403\)/,
    );
    assert.equal(
      await page.locator(".dashboard-timeline-inspector").innerText(),
      "",
    );
    assert.equal(await page.locator(".dashboard-timeline-cluster").count(), 0);
    assert.equal(await page.locator(".dashboard-timeline-mark").count(), 1);
    assert.doesNotMatch(
      await page.locator("#dashboardTimeline").innerText(),
      /Fixture Ada|Exercise/,
    );
    assert.match(
      await page.locator(".dashboard-timeline-count").innerText(),
      /1 visible · 1 loaded/,
    );
    await page
      .locator("#dashboardTimeline")
      .screenshot({ path: `${evidence}/redesign-after-denial.png` });
    collisionFixture = true;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(async (key) => {
      (window as any).CoachDashboard.clear();
      await (window as any).CoachDashboard.load(null, key);
    }, store.secrets.admin);
    await page.waitForFunction(() =>
      document
        .querySelector(".dashboard-timeline-count")
        ?.textContent?.includes("430 loaded"),
    );
    await page
      .locator("#dashboardTimeline")
      .getByRole("button", { name: "Zoom in", exact: true })
      .click();
    assert.deepEqual(
      await page.locator(".dashboard-timeline-cluster").allTextContents(),
      ["321", "102", "7"],
    );
    const pills = await page
      .locator(".dashboard-timeline-cluster")
      .evaluateAll((nodes) =>
        nodes
          .map((n) => ({
            left: n.getBoundingClientRect().left,
            right: n.getBoundingClientRect().right,
          }))
          .sort((a, b) => a.left - b.left),
      );
    for (let i = 1; i < pills.length; i++)
      assert.ok(
        pills[i].left >= pills[i - 1].right + 4,
        "mixed-color count pills cannot overlap adjacent event hit targets",
      );
    await page
      .locator("#dashboardTimeline")
      .screenshot({ path: `${evidence}/redesign-collision-boundaries.png` });
  } finally {
    await browser.close();
    await app.close();
    backend.closeAllConnections();
    await new Promise<void>((r) => backend.close(() => r()));
    await rm(home, { recursive: true, force: true });
  }
});
