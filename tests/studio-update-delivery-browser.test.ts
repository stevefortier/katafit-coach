import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { settingsTab } from "./helpers/settings-navigation.js";

// A launcher that delivers Pi images lets an upgrade start while the image for
// the published release is missing: confirming it downloads the image first.
for (const deliverySupported of [true, false])
  test(`Upgrade with a missing Pi image is ${deliverySupported ? "offered by a delivering launcher" : "deferred without one"}`, async () => {
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
    const browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const installed = "1".repeat(40),
        latest = "a".repeat(40);
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        const checkedAt = Date.now();
        const body =
          path === "/api/config"
            ? {
                revision: 1,
                origin: "https://synthetic.invalid",
                provider: {
                  model: "synthetic",
                  baseUrl: "https://synthetic.invalid",
                },
                persona: await page.evaluate(() =>
                  Object.fromEntries(
                    [
                      "name",
                      "voice",
                      "principles",
                      "examples",
                      "boundaries",
                      "initiative",
                      "verbosity",
                      "markdown",
                    ].map((f) => [
                      f,
                      (document.getElementById(f) as HTMLInputElement).value,
                    ]),
                  ),
                ),
              }
            : path === "/api/status"
              ? {
                  state: "stopped",
                  safeToReplace: true,
                  stopConfirmed: true,
                  installed,
                }
              : path.startsWith("/api/update")
                ? {
                    installed,
                    latest,
                    checkedAt,
                    serverNow: checkedAt,
                    supported: true,
                    sourceChannel: "ready-releases-v1",
                    readinessProtocol: 1,
                    readinessSupported: true,
                    preparationSupported: true,
                    preparationProtocol: 2,
                    deliverySupported,
                    readiness: {
                      sha: latest,
                      fingerprint: "c".repeat(64),
                      checkedAt,
                      observedAt: checkedAt,
                      state: "delivery-pending",
                      reason: "MISSING_MATCHING_ARTIFACT",
                    },
                    guidance: "New source available.",
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
      await page.waitForFunction(
        () => !document.getElementById("studio")!.hidden,
      );
      await page.locator("#settingsTab").click();
      await settingsTab(page, "Updates");
      await page.waitForFunction(() =>
        /Published release/.test(
          document.getElementById("updateReadiness")!.textContent!,
        ),
      );
      const readiness = await page.locator("#updateReadiness").innerText();
      if (deliverySupported) {
        assert.match(readiness, /Upgrading downloads and verifies it first/);
        await page.waitForFunction(
          () =>
            !(document.getElementById("updateApply") as HTMLButtonElement)
              .disabled,
          undefined,
          { timeout: 5000 },
        );
      } else {
        assert.match(readiness, /delivery pending on this host/);
        assert.equal(await page.locator("#updateApply").isDisabled(), true);
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      server.close();
    }
  });
