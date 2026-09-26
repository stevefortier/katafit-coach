import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";

test("Settings sections are exclusive accessible tabs and preserve drafts", async () => {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://localhost").pathname;
    const file = ["/app.js", "/terminal.js", "/style.css"].includes(path)
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
      viewport: { width: 1280, height: 900 },
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
              },
            }
          : path === "/api/members"
            ? { members: [], has_more: false }
            : path === "/api/status"
              ? { state: "stopped" }
              : path === "/api/operator/chat"
                ? { messages: [] }
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
    assert.equal(await tabs.count(), 6);
    assert.equal(await page.locator("#diagnosticsTab").count(), 1);
    assert.equal(await page.getByRole("tabpanel").count(), 1);
    await page.locator("#token").fill("unsaved-secret");
    for (const name of [
      "Persona",
      "Preview",
      "Updates",
      "Worker",
      "Models",
      "Kata.fit",
    ]) {
      await page.getByRole("tab", { name, exact: true }).click();
      assert.equal(await page.getByRole("tabpanel").count(), 1);
      assert.equal(
        await page.getByRole("tabpanel").getAttribute("id"),
        name.toLowerCase().replace(".", ""),
      );
      assert.equal(
        await page.getByRole("tab", { selected: true }).innerText(),
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
      await page.getByRole("tab", { selected: true }).innerText(),
      "Models",
    );
    await page
      .getByRole("tab", { name: "Models", exact: true })
      .press("ArrowRight");
    assert.equal(
      await page.getByRole("tab", { selected: true }).innerText(),
      "Persona",
    );
    assert.equal(new URL(page.url()).search, "?section=persona");
    await page.locator("#name").fill("Draft coach");
    await page.getByRole("tab", { name: "Persona", exact: true }).press("End");
    assert.equal(
      await page.getByRole("tab", { selected: true }).innerText(),
      "Worker",
    );
    await page
      .getByRole("tab", { name: "Worker", exact: true })
      .press("ArrowRight");
    assert.equal(
      await page.getByRole("tab", { selected: true }).innerText(),
      "Kata.fit",
    );
    await page
      .getByRole("tab", { name: "Kata.fit", exact: true })
      .press("ArrowLeft");
    await page.getByRole("tab", { name: "Worker", exact: true }).press("Home");
    await page
      .getByRole("tab", { name: "Kata.fit", exact: true })
      .press("ArrowRight");
    await page
      .getByRole("tab", { name: "Models", exact: true })
      .press("ArrowRight");
    assert.equal(await page.locator("#name").inputValue(), "Draft coach");
    await page.getByRole("tab", { name: "Preview", exact: true }).click();
    await page.goBack();
    assert.equal(
      await page.getByRole("tab", { selected: true }).innerText(),
      "Persona",
    );
    await page.goForward();
    assert.equal(
      await page.getByRole("tab", { selected: true }).innerText(),
      "Preview",
    );
    await page.reload();
    await page.locator("#studio").waitFor({ state: "visible" });
    assert.equal(
      await page.getByRole("tab", { selected: true }).innerText(),
      "Preview",
    );
    await page.locator("#coachTab").click();
    assert.equal(new URL(page.url()).pathname, "/chat/operator");
    await page.goBack();
    assert.equal(
      await page.getByRole("tab", { selected: true }).innerText(),
      "Preview",
    );
    await page.locator("#lockStudio").click();
    await page.goto(new URL("/settings?section=worker", page.url()).href);
    await page.locator("#adminKey").fill("synthetic-admin");
    await page.locator("#unlock").click();
    await page.locator("#studio").waitFor({ state: "visible" });
    assert.equal(
      await page.getByRole("tab", { selected: true }).innerText(),
      "Worker",
    );
    await page.goto(new URL("/settings?section=unknown", page.url()).href);
    await page.locator("#studio").waitFor({ state: "visible" });
    assert.equal(
      await page.getByRole("tab", { selected: true }).innerText(),
      "Kata.fit",
    );
    await page.goto(new URL("/settings#updates", page.url()).href);
    assert.equal(
      await page.getByRole("tab", { selected: true }).innerText(),
      "Updates",
    );
    await page.evaluate(() => {
      location.hash = "logsView";
    });
    await page
      .getByRole("region", { name: "Diagnostics", exact: true })
      .waitFor();
    await page.goBack();
    await page
      .getByRole("tabpanel", { name: "Updates", exact: true })
      .waitFor();
    await page.reload();
    await page.locator("#studio").waitFor({ state: "visible" });
    assert.equal(
      await page.getByRole("tab", { selected: true }).innerText(),
      "Updates",
    );
    await page.goto(
      new URL("/settings?section=persona#updates", page.url()).href,
    );
    await page.locator("#studio").waitFor({ state: "visible" });
    assert.equal(
      await page.getByRole("tab", { selected: true }).innerText(),
      "Persona",
    );
    await page.goto(
      new URL("/settings?section=invalid#updates", page.url()).href,
    );
    await page.locator("#studio").waitFor({ state: "visible" });
    assert.equal(
      await page.getByRole("tab", { selected: true }).innerText(),
      "Kata.fit",
    );
    await page.locator("#lockStudio").click();
    await page.goto(
      new URL("/settings?section=preview#" + "a".repeat(64), page.url()).href,
    );
    await page.locator("#studio").waitFor({ state: "visible" });
    assert.equal(
      await page.getByRole("tab", { selected: true }).innerText(),
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
    await page
      .getByRole("button", { name: "Diagnostics", exact: true })
      .click();
    await loaded;
    await page.locator("#settingsTab").click();
    await page.getByRole("tab", { name: "Persona", exact: true }).click();
    const stoppedCount = logRequests;
    await page.waitForTimeout(2200);
    assert.equal(logRequests, stoppedCount, "hidden diagnostics must not poll");
    const evidence =
      process.env.COACH_EVIDENCE_DIR || `${tmpdir()}/katafit-settings-evidence`;
    await mkdir(evidence, { recursive: true });
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({
      path: `${evidence}/settings-desktop.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const name of [
      "Kata.fit",
      "Models",
      "Persona",
      "Preview",
      "Updates",
      "Worker",
    ]) {
      await page.getByRole("tab", { name, exact: true }).click();
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
        box && box.x >= 0 && box.x + box.width <= 390 && box.height >= 44,
      );
      assert.equal(await page.getByRole("tabpanel").count(), 1);
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: `${evidence}/settings-mobile-${name.toLowerCase().replace(".", "")}.png`,
        fullPage: true,
      });
    }
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
