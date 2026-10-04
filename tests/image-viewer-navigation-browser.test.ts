import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
import sharp from "sharp";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { chromePath } from "./helpers/chrome.js";

test("Pi viewer navigates displayed image order, skips files, preserves bottom portrait layout and fences pending removal", async () => {
  const home = await mkdtemp(tmpdir() + "/viewer-nav-");
  const store = new Store(home);
  await store.init();
  const app = await admin(store, 0);
  const browser = await chromium.launch({
    executablePath: chromePath(),
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(app.origin);
    await page.evaluate("window.__name = (fn) => fn");
    const bytes = await sharp({
      create: { width: 300, height: 450, channels: 3, background: "#447799" },
    })
      .png()
      .toBuffer();
    await page.evaluate(
      ({ data, hash, size }) => {
        const w = window as any;
        const body = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        w.reads = [];
        w.release = undefined;
        w.panel = w.operatorAttachments(
          (id: string) => document.getElementById(id),
          async (path: string) => {
            w.reads.push(path);
            if (path.endsWith("3"))
              await new Promise((resolve) => {
                w.release = resolve;
              });
            return new Response(body, {
              headers: { "content-type": "image/png" },
            });
          },
        );
        w.sources = [1, 2, 3, 4].map((i) => ({
          id: "at_" + String(i).padStart(32, "0"),
          filename:
            i === 2 ? "ordinary-photo-filename-1234.png" : `photo-${i}.png`,
          caption:
            i === 2
              ? "A normal portrait caption with enough detail to wrap across several lines on a narrow phone with controls safe."
              : `Caption ${i}`,
          preview: i === 4 ? "download" : "image",
          mime_type: "image/png",
          byte_count: size,
          sha256: hash,
        }));
        w.panel.snapshot("a".repeat(32), w.sources, null);
        document.getElementById("studio")!.hidden = false;
        document.getElementById("nativeAttachments")!.hidden = false;
      },
      {
        data: bytes.toString("base64"),
        hash: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
      },
    );
    await page.waitForFunction(
      () =>
        !(
          document.querySelector(
            '[data-attachment-id$="2"] .attachment-preview',
          ) as HTMLButtonElement
        )?.disabled,
    );
    await page.evaluate(() =>
      (
        document.querySelector(
          '[data-attachment-id$="2"] .attachment-preview',
        ) as HTMLButtonElement
      ).click(),
    );
    const previous = page.getByRole("button", {
      name: "Previous image",
      exact: true,
    });
    const next = page.getByRole("button", { name: "Next image", exact: true });
    assert.equal(await previous.isDisabled(), false);
    await next.click();
    assert.equal(
      await page.locator("#attachmentDialogTitle").innerText(),
      "photo-1.png",
    );
    assert.equal(await next.isDisabled(), true);
    assert.equal(
      await page.locator("#attachmentDialogDownload").getAttribute("download"),
      "photo-1.png",
    );
    await page.waitForTimeout(100); // Native disabled-button blur must settle.
    assert.equal(
      await page.evaluate(() =>
        document
          .getElementById("attachmentDialog")!
          .contains(document.activeElement),
      ),
      true,
      "endpoint activation must retain real focus inside the dialog",
    );
    await page.keyboard.press("ArrowLeft");
    assert.equal(
      await page.locator("#attachmentDialogCaption").innerText(),
      "A normal portrait caption with enough detail to wrap across several lines on a narrow phone with controls safe.",
    );
    for (const width of [320, 390, 1280]) {
      const height = width === 320 ? 568 : width === 1280 ? 900 : 844;
      await page.setViewportSize({ width, height });
      const geometry = await page.evaluate(() => {
        const image = document
          .getElementById("attachmentDialogImage")!
          .getBoundingClientRect();
        const nav = document
          .getElementById("attachmentDialogNavigation")!
          .getBoundingClientRect();
        const dialog = document.getElementById("attachmentDialog")!;
        return {
          dialogBottom: dialog.getBoundingClientRect().bottom,
          scrolls: dialog.scrollHeight > dialog.clientHeight,
          image: {
            x: image.x,
            right: image.right,
            width: image.width,
            bottom: image.bottom,
          },
          nav: { top: nav.top, bottom: nav.bottom, x: nav.x, right: nav.right },
          overflow:
            document.getElementById("attachmentDialog")!.scrollWidth >
            document.getElementById("attachmentDialog")!.clientWidth,
        };
      });
      assert.ok(geometry.nav.top >= geometry.image.bottom);
      assert.ok(
        geometry.nav.bottom <= height - 8,
        `bottom controls visible at ${width}: ${JSON.stringify(geometry)}`,
      );
      assert.ok(
        geometry.nav.bottom <= geometry.dialogBottom - 10,
        JSON.stringify(geometry),
      );
      assert.equal(
        geometry.scrolls,
        false,
        "wrapped metadata must not require footer scrolling",
      );
      assert.equal(geometry.overflow, false);
      if (width < 600) assert.ok(geometry.image.width > width * 0.85);
      const evidence = process.env.IMAGE_VIEWER_EVIDENCE;
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        await page.screenshot({ path: `${evidence}/pi-${width}.png` });
      }
    }
    await previous.click(); // held third image; next immediately supersedes it
    assert.equal(
      await page.locator("#attachmentDialogPosition").innerText(),
      "Loading image…",
    );
    const shownUrl = await page
      .locator("#attachmentDialogImage")
      .getAttribute("src");
    const readsBeforeRefresh = await page.evaluate(
      () => (window as any).reads.length,
    );
    await page.evaluate(() => {
      const w = window as any;
      w.panel.add("a".repeat(32), {
        ...w.sources[3],
        id: "at_" + String(5).padStart(32, "0"),
      });
    });
    assert.equal(
      await page.locator("#attachmentDialogPosition").innerText(),
      "Loading image…",
      "inventory refresh must not show the pending target position over old pixels",
    );
    assert.equal(
      await page.locator("#attachmentDialogImage").getAttribute("src"),
      shownUrl,
    );
    assert.equal(
      await page.locator("#attachmentDialogDownload").getAttribute("href"),
      shownUrl,
    );
    assert.equal(
      await page.locator("#attachmentDialogDownload").getAttribute("download"),
      "ordinary-photo-filename-1234.png",
    );
    assert.equal(
      await page.evaluate(() => (window as any).reads.length),
      readsBeforeRefresh,
    );
    await next.click();
    assert.equal(
      await page.locator("#attachmentDialogPosition").innerText(),
      "2 of 3",
    );
    assert.equal(
      await page.locator("#attachmentDialogTitle").innerText(),
      "ordinary-photo-filename-1234.png",
    );
    await previous.click();
    await page.evaluate(() => {
      const w = window as any;
      w.panel.snapshot("a".repeat(32), w.sources.slice(0, 2), null);
      w.release();
    });
    await page.waitForTimeout(50);
    assert.equal(
      await page.locator("#attachmentDialogTitle").innerText(),
      "ordinary-photo-filename-1234.png",
      "removing pending target preserves acquired selection",
    );
    await page.evaluate(() => {
      const w = window as any;
      w.panel.snapshot("a".repeat(32), w.sources.slice(0, 1), null);
      (
        document.querySelector(
          '[data-attachment-id$="1"] .attachment-preview',
        ) as HTMLButtonElement
      ).click();
    });
    assert.equal(
      await page.locator("#attachmentDialogNavigation").isVisible(),
      false,
    );
    await page.evaluate(() => {
      const w = window as any;
      w.panel.add("a".repeat(32), w.sources[1]);
    });
    assert.equal(
      await page.locator("#attachmentDialogNavigation").isVisible(),
      true,
    );
    assert.equal(await previous.isDisabled(), false);
    assert.equal(
      await page.locator("#attachmentDialogPosition").innerText(),
      "2 of 2",
    );
    await page.keyboard.press("ArrowRight");
    assert.equal(
      await page.locator("#attachmentDialogTitle").innerText(),
      "photo-1.png",
    );
    await previous.click();
    await page.waitForFunction(
      () =>
        document.getElementById("attachmentDialogTitle")!.textContent ===
        "ordinary-photo-filename-1234.png",
    );
    assert.equal(await previous.isDisabled(), true);
    await page.waitForTimeout(100);
    assert.equal(
      await page.evaluate(() =>
        document
          .getElementById("attachmentDialog")!
          .contains(document.activeElement),
      ),
      true,
      "first-image endpoint also retains keyboard focus",
    );
    await page.keyboard.press("ArrowRight");
    assert.equal(
      await page.locator("#attachmentDialogTitle").innerText(),
      "photo-1.png",
    );
    await page.evaluate(() => (window as any).panel.clear());
    assert.equal(await page.locator("#attachmentDialog").isVisible(), false);
  } finally {
    await browser.close();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
