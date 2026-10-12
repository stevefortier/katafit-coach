import { browserEvidence } from "./helpers/browser-evidence.js";
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
  const readinessEvidence = await browserEvidence();
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
    let preparationAttempt: unknown;
    let sourceChannel: string | undefined;
    let applying = false;
    let readinessState = "delivery-pending";
    let localRefreshes = 0;
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/update/check") checks++;
      if (path === "/api/update/readiness") {
        localRefreshes++;
        readinessState = "ready";
      }
      const checkedAt = checks ? Date.now() : 0;
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
                  checkedAt,
                  supported: true,
                  readinessProtocol:
                    sourceChannel === "ready-releases-v1" ? 1 : undefined,
                  readinessSupported: sourceChannel === "ready-releases-v1",
                  readiness:
                    sourceChannel === "ready-releases-v1"
                      ? {
                          sha: "a".repeat(40),
                          fingerprint: "c".repeat(64),
                          checkedAt,
                          observedAt: Date.now(),
                          state: readinessState,
                          reason:
                            readinessState === "delivery-pending"
                              ? "MISSING_MATCHING_ARTIFACT"
                              : undefined,
                        }
                      : undefined,
                  manualRestartSupported: true,
                  preparationSupported: true,
                  applying,
                  checkError,
                  guidance: checkError
                    ? "GitHub rate limit. Source check failed."
                    : "New source available. Updates are installed only after your confirmation.",
                  lastOperation: operation,
                  preparationOutcomeSupported: true,
                  preparationAttempt,
                  sourceChannel,
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
    const enteredCheck = page.waitForResponse("**/api/update/check");
    await settingsTab(page, "Updates");
    await enteredCheck;
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
    assert.equal(
      await page.locator(".update-versions .hint").nth(1).innerText(),
      "LATEST SOURCE",
      "new app must not claim a ready-release channel under an unknown owner",
    );
    assert.equal(
      await page.locator("#updateApply").isDisabled(),
      true,
      "unknown owner cannot offer execution",
    );
    sourceChannel = "ready-releases-v1";
    await page.locator("#updateCheck").click();
    await page.waitForTimeout(100);
    assert.equal(await page.locator("#updateApply").isDisabled(), true);
    assert.match(
      await page.locator("#updateReadiness").innerText(),
      /delivery pending/i,
    );
    for (const width of [1280, 360]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: `${readinessEvidence}/readiness-pending-${width}.png`,
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
    }
    const sourceCount = checks;
    await page.locator("#updateReadinessRefresh").click();
    await page.waitForTimeout(100);
    assert.equal(localRefreshes, 1);
    assert.equal(checks, sourceCount);
    assert.match(
      await page.locator("#updateReadiness").innerText(),
      /host ready/i,
    );
    const diagnostic = await page.evaluate("JSON.parse(logJSON())");
    assert.equal(diagnostic.update.readinessSupported, true);
    assert.equal(diagnostic.update.readiness.sha, "a".repeat(40));
    assert.equal(diagnostic.update.readiness.state, "ready");
    assert.equal(diagnostic.update.readinessProtocol, 1);
    assert.equal(await page.locator("#updateApply").isDisabled(), false);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: `${readinessEvidence}/readiness-ready-360.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    operation = {
      id: "00000000-0000-4000-8000-000000000001",
      sha: "1".repeat(40),
      state: "succeeded",
      at: Date.now() - 1000,
    };
    preparationAttempt = {
      id: "00000000-0000-4000-8000-000000000002",
      sha: "a".repeat(40),
      state: "failed",
      stage: "artifact",
      reason: "EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED",
      artifactReason: "MISSING_MATCHING_ARTIFACT",
      durable: true,
      at: Date.now(),
    };
    await page.reload();
    await page.locator("#studio").waitFor({ state: "visible" });
    await page
      .locator("#updatePreparation")
      .filter({ hasText: "Matching trusted native artifact is missing" })
      .waitFor();
    assert.match(
      await page.locator("#updatePreparation").innerText(),
      /No installation accepted/,
    );
    assert.equal(
      await page.locator(".update-versions .hint").nth(1).innerText(),
      "PUBLISHED RELEASE",
    );
    assert.match(
      await page.locator("#updateOutcome").innerText(),
      /Last upgrade succeeded/,
    );
    assert.doesNotMatch(
      await page.locator("#updatePreparation").innerText(),
      /automatic updates retry/,
    );
    const evidence = process.env.MANUAL_UPDATES_EVIDENCE;
    for (const width of [1280, 360]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        await page.screenshot({
          path: `${evidence}/preparation-failed-${width}.png`,
          fullPage: true,
        });
      }
    }
    preparationAttempt = {
      ...(preparationAttempt as Record<string, unknown>),
      state: "completed",
    };
    await page.locator("#updateCheck").click();
    await page
      .locator("#updatePreparation")
      .filter({ hasText: "Preparation completed" })
      .waitFor();
    assert.match(
      await page.locator("#updatePreparation").innerText(),
      /Installation outcome is shown separately/,
    );
    assert.doesNotMatch(
      await page.locator("#updatePreparation").innerText(),
      /No installation accepted/,
    );
    preparationAttempt = undefined;
    operation = undefined;
    await page.setViewportSize({ width: 1280, height: 900 });
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
