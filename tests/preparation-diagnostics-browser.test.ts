import { browserEvidence } from "./helpers/browser-evidence.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { settingsTab } from "./helpers/settings-navigation.js";
const attempt = {
  id: "00000000-0000-4000-8000-000000000001",
  sha: "a".repeat(40),
  at: Date.now(),
  stage: "source",
  state: "failed",
  durable: true,
};
const cases = [
  {
    name: "corrupt journal without retained observation",
    issue: "PREPARATION_JOURNAL_UNAVAILABLE",
    attempt: undefined,
    text: /journal unavailable.*no retained preparation observation/i,
  },
  {
    name: "failed recovery persistence",
    issue: "PREPARATION_JOURNAL_UNAVAILABLE",
    attempt: {
      ...attempt,
      state: "interrupted",
      durable: false,
      reason: "PREPARATION_JOURNAL_UNAVAILABLE",
    },
    text: /process-local.*not durably retained/i,
  },
  {
    name: "cancelled preparation reason",
    issue: undefined,
    attempt: { ...attempt, state: "cancelled", reason: "BUILD_CANCELLED" },
    text: /preparation was cancelled/i,
  },
  {
    name: "cleanup failure ownership",
    issue: undefined,
    attempt: {
      ...attempt,
      stage: "cleanup",
      reason: "UPDATE_CLEANUP_PENDING",
      artifactReason: "CLEANUP_PENDING",
    },
    text: /cleanup.*ownership.*retain/i,
  },
  {
    name: "unknown error prose is excluded",
    issue: "private-journal-sentinel",
    attempt: {
      ...attempt,
      durable: false,
      reason: "private-error-sentinel",
      artifactReason: "private-artifact-sentinel",
    },
    text: /process-local.*not durably retained/i,
  },
];
for (const scenario of cases)
  test(`served preparation diagnostics: ${scenario.name}`, async () => {
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
    const evidence = await browserEvidence();
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
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
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
                  name: "Synthetic",
                  voice: "Supportive",
                  verbosity: "Balanced",
                },
              }
            : path === "/api/status"
              ? { state: "stopped", safeToReplace: true, stopConfirmed: true }
              : path.startsWith("/api/update")
                ? {
                    installed: "1".repeat(40),
                    latest: null,
                    sourceChannel: "ready-releases-v1",
                    readinessProtocol: 1,
                    readinessSupported: true,
                    supported: true,
                    preparationProtocol: 2,
                    preparationOutcomeSupported: true,
                    preparationAttempt: scenario.attempt,
                    preparationJournalIssue: scenario.issue,
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
      await page.goto(
        `http://127.0.0.1:${(server.address() as any).port}/dashboard`,
      );
      await page.locator("#adminKey").fill("synthetic-admin");
      await page.locator("#unlock").click();
      await page.locator("#studio").waitFor({ state: "visible" });
      await page.locator("#settingsTab").click();
      await settingsTab(page, "Updates");
      await page.waitForFunction(
        () => document.getElementById("updatePreparation")?.textContent !== "",
      );
      assert.match(
        await page.locator("#updatePreparation").innerText(),
        scenario.text,
      );
      const diagnostic = await page.evaluate("JSON.parse(logJSON()).update");
      assert.equal(
        diagnostic.preparationJournalIssue,
        scenario.issue === "PREPARATION_JOURNAL_UNAVAILABLE"
          ? scenario.issue
          : undefined,
      );
      assert.equal(
        diagnostic.preparationAttempt?.durable,
        scenario.attempt?.durable,
      );
      assert.equal(
        diagnostic.preparationAttempt?.state,
        scenario.attempt?.state,
      );
      assert.equal(
        diagnostic.preparationAttempt?.reason,
        scenario.attempt?.reason?.startsWith("private-")
          ? undefined
          : scenario.attempt?.reason,
      );
      assert.doesNotMatch(JSON.stringify(diagnostic), /private-.*sentinel/);
      assert.doesNotMatch(
        await page.locator("#updatePreparation").innerText(),
        /private-.*sentinel/,
      );
      for (const width of [1280, 360]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(() => scrollTo(0, 0));
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        await page.screenshot({
          path: `${evidence}/hardening-${cases.indexOf(scenario)}-${width}.png`,
          fullPage: true,
        });
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
