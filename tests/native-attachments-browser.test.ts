import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { chromePath } from "./helpers/chrome.js";
import sharp from "sharp";
import { attachmentHarness } from "./helpers/attachments.js";

// Served admin UI against the real admin server, WebSocket, gateway and
// synthetic continuity backend; only the Docker runtime is an in-memory
// stand-in. Real Docker Pi is covered by the NATIVE_DOCKER_TEST tests.
const shots = process.env.ATTACHMENT_SCREENSHOT_DIR;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("Operator attachment panel previews, enlarges and downloads beside the terminal on desktop and mobile; reconnect dedups; Stop clears", async () => {
  const h = await attachmentHarness();
  const browser = await chromium.launch({
    executablePath: chromePath(),
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    if (shots) await mkdir(shots, { recursive: true });
    const png = await sharp({
      create: { width: 640, height: 400, channels: 3, background: "#2d6cdf" },
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: 320,
              height: 200,
              channels: 3,
              background: "#f2b705",
            },
          })
            .png()
            .toBuffer(),
          left: 160,
          top: 100,
        },
      ])
      .png()
      .toBuffer();
    const csv = Buffer.from("member,classes\nSynthetic A,3\nSynthetic B,5\n");
    const html = Buffer.from("<script>window.pwned=1</script><b>x</b>");
    h.files.set("charts/attendance.png", png);
    h.files.set("report.csv", csv);
    h.files.set("page.html", html);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      acceptDownloads: true,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const fetched: string[] = [];
    const statuses: number[] = [];
    page.on("response", (r) => {
      if (r.url().includes("/api/terminal/attachments/")) {
        statuses.push(r.status());
        // A 503 while Pi's tool call is still in flight is retried.
        if (r.status() !== 503 && !fetched.includes(r.url()))
          fetched.push(r.url());
      }
    });
    await page.goto(h.app.origin + "/chat/operator");
    await page.locator("#adminKey").fill(h.f.store.secrets.admin);
    await page.locator("#unlock").click();
    await page.locator("#nativeStart").click({ timeout: 5000 });
    await page.waitForFunction(() =>
      document
        .querySelector("#nativeStatus")
        ?.textContent?.startsWith("Connected"),
    );
    assert.equal(
      await page.locator("#nativeAttachmentsEmpty").isVisible(),
      true,
    );
    const receipts = [];
    for (const args of [
      {
        workspace_path: "charts/attendance.png",
        caption: 'Weekly attendance <img src=x onerror="window.pwned=2">',
      },
      { workspace_path: "report.csv", filename: "attendance report.csv" },
      { workspace_path: "page.html" },
    ])
      receipts.push(JSON.parse((await h.send(args)).content[0].text));
    assert.deepEqual(
      receipts.map((r) => [r.status, r.panel_connected]),
      Array(3).fill(["accepted_to_operator_panel", true]),
    );
    const cards = page.locator("#nativeAttachmentList > li");
    await page.waitForFunction(
      () =>
        (document.querySelector(".attachment-preview img") as HTMLImageElement)
          ?.naturalWidth > 0,
    );
    assert.equal(await cards.count(), 3);
    assert.equal(
      await page.locator("#nativeAttachmentsEmpty").isVisible(),
      false,
    );
    const preview = page.locator(".attachment-preview img");
    assert.equal(
      await preview.evaluate((i: HTMLImageElement) => i.naturalWidth),
      640,
    );
    assert.match((await preview.getAttribute("src"))!, /^blob:/);
    // Untrusted caption/filename text is rendered inert.
    assert.equal(
      await cards.nth(0).locator(".attachment-caption").textContent(),
      'Weekly attendance <img src=x onerror="window.pwned=2">',
    );
    assert.equal(await cards.nth(0).locator("img").count(), 1);
    assert.equal(
      await cards.nth(2).locator(".attachment-name").textContent(),
      "page.html",
    );
    assert.equal(await cards.nth(2).locator("img").count(), 0);
    assert.equal(await page.evaluate(() => (window as any).pwned), undefined);
    // Terminal and panel are side by side on desktop.
    const terminalBox = (await page.locator("#nativeTerminal").boundingBox())!;
    const panelBox = (await page.locator("#nativeAttachments").boundingBox())!;
    assert.ok(panelBox.x >= terminalBox.x + terminalBox.width - 1);
    assert.ok(Math.abs(panelBox.y - terminalBox.y) < 2);
    if (shots)
      await page
        .locator("#operatorView")
        .screenshot({ path: shots + "/attachments-desktop-1280.png" });
    // Only the image was fetched eagerly; files are fetched on demand.
    assert.equal(fetched.length, 1);

    await cards.nth(0).locator(".attachment-preview").click();
    const dialog = page.locator("#attachmentDialog");
    await page.waitForFunction(
      () =>
        (document.querySelector("#attachmentDialog") as HTMLDialogElement)
          .open &&
        (document.querySelector("#attachmentDialogImage") as HTMLImageElement)
          .naturalWidth === 640,
    );
    assert.equal(
      await page.locator("#attachmentDialogTitle").textContent(),
      "attendance.png",
    );
    if (shots)
      await page.screenshot({ path: shots + "/attachments-enlarged-1280.png" });
    const [dialogDownload] = await Promise.all([
      page.waitForEvent("download"),
      page.locator("#attachmentDialogDownload").click(),
    ]);
    assert.equal(dialogDownload.suggestedFilename(), "attendance.png");
    assert.equal(sha(await readFile((await dialogDownload.path())!)), sha(png));
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () =>
        !(document.querySelector("#attachmentDialog") as HTMLDialogElement)
          .open,
    );
    assert.equal(await dialog.isVisible(), false);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      cards.nth(1).getByRole("button", { name: "Download" }).click(),
    ]);
    assert.equal(download.suggestedFilename(), "attendance report.csv");
    assert.equal(sha(await readFile((await download.path())!)), sha(csv));
    const [htmlDownload] = await Promise.all([
      page.waitForEvent("download"),
      cards.nth(2).getByRole("button", { name: "Download" }).click(),
    ]);
    assert.equal(sha(await readFile((await htmlDownload.path())!)), sha(html));
    assert.equal(fetched.length, 3);
    assert.equal(await page.evaluate(() => (window as any).pwned), undefined);

    // Reconnect: snapshot reconciles with no duplicate cards and no refetch.
    const runtimes = h.runtimes.length;
    await page.locator("#nativeStart").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#nativeStatus")
        ?.textContent?.startsWith("Connected"),
    );
    await page.waitForTimeout(200);
    assert.equal(h.runtimes.length, runtimes, "same runtime after reconnect");
    assert.equal(await cards.count(), 3);
    assert.equal(fetched.length, 3);
    assert.equal(
      await preview.evaluate((i: HTMLImageElement) => i.naturalWidth),
      640,
    );

    // Mobile: stacked below the terminal with no horizontal overflow.
    await page.setViewportSize({ width: 360, height: 800 });
    await page.waitForTimeout(150);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      "no horizontal overflow at 360px",
    );
    const mobileTerminal = (await page
      .locator("#nativeTerminal")
      .boundingBox())!;
    const mobilePanel = (await page
      .locator("#nativeAttachments")
      .boundingBox())!;
    assert.ok(mobilePanel.y >= mobileTerminal.y + mobileTerminal.height - 1);
    assert.ok(mobilePanel.x + mobilePanel.width <= 360);
    if (shots) {
      await page
        .locator("#nativeTerminal")
        .evaluate((el) => el.scrollIntoView());
      await page.screenshot({
        path: shots + "/attachments-mobile-360-terminal.png",
      });
      await page
        .locator("#nativeAttachments")
        .evaluate((el) => el.scrollIntoView({ block: "end" }));
      await page.screenshot({ path: shots + "/attachments-mobile-360.png" });
    }
    await cards.nth(0).locator(".attachment-preview").click();
    await page.waitForFunction(
      () =>
        (document.querySelector("#attachmentDialogImage") as HTMLImageElement)
          .naturalWidth === 640,
    );
    const dialogBox = (await dialog.boundingBox())!;
    assert.ok(dialogBox.width <= 360);
    if (shots)
      await page.screenshot({
        path: shots + "/attachments-enlarged-mobile-360.png",
      });
    await page.locator("#attachmentDialogClose").click();

    // Stop erases the panel and revokes blob URLs.
    const blobUrl = (await preview.getAttribute("src"))!;
    await page.locator("#nativeStop").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#nativeStatus")
        ?.textContent?.startsWith("Stopped"),
    );
    assert.equal(await cards.count(), 0);
    assert.equal(
      await page.locator("#nativeAttachmentsEmpty").isVisible(),
      true,
    );
    assert.equal(
      await page.evaluate(
        (url) =>
          fetch(url).then(
            () => "readable",
            () => "revoked",
          ),
        blobUrl,
      ),
      "revoked",
    );
    const stale = await h.get(new URL(fetched[0]).pathname);
    assert.equal(stale.status, 404);

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await h.close();
  }
});

test("a server-side session end (another tab or configuration change) clears the panel", async () => {
  const h = await attachmentHarness();
  const browser = await chromium.launch({
    executablePath: chromePath(),
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    h.files.set("report.csv", Buffer.from("synthetic,1\n"));
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(h.app.origin + "/chat/operator");
    await page.locator("#adminKey").fill(h.f.store.secrets.admin);
    await page.locator("#unlock").click();
    await page.locator("#nativeStart").click({ timeout: 5000 });
    await page.waitForFunction(() =>
      document
        .querySelector("#nativeStatus")
        ?.textContent?.startsWith("Connected"),
    );
    await h.send({ workspace_path: "report.csv" });
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#nativeAttachmentList > li").length === 1,
    );
    const stop = await fetch(h.app.origin + "/api/terminal/stop", {
      method: "POST",
      headers: h.headers,
      body: "{}",
    });
    assert.equal(stop.status, 200);
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#nativeAttachmentList > li").length === 0,
    );
    assert.equal(
      await page.locator("#nativeAttachmentsEmpty").isVisible(),
      true,
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await h.close();
  }
});
