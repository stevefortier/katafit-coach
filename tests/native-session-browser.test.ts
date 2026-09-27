import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { chromePath } from "./helpers/chrome.js";
import { attachmentHarness } from "./helpers/attachments.js";
import { archiveFixture } from "./helpers/archive.js";
import { NativeConversations } from "../src/sandbox/conversations.js";
import sharp from "sharp";

test(
  "served history is current-authorized, inert and usable on desktop/mobile: Stop, rename, refresh/deep link, new, select and delete",
  { timeout: 60000 },
  async () => {
    const h = await attachmentHarness({}, archiveFixture);
    const browser = await chromium.launch({
      executablePath: chromePath(),
      headless: true,
      args: ["--no-sandbox"],
    });
    try {
      const initial = await h.connect();
      await h.runtimes.at(-1).gateway.handle({
        kind: "provider",
        body: {
          model: "approved-custom-model",
          messages: [
            {
              role: "user",
              content:
                "Synthetic saved prompt <script>window.pwned=1</script>\u001b[31m",
            },
          ],
          stream: true,
        },
      });
      initial.ws.close();
      await fetch(h.app.origin + "/api/terminal/stop", {
        method: "POST",
        headers: h.headers,
        body: "{}",
      });
      const list = await h.get("/api/terminal/history");
      assert.equal(list.status, 200);
      assert.match(list.headers.get("cache-control")!, /no-store/);
      const rows = (await list.json()) as any;
      const id = rows.sessions[0].id;
      const controller = new NativeConversations(h.f.store);
      const original = await controller.storage.loadForHost(id);
      const newer = await controller.storage.create(original.snapshot);
      await fetch(h.app.origin + "/api/terminal/history/select", {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ id: newer.id }),
      });
      assert.equal(
        (await h.get("/api/terminal/history/" + id, false)).status,
        401,
      );
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(h.app.origin + "/chat/operator?conversation=" + id);
      await page.locator("#adminKey").fill(h.f.store.secrets.admin);
      await page.locator("#unlock").click();
      await page
        .locator("#nativeHistoryLog")
        .getByText("Synthetic archived answer", { exact: false })
        .waitFor();
      assert.equal(await page.evaluate(() => (window as any).pwned), undefined);
      assert.equal(await page.locator("#nativeHistoryLog script").count(), 0);
      assert.doesNotMatch(
        (await page.locator("#nativeHistoryLog").textContent())!,
        /"type": "text"|\[31m/,
      );
      await page.route("**/api/terminal/ticket", (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"error":"synthetic_unavailable"}',
        }),
      );
      const ticket = page.waitForResponse((response) =>
        response.url().endsWith("/api/terminal/ticket"),
      );
      await page.locator("#nativeStart").click();
      await ticket;
      assert.equal(
        ((await (await h.get("/api/terminal/history")).json()) as any).selected,
        id,
        "deep-link Start binds the viewed conversation, never another default",
      );
      await controller.delete(newer.id);
      await page.locator("#nativeStop").click();
      await page.waitForFunction(
        () =>
          document
            .querySelector("#nativeConnection")
            ?.getAttribute("data-state") === "stopped",
      );
      await page.locator("#nativeHistoryTitle").fill("Synthetic renamed");
      await page.locator("#nativeHistoryRename").click();
      await page.waitForFunction(() =>
        document
          .querySelector("#nativeHistoryNotice")
          ?.textContent?.includes("Renamed"),
      );
      for (const viewport of [
        { width: 1280, height: 900 },
        { width: 360, height: 800 },
      ]) {
        await page.setViewportSize(viewport);
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        if (process.env.HISTORY_SCREENSHOT_DIR) {
          await mkdir(process.env.HISTORY_SCREENSHOT_DIR, { recursive: true });
          // Full-page capture at scroll zero avoids locator auto-scroll moving
          // the sticky app header over the evidence. Crop only the Operator
          // toolbar + expanded history; preserve the full original alongside.
          await page.evaluate(() => window.scrollTo(0, 0));
          const toolbar = (await page
            .locator(".native-toolbar")
            .boundingBox())!;
          const panel = (await page
            .locator("#nativeHistoryPanel")
            .boundingBox())!;
          const full = `${process.env.HISTORY_SCREENSHOT_DIR}/history-full-${viewport.width}.png`;
          await page.screenshot({ path: full, fullPage: true });
          await sharp(full)
            .extract({
              left: Math.floor(toolbar.x),
              top: Math.floor(toolbar.y),
              width: Math.floor(toolbar.width),
              height: Math.ceil(panel.y + panel.height - toolbar.y),
            })
            .toFile(
              `${process.env.HISTORY_SCREENSHOT_DIR}/history-${viewport.width}.png`,
            );
        }
      }
      await page.reload(); // Studio remembers this synthetic admin in session storage.
      await page.waitForFunction(
        () =>
          (document.querySelector("#nativeHistoryTitle") as HTMLInputElement)
            ?.value === "Synthetic renamed",
      );
      await page.locator("#nativeHistoryNew").click();
      assert.equal(await page.locator("#nativeHistoryLog").textContent(), "");
      await page.locator("#nativeHistorySelect").selectOption(id);
      await page
        .locator("#nativeHistoryLog")
        .getByText("Synthetic archived answer", { exact: false })
        .waitFor();
      (h.f as Awaited<ReturnType<typeof archiveFixture>>).revoke();
      await page.locator("#nativeHistoryToggle").click();
      await page.waitForFunction(() =>
        document
          .querySelector("#nativeHistoryNotice")
          ?.textContent?.includes("withheld"),
      );
      assert.equal(await page.locator("#nativeHistoryLog").textContent(), "");
      assert.equal(
        await page.locator("#nativeHistorySnapshot").textContent(),
        "",
      );
      assert.equal(await page.locator("#nativeHistoryTitle").inputValue(), "");
      page.once("dialog", (dialog) => dialog.accept());
      const deleted = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/terminal/history/delete") &&
          response.status() === 200,
      );
      await page.locator("#nativeHistoryDelete").click();
      await deleted;
      await page.waitForFunction(
        () => !document.querySelector("#nativeHistoryLog")?.textContent,
      );
      assert.equal(
        ((await (await h.get("/api/terminal/history")).json()) as any).sessions
          .length,
        0,
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await h.close();
    }
  },
);
