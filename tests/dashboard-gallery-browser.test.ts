import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import sharp from "sharp";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

test("served Gallery independently pages historical inventories, lazily decodes and opens shared Pi viewer", async () => {
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
    user_id: "ada",
    type: "media",
    status: "complete",
    created_at: "2026-09-28T12:00:00Z",
    data: { files: [{ _id: "f1", type: "image/png" }] },
  });
  const backend = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture");
    calls.push(req.url!);
    if (url.pathname.startsWith("/api/media/")) {
      res.setHeader("content-type", "image/png");
      res.end(pixels);
      return;
    }
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/friends/feed/dojo")
      res.end(
        JSON.stringify({
          users: [{ _id: "ada", display_name: "Synthetic Ada" }],
          activities:
            url.searchParams.get("type") === "media"
              ? [row(url.searchParams.has("cursor") ? "older" : "latest")]
              : [row("latest")],
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
          owner: { _id: "ada" },
        }),
      );
    else if (url.pathname.endsWith("dashboard-members"))
      res.end(
        JSON.stringify({
          members: [{ _id: "ada", display_name: "Synthetic Ada", stats: {} }],
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
    await page.goto(server.origin);
    await page.evaluate(() => {
      document.getElementById("studio")!.hidden = false;
      document.getElementById("login")!.hidden = true;
      document.getElementById("dashboardPanel")!.hidden = false;
    });
    await page.evaluate(
      (key) => (window as any).CoachDashboard.load(null, key),
      store.secrets.admin,
    );
    const tabs = page.getByRole("tablist", { name: "Dojo sections" });
    assert.equal(await tabs.getByRole("tab").count(), 4);
    assert.equal(await page.locator("#dashboardGallery").isVisible(), false);
    await tabs.getByRole("tab", { name: "Gallery", exact: true }).click();
    assert.equal(
      await page.locator("#dashboardGallery h3").innerText(),
      "Gallery",
    );
    assert.ok(
      await page
        .locator("#dashboardGallery")
        .evaluate((el) =>
          Boolean(
            document
              .getElementById("dashboardCharts")!
              .compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        ),
    );
    await page.locator("#dashboardGallery").scrollIntoViewIfNeeded();
    await page
      .waitForFunction(
        () => document.querySelectorAll("#dashboardGallery img").length >= 4,
      )
      .catch(async (error) => {
        console.log(calls, await page.locator("#dashboardGallery").innerText());
        throw error;
      });
    await page.locator(".dashboard-gallery-sentinel").scrollIntoViewIfNeeded();
    await page.waitForFunction(
      () => document.querySelectorAll("#dashboardGallery img").length === 8,
    );
    assert.equal(
      calls.filter((x) => x === "/api/friends/activity/latest").length,
      1,
      "charts and gallery reuse acquired detail",
    );
    assert.equal(calls.filter((x) => x.includes("type=media")).length, 2);
    const image = page.locator("#dashboardGallery img").first();
    await image.waitFor();
    assert.ok(
      await image.evaluate(
        (img: any) => img.complete && img.naturalWidth === 160,
      ),
    );
    const count = calls.filter((x) => x.startsWith("/api/media/")).length;
    await image.click();
    assert.ok(
      await page.locator("#attachmentDialog").evaluate((el: any) => el.open),
    );
    assert.ok(
      await page.locator("#attachmentDialog").isVisible(),
      "fullscreen must be painted while the Pi pane is hidden",
    );
    assert.equal(
      await page
        .locator("#attachmentDialogImage")
        .evaluate((img: any) => img.naturalWidth),
      160,
    );
    assert.equal(
      await page.locator("#attachmentDialogImage").getAttribute("src"),
      await image.getAttribute("src"),
    );
    assert.equal(
      calls.filter((x) => x.startsWith("/api/media/")).length,
      count,
    );
    const previous = page.getByRole("button", {
      name: "Previous image",
      exact: true,
    });
    const next = page.getByRole("button", { name: "Next image", exact: true });
    assert.equal(await previous.isDisabled(), true);
    await next.click();
    assert.match(
      await page.locator("#attachmentDialogCaption").innerText(),
      /Photo 2 of 4/,
    );
    assert.equal(
      await page.locator("#attachmentDialogDownload").getAttribute("href"),
      await page.locator("#dashboardGallery img").nth(1).getAttribute("src"),
    );
    await page.keyboard.press("ArrowLeft");
    assert.equal(await previous.isDisabled(), true);
    const evidence = process.env.GALLERY_BROWSER_EVIDENCE || home + "/evidence";
    await mkdir(evidence, { recursive: true });
    for (const [width, height] of [
      [320, 568],
      [390, 844],
      [1280, 800],
    ]) {
      await page.setViewportSize({ width, height });
      const geometry = await page.evaluate(() => {
        const img = document
          .getElementById("attachmentDialogImage")!
          .getBoundingClientRect();
        const nav = document
          .getElementById("attachmentDialogNavigation")!
          .getBoundingClientRect();
        return {
          imageBottom: img.bottom,
          imageWidth: img.width,
          navTop: nav.top,
          navBottom: nav.bottom,
        };
      });
      assert.ok(geometry.navTop >= geometry.imageBottom);
      assert.ok(
        geometry.navBottom < height - 8,
        JSON.stringify({ width, height, ...geometry }),
      );
      if (width < 600) assert.ok(geometry.imageWidth > width * 0.85);
      await page.screenshot({
        path: `${evidence}/gallery-viewer-${width}.png`,
      });
    }
    await page.screenshot({
      path: evidence + "/gallery-desktop-fullscreen.png",
    });
    await page.keyboard.press("Escape");
    assert.equal(
      await page.locator("#attachmentDialog").evaluate((el: any) => el.open),
      false,
    );
    assert.ok(
      await image.locator("..").evaluate((el) => document.activeElement === el),
      "Escape restores native button focus",
    );
    await page.keyboard.press("Enter");
    assert.ok(await page.locator("#attachmentDialog").isVisible());
    await page.mouse.click(2, 2);
    assert.equal(await page.locator("#attachmentDialog").isVisible(), false);
    const positionGallery = () =>
      page.evaluate(() => {
        const owner = document.getElementById("workspaceScroll")!;
        owner.scrollTop +=
          document.getElementById("dashboardGallery")!.getBoundingClientRect()
            .top - 270;
      });
    await positionGallery();
    await page.screenshot({ path: evidence + "/gallery-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await positionGallery();
    await page.screenshot({ path: evidence + "/gallery-phone.png" });
    await image.click();
    await page.evaluate(() => (window as any).CoachDashboard.clear());
    assert.equal(await page.locator("#dashboardGallery img").count(), 0);
    const holds = new Map<
      string,
      { ready: Promise<void>; release: () => void }
    >();
    for (const id of ["f35", "f36", "f37", "f40"]) {
      let release!: () => void;
      holds.set(id, {
        ready: new Promise<void>((resolve) => {
          release = resolve;
        }),
        release: () => release(),
      });
    }
    const held: string[] = [];
    await page.route("**/api/dashboard/photo?**", async (route) => {
      const id = new URL(route.request().url()).searchParams.get("file_id")!;
      const gate = holds.get(id);
      if (gate) {
        held.push(id);
        await gate.ready;
      }
      await route.continue().catch(() => {});
    });
    photoCount = 40;
    const previousBytes = calls.filter((x) =>
      x.startsWith("/api/media/"),
    ).length;
    await page.evaluate(
      (key) => (window as any).CoachDashboard.load(null, key),
      store.secrets.admin,
    );
    await page.locator("#dashboardGallery").scrollIntoViewIfNeeded();
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#dashboardGallery button.dashboard-photo")
          .length >= 40,
    );
    await page.waitForTimeout(300);
    assert.ok(
      calls.filter((x) => x.startsWith("/api/media/")).length - previousBytes <
        20,
      "large full inventories must not frontload offscreen image bytes",
    );
    const waitHeld = async (id: string) => {
      const deadline = Date.now() + 5000;
      while (!held.includes(id)) {
        assert.ok(
          Date.now() < deadline,
          `missing held ${id}; caption=${await page.locator("#attachmentDialogCaption").innerText()}; calls=${calls.slice(-5)}`,
        );
        await page.waitForTimeout(10);
      }
    };
    await image.click();
    for (let i = 0; i < 34; i++) await page.keyboard.press("ArrowRight");
    await waitHeld("f35");
    assert.ok(
      held.includes("f35"),
      "navigation lazily uses the original loader for unacquired frames",
    );
    assert.ok(await page.locator("#attachmentDialogImage").getAttribute("src"));
    assert.doesNotMatch(
      await page.locator("#attachmentDialogCaption").innerText(),
      /^Photo 35 of 40/,
    );
    await page.keyboard.press("ArrowLeft"); // newer selection wins while f35 is pending
    await page.waitForFunction(() =>
      document
        .getElementById("attachmentDialogCaption")!
        .textContent?.startsWith("Photo 34 of 40"),
    );
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Escape");
    holds.get("f35")!.release();
    await page.waitForFunction(
      () => document.querySelectorAll("#dashboardGallery img").length >= 35,
    );
    assert.equal(await page.locator("#attachmentDialog").isVisible(), false);
    assert.equal(
      await page.locator("#attachmentDialogImage").getAttribute("src"),
      null,
    );
    await image.click();
    for (let i = 0; i < 35; i++) await page.keyboard.press("ArrowRight");
    await waitHeld("f36");
    assert.ok(held.includes("f36"));
    await page.evaluate(() =>
      (
        document.querySelector(".dashboard-member-card") as HTMLButtonElement
      ).click(),
    );
    holds.get("f36")!.release();
    await page.waitForTimeout(100);
    assert.equal(
      await page.locator("#attachmentDialogImage").getAttribute("src"),
      null,
      "filter closes and fences a pending viewer read",
    );
    await image.click();
    for (let i = 0; i < 36; i++) await page.keyboard.press("ArrowRight");
    await waitHeld("f37");
    assert.ok(held.includes("f37"));
    await page.evaluate(() => (window as any).lockSession());
    for (const gate of holds.values()) gate.release();
    await page.waitForTimeout(100);
    assert.equal(
      await page.locator("#attachmentDialogImage").getAttribute("src"),
      null,
      "lock cannot resurrect pending images",
    );
    assert.equal(await page.locator("#dashboardGallery img").count(), 0);
  } finally {
    await browser?.close();
    await server.close();
    await new Promise<void>((r) => backend.close(() => r()));
    await rm(home, { recursive: true, force: true });
  }
});
