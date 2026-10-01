import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
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
  try {
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
    await page.evaluate(() => {
      const spacer = document.createElement("p");
      spacer.style.height = "2200px";
      spacer.textContent = "Synthetic long-page scroll fixture";
      document.querySelector("#dashboardPanel")!.append(spacer);
    });
    const geometry = () =>
      page.evaluate(() => {
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
          workspaceScroll:
            document.querySelector("#workspaceScroll")!.scrollTop,
        };
      });
    assert.ok((await geometry()).cardsBottom < (await geometry()).mapTop);
    const evidence = process.env.DOJO_STICKY_EVIDENCE_DIR;
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: evidence + "/desktop-top-synthetic.png" });
    }
    await page.evaluate(() => scrollTo(0, 650));
    let g = await geometry();
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
    assert.ok(Math.abs((await geometry()).rootScroll - 650) < 2);
    await page.evaluate(() =>
      (document.querySelector("#coachLauncher") as HTMLElement).click(),
    );
    await page.waitForFunction(() =>
      document
        .querySelector("#nativeStatus")
        ?.textContent?.startsWith("Connected"),
    );
    await page
      .locator("#workspaceScroll")
      .evaluate((el) => el.scrollTo(0, 950));
    g = await geometry();
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
    assert.ok(Math.abs((await geometry()).workspaceScroll - 950) < 2);
    if (evidence)
      await page.screenshot({
        path: evidence + "/desktop-docked-sticky-synthetic.png",
      });
    await page.locator("#coachPaneCollapse").click();
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(() => scrollTo(0, 650));
      g = await geometry();
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
      assert.ok(Math.abs((await geometry()).rootScroll - 650) < 2);
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
  }
});
