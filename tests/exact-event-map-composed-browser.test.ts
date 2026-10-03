import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { ledger, ada, bob, ev } from "./helpers/exact-map-fixture.js";

test("served exact map composes native civil-date navigation, decoded 512 roster avatars and ordinary location chooser clicks", async () => {
  const home = await mkdtemp(tmpdir() + "/exact-map-composed-");
  const users = [
    { _id: ada, display_name: "Synthetic Ada", stats: { height_cm: 170 } },
    { _id: bob, display_name: "Synthetic Bob", stats: {} },
  ];
  const events = ledger();
  const avatar = await sharp({
    create: { width: 341, height: 512, channels: 3, background: "#527294" },
  })
    .png()
    .toBuffer();
  const tile = await sharp({
    create: { width: 256, height: 256, channels: 3, background: "#26343f" },
  })
    .png()
    .toBuffer();
  const calls: string[] = [];
  const backend = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture");
    calls.push(req.url!);
    assert.equal(req.headers.authorization, "Bearer synthetic-composed");
    if (/^\/api\/users\/[a-f0-9]{24}\/avatar\/512$/.test(url.pathname)) {
      res.setHeader("content-type", "image/png");
      res.end(avatar);
      return;
    }
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/friends/dojo/dashboard-members")
      res.end(JSON.stringify({ members: users }));
    else if (url.pathname === "/api/friends/dojo/day-events") {
      const rows =
        url.searchParams.get("start") === "2026-09-28T00:00:00.000Z"
          ? events
          : [];
      res.end(
        JSON.stringify({
          users,
          events: url.searchParams.has("event_id")
            ? rows.filter((e) => e.id === url.searchParams.get("event_id"))
            : rows,
          hasMore: false,
        }),
      );
    } else if (url.pathname.startsWith("/api/friends/activity/")) {
      res.statusCode = 404;
      res.end("{}");
    } else
      res.end(JSON.stringify({ users: [], activities: [], hasMore: false }));
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(backend.address() as any).port}`,
    token: "synthetic-composed",
  });
  const app = await admin(store, 0);
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  });
  try {
    const evidence = process.env.EXACT_MAP_EVIDENCE_DIR || home + "/evidence";
    await mkdir(evidence, { recursive: true });
    const receipts: any[] = [];
    for (const width of [1440, 320]) {
      const context = await browser.newContext({
        viewport: { width, height: 1100 },
        timezoneId: "UTC",
      });
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.route("https://tile.openstreetmap.org/**", (r) =>
          r.fulfill({ contentType: "image/png", body: tile }),
        );
        await page.goto(app.origin + "/dashboard");
        await page.locator("#adminKey").fill(store.secrets.admin);
        await page.locator("#unlock").click();
        await page.locator("#dashboardMapDate").fill("2026-09-28");
        await page.locator("#dashboardMapDate").dispatchEvent("change");
        await page.waitForFunction(
          () =>
            document.querySelectorAll(".dashboard-event-dot").length === 7 &&
            document.querySelectorAll(".dashboard-member-portrait img")
              .length === 2,
        );
        const portraits = await page
          .locator(".dashboard-member-portrait img")
          .evaluateAll(async (nodes) => {
            await Promise.all(
              nodes.map((n) => (n as HTMLImageElement).decode()),
            );
            return nodes.map((n) => {
              const i = n as HTMLImageElement;
              return {
                width: i.naturalWidth,
                height: i.naturalHeight,
                fit: getComputedStyle(i).objectFit,
              };
            });
          });
        assert.deepEqual(portraits, [
          { width: 341, height: 512, fit: "cover" },
          { width: 341, height: 512, fit: "cover" },
        ]);
        assert.equal(
          await page.getByLabel("Month", { exact: true }).inputValue(),
          "9",
        );
        assert.equal(
          await page.getByLabel("Year", { exact: true }).inputValue(),
          "2026",
        );
        assert.equal(
          await page.getByLabel("Day of month", { exact: true }).inputValue(),
          "28",
        );
        assert.equal(await page.locator("#dashboardMapDay option").count(), 30);
        const group = page.locator('.dashboard-map-group[data-count="3"]');
        await group.click();
        await page
          .locator(`.dashboard-map-choice[data-event-id="${ev(2)}"]`)
          .click();
        await page.waitForFunction(() =>
          document
            .querySelector("#dashboardMapSelection")
            ?.textContent?.includes(
              "Current subject activity unavailable (404)",
            ),
        );
        assert.equal(
          await page
            .locator(`.dashboard-timeline-mark[data-event-id="${ev(2)}"]`)
            .getAttribute("aria-pressed"),
          "true",
        );
        await group.click({ timeout: 3000 });
        await page
          .locator(`.dashboard-map-choice[data-event-id="${ev(1)}"]`)
          .click();
        await page.waitForFunction(() =>
          document
            .querySelector("#dashboardMapSelection")
            ?.textContent?.includes("Event access rechecked"),
        );
        assert.match(
          await page.locator("#dashboardMapSelection").innerText(),
          /Event location: 40\.7, -73\.9/,
        );
        assert.equal(
          await page
            .locator('.dashboard-event-dot[aria-pressed="true"]')
            .getAttribute("data-event-id"),
          ev(1),
        );
        await page
          .locator("#dashboardMap .leaflet-tile-loaded")
          .first()
          .waitFor();
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({
          path: `${evidence}/synthetic-composed-${width}.png`,
          fullPage: true,
        });
        const geometry = await page.evaluate(() => ({
          width: innerWidth,
          scroll: document.documentElement.scrollWidth,
          map: document
            .querySelector("#dashboardMap")!
            .getBoundingClientRect()
            .toJSON(),
          detail: document
            .querySelector("#dashboardMapSelection")!
            .getBoundingClientRect()
            .toJSON(),
        }));
        assert.ok(geometry.scroll <= width + 1, JSON.stringify(geometry));
        assert.ok(
          width === 320
            ? geometry.detail.top >= geometry.map.bottom
            : geometry.detail.left >= geometry.map.right,
        );
        // Ordinary approved date controls update the same canonical stream.
        await page
          .getByRole("button", { name: "Next day", exact: true })
          .click();
        await page.waitForFunction(() =>
          document
            .querySelector("#dashboardMapStatus")
            ?.textContent?.includes("0 of 0"),
        );
        assert.equal(
          await page
            .locator(".dashboard-event-dot,.dashboard-timeline-mark")
            .count(),
          0,
        );
        await page
          .getByRole("button", { name: "Previous day", exact: true })
          .click();
        await page.waitForFunction(
          () => document.querySelectorAll(".dashboard-event-dot").length === 7,
        );
        assert.deepEqual(errors, []);
        receipts.push({
          synthetic: true,
          width,
          portraits,
          geometry,
          ordinaryChooserReopened: true,
        });
      } finally {
        await context.close();
      }
    }
    assert.ok(
      !calls.some((c) =>
        c.startsWith("/api/friends/dojo/positioned-activities"),
      ),
    );
    await writeFile(
      `${evidence}/composed-receipts.json`,
      JSON.stringify(receipts, null, 2),
    );
  } finally {
    await browser.close();
    await app.close();
    backend.closeAllConnections();
    await new Promise<void>((r) => backend.close(() => r()));
    await rm(home, { recursive: true, force: true });
  }
});
