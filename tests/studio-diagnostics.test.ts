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
      assert.match(await response.text(), /id="serverSettingsTabs"/);
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
    assert.equal(
      await page.locator("#diagnosticsTab").count(),
      0,
      "Activity is not a primary tab",
    );
    assert.equal(await page.locator(".studio-tabs > button").count(), 3);
    assert.equal(
      await page.locator("#serverSettingsTabs #settings-log-tab").innerText(),
      "Log",
    );
    assert.equal(await page.locator("#settingsPanel #diagnostics").count(), 1);
    assert.equal(await page.locator("#diagnostics h2").textContent(), "Log");
    assert.equal(
      await page.locator("#settingsTab").getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(
      await page.locator("#settings-log-tab").getAttribute("aria-selected"),
      "true",
    );
    assert.equal(await page.locator("#logsView > summary").count(), 0);
    for (const id of ["save", "export", "revision", "coachPanel"])
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
      assert.equal(new URL(page.url()).pathname, "/settings");
      assert.equal(
        new URL(page.url()).search + new URL(page.url()).hash,
        "?section=log",
      );
    }
    for (const view of ["logs", "performance"]) {
      await page.goto(app.origin + "/diagnostics?section=" + view);
      await page.locator("#logRefresh").waitFor({ state: "visible" });
      assert.equal(new URL(page.url()).pathname, "/settings");
      assert.equal(
        new URL(page.url()).search,
        "?section=log" + (view === "performance" ? "&view=performance" : ""),
      );
      assert.equal(
        await page
          .locator("#diagnostics-" + view + "-tab")
          .getAttribute("aria-selected"),
        "true",
      );
    }
    await page.goto(app.origin + "/settings?section=persona#logsView");
    await page.locator("#name").waitFor({ state: "visible" });
    await page.locator("#name").fill("Unsaved diagnostic detour");
    await page.locator("#settingsTab").click();
    await page.locator("#settings-log-tab").click();
    await page.goBack();
    await page.goBack();
    await page.locator("#name").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#name").inputValue(),
      "Unsaved diagnostic detour",
    );
    await page.goForward();
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
        "coachLauncher",
        "dashboardTab",
        "settingsTab",
        "coachSettingsTab",
        "settings-log-tab",
        "logRefresh",
        "logPause",
        "logCopy",
        "logDownload",
      ]) {
        const box = await page.locator("#" + id).boundingBox();
        assert.ok(
          box &&
            box.x >= 0 &&
            box.x + box.width <= width &&
            box.height >= (id === "coachLauncher" && width <= 700 ? 36 : 44),
          id,
        );
      }
      await page.screenshot({
        path: `${evidence}/synthetic-settings-log-${width}.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    // A docked Coach pane leaves Log visible, so polling continues.
    await page.locator("#coachLauncher").click();
    const docked = requests;
    await page.waitForTimeout(2200);
    assert.ok(requests > docked, "docked Coach keeps Log polling");
    for (const target of [
      "#settings-katafit-tab",
      "#coachPaneExpand",
      "#lockStudio",
    ]) {
      await page.locator(target).click();
      const stopped = requests;
      await page.waitForTimeout(2200);
      assert.equal(requests, stopped, target + " stops polling");
      if (target === "#coachPaneExpand")
        await page.locator("#coachPaneExpand").click();
      if (target !== "#lockStudio") {
        await page.locator("#settingsTab").click();
        await page.locator("#settings-log-tab").click();
      }
    }
    await page.goto(
      app.origin + "/settings?section=diagnostics#" + store.secrets.admin,
    );
    await page.locator("#logRefresh").waitFor({ state: "visible" });
    assert.equal(new URL(page.url()).pathname, "/settings");
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
    await page.locator("#settings-katafit-tab").click();
    await page.locator("#settingsTab").click();
    await page.locator("#settings-log-tab").click();
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
