import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import sharp from "sharp";

// Synthetic authorized avatar bytes; real dashboard renderer and production CSS.
test("roster covers full-height slots with decoded larger avatars and cached selection", async () => {
  const image = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="341" height="512" viewBox="0 0 100 150"><defs><pattern id="grid" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="#365878"/><path d="M0 0h4v4" stroke="#7194ad" stroke-width=".4"/></pattern></defs><rect width="100" height="150" fill="url(#grid)"/><circle cx="50" cy="20" r="12" fill="#deb998"/><path d="M32 35h36v65H32zM32 100h14v45H32zM54 100h14v45H54z" fill="#deb998"/><path d="M36 42h28M36 46h28M36 50h28M36 54h28M36 58h28" stroke="#a67a60" stroke-width=".6"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  const avatarReads: string[] = [];
  const snapshots: unknown[] = [];
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
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>body{margin:0;padding:12px}#dashboardPanel{max-width:1100px;margin:auto}header{position:fixed;top:0;height:40px;width:100%;background:#111;z-index:12}#studioNotice{position:fixed;top:40px;height:20px;width:100%;background:#222;z-index:11}:root{--header-offset:40px;--notice-offset:20px}.spacer{height:180px}.tail{height:1600px}</style><header>SYNTHETIC roster · 341 × 512 PNG</header><div id="studioNotice">Fixture data · production CSS</div><section id="dashboardPanel"><div class="spacer"></div><input id="dashboardMapDate" type="date"><div id="dashboardMapStatus"></div><div id="dashboardMap"></div><div id="dashboardMapSelection"></div><h3 id="dashboardMemberHeading"></h3><div id="dashboardMemberCards" class="dashboard-member-cards" role="group" aria-label="Member filters"></div><div id="dashboardStatus"></div><div id="dashboardCoverage"></div><div id="dashboardRoster"></div><div id="dashboardCharts"></div><div class="tail"></div></section><script src="/dashboard.js"></script>',
      );
    } else if (url.pathname === "/api/dashboard/avatar") {
      avatarReads.push(url.searchParams.get("id")!);
      res.statusCode =
        url.searchParams.get("id") === "aaaaaaaaaaaaaaaaaaaaaaaa" ? 200 : 404;
      res.setHeader("content-type", "image/png");
      res.end(res.statusCode === 200 ? image : "");
    } else {
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/api/dashboard/members")
        res.end(
          JSON.stringify({
            members: [
              {
                _id: "aaaaaaaaaaaaaaaaaaaaaaaa",
                display_name:
                  "Synthetic AlexandraVeryLongUnbrokenFamilyName Progress Portrait",
                stats: { height_cm: 170, weight: { value: 68, unit: "kg" } },
              },
              {
                _id: "bbbbbbbbbbbbbbbbbbbbbbbb",
                display_name: "Synthetic Bob (no image)",
                stats: {},
              },
              {
                _id: "cccccccccccccccccccccccc",
                display_name: "Synthetic Cy",
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
          }),
        );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${(server.address() as any).port}/`);
    await page.evaluate(() =>
      (window as any).CoachDashboard.load(null, "synthetic"),
    );
    await page.waitForFunction(
      () =>
        document.querySelector(".dashboard-member-portrait img") instanceof
          HTMLImageElement &&
        (
          document.querySelector(
            ".dashboard-member-portrait img",
          ) as HTMLImageElement
        ).naturalHeight === 512,
    );
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => window.scrollTo(0, 0));
      const geometry = await page.evaluate(() => {
        const all = document.querySelector(".dashboard-member-all")!;
        const card = document.querySelector(
          ".dashboard-member-card:not(.dashboard-member-all)",
        )!;
        return {
          all: all.getBoundingClientRect().toJSON(),
          card: card.getBoundingClientRect().toJSON(),
          sharedParent: all.parentElement === card.parentElement,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      assert.ok(
        geometry.all.bottom <= geometry.card.top,
        `All members must be above member slots at ${width}px`,
      );
      assert.ok(
        geometry.all.width < 170,
        "All members has intrinsic compact width",
      );
      assert.equal(
        geometry.sharedParent,
        false,
        "All members is outside the photo rail",
      );
      assert.equal(
        geometry.overflow,
        false,
        "only roster rail may overflow horizontally",
      );
      const photoGeometry = await page.evaluate(() => {
        const portrait = document.querySelector(".dashboard-member-portrait")!;
        const card = portrait.closest("button")!;
        const image = portrait.querySelector("img")!;
        const style = getComputedStyle(card);
        const rect = card.getBoundingClientRect();
        const photo = portrait.getBoundingClientRect();
        return {
          imageBox: image.getBoundingClientRect().toJSON(),
          photo: photo.toJSON(),
          native: [image.naturalWidth, image.naturalHeight],
          top: photo.top,
          bottom: photo.bottom,
          innerTop: rect.top + parseFloat(style.borderTopWidth),
          innerBottom: rect.bottom - parseFloat(style.borderBottomWidth),
          fit: getComputedStyle(image).objectFit,
          radius: getComputedStyle(image).borderRadius,
          ring: getComputedStyle(portrait).boxShadow,
          portraitBorder: getComputedStyle(portrait).borderTopWidth,
          noImage: document.querySelectorAll(
            ".dashboard-member-portrait:not(:has(img))",
          ).length,
          textFits: Array.from(
            card.querySelectorAll(
              "strong, span:not(.dashboard-member-portrait)",
            ),
          ).every((node) => node.getBoundingClientRect().right <= rect.right),
        };
      });
      assert.deepEqual(
        photoGeometry.native,
        [341, 512],
        "actual PNG bytes decode at larger native dimensions, not an enlarged 64px fixture",
      );
      assert.deepEqual(
        photoGeometry.imageBox,
        photoGeometry.photo,
        "image element occupies the entire full-height photo zone",
      );
      snapshots.push({ width, phase: "initial", photoGeometry });
      assert.equal(
        photoGeometry.top,
        photoGeometry.innerTop,
        "photo starts at card inner top",
      );
      assert.equal(
        photoGeometry.bottom,
        photoGeometry.innerBottom,
        "photo reaches card inner bottom even beside long names",
      );
      assert.equal(
        photoGeometry.fit,
        "cover",
        "photo fills the full rectangular zone without letterbox bands",
      );
      assert.equal(
        photoGeometry.radius,
        "0px",
        "roster photo is rectangular, unlike map avatars",
      );
      assert.equal(photoGeometry.ring, "none");
      assert.equal(photoGeometry.portraitBorder, "0px");
      assert.equal(
        photoGeometry.noImage,
        2,
        "no-image members retain initials",
      );
      assert.equal(photoGeometry.textFits, true);
      const rail = page.locator(".dashboard-member-rail");
      await rail.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      const previousLeft = await rail.evaluate((el) => el.scrollLeft);
      assert.ok(
        width === 1440 || previousLeft > 0,
        "large roster has horizontally offscreen members",
      );
      await page.getByRole("button", { name: /Synthetic Cy/ }).click();
      assert.ok(
        Math.abs(
          (await rail.evaluate((el) => el.scrollLeft)) -
            (await rail.evaluate(
              (el, previous) =>
                Math.min(previous, el.scrollWidth - el.clientWidth),
              previousLeft,
            )),
        ) <= 1,
        "selection preserves offset at the maximum (fractional extent rounds within 1px)",
      );
      assert.equal(
        await page
          .getByRole("button", { name: /Synthetic Cy/ })
          .getAttribute("aria-pressed"),
        "true",
      );
      const selectedLeft = await rail.evaluate((el) => el.scrollLeft);
      await page
        .getByRole("button", { name: "All members", exact: true })
        .click();
      assert.ok(
        Math.abs(
          (await rail.evaluate((el) => el.scrollLeft)) -
            (await rail.evaluate(
              (el, previous) =>
                Math.min(previous, el.scrollWidth - el.clientWidth),
              selectedLeft,
            )),
        ) <= 1,
        "return to all with cached portrait retains max-boundary offset",
      );
      if (width !== 1440) {
        await rail.evaluate((el) => {
          el.scrollLeft = 100;
        });
        await page
          .getByRole("button", { name: /Synthetic Cy/ })
          .evaluate((el) => (el as HTMLButtonElement).click());
        assert.equal(
          await rail.evaluate((el) => el.scrollLeft),
          100,
          "mid-rail selection retains the exact offset",
        );
      }
      await page
        .locator(".dashboard-member-portrait img")
        .evaluate((el) => (el as HTMLImageElement).decode());
      const cached = await page
        .locator(".dashboard-member-portrait img")
        .evaluate((el) => {
          const image = el as HTMLImageElement;
          return {
            fit: getComputedStyle(image).objectFit,
            radius: getComputedStyle(image).borderRadius,
            native: [image.naturalWidth, image.naturalHeight],
            box: image.getBoundingClientRect().toJSON(),
            photo: image.parentElement!.getBoundingClientRect().toJSON(),
          };
        });
      assert.equal(cached.radius, "0px", "cached rerender remains rectangular");
      assert.equal(
        cached.fit,
        "cover",
        "cached rerender still fills the photo zone",
      );
      assert.deepEqual(cached.native, [341, 512]);
      assert.deepEqual(cached.box, cached.photo);
      snapshots.push({ width, phase: "cached", cached });
      await rail.evaluate((el) => {
        el.scrollLeft = 0;
      });
      const member = page
        .locator(".dashboard-member-card:not(.dashboard-member-all)")
        .first();
      await member.focus();
      await page.keyboard.press("Enter");
      assert.equal(
        await page
          .locator('.dashboard-member-card[aria-pressed="true"]')
          .count(),
        1,
      );
      const all = page.getByRole("button", {
        name: "All members",
        exact: true,
      });
      await all.focus();
      await page.keyboard.press("Space");
      assert.equal(await all.getAttribute("aria-pressed"), "true");
      assert.equal(
        await page
          .locator('.dashboard-member-card[aria-pressed="true"]')
          .count(),
        0,
      );
      await page.evaluate(() => window.scrollTo(0, 500));
      await page.waitForTimeout(100);
      assert.equal(
        await page
          .locator("#dashboardMemberCards")
          .evaluate((el) => getComputedStyle(el).position),
        "static",
        "shared roster remains in normal flow instead of covering pane rows",
      );
      const evidence = process.env.COACH_ROSTER_EVIDENCE;
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        await page.screenshot({
          path: `${evidence}/roster-${width}-sticky.png`,
        });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: `${evidence}/roster-${width}.png` });
      }
    }
    assert.deepEqual(
      avatarReads,
      [
        "aaaaaaaaaaaaaaaaaaaaaaaa",
        "bbbbbbbbbbbbbbbbbbbbbbbb",
        "cccccccccccccccccccccccc",
      ],
      "selection, viewport changes and cached rerenders do not download avatars again",
    );
    if (process.env.COACH_ROSTER_EVIDENCE)
      await writeFile(
        `${process.env.COACH_ROSTER_EVIDENCE}/synthetic-roster-geometry.json`,
        JSON.stringify(snapshots, null, 2),
      );
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
