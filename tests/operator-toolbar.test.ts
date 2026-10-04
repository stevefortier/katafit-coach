import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

// The served admin document is real; only the Pi ticket/socket are synthetic.
test(
  "Coach automatically opens its terminal without exposing conversation or lifecycle controls",
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(tmpdir() + "/ephemeral-ui-");
    const store = new Store(dir);
    await store.init();
    const app = await admin(store, 0);
    const browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      const calls: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (request.url().includes("/api/terminal/"))
          calls.push(new URL(request.url()).pathname);
      });
      await page.route("**/api/terminal/ticket", (route) =>
        route.fulfill({ json: { path: "/synthetic-pi", ticket: "test" } }),
      );
      await page.routeWebSocket("**/synthetic-pi", (ws) => {
        ws.onMessage((message) => {
          if (JSON.parse(String(message)).ticket)
            ws.send(JSON.stringify({ type: "ready" }));
        });
      });
      await page.goto(app.origin + "/settings");
      await page.locator("#adminKey").fill(store.secrets.admin);
      await page.locator("#unlock").click();
      assert.equal(
        calls.includes("/api/terminal/ticket"),
        false,
        "settings must not acquire Pi",
      );
      await page.locator("#coachLauncher").click();
      await page.waitForFunction(() =>
        document
          .querySelector("#nativeStatus")
          ?.textContent?.startsWith("Connected"),
      );
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.locator("#nativeTerminal").isVisible(), true);
        assert.equal(
          await page.locator("#nativeAttachments").isVisible(),
          true,
        );
        if (process.env.KATAFIT_UI_SCREENSHOT) {
          await page.screenshot({ path: process.env.KATAFIT_UI_SCREENSHOT });
          await page.setViewportSize({ width: 1440, height: 900 });
          await page.screenshot({
            path: process.env.KATAFIT_UI_SCREENSHOT.replace(
              /\.png$/,
              "-wide.png",
            ),
          });
          await page.setViewportSize({ width: 320, height: 900 });
        }
        assert.equal(
          await page
            .locator(
              ".native-toolbar, #nativeHistoryPanel, #nativeStart, #nativeStop, #nativeHistoryToggle, #nativeHistorySelect, #nativeHistoryTitle, #nativeHistoryDelete, #nativeHistoryNew, #nativeHistoryRename, #nativeHistorySnapshot",
            )
            .count(),
          0,
        );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
      }
      assert.deepEqual(
        calls.filter((path) => path.includes("history")),
        [],
        "no history reads or selections",
      );
      const ticketCount = calls.filter(
        (path) => path === "/api/terminal/ticket",
      ).length;
      // Page navigation and collapse neither detach nor restart the session.
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.locator("#coachPaneCollapse").click();
      await page.locator("#dashboardTab").click();
      await page.locator("#settingsTab").click();
      await page.locator("#settings-log-tab").click();
      await page.waitForTimeout(1800);
      assert.equal(
        await page.locator("#nativeStatus").innerText(),
        "Connected to isolated Pi.",
      );
      assert.equal(
        calls.filter((path) => path === "/api/terminal/ticket").length,
        ticketCount,
        "collapsed Coach keeps its connection without reconnecting",
      );
      assert.equal(
        calls.includes("/api/terminal/stop"),
        false,
        "navigation never stops the runtime",
      );
      await page.locator("#coachLauncher").click();
      assert.equal(
        calls.filter((path) => path === "/api/terminal/ticket").length,
        ticketCount,
      );
      await page.reload();
      if (await page.locator("#adminKey").isVisible()) {
        await page.locator("#adminKey").fill(store.secrets.admin);
        await page.locator("#unlock").click();
      }
      await page.waitForFunction(() =>
        document
          .querySelector("#nativeStatus")
          ?.textContent?.startsWith("Connected"),
      );
      const beforeRestore = calls.filter(
        (path) => path === "/api/terminal/ticket",
      ).length;
      await page.evaluate(() => {
        dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
        dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      });
      await page.waitForFunction(() =>
        document
          .querySelector("#nativeStatus")
          ?.textContent?.startsWith("Connected"),
      );
      assert.equal(
        calls.filter((path) => path === "/api/terminal/ticket").length,
        beforeRestore + 1,
        "BFCache return must reattach without a manual button",
      );
      await page.route("**/api/terminal/ticket", (route) => route.abort());
      await page.evaluate(() => {
        dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
        dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      });
      await page.waitForFunction(() =>
        document
          .querySelector("#nativeStatus")
          ?.textContent?.startsWith("Native Pi unavailable"),
      );
      assert.equal(
        await page.locator("#nativeStatus").evaluate((el) => {
          const box = el.getBoundingClientRect();
          return box.width > 200 && getComputedStyle(el).clipPath === "none";
        }),
        true,
        "automatic connection failure must be visible without a Retry button",
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
