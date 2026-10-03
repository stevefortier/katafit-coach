import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import sharp from "sharp";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

test("served Dojo subtabs preserve scope, keyboard selection and map return geometry", async () => {
  const home = await mkdtemp(tmpdir() + "/gallery-browser-");
  const calls: string[] = [];
  let photoCount = 4;
  const pixels = await sharp({
    create: {
      width: 160,
      height: 240,
      channels: 3,
      background: { r: 70, g: 120, b: 150 },
    },
  })
    .png()
    .toBuffer();
  const row = (id: string) => ({
    _id: id,
    user_id: "aaaaaaaaaaaaaaaaaaaaaaaa",
    type: "media",
    status: "complete",
    created_at: "2026-09-28T12:00:00Z",
    data: { files: [{ _id: "f1", type: "image/png" }] },
  });
  const backend = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture");
    calls.push(req.url!);
    if (
      url.pathname.startsWith("/api/media/") ||
      /^\/api\/users\/[^/]+\/avatar\/512$/.test(url.pathname)
    ) {
      res.setHeader("content-type", "image/png");
      res.end(pixels);
      return;
    }
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/friends/feed/dojo")
      res.end(
        JSON.stringify({
          users: [
            { _id: "aaaaaaaaaaaaaaaaaaaaaaaa", display_name: "Synthetic Ada" },
          ],
          activities:
            url.searchParams.get("type") === "media"
              ? [row(url.searchParams.has("cursor") ? "older" : "latest")]
              : [
                  row("latest"),
                  ...[26, 27, 28].map((day, index) => ({
                    ...row(`workout-${day}`),
                    type: "workout",
                    created_at: `2026-09-${day}T12:00:00Z`,
                    workout_progress: { completed_sets: 4 + index * 2 },
                  })),
                ],
          hasMore:
            url.searchParams.get("type") === "media" &&
            !url.searchParams.has("cursor"),
          nextCursor: url.searchParams.has("cursor") ? null : "opaque_cursor",
        }),
      );
    else if (url.pathname.startsWith("/api/friends/activity/"))
      res.end(
        JSON.stringify({
          activity: {
            ...row(url.pathname.split("/").at(-1)!),
            data: {
              files: Array.from({ length: photoCount }, (_, i) => ({
                _id: `f${i + 1}`,
                type: "image/png",
              })),
            },
          },
          owner: { _id: "aaaaaaaaaaaaaaaaaaaaaaaa" },
        }),
      );
    else if (url.pathname.endsWith("day-events"))
      res.end(
        JSON.stringify({
          users: [
            { _id: "aaaaaaaaaaaaaaaaaaaaaaaa", display_name: "Synthetic Ada" },
          ],
          events: [
            {
              id: "eeeeeeeeeeeeeeeeeeeeeeee",
              user_id: "aaaaaaaaaaaaaaaaaaaaaaaa",
              occurred_at: new Date(
                Date.parse(url.searchParams.get("start")!) + 3600000,
              ).toISOString(),
              event_type: "workout.completed",
              subject: { type: "workout", id: "latest" },
              details: { name: "Synthetic workout" },
              position: {
                availability: "available",
                latitude: 40.7,
                longitude: -73.9,
              },
            },
          ],
          hasMore: false,
          nextCursor: null,
        }),
      );
    else if (url.pathname.endsWith("dashboard-members"))
      res.end(
        JSON.stringify({
          members: [
            {
              _id: "aaaaaaaaaaaaaaaaaaaaaaaa",
              display_name: "Synthetic Ada",
              stats: {},
            },
          ],
        }),
      );
    else
      res.end(
        JSON.stringify({
          users: [],
          activities: [],
          events: [],
          hasMore: false,
          members: [],
        }),
      );
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(backend.address() as any).port}`,
    token: "synthetic",
  });
  const server = await admin(store, 0);
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    await page.route("https://tile.openstreetmap.org/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#ddd9cc"/><path d="M0 80H256M80 0V256M0 180H256" stroke="#fff" stroke-width="12"/><text x="90" y="145" font-size="16">Synthetic map</text></svg>',
      }),
    );
    await page.goto(server.origin + "/dashboard");
    await page.locator("#adminKey").fill(store.secrets.admin);
    await page.locator("#unlock").click();
    await page.locator("#dashboardMapPane").waitFor();
    const map = page.locator("#dashboardMapPane");
    const trends = page.locator("#dashboardCharts");
    const gallery = page.locator("#dashboardGallery");
    const tabs = page.getByRole("tablist", { name: "Dojo sections" });
    assert.ok(await map.isVisible());
    assert.equal(await trends.isVisible(), false);
    assert.equal(await gallery.isVisible(), false);
    await page
      .waitForFunction(
        () => document.querySelectorAll(".dashboard-event-dot").length > 0,
        null,
        { timeout: 5000 },
      )
      .catch(async (error) => {
        console.log(
          calls,
          await page.locator("#dashboardMapStatus").textContent(),
          await page.locator("#dashboardTimeline").textContent(),
        );
        throw error;
      });
    await page
      .locator("#dashboardMemberCards button")
      .filter({ hasText: "Synthetic Ada" })
      .first()
      .click();
    const selected = page
      .locator('#dashboardMemberCards button[aria-pressed="true"]')
      .first();
    const member = await selected.textContent();
    const portrait = page.locator(".dashboard-member-portrait img").first();
    await portrait.waitFor();
    await portrait.evaluate((img: HTMLImageElement) => img.decode());
    const portraitUrl = await portrait.getAttribute("src");
    const avatarCalls = calls.filter((x) => x.includes("/avatar/")).length;
    const date = await page.locator("#dashboardMapDate").inputValue();
    await page.locator(".dashboard-event-dot").first().click();
    await page.waitForFunction(() =>
      document
        .getElementById("dashboardMapSelection")
        ?.textContent?.includes("Event access rechecked"),
    );
    const detail = await page.locator("#dashboardMapSelection").textContent();
    await page.waitForTimeout(200);
    assert.equal(
      calls.filter((x) => x.includes("type=media")).length,
      1,
      "hidden initial Gallery retains one bounded inventory page without automatic continuation",
    );
    await tabs.getByRole("tab", { name: "Map & events" }).focus();
    await page.keyboard.press("ArrowRight");
    assert.ok(await trends.isVisible());
    assert.equal(await map.isVisible(), false);
    assert.equal(await page.locator("#dashboardMapYear").isVisible(), false);
    await page.keyboard.press("End");
    assert.ok(await gallery.isVisible());
    await gallery.scrollIntoViewIfNeeded();
    const image = gallery.locator("img").first();
    await image.waitFor();
    await image.evaluate((img: any) => img.decode());
    const acquired = await image.getAttribute("src");
    await image.click();
    assert.ok(await page.locator("#attachmentDialog").isVisible());
    assert.equal(
      await page
        .locator("#attachmentDialog")
        .evaluate((el) => !!el.closest('[role="tabpanel"]')),
      false,
    );
    await page.keyboard.press("Escape");
    assert.ok(
      await image.locator("..").evaluate((el) => el === document.activeElement),
    );
    await tabs.getByRole("tab", { name: "Map & events" }).click();
    const rosterCalls = calls.filter((x) =>
      x.includes("dashboard-members"),
    ).length;
    const galleryCalls = calls.filter((x) => x.includes("type=media")).length;
    await page.waitForTimeout(200);
    assert.equal(
      calls.filter((x) => x.includes("type=media")).length,
      galleryCalls,
      "hidden gallery does not automatically page",
    );
    const evidence = process.env.DOJO_SUBTABS_EVIDENCE || home + "/evidence";
    await mkdir(evidence, { recursive: true });
    for (const width of [1280, 390, 320]) {
      await tabs.getByRole("tab", { name: "Activity trends" }).click();
      await page.setViewportSize({ width, height: 844 });
      await tabs.getByRole("tab", { name: "Map & events" }).click();
      await page.waitForFunction(() =>
        [
          ...document.querySelectorAll<HTMLElement>(".dashboard-event-dot"),
        ].some((el) => {
          const r = el.getBoundingClientRect();
          const m = document
            .getElementById("dashboardMap")!
            .getBoundingClientRect();
          return (
            !el.hidden &&
            r.width > 0 &&
            r.left >= m.left &&
            r.right <= m.right &&
            r.top >= m.top &&
            r.bottom <= m.bottom
          );
        }),
      );
      assert.equal(await page.locator("#dashboardMapDate").inputValue(), date);
      assert.equal(
        await page.locator("#dashboardMapSelection").textContent(),
        detail,
      );
      assert.equal(await selected.textContent(), member);
      assert.equal(await portrait.getAttribute("src"), portraitUrl);
      await portrait.evaluate((img: HTMLImageElement) => img.decode());
      assert.equal(
        calls.filter((x) => x.includes("/avatar/")).length,
        avatarCalls,
      );
      await page.evaluate(() => {
        document.querySelector("#workspaceScroll")!.scrollTop = 0;
      });
      const geometry = await page.evaluate(() => {
        const roster = document.getElementById("dashboardMemberCards")!;
        const tabs = document.getElementById("dashboardSubtabs")!;
        const pane = document.getElementById("dashboardMapPane")!;
        return {
          position: getComputedStyle(roster).position,
          rosterBottom: roster.getBoundingClientRect().bottom,
          tabsTop: tabs.getBoundingClientRect().top,
          tabsBottom: tabs.getBoundingClientRect().bottom,
          paneTop: pane.getBoundingClientRect().top,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      assert.equal(geometry.position, "static");
      assert.ok(geometry.rosterBottom <= geometry.tabsTop + 1);
      assert.ok(geometry.tabsBottom <= geometry.paneTop + 1);
      assert.equal(geometry.overflow, false);
      await page.screenshot({
        path: `${evidence}/synthetic-map-${width}.png`,
        fullPage: true,
      });
      await tabs.getByRole("tab", { name: "Gallery", exact: true }).click();
      assert.equal(await image.getAttribute("src"), acquired);
      await page.screenshot({
        path: `${evidence}/synthetic-gallery-${width}.png`,
      });
      await tabs.getByRole("tab", { name: "Activity trends" }).click();
      await page.screenshot({
        path: `${evidence}/synthetic-trends-${width}.png`,
      });
    }
    assert.equal(
      calls.filter((x) => x.includes("dashboard-members")).length,
      rosterCalls,
      "presentation switches do not reload roster",
    );
  } finally {
    await browser?.close();
    await server.close();
    backend.closeAllConnections();
    await new Promise<void>((r) => backend.close(() => r()));
    await rm(home, { recursive: true, force: true });
  }
});
