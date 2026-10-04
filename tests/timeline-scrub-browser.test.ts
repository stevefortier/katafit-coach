import test from "node:test";
import { timelineCounts } from "./helpers/timeline-counts.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

test("individual slices hover and touch scrub preserve committed detail and map selection", async () => {
  const home = await mkdtemp("/tmp/coach-timeline-redesign-");
  const member = "aaaaaaaaaaaaaaaaaaaaaaaa",
    peer = "bbbbbbbbbbbbbbbbbbbbbbbb";
  const activity = "cccccccccccccccccccccccc";
  let liveStatus = 200,
    reads = 0,
    eventReads = 0;
  const backend = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/friends/dojo/day-events") {
      if (url.searchParams.has("event_id")) eventReads++;
      const start = Date.parse(url.searchParams.get("start")!);
      const events = Array.from({ length: 3 }, (_, i) => ({
        id: (i + 1).toString(16).padStart(24, "0"),
        user_id: member,
        occurred_at: new Date(start + 12 * 3600000).toISOString(),
        event_type: i === 2 ? "future.unknown" : "workout.set_completed",
        subject: { type: "workout", id: activity },
        details: {
          exercise_index: 0,
          set_index: i,
          changed_fields: ["complete"],
          name: "<img onerror=alert(1)>",
        },
        position: { availability: "available", latitude: 42, longitude: -71 },
        actor_type: "member",
        source: "interactive",
      }));
      events.push({
        ...events[0],
        id: "000000000000000000001001",
        occurred_at: new Date(start + 14 * 3600000).toISOString(),
      });
      events.push({
        ...events[0],
        id: "000000000000000000001002",
        position: undefined,
        user_id: peer,
        event_type: "meal.deleted",
        occurred_at: new Date(start + 18 * 3600000).toISOString(),
      });
      res.end(
        JSON.stringify({
          users: [
            { _id: member, display_name: "Fixture Ada" },
            { _id: peer, display_name: "Fixture Bea" },
          ],
          events: url.searchParams.has("event_id")
            ? events.filter((e) => e.id === url.searchParams.get("event_id"))
            : [...events].reverse(),
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
            position: {
              availability: "available",
              latitude: 42,
              longitude: -71,
            },
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
              position: {
                availability: "available",
                latitude: 42,
                longitude: -71,
              },
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
    await page.waitForFunction(
      () => document.querySelectorAll(".dashboard-timeline-mark").length === 5,
    );
    assert.equal(
      await page.locator(".dashboard-timeline-cluster").count(),
      0,
      "no occurrence grouping",
    );
    assert.equal(
      await page.locator(".dashboard-timeline-mark:not([hidden])").count(),
      5,
    );
    const mark = (id: string) =>
      page.locator(`.dashboard-timeline-mark[data-event-id="${id}"]`);
    const first = "000000000000000000000001";
    const later = "000000000000000000001001";
    const noGPS = "000000000000000000001002";
    const center = async (id: string) => {
      const b = (await mark(id).boundingBox())!;
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    await page.waitForTimeout(100);
    const before = reads,
      beforeEvents = eventReads;
    const c = await center(first);
    await page.mouse.move(c.x, c.y);
    await page.locator(".dashboard-timeline-tooltip").waitFor();
    assert.equal(
      await page
        .locator(".dashboard-timeline-tooltip")
        .getAttribute("data-event-id"),
      first,
    );
    assert.equal(
      await mark(first).getAttribute("data-preview"),
      "true",
      "hover visibly highlights the exact timeline slice",
    );
    assert.equal(
      await mark(first).evaluate((node) => getComputedStyle(node).boxShadow),
      "rgb(255, 255, 255) 0px 0px 0px 2px",
      "preview slice has a visible white halo distinct from category color",
    );
    assert.equal(reads, before, "hover is local");
    assert.equal(eventReads, beforeEvents, "hover does not reauthorize event");
    assert.ok(
      (await page.locator(".dashboard-timeline-tooltip").boundingBox())!
        .height <= 76,
      "preview is a small tooltip",
    );
    assert.ok(
      !(await page
        .locator(".dashboard-timeline-tooltip")
        .textContent())!.includes(activity),
      "preview omits long subject identifiers",
    );
    assert.equal(
      await page.locator("#dashboardMapSelection").textContent(),
      "",
    );
    const dot = page.locator(`.dashboard-event-dot[data-event-id="${first}"]`);
    assert.equal(
      await dot.isVisible(),
      true,
      "preview exposes exact coincident map dot",
    );
    assert.equal(await dot.getAttribute("data-preview"), "true");
    assert.equal(await dot.getAttribute("aria-pressed"), "false");
    await page.screenshot({ path: `${evidence}/scrub-hover-desktop.png` });
    await page.mouse.click(c.x, c.y);
    await page
      .getByText("Current authorized workout", { exact: true })
      .waitFor();
    assert.equal(reads, before + 1, "one click one live detail read");
    assert.equal(
      eventReads,
      beforeEvents + 1,
      "one click one exact event read",
    );
    assert.equal(await dot.getAttribute("aria-pressed"), "true");
    const selected = await page.locator("#dashboardMapSelection").textContent();
    const l = await center(later);
    await page.mouse.move(l.x, l.y);
    assert.equal(
      await page.locator("#dashboardMapSelection").textContent(),
      selected,
    );
    assert.equal(
      await page
        .locator(`.dashboard-event-dot[data-event-id="${later}"]`)
        .getAttribute("data-preview"),
      "true",
    );
    const n = await center(noGPS);
    await page.mouse.move(n.x, n.y);
    assert.equal(
      await page.locator('.dashboard-event-dot[data-preview="true"]').count(),
      0,
      "no GPS does not borrow another point",
    );
    await page.mouse.move(0, 0);
    assert.equal(
      await page.locator(".dashboard-timeline-tooltip").isVisible(),
      false,
    );
    assert.equal(
      await dot.getAttribute("aria-pressed"),
      "true",
      "dismiss preserves committed point",
    );
    const cdp = await page.context().newCDPSession(page);
    const touch = async (
      type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
      point?: { x: number; y: number },
    ) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: point ? [{ ...point, id: 1 }] : [],
      });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(100);
      const initial = await center(first),
        dest = await center(later);
      const count = reads,
        eventCount = eventReads;
      const detail = await page.locator("#dashboardMapSelection").textContent();
      await touch("touchStart", initial);
      await touch("touchMove", dest);
      assert.equal(
        await page
          .locator(".dashboard-timeline-tooltip")
          .getAttribute("data-event-id"),
        later,
      );
      assert.equal(
        await page.locator("#dashboardMapSelection").textContent(),
        detail,
      );
      assert.equal(reads, count, "touch drag previews without reads");
      assert.equal(eventReads, eventCount, "touch preview no exact reads");
      await page.screenshot({ path: `${evidence}/scrub-touch-${width}.png` });
      await touch("touchEnd");
      await page.waitForFunction(
        (id) =>
          document
            .querySelector(`.dashboard-timeline-mark[data-event-id="${id}"]`)
            ?.getAttribute("aria-pressed") === "true",
        later,
      );
      await page
        .getByText("Current authorized workout", { exact: true })
        .waitFor();
      assert.equal(
        reads,
        count + 1,
        "release commits once, no synthetic click double-read",
      );
      await touch("touchStart", initial);
      await touch("touchMove", { x: dest.x, y: dest.y + 80 });
      assert.equal(
        await page
          .locator(".dashboard-timeline-tooltip")
          .getAttribute("data-event-id"),
        later,
        "capture keeps scrubbing beyond track",
      );
      await touch("touchCancel");
      assert.equal(
        await page.locator(".dashboard-timeline-tooltip").isVisible(),
        false,
      );
      assert.equal(reads, count + 1, "cancel never commits");
      assert.equal(await mark(later).getAttribute("aria-pressed"), "true");
      await touch("touchStart", initial);
      await touch("touchMove", { x: dest.x, y: dest.y + 80 });
      await touch("touchEnd");
      await page
        .getByText("Current authorized workout", { exact: true })
        .waitFor();
      assert.equal(
        reads,
        count + 2,
        "release outside commits captured nearest event",
      );
      assert.equal(
        eventReads,
        eventCount + 2,
        "each release has exactly one exact read, cancel has none",
      );
      const height = (await page
        .locator(".dashboard-timeline-track")
        .boundingBox())!.height;
      assert.equal(height, 51);
    }
    await mark(first).focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(
      await page
        .locator(".dashboard-timeline-mark:focus")
        .getAttribute("data-event-id"),
      "000000000000000000000002",
    );
    await page.keyboard.press("Enter");
    await page
      .getByText("Current authorized workout", { exact: true })
      .waitFor();
    assert.match(
      (await page.locator("#dashboardMapSelection").textContent())!,
      /Set 2/,
    );
    await page.getByRole("button", { name: "Next event", exact: true }).click();
    await page
      .getByText("Current authorized workout", { exact: true })
      .waitFor();
    assert.equal(
      await mark("000000000000000000000003").getAttribute("aria-pressed"),
      "true",
    );
    await page
      .getByRole("button", { name: "Previous event", exact: true })
      .click();
    await page
      .getByText("Current authorized workout", { exact: true })
      .waitFor();
    assert.equal(
      await mark("000000000000000000000002").getAttribute("aria-pressed"),
      "true",
    );
    // Touch time labels pan a zoomed track rather than committing an event.
    await page
      .locator("#dashboardTimeline")
      .getByRole("button", { name: "Zoom in", exact: true })
      .click();
    await page
      .locator("#dashboardTimeline")
      .getByRole("button", { name: "Zoom in", exact: true })
      .click();
    const panReads = reads,
      panEvents = eventReads;
    const scrollBox = (await page
      .locator(".dashboard-timeline-scroll")
      .boundingBox())!;
    const band = (await page
      .locator(".dashboard-timeline-track")
      .boundingBox())!;
    const oldScroll = await page
      .locator(".dashboard-timeline-scroll")
      .evaluate((n) => n.scrollLeft);
    await touch("touchStart", {
      x: scrollBox.x + scrollBox.width / 2,
      y: band.y + 46,
    });
    await touch("touchMove", {
      x: scrollBox.x + scrollBox.width / 2 - 40,
      y: band.y + 46,
    });
    await touch("touchEnd");
    assert.ok(
      (await page
        .locator(".dashboard-timeline-scroll")
        .evaluate((n) => n.scrollLeft)) > oldScroll,
      "ruler drag preserves horizontal pan",
    );
    assert.equal(reads, panReads);
    assert.equal(eventReads, panEvents);
    await page.getByRole("button", { name: "Full day", exact: true }).click();
    // A real served scope read supersedes an active captured touch gesture.
    let releaseRoute: (status: number) => void = () => {
      throw new Error("route not held");
    };
    await page.evaluate(() => {
      (window as any).oldTrack = document.querySelector(
        ".dashboard-timeline-track",
      );
      (window as any).oldScroll = document.querySelector(
        ".dashboard-timeline-scroll",
      );
    });
    await page.route("**/api/dashboard/timeline?**", async (route) => {
      const status = await new Promise<number>((resolve) => {
        releaseRoute = resolve;
      });
      await route.fulfill({
        status,
        contentType: "application/json",
        body: "{}",
      });
    });
    await page.mouse.move(0, 0);
    await touch("touchStart", await center(first));
    assert.equal(
      await page.locator(".dashboard-timeline-tooltip").isVisible(),
      true,
    );
    await page.locator("#dashboardMapDate").dispatchEvent("change");
    await page
      .getByText("Loading authorized day events…", { exact: true })
      .waitFor();
    assert.equal(
      await page.locator(".dashboard-timeline-tooltip").isVisible(),
      false,
      "pending reload immediately clears preview",
    );
    const pendingReads = reads,
      pendingEvents = eventReads;
    await touch("touchMove", await center(later));
    await touch("touchEnd");
    assert.equal(reads, pendingReads);
    assert.equal(eventReads, pendingEvents);
    releaseRoute(503);
    await page.getByText(/Timeline unavailable \(503\)/).waitFor();
    await page.waitForTimeout(100);
    const restored = await center(first);
    await page.mouse.move(restored.x, restored.y);
    assert.equal(
      await page.locator(".dashboard-timeline-tooltip").isVisible(),
      true,
      "transient reload restores local preview",
    );
    await page.locator("#dashboardMapDate").dispatchEvent("change");
    await page
      .getByText("Loading authorized day events…", { exact: true })
      .waitFor();
    releaseRoute(403);
    await page.getByText(/Timeline unavailable \(403\)/).waitFor();
    assert.equal(
      await page.locator(".dashboard-timeline-mark").count(),
      0,
      "denial purges timeline",
    );
    assert.equal(
      await page.locator('.dashboard-event-dot[data-preview="true"]').count(),
      0,
    );
    await page.unroute("**/api/dashboard/timeline?**");
    await page.locator("#dashboardMapDate").dispatchEvent("change");
    await page.waitForFunction(
      () => document.querySelectorAll(".dashboard-timeline-mark").length === 5,
    );
    await page.waitForTimeout(100);
    const freshHover = await center(first);
    await page.mouse.move(0, 0);
    await page.mouse.move(freshHover.x, freshHover.y);
    assert.equal(await dot.getAttribute("data-preview"), "true");
    await page.evaluate(() => {
      (window as any).oldTrack.onpointerleave();
      (window as any).oldTrack.onpointercancel();
      (window as any).oldScroll.onscroll();
    });
    assert.equal(
      await dot.getAttribute("data-preview"),
      "true",
      "superseded track handlers cannot dismiss the new map preview",
    );
  } finally {
    await browser.close();
    await app.close();
    backend.closeAllConnections();
    await new Promise<void>((r) => backend.close(() => r()));
    await rm(home, { recursive: true, force: true });
  }
});
