import { settingsTab } from "./helpers/settings-navigation.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";

test("Settings sections are exclusive accessible tabs and preserve drafts", async () => {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://localhost").pathname;
    // Optional vendor assets are unavailable in this settings-only fixture;
    // return a real 404, never index.html as JavaScript.
    if (
      [
        "/xterm.js",
        "/xterm-fit.js",
        "/xterm.css",
        "/leaflet.js",
        "/leaflet.css",
      ].includes(path)
    ) {
      res.writeHead(404).end();
      return;
    }
    const file = [
      "/backend-performance.js",
      "/dashboard.js",
      "/app.js",
      "/terminal.js",
      "/style.css",
    ].includes(path)
      ? path.slice(1)
      : "index.html";
    res.setHeader(
      "Content-Type",
      file.endsWith("js")
        ? "text/javascript"
        : file.endsWith("css")
          ? "text/css"
          : "text/html",
    );
    res.end(await readFile(new URL("../ui/" + file, import.meta.url)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
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
                name: "Synthetic Coach",
                voice: "Supportive",
                verbosity: "Balanced",
                initiative: "Offer one synthetic next step.",
                principles: "Synthetic fixture: build sustainable habits.",
                examples: "Synthetic example: start at a comfortable pace.",
                boundaries: "Synthetic fixture: do not diagnose injuries.",
                markdown: "Use short paragraphs.",
              },
            }
          : path === "/api/members"
            ? { members: [], has_more: false }
            : path === "/api/status"
              ? { state: "stopped" }
              : path === "/api/terminal/receipts"
                ? { actions: [] }
                : path === "/api/memories"
                  ? {
                      revision: 0,
                      items: [],
                      members: [],
                      total: 0,
                      has_more: false,
                      next_cursor: null,
                    }
                  : path === "/api/skills"
                    ? { revision: 1, skills: [] }
                    : {};
      await route.fulfill({ json: body });
    });
    await page.goto(
      `http://127.0.0.1:${(server.address() as any).port}/settings`,
    );
    await page.locator("#adminKey").fill("synthetic-admin");
    await page.locator("#unlock").click();
    await page.locator("#studio").waitFor({ state: "visible" });
    const tabs = page.getByRole("tab");
    assert.deepEqual(
      await page
        .locator(".studio-tabs button")
        .allTextContents()
        .then((names) => names.map((name) => name.trim())),
      ["Dojo", "Server Settings", "Coach Settings"],
    );
    assert.equal(await tabs.count(), 4);
    assert.equal(await page.locator("#diagnosticsTab").count(), 0);
    assert.equal(await page.getByRole("tabpanel").count(), 1);
    await page.locator("#token").fill("unsaved-secret");
    for (const name of [
      "Persona",
      "Preview",
      "Skills",
      "Memories",
      "Updates",
      "Worker",
      "Models",
      "Kata.fit",
    ]) {
      await settingsTab(page, name);
      assert.equal(await page.getByRole("tabpanel").count(), 1);
      assert.equal(
        await page.getByRole("tabpanel").getAttribute("id"),
        name.toLowerCase().replace(".", ""),
      );
      assert.equal(
        await page
          .locator("#serverSettingsTabs, #coachSettingsTabs")
          .getByRole("tab", { selected: true })
          .innerText(),
        name,
      );
      assert.equal(
        await page.locator("#personaHistory").isVisible(),
        name === "Persona",
      );
    }
    assert.equal(await page.locator("#token").inputValue(), "unsaved-secret");
    await page
      .getByRole("tab", { name: "Kata.fit", exact: true })
      .press("ArrowRight");
    assert.equal(
      await page
        .locator("#serverSettingsTabs, #coachSettingsTabs")
        .getByRole("tab", { selected: true })
        .innerText(),
      "Models",
    );
    await page
      .getByRole("tab", { name: "Models", exact: true })
      .press("ArrowRight");
    assert.equal(
      await page
        .locator("#serverSettingsTabs, #coachSettingsTabs")
        .getByRole("tab", { selected: true })
        .innerText(),
      "Updates",
    );
    await page
      .getByRole("tab", { name: "Updates", exact: true })
      .press("ArrowRight");
    assert.equal(
      await page.locator("#settings-log-tab").getAttribute("aria-selected"),
      "true",
    );
    assert.equal(await page.locator("#diagnostics").isVisible(), true);
    await page.locator("#settings-log-tab").press("ArrowRight");
    assert.equal(
      await page
        .locator("#serverSettingsTabs, #coachSettingsTabs")
        .getByRole("tab", { selected: true })
        .innerText(),
      "Kata.fit",
    );
    await page.getByRole("tab", { name: "Kata.fit", exact: true }).press("End");
    assert.equal(
      await page
        .locator("#serverSettingsTabs, #coachSettingsTabs")
        .getByRole("tab", { selected: true })
        .innerText(),
      "Log",
    );
    await page.getByRole("tab", { name: "Log", exact: true }).press("Home");
    await settingsTab(page, "Persona");
    assert.equal(new URL(page.url()).search, "?section=persona");
    assert.equal(await tabs.count(), 5);
    await page.locator("#name").fill("Draft coach");
    await page.getByRole("tab", { name: "Persona", exact: true }).press("End");
    assert.equal(
      await page
        .locator("#serverSettingsTabs, #coachSettingsTabs")
        .getByRole("tab", { selected: true })
        .innerText(),
      "Worker",
    );
    await page
      .getByRole("tab", { name: "Worker", exact: true })
      .press("ArrowRight");
    assert.equal(
      await page
        .locator("#serverSettingsTabs, #coachSettingsTabs")
        .getByRole("tab", { selected: true })
        .innerText(),
      "Persona",
    );
    await page
      .getByRole("tab", { name: "Persona", exact: true })
      .press("ArrowLeft");
    assert.equal(
      await page
        .locator("#serverSettingsTabs, #coachSettingsTabs")
        .getByRole("tab", { selected: true })
        .innerText(),
      "Worker",
    );
    await page.getByRole("tab", { name: "Worker", exact: true }).press("Home");
    await settingsTab(page, "Models");
    await page.locator("#coachSettingsTab").click();
    assert.equal(
      await page
        .locator("#serverSettingsTabs, #coachSettingsTabs")
        .getByRole("tab", { selected: true })
        .innerText(),
      "Persona",
    );
    await page.locator("#settingsTab").click();
    assert.equal(
      await page
        .locator("#serverSettingsTabs, #coachSettingsTabs")
        .getByRole("tab", { selected: true })
        .innerText(),
      "Models",
    );
    assert.equal(await page.locator("#token").inputValue(), "unsaved-secret");
    await page.locator("#coachSettingsTab").click();
    assert.equal(await page.locator("#name").inputValue(), "Draft coach");
    await settingsTab(page, "Preview");
    await page.goBack();
    assert.equal(
      await page
        .locator("#serverSettingsTabs, #coachSettingsTabs")
        .getByRole("tab", { selected: true })
        .innerText(),
      "Persona",
    );
    await page.goForward();
    assert.equal(
      await page
        .locator("#serverSettingsTabs, #coachSettingsTabs")
        .getByRole("tab", { selected: true })
        .innerText(),
      "Preview",
    );
    await page.reload();
    await page.locator("#studio").waitFor({ state: "visible" });
    assert.equal(
      await page
        .locator("#serverSettingsTabs, #coachSettingsTabs")
        .getByRole("tab", { selected: true })
        .innerText(),
      "Preview",
    );
    await page.locator("#dashboardTab").click();
    assert.equal(new URL(page.url()).pathname, "/dashboard");
    await page.goBack();
    assert.equal(
      await page
        .locator("#serverSettingsTabs, #coachSettingsTabs")
        .getByRole("tab", { selected: true })
        .innerText(),
      "Preview",
    );
    await page.locator("#lockStudio").click();
    await page.goto(new URL("/settings?section=worker", page.url()).href);
    await page.locator("#adminKey").fill("synthetic-admin");
    await page.locator("#unlock").click();
    await page.locator("#studio").waitFor({ state: "visible" });
    assert.equal(
      await page
        .locator("#serverSettingsTabs, #coachSettingsTabs")
        .getByRole("tab", { selected: true })
        .innerText(),
      "Worker",
    );
    await page.goto(new URL("/settings?section=unknown", page.url()).href);
    await page.locator("#studio").waitFor({ state: "visible" });
    assert.equal(
      await page
        .locator("#serverSettingsTabs, #coachSettingsTabs")
        .getByRole("tab", { selected: true })
        .innerText(),
      "Kata.fit",
    );
    await page.goto(new URL("/settings#updates", page.url()).href);
    assert.equal(
      await page
        .locator("#serverSettingsTabs, #coachSettingsTabs")
        .getByRole("tab", { selected: true })
        .innerText(),
      "Updates",
    );
    await page.evaluate(() => {
      location.hash = "logsView";
    });
    await page.getByRole("tabpanel", { name: "Log", exact: true }).waitFor();
    await page.goBack();
    await page
      .getByRole("tabpanel", { name: "Updates", exact: true })
      .waitFor();
    await page.reload();
    await page.locator("#studio").waitFor({ state: "visible" });
    assert.equal(
      await page
        .locator("#serverSettingsTabs, #coachSettingsTabs")
        .getByRole("tab", { selected: true })
        .innerText(),
      "Updates",
    );
    await page.goto(
      new URL("/settings?section=persona#updates", page.url()).href,
    );
    await page.locator("#studio").waitFor({ state: "visible" });
    assert.equal(
      await page
        .locator("#serverSettingsTabs, #coachSettingsTabs")
        .getByRole("tab", { selected: true })
        .innerText(),
      "Persona",
    );
    await page.goto(
      new URL("/settings?section=invalid#updates", page.url()).href,
    );
    await page.locator("#studio").waitFor({ state: "visible" });
    assert.equal(
      await page
        .locator("#serverSettingsTabs, #coachSettingsTabs")
        .getByRole("tab", { selected: true })
        .innerText(),
      "Kata.fit",
    );
    await page.locator("#lockStudio").click();
    await page.goto(
      new URL("/settings?section=preview#" + "a".repeat(64), page.url()).href,
    );
    await page.locator("#studio").waitFor({ state: "visible" });
    assert.equal(
      await page
        .locator("#serverSettingsTabs, #coachSettingsTabs")
        .getByRole("tab", { selected: true })
        .innerText(),
      "Preview",
    );
    assert.equal(
      new URL(page.url()).hash,
      "",
      "admin key scrubbed without losing section",
    );
    let logRequests = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/logs") logRequests++;
    });
    await page.route("**/api/logs", (route) =>
      route.fulfill({ json: { entries: [] } }),
    );
    const loaded = page.waitForResponse("**/api/logs");
    await page.locator("#settingsTab").click();
    await page.locator("#settings-log-tab").click();
    await loaded;
    await page.locator("#settingsTab").click();
    await settingsTab(page, "Persona");
    const stoppedCount = logRequests;
    await page.waitForTimeout(2200);
    assert.equal(logRequests, stoppedCount, "hidden diagnostics must not poll");
    const evidence =
      process.env.COACH_EVIDENCE_DIR || `${tmpdir()}/katafit-settings-evidence`;
    await mkdir(evidence, { recursive: true });
    await page.evaluate(() => scrollTo(0, 0));
    for (const [group, name] of [
      ["server", "Kata.fit"],
      ["coach", "Persona"],
    ]) {
      await settingsTab(page, name);
      assert.notEqual(
        await page.locator("#noticeRegion").getAttribute("role"),
        "alert",
        "synthetic evidence fixture has no API-shape errors",
      );
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: `${evidence}/${group}-desktop.png`,
        fullPage: true,
      });
    }
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(
        await page
          .locator(".studio-tabs button")
          .evaluateAll((buttons) =>
            buttons.every((button) => button.scrollWidth <= button.clientWidth),
          ),
        true,
        "all primary names must fit, not ellipsize",
      );
      for (const name of [
        "Kata.fit",
        "Models",
        "Persona",
        "Preview",
        "Skills",
        "Memories",
        "Updates",
        "Worker",
      ]) {
        await settingsTab(page, name);
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        const box = await page
          .getByRole("tab", { name, exact: true })
          .boundingBox();
        assert.ok(
          box && box.x >= 0 && box.x + box.width <= width && box.height >= 44,
        );
        assert.equal(await page.getByRole("tabpanel").count(), 1);
        assert.notEqual(
          await page.locator("#noticeRegion").getAttribute("role"),
          "alert",
          "synthetic evidence fixture has no API-shape errors",
        );
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({
          path: `${evidence}/settings-mobile-${width}-${name.toLowerCase().replace(".", "")}.png`,
          fullPage: true,
        });
      }
    }
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
