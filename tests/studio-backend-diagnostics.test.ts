import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { Diagnostics } from "../src/diagnostics/log.js";

test("real Diagnostics shows all 5000, verbose filter, copy/download and stable live rows", async () => {
  const dir = await mkdtemp(tmpdir() + "/backend-ui-");
  const store = new Store(dir);
  await store.init();
  const log = new Diagnostics(dir);
  for (let i = 0; i < 5001; i++)
    log.record({
      source: "backend",
      stage: "backend-call",
      level: i === 5000 ? "warn" : "verbose",
      backendCall: {
        route: "mcp",
        method: "POST",
        operation: "tools/call",
        tool: "coach_list_requests",
        outcome: i === 5000 ? "timeout" : "ok",
      },
      metadata: {
        elapsedMs: i === 5000 ? 25000 : 123,
        statusCode: i === 5000 ? undefined : 200,
        responseBytes: 1234,
        budgetMs: 25000,
      },
    });
  const app = await admin(store, 0);
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(app.origin + "/diagnostics#" + store.secrets.admin);
    await page.locator("#logLevel").selectOption("all");
    await page.waitForFunction(
      () => document.querySelectorAll("#logRows article").length === 5000,
    );
    assert.match(
      await page.locator("#logStatus").innerText(),
      /5000 shown \/ 5000 retained \(max 5000\)/,
    );
    await page.locator("#logLevel").selectOption("verbose");
    assert.equal(await page.locator("#logRows article").count(), 4998);
    assert.match(
      await page.locator("#logRows article").first().innerText(),
      /coach_list_requests.*123 ms.*HTTP 200/,
    );
    await page.evaluate(() => {
      (window as any).firstLog = document.querySelector("#logRows article");
      document.querySelector("#logRows")!.scrollTop = 400;
    });
    const response = page.waitForResponse("**/api/logs");
    await page.locator("#logRefresh").click();
    await response;
    assert.equal(
      await page.evaluate(
        () =>
          (window as any).firstLog ===
          document.querySelector("#logRows article"),
      ),
      true,
    );
    assert.equal(
      await page.locator("#logRows").evaluate((el) => el.scrollTop),
      400,
    );
    await page.locator("#logCopy").click();
    const copied = JSON.parse(
      await page.evaluate(() => navigator.clipboard.readText()),
    );
    assert.equal(copied.entries.length, 4998);
    assert.equal(copied.entries[0].metadata.elapsedMs, 123);
    assert.equal(copied.entries[0].backendCall.tool, "coach_list_requests");
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#logDownload").click();
    const download = await downloadPromise;
    assert.deepEqual(
      JSON.parse(await readFile((await download.path())!, "utf8")).entries,
      copied.entries,
    );
    await page.locator("#logLevel").selectOption("warn");
    assert.equal(await page.locator("#logRows article").count(), 1);
    assert.match(await page.locator("#logRows").innerText(), /timeout/);
    await page.locator("#logLevel").selectOption("all");
    const evidence =
      process.env.COACH_EVIDENCE_DIR ||
      tmpdir() + "/coach-backend-diagnostics-evidence";
    await mkdir(evidence, { recursive: true });
    await page.evaluate(() => {
      const label = document.createElement("p");
      label.textContent = "SYNTHETIC LOCAL DIAGNOSTICS — no production data";
      document.querySelector("#diagnostics")!.prepend(label);
    });
    await page.evaluate("notice('')");
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => {
        scrollTo(0, 0);
        document.querySelector("#logRows")!.scrollTop = 0;
      });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.screenshot({
        path: `${evidence}/synthetic-backend-diagnostics-${width}.png`,
        fullPage: true,
      });
    }
    assert.deepEqual(errors, []);
    await page.locator("#lockStudio").click();
    assert.equal(await page.locator("#logRows article").count(), 0);
    assert.equal(
      await page.evaluate("JSON.parse(logJSON()).entries.length"),
      0,
    );
    assert.equal(await page.evaluate("logNodes.size"), 0);
  } finally {
    await browser?.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
