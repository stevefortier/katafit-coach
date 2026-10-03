import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import sharp from "sharp";

// All people, numbers and pixels in this served-renderer fixture are synthetic.
test("synthetic roster cards use bounded intrinsic widths across cache renders", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-roster-intrinsic-"));
  const evidence = process.env.COACH_ROSTER_EVIDENCE ?? home;
  const members = [
    { _id: "ada", display_name: "Ada" },
    {
      _id: "long",
      display_name: "Synthetic Alexandertheverylongunbrokenname".repeat(4),
    },
    { _id: "missing", display_name: "Synthetic Missing" },
  ].map((user, i) => ({
    ...user,
    _id: String(i + 1).repeat(24),
    stats:
      i === 2
        ? { body_fat_percent: 42 }
        : {
            weight: { value: 68, unit: "kg" },
            height_cm: 170,
            age_years: 30,
            body_fat_percent: 21,
            body_fat_estimate: { source: "ai", estimated: true, value: 21 },
          },
  }));
  const avatar = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#385c80"/><circle cx="256" cy="190" r="100" fill="#dcb998"/><path d="M35 512Q256 240 477 512" fill="#dcb998"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture");
    if (["/dashboard.js", "/style.css"].includes(url.pathname)) {
      res.setHeader(
        "content-type",
        url.pathname.endsWith("js") ? "text/javascript" : "text/css",
      );
      res.end(await readFile(new URL(`../ui${url.pathname}`, import.meta.url)));
    } else if (url.pathname === "/") {
      res.setHeader("content-type", "text/html");
      res.end(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><main style="padding:8px;min-width:0"><h1>SYNTHETIC ROSTER FIXTURE</h1><input id="dashboardMapDate" type="date"><div id="dashboardMapStatus"></div><div id="dashboardMap"></div><div id="dashboardMapSelection"></div><div id="dashboardMemberHeading"></div><div id="dashboardMemberCards" class="dashboard-member-cards"></div><div id="dashboardStatus"></div><div id="dashboardCoverage"></div><div id="dashboardRoster"></div><div id="dashboardCharts"></div></main><script src="/dashboard.js"></script>',
      );
    } else {
      calls.push(url.pathname + url.search);
      if (url.pathname === "/api/dashboard/avatar") {
        if (url.searchParams.get("id") === members[2]._id) {
          res.statusCode = 404;
          res.end();
        } else {
          res.setHeader("content-type", "image/png");
          res.end(avatar);
        }
      } else {
        res.setHeader("content-type", "application/json");
        if (url.pathname === "/api/dashboard/members")
          res.end(JSON.stringify({ members }));
        else if (url.pathname === "/api/dashboard")
          res.end(
            JSON.stringify({ users: members, activities: [], hasMore: false }),
          );
        else {
          res.statusCode = 404;
          res.end("{}");
        }
      }
    }
  });
  let browser;
  try {
    await mkdir(evidence, { recursive: true });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    const geometry = [];
    for (const width of [1440, 320, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 850 },
        hasTouch: width !== 1440,
      });
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto(`http://127.0.0.1:${(server.address() as any).port}/`);
        await page.evaluate(() =>
          (window as any).CoachDashboard.load(null, "synthetic"),
        );
        const cards = page.locator(".dashboard-member-card");
        await cards.first().waitFor();
        await page.waitForFunction(
          () =>
            document.querySelectorAll(".dashboard-roster-image").length === 2 &&
            [
              ...document.querySelectorAll<HTMLImageElement>(
                ".dashboard-roster-image",
              ),
            ].every((img) => img.complete && img.naturalWidth === 512),
        );
        const measure = () =>
          page.evaluate(() => ({
            widths: [
              ...document.querySelectorAll(".dashboard-member-card"),
            ].map((n) => n.getBoundingClientRect().width),
            heights: [
              ...document.querySelectorAll(".dashboard-member-card"),
            ].map((n) => n.getBoundingClientRect().height),
            overflow: document.documentElement.scrollWidth > innerWidth,
            railOverflow:
              document.querySelector(".dashboard-member-rail")!.scrollWidth >
              document.querySelector(".dashboard-member-rail")!.clientWidth,
            images: [
              ...document.querySelectorAll<HTMLImageElement>(
                ".dashboard-roster-image",
              ),
            ].map((img) => ({
              width: img.getBoundingClientRect().width,
              height: img.getBoundingClientRect().height,
              portraitHeight: img.parentElement!.getBoundingClientRect().height,
              fit: getComputedStyle(img).objectFit,
            })),
          }));
        assert.equal(
          (await cards.first().innerText()).includes("(photo estimate)"),
          false,
          "roster provenance is a tooltip, not inline text",
        );
        const initial = await measure();
        assert.ok(
          initial.widths[0] < initial.widths[1],
          `short cards must be narrower than bounded long-name cards: ${initial.widths}`,
        );
        assert.ok(
          initial.widths.every((w) => w <= 340),
          "cards must not grow to fill desktop rail",
        );
        assert.equal(initial.overflow, false);
        assert.equal(initial.railOverflow, width !== 1440);
        for (const image of initial.images) {
          assert.equal(image.width, width === 1440 ? 100 : 90);
          assert.equal(image.height, image.portraitHeight);
          assert.equal(image.fit, "cover");
        }
        assert.equal(await cards.nth(2).locator("img").count(), 0);
        assert.match(await cards.nth(2).innerText(), /Body fat.*Unavailable/);
        const reads = calls.length;
        await cards.first().focus();
        await page.keyboard.press("Enter");
        assert.equal(await cards.first().getAttribute("aria-pressed"), "true");
        const rail = page.locator(".dashboard-member-rail");
        if (width !== 1440) {
          await rail.evaluate((node) => {
            node.scrollLeft = 100;
          });
          await page.waitForTimeout(30);
        }
        await cards.nth(1).focus();
        await page.keyboard.press("Space");
        assert.equal(await cards.nth(1).getAttribute("aria-pressed"), "true");
        if (width !== 1440) {
          const scroll = await rail.evaluate((node) => node.scrollLeft);
          await cards.nth(1).focus();
          await page.keyboard.press("Enter");
          assert.equal(
            await rail.evaluate((node) => node.scrollLeft),
            scroll,
            "cached rerender retains mobile rail scroll",
          );
        }
        await page
          .getByRole("button", { name: "Select All", exact: true })
          .click();
        assert.equal(
          calls.length,
          reads,
          "selection rerenders reuse cached authorized data",
        );
        const cached = await measure();
        assert.deepEqual(cached.widths, initial.widths);
        geometry.push({ width, initial, cached });
        const info = page.getByRole("button", {
          name: "About body fat estimate for Ada",
          exact: true,
        });
        const infoGeometry = await info.evaluate((node) => {
          const row = node.parentElement!.querySelector(
            ".dashboard-member-bodyfat",
          )!;
          const range = document.createRange();
          range.selectNodeContents(row);
          const text = range.getBoundingClientRect();
          const icon = node.getBoundingClientRect();
          return {
            textRight: text.right,
            iconLeft: icon.left,
            iconHeight: icon.height,
            rowTop: row.getBoundingClientRect().top,
            iconTop: icon.top,
            paddingRight: getComputedStyle(row).paddingRight,
          };
        });
        assert.equal(infoGeometry.paddingRight, "36px");
        assert.ok(
          infoGeometry.textRight <= infoGeometry.iconLeft - 4,
          "body-fat percent must not overlap info icon",
        );
        assert.equal(infoGeometry.iconHeight, 24);
        assert.ok(Math.abs(infoGeometry.rowTop - infoGeometry.iconTop) <= 1);
        const tooltip = page.locator(".dashboard-member-tooltip").first();
        assert.equal(
          await cards.locator("button, [tabindex], [role=button]").count(),
          0,
          "no nested interactive controls",
        );
        assert.equal(
          await page
            .locator(".dashboard-member-entry")
            .nth(2)
            .locator(".dashboard-member-info")
            .count(),
          0,
          "invalid AI provenance has no estimate cue",
        );
        assert.equal(
          await info.getAttribute("aria-describedby"),
          await tooltip.getAttribute("id"),
        );
        const selected = () =>
          cards.evaluateAll((nodes) =>
            nodes.map((n) => n.getAttribute("aria-pressed")),
          );
        const beforeInfo = await selected();
        if (width === 1440) {
          await page.mouse.move(0, 0);
          await info.hover();
          await tooltip.waitFor({ state: "visible" });
          await tooltip.hover();
          await page.waitForTimeout(220);
          assert.equal(
            await tooltip.isVisible(),
            true,
            "tooltip stays hoverable",
          );
          await page.keyboard.press("Escape");
          await tooltip.waitFor({ state: "hidden" });
          await page.mouse.move(0, 0);
        }
        await page
          .getByRole("button", { name: "Select All", exact: true })
          .focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");
        assert.equal(
          await info.evaluate((n) => n === document.activeElement),
          true,
        );
        await tooltip.waitFor({ state: "visible" });
        assert.equal(
          await tooltip.innerText(),
          "Body fat is estimated from progress photos.",
        );
        await page.keyboard.press("Escape");
        await tooltip.waitFor({ state: "hidden" });
        assert.equal(
          await info.evaluate((n) => n === document.activeElement),
          true,
        );
        await page.keyboard.press("Tab");
        if (width === 1440) await info.click();
        else await info.tap();
        await tooltip.waitFor({ state: "visible" });
        assert.deepEqual(
          await selected(),
          beforeInfo,
          "reading provenance does not select a member",
        );
        const bounds = await tooltip.boundingBox();
        assert.equal(
          bounds?.width,
          260,
          "tooltip width is stable before viewport clamping",
        );
        assert.ok(
          bounds && bounds.x >= 0 && bounds.x + bounds.width <= width,
          "top-layer tooltip stays within viewport",
        );
        await page.screenshot({
          path: join(evidence, `synthetic-tooltip-${width}.png`),
        });
        assert.equal(
          await tooltip.isVisible(),
          true,
          "captured tooltip is visible",
        );
        await page.locator("h1").click();
        await tooltip.waitFor({ state: "hidden" });
        if (width === 1440) await info.click();
        else await info.tap();
        await tooltip.waitFor({ state: "visible" });
        await page.setViewportSize({ width: width + 1, height: 850 });
        await tooltip.waitFor({ state: "hidden" });
        await page.setViewportSize({ width, height: 850 });
        if (width !== 1440) {
          await info.tap();
          await tooltip.waitFor({ state: "visible" });
          await rail.evaluate((node) => {
            node.scrollLeft += 20;
          });
          await tooltip.waitFor({ state: "hidden" });
          await rail.evaluate((node) => {
            node.scrollLeft = 0;
          });
        }
        // A native closing toggle is delivered asynchronously. It can arrive
        // after a new keyboard focus has scheduled its deferred reveal.
        await info.click();
        await tooltip.waitFor({ state: "visible" });
        await page.keyboard.press("Escape");
        await tooltip.waitFor({ state: "hidden" });
        await page.keyboard.press("Tab");
        await info.evaluate((node) => {
          node.focus();
          const tip = document.getElementById(
            node.getAttribute("aria-describedby")!,
          )!;
          tip.dispatchEvent(
            new ToggleEvent("toggle", { oldState: "open", newState: "closed" }),
          );
        });
        await tooltip.waitFor({ state: "visible", timeout: 5000 });
        await page.keyboard.press("Escape");
        await tooltip.waitFor({ state: "hidden" });
        assert.deepEqual(await selected(), beforeInfo);
        await page.screenshot({
          path: join(evidence, `synthetic-roster-${width}.png`),
          fullPage: true,
        });
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
    await writeFile(
      join(evidence, "geometry.json"),
      JSON.stringify(geometry, null, 2),
    );
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
