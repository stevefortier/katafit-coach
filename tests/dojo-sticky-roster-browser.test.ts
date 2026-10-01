import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

// Real served UI; only member data, map tiles and native Pi are synthetic.
test("Dojo roster stays above the map and remains selectable while scrolling", async () => {
  const home = await mkdtemp(tmpdir() + "/dojo-sticky-roster-");
  const store = new Store(home);
  await store.init();
  const app = await admin(store, 0);
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    headless: true,
    ignoreDefaultArgs: ["--hide-scrollbars"],
    args: ["--no-sandbox"],
  });
  const evidence = process.env.DOJO_STICKY_EVIDENCE_DIR;
  const snapshots: { phase: string; requested: number; geometry: unknown }[] =
    [];
  try {
    if (evidence) await mkdir(evidence, { recursive: true });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    page.setDefaultTimeout(10000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const members = ["Ada", "Bob"].map((name, i) => ({
      _id: String(i + 1).repeat(24),
      display_name: `Synthetic ${name}`,
      stats: {
        weight: { value: 68 + i * 5, unit: "kg" },
        height_cm: 170 + i * 5,
        body_fat_percent: 20,
        body_fat_estimate: { source: "ai", estimated: true, value: 20 },
        age_years: 30 + i,
      },
      last_position: {
        activity_id: `synthetic-position-${i}`,
        type: "workout",
        occurred_at: "2026-09-30T12:00:00Z",
        position: { latitude: 40.72 + i * 0.003, longitude: -74.04 },
      },
    }));
    await page.route(/\/api\/dashboard(?:[/?]|$)/, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/dashboard/avatar") {
        await route.fulfill({ status: 404, body: "" });
      } else if (path === "/api/dashboard/members") {
        await route.fulfill({ json: { members } });
      } else if (path === "/api/dashboard/timeline") {
        // This BFF proxies /api/friends/dojo/day-events, not day-activities.
        const start = new URL(route.request().url()).searchParams.get("start")!;
        await route.fulfill({
          json: {
            users: members,
            events: members.map((member, i) => ({
              id: `synthetic-event-${i}`,
              user_id: member._id,
              occurred_at: new Date(
                Date.parse(start) + (i + 1) * 3600000,
              ).toISOString(),
              event_type: "workout.completed",
              subject: { type: "workout", id: String(i + 3).repeat(24) },
              details: {
                name: "Synthetic workout",
                from_status: "ongoing",
                to_status: "complete",
              },
              actor_type: "member",
              source: "interactive",
            })),
            hasMore: false,
            nextCursor: null,
            coverage: { historical_aggregates: true },
          },
        });
      } else {
        await route.fulfill({
          json: { users: members, activities: [], hasMore: false },
        });
      }
    });
    await page.route("https://tile.openstreetmap.org/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#ddd9cc"/><path d="M0 80H256M80 0V256M0 180H256" stroke="#fff" stroke-width="12"/><text x="100" y="145" font-size="16">Synthetic map</text></svg>',
      }),
    );
    await page.route("**/api/terminal/ticket", (route) =>
      route.fulfill({
        json: { path: "/synthetic-roster-pi", ticket: "synthetic" },
      }),
    );
    await page.routeWebSocket("**/synthetic-roster-pi", (socket) => {
      socket.onMessage((raw) => {
        if (JSON.parse(String(raw)).ticket)
          socket.send(JSON.stringify({ type: "ready" }));
      });
    });
    await page.goto(app.origin + "/dashboard");
    await page.locator("#adminKey").fill(store.secrets.admin);
    await page.locator("#unlock").click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#dashboardMemberCards button").length === 3,
    );
    await page.locator("#dashboardCharts h3").waitFor();
    await page.waitForFunction(
      () =>
        !document
          .querySelector("#dashboardTimeline")!
          .textContent!.includes("Loading authorized day events"),
    );
    assert.equal(
      await page
        .locator("#dashboardTimeline .dashboard-timeline-count")
        .count(),
      1,
      "sticky fixture must render the real day-events timeline, not an invalid activities envelope",
    );
    assert.equal(await page.locator(".dashboard-timeline-mark").count(), 2);
    // Deliberately sparse feed: no chart categories are invented to make the
    // document long enough. A finite nonshrinking fixture owns that height.
    assert.equal(await page.locator(".dashboard-chart").count(), 0);
    await page.evaluate(() => {
      const spacer = document.createElement("div");
      spacer.id = "stickyScrollFixture";
      spacer.style.cssText = "height:2200px;min-height:2200px;flex-shrink:0";
      spacer.textContent = "Synthetic long-page scroll fixture";
      document.querySelector("#dashboardPanel")!.append(spacer);
    });
    const geometry = async (phase = "geometry", requested = 0) => {
      const result = await page.evaluate(() => {
        const cards = document.querySelector<HTMLElement>(
          "#dashboardMemberCards",
        )!;
        const map = document.querySelector<HTMLElement>("#dashboardMap")!;
        const header = document.querySelector("header")!;
        return {
          cardsTop: cards.getBoundingClientRect().top,
          cardsBottom: cards.getBoundingClientRect().bottom,
          mapTop: map.getBoundingClientRect().top,
          headerBottom: header.getBoundingClientRect().bottom,
          stickyTop: parseFloat(getComputedStyle(cards).top),
          rosterHeight: cards.offsetHeight,
          overflow: document.documentElement.scrollWidth > innerWidth,
          rootScroll: scrollY,
          rootHeight: document.documentElement.scrollHeight,
          rootMax: document.documentElement.scrollHeight - innerHeight,
          viewport: { width: innerWidth, height: innerHeight },
          workspaceHeight:
            document.querySelector("#workspaceScroll")!.scrollHeight,
          workspaceMax:
            document.querySelector("#workspaceScroll")!.scrollHeight -
            document.querySelector("#workspaceScroll")!.clientHeight,
          rosterPosition: getComputedStyle(cards).position,
          headerPosition: getComputedStyle(header).position,
          headerOffset: getComputedStyle(
            document.documentElement,
          ).getPropertyValue("--header-offset"),
          rootBehavior: getComputedStyle(document.documentElement)
            .scrollBehavior,
          panelBottom: document
            .querySelector("#dashboardPanel")!
            .getBoundingClientRect().bottom,
          timelineText:
            document.querySelector("#dashboardTimeline")!.textContent,
          chartCount: document.querySelectorAll(".dashboard-chart").length,
          spacerHeight: document
            .querySelector("#stickyScrollFixture")!
            .getBoundingClientRect().height,
          workspaceScroll:
            document.querySelector("#workspaceScroll")!.scrollTop,
        };
      });
      snapshots.push({ phase, requested, geometry: result });
      return result;
    };
    const top = await geometry("desktop-top");
    assert.ok(top.cardsBottom < top.mapTop);
    assert.ok(top.rootMax >= 650, JSON.stringify(top));
    assert.equal(top.rosterPosition, "sticky");
    if (evidence) {
      await page.screenshot({ path: evidence + "/desktop-top-synthetic.png" });
    }
    await page.evaluate(() => scrollTo(0, 650));
    let g = await geometry("desktop-scrolled", 650);
    assert.ok(Math.abs(g.rootScroll - 650) < 2, JSON.stringify(g));
    assert.ok(g.cardsBottom <= g.panelBottom);
    assert.ok(Math.abs(g.cardsTop - g.stickyTop) < 2);
    assert.ok(g.cardsTop >= g.headerBottom - 1);
    assert.equal(g.overflow, false);
    await page
      .locator("#dashboardMemberCards")
      .getByRole("button", { name: /Synthetic Bob/ })
      .click();
    assert.equal(
      await page
        .locator("#dashboardMemberCards")
        .getByRole("button", { name: /Synthetic Bob/ })
        .getAttribute("aria-pressed"),
      "true",
    );
    g = await geometry("desktop-selected", 650);
    assert.ok(Math.abs(g.rootScroll - 650) < 2, JSON.stringify(g));
    assert.ok(Math.abs(g.cardsTop - g.stickyTop) < 2);
    assert.ok(g.cardsTop >= g.headerBottom - 1);
    assert.ok(g.cardsBottom <= g.panelBottom);
    await page.evaluate(() =>
      (document.querySelector("#coachLauncher") as HTMLElement).click(),
    );
    await page.waitForFunction(() =>
      document
        .querySelector("#nativeStatus")
        ?.textContent?.startsWith("Connected"),
    );
    const docked = await geometry("docked-ready", 950);
    assert.ok(docked.workspaceMax >= 950, JSON.stringify(docked));
    await page
      .locator("#workspaceScroll")
      .evaluate((el) => el.scrollTo(0, 950));
    g = await geometry("docked-scrolled", 950);
    assert.ok(Math.abs(g.workspaceScroll - 950) < 2, JSON.stringify(g));
    assert.ok(g.cardsBottom <= g.panelBottom);
    assert.equal(g.rootScroll, 0);
    assert.ok(Math.abs(g.cardsTop - g.stickyTop) < 2);
    assert.ok(g.cardsTop >= g.headerBottom - 1);
    await page
      .locator("#dashboardMemberCards")
      .getByRole("button", { name: /Synthetic Ada/ })
      .click();
    assert.equal(
      await page
        .locator("#dashboardMemberCards")
        .getByRole("button", { name: /Synthetic Ada/ })
        .getAttribute("aria-pressed"),
      "true",
    );
    g = await geometry("docked-selected", 950);
    assert.ok(Math.abs(g.workspaceScroll - 950) < 2, JSON.stringify(g));
    if (evidence)
      await page.screenshot({
        path: evidence + "/desktop-docked-sticky-synthetic.png",
      });
    await page.locator("#coachPaneCollapse").click();
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      // setViewportSize resolves before the header ResizeObserver publishes its
      // new sticky offset. Do not scroll/click against the old desktop geometry.
      await page.waitForFunction(() => {
        const cards = document.querySelector("#dashboardMemberCards")!;
        const header = document.querySelector("header")!;
        return (
          parseFloat(getComputedStyle(cards).top) >=
          header.getBoundingClientRect().bottom - 1
        );
      });
      const before = await geometry(`mobile-${width}-ready`, 650);
      assert.ok(before.rootMax >= 650, JSON.stringify({ width, before }));
      assert.ok(
        before.stickyTop >= before.headerBottom - 1,
        JSON.stringify({ width, before }),
      );
      await page.evaluate(() => scrollTo(0, 650));
      g = await geometry(`mobile-${width}-scrolled`, 650);
      assert.ok(Math.abs(g.rootScroll - 650) < 2, JSON.stringify({ width, g }));
      assert.ok(g.cardsTop >= g.headerBottom - 1);
      assert.ok(g.cardsBottom <= g.panelBottom);
      assert.equal(g.overflow, false);
      assert.ok(g.rosterHeight < 200, JSON.stringify({ width, g }));
      assert.ok(Math.abs(g.cardsTop - g.stickyTop) < 2);
      await page
        .locator("#dashboardMemberCards")
        .getByRole("button", { name: /Synthetic Bob/ })
        .click();
      assert.equal(
        await page
          .locator("#dashboardMemberCards")
          .getByRole("button", { name: /Synthetic Bob/ })
          .getAttribute("aria-pressed"),
        "true",
      );
      const after = await geometry(`mobile-${width}-selected`, 650);
      assert.ok(Math.abs(after.cardsTop - after.stickyTop) < 2);
      assert.ok(after.cardsTop >= after.headerBottom - 1);
      assert.ok(after.cardsBottom <= after.panelBottom);
      assert.ok(
        Math.abs(after.rootScroll - 650) < 2,
        JSON.stringify({ width, before, scrolled: g, after }),
      );
      if (evidence && width === 390)
        await page.screenshot({
          path: evidence + "/mobile-sticky-synthetic.png",
        });
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await app.close();
    await rm(home, { recursive: true, force: true });
    if (evidence)
      await writeFile(
        evidence + "/geometry-synthetic.json",
        JSON.stringify(
          {
            node: process.version,
            browser: browser.version(),
            fixture: {
              timeline: "day-events",
              events: 2,
              feedActivities: 0,
              spacerHeight: 2200,
            },
            snapshots,
          },
          null,
          2,
        ) + "\n",
      );
  }
});
