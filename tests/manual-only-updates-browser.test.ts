import { settingsTab } from "./helpers/settings-navigation.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

test("source checks occur only on Updates entry and explicit Check, not unlock or visibility", async () => {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://localhost").pathname;
    const file = /\.(js|css|svg)$/.test(path) ? path.slice(1) : "index.html";
    try {
      res.setHeader(
        "Content-Type",
        file.endsWith("js")
          ? "text/javascript"
          : file.endsWith("css")
            ? "text/css"
            : "text/html",
      );
      res.end(await readFile(new URL("../ui/" + file, import.meta.url)));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let checks = 0;
    let checkError: string | null = null;
    let operation: unknown;
    let applying = false;
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/update/check") checks++;
      const body =
        path === "/api/config"
          ? {
              revision: 1,
              origin: "https://synthetic.invalid",
              provider: {
                model: "synthetic",
                baseUrl: "https://synthetic.invalid",
              },
              persona: {
                name: "Synthetic Coach",
                voice: "Supportive",
                verbosity: "Balanced",
              },
            }
          : path === "/api/status"
            ? { state: "stopped", safeToReplace: true, stopConfirmed: true }
            : path.startsWith("/api/update")
              ? {
                  installed: "1".repeat(40),
                  latest: checkError ? null : "a".repeat(40),
                  checkedAt: checks ? Date.now() : 0,
                  supported: true,
                  manualRestartSupported: true,
                  preparationSupported: true,
                  applying,
                  checkError,
                  guidance: checkError
                    ? "GitHub rate limit. Source check failed."
                    : "New source available. Updates are installed only after your confirmation.",
                  lastOperation: operation,
                }
              : path === "/api/members"
                ? { members: [], has_more: false }
                : path === "/api/terminal/receipts"
                  ? { actions: [] }
                  : path === "/api/memories"
                    ? { revision: 0, items: [], total: 0 }
                    : {};
      await route.fulfill({ json: body });
    });
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    await page.goto(origin + "/dashboard");
    await page.locator("#adminKey").fill("synthetic-admin");
    await page.locator("#unlock").click();
    await page.locator("#studio").waitFor({ state: "visible" });
    await page.waitForTimeout(100);
    assert.equal(checks, 0, "dashboard unlock cannot check source");
    await page.locator("#settingsTab").click();
    await settingsTab(page, "Persona");
    assert.equal(checks, 0);
    await settingsTab(page, "Updates");
    await page.waitForFunction(
      () =>
        document.getElementById("updateLatest")?.textContent === "aaaaaaaaaaaa",
    );
    assert.equal(checks, 1);
    assert.equal(
      await page
        .locator("#updateAuto, #updateSchedule, #updateAutoStatus")
        .count(),
      0,
    );
    await settingsTab(page, "Updates");
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await page.waitForTimeout(100);
    assert.equal(checks, 1);
    await page.locator("#updateCheck").click();
    await page.waitForTimeout(100);
    assert.equal(checks, 2);
    await settingsTab(page, "Persona");
    await page.goBack();
    await page.waitForTimeout(100);
    assert.equal(checks, 3, "history entry checks once");
    await page.goForward();
    await page.goBack();
    await page.waitForTimeout(100);
    assert.equal(checks, 4);
    await page.reload();
    await page.locator("#studio").waitFor({ state: "visible" });
    await page.waitForTimeout(100);
    assert.equal(checks, 5, "restored unlock on Updates checks exactly once");
    const evidence = process.env.MANUAL_UPDATES_EVIDENCE;
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await page.screenshot({
        path: evidence + "/synthetic-updates-desktop.png",
        fullPage: true,
      });
      checkError = "RATE_LIMITED";
      await page.locator("#updateCheck").click();
      await page.waitForTimeout(100);
      await page.setViewportSize({ width: 360, height: 800 });
      await page
        .locator("#updateCheckStatus")
        .filter({ hasText: "GitHub rate limit" })
        .waitFor();
      await page.screenshot({
        path: evidence + "/synthetic-updates-mobile-rate-limit.png",
        fullPage: true,
      });
      checkError = null;
      operation = {
        id: "00000000-0000-4000-8000-000000000001",
        sha: "a".repeat(40),
        state: "failed",
        phase: "activating",
        reason: "ACTIVATION_ROLLED_BACK",
        at: Date.now(),
      };
      await page.locator("#updateCheck").click();
      await page.waitForTimeout(100);
      await page
        .locator("#updateOutcome")
        .filter({ hasText: "Last upgrade failed" })
        .waitFor();
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: evidence + "/synthetic-updates-mobile-rollback.png",
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
    }
    await page.locator("#lockStudio").click();
    await page.locator("#adminKey").fill("synthetic-admin");
    const before = checks;
    await page.locator("#unlock").click();
    await page.waitForTimeout(150);
    assert.equal(checks, before + 1, "locked deep-link entry checks once");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
