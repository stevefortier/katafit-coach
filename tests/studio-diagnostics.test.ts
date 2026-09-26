import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

test("real Diagnostics route, migration, drafts, immediate logs and lifecycle", async () => {
  const dir = await mkdtemp(tmpdir() + "/diagnostics-test-");
  const store = new Store(dir);
  await store.init();
  const app = await admin(store, 0);
  let browser;
  try {
    for (const path of ["/diagnostics", "/diagnostics?source=test"]) {
      const response = await fetch(app.origin + path);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type")!, /text\/html/);
      assert.match(await response.text(), /id="diagnosticsTab"/);
    }
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage();
    let requests = 0;
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/logs") requests++;
    });
    await page.goto(app.origin + "/diagnostics");
    assert.equal(requests, 0);
    await page.locator("#adminKey").fill(store.secrets.admin);
    const loaded = page.waitForResponse("**/api/logs");
    await page.locator("#unlock").click();
    await loaded;
    await page.locator("#logRefresh").waitFor({ state: "visible" });
    assert.equal(await page.locator("#logsView > summary").count(), 0);
    for (const id of [
      "settingsPanel",
      "save",
      "export",
      "revision",
      "coachPanel",
    ])
      assert.equal(await page.locator("#" + id).isVisible(), false);
    await page.reload();
    await page.locator("#logRefresh").waitFor({ state: "visible" });
    for (const legacy of [
      "/settings?section=diagnostics",
      "/settings#diagnostics",
      "/settings#logsView",
    ]) {
      await page.goto(app.origin + legacy);
      await page.locator("#logRefresh").waitFor({ state: "visible" });
      assert.equal(new URL(page.url()).pathname, "/diagnostics");
      assert.equal(new URL(page.url()).search + new URL(page.url()).hash, "");
    }
    await page.goto(app.origin + "/settings?section=persona#logsView");
    await page.locator("#name").waitFor({ state: "visible" });
    await page.locator("#name").fill("Unsaved diagnostic detour");
    await page.locator("#diagnosticsTab").click();
    await page.goBack();
    assert.equal(
      await page.locator("#name").inputValue(),
      "Unsaved diagnostic detour",
    );
    await page.goForward();
    await page.locator("#logRefresh").waitFor({ state: "visible" });
    const evidence =
      process.env.COACH_EVIDENCE_DIR ||
      tmpdir() + "/coach-diagnostics-evidence";
    await mkdir(evidence, { recursive: true });
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => scrollTo(0, 0));
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      for (const id of [
        "coachTab",
        "settingsTab",
        "diagnosticsTab",
        "logRefresh",
        "logPause",
        "logCopy",
        "logDownload",
      ]) {
        const box = await page.locator("#" + id).boundingBox();
        assert.ok(
          box && box.x >= 0 && box.x + box.width <= width && box.height >= 44,
          id,
        );
      }
      await page.screenshot({
        path: `${evidence}/synthetic-diagnostics-${width}.png`,
        fullPage: true,
      });
    }
    for (const target of ["#settingsTab", "#coachTab", "#lockStudio"]) {
      await page.locator(target).click();
      const stopped = requests;
      await page.waitForTimeout(2200);
      assert.equal(requests, stopped, target + " stops polling");
      if (target !== "#lockStudio")
        await page.locator("#diagnosticsTab").click();
    }
    await page.goto(
      app.origin + "/settings?section=diagnostics#" + store.secrets.admin,
    );
    await page.locator("#logRefresh").waitFor({ state: "visible" });
    assert.equal(new URL(page.url()).pathname, "/diagnostics");
    assert.equal(new URL(page.url()).hash, "");
    // Hold a real browser fetch to prove abort and late-result fencing on hide.
    await page.evaluate(() => {
      const original = window.fetch;
      (window as any).logAborted = false;
      window.fetch = (input, init) => {
        if (String(input).includes("/api/logs"))
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              (window as any).logAborted = true;
              reject(new DOMException("Aborted", "AbortError"));
            });
          });
        return original(input, init);
      };
    });
    await page.locator("#settingsTab").click();
    await page.locator("#diagnosticsTab").click();
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    assert.equal(await page.evaluate(() => (window as any).logAborted), true);
    const stopped = requests;
    await page.waitForTimeout(2200);
    assert.equal(requests, stopped);
  } finally {
    await browser?.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
