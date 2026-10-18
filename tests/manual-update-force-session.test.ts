import test from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright-core";
import { readyBrowserFixture } from "./fixtures/legacy-source-check.js";
import { forceHarness, until } from "./helpers/force-upgrade.js";
import { settingsTab } from "./helpers/settings-navigation.js";

for (const lateCompletion of [false, true]) {
  test(
    `held Force is session-owned across lock/unlock; lateCompletion=${lateCompletion}`,
    { timeout: 30000 },
    async () => {
      const h = await forceHarness({ heldWorker: true });
      let browser: Browser | undefined;
      try {
        readyBrowserFixture(h.updates);
        await h.post("/api/run");
        await h.post("/api/update/apply", {
          sha: h.updates.latest,
          confirm: true,
        });
        await until(async () => (await h.queue()).phase === "waiting-worker");
        browser = await chromium.launch({
          executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
          headless: true,
          args: ["--no-sandbox"],
        });
        const page = await browser.newPage();
        page.setDefaultTimeout(5000);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(h.app.origin + "/#" + h.f.store.secrets.admin);
        await page.locator("#studio").waitFor({ state: "visible" });
        await settingsTab(page, "Updates");
        // Hold only Force at the browser fetch boundary, before dispatch. In the
        // late case even abort cannot settle the old promise, exercising finally.
        await page.evaluate((late) => {
          const w = window as any;
          w.forceWaits = [];
          const original = window.fetch.bind(window);
          window.fetch = (input, init) => {
            if (String(input) !== "/api/update/force")
              return original(input, init);
            return new Promise<Response>((resolve, reject) => {
              const entry = {
                signal: init?.signal,
                body: init?.body,
                finish: reject,
              };
              w.forceWaits.push(entry);
              if (!late)
                init?.signal?.addEventListener(
                  "abort",
                  () => reject(new DOMException("Aborted", "AbortError")),
                  { once: true },
                );
            });
          };
        }, lateCompletion);
        await page.locator("#updateQueueForce").click();
        await page.locator("#updateForceConfirmApply").click();
        await page.waitForFunction(
          () => (window as any).forceWaits.length === 1,
        );
        await page.locator("#lockStudio").click();
        await page.locator("#adminKey").fill(h.f.store.secrets.admin);
        await page.locator("#unlock").click();
        await page.locator("#studio").waitFor({ state: "visible" });
        await settingsTab(page, "Updates");
        await page.locator("#updateQueueForce").waitFor({ state: "visible" });
        await page.waitForFunction("!updateRequest");
        assert.equal(
          await page.locator("#updateQueueForce").isDisabled(),
          false,
          "old Force must not disable new session",
        );
        assert.equal(
          await page.locator("#updateQueueCancel").isDisabled(),
          false,
        );
        assert.equal(
          await page.evaluate(
            () => (window as any).forceWaits[0].signal?.aborted,
          ),
          true,
          "lock aborts the obsolete local response wait",
        );
        await page.locator("#updateQueueForce").click();
        await page.locator("#updateForceConfirm").waitFor({ state: "visible" });
        assert.equal(
          await page.locator("#updateForceTarget").textContent(),
          h.updates.latest,
        );
        if (lateCompletion) {
          // A second held request belongs to the new session. Old finally must
          // neither release its busy gate nor erase its confirmation target.
          await page.locator("#updateForceConfirmApply").click();
          await page.waitForFunction(
            () => (window as any).forceWaits.length === 2,
          );
          await page.evaluate(() =>
            (window as any).forceWaits[0].finish(
              new Error("obsolete held Force"),
            ),
          );
          await page.evaluate(
            () => new Promise((resolve) => setTimeout(resolve, 50)),
          );
          assert.equal(
            await page.locator("#updateQueueForce").isDisabled(),
            true,
          );
          assert.equal(
            await page.locator("#updateQueueCancel").isDisabled(),
            true,
          );
          assert.equal(
            await page.locator("#updateForceConfirmApply").isDisabled(),
            true,
          );
          assert.deepEqual(await page.evaluate("updateForceQueue"), {
            id: (await h.queue()).id,
            sha: h.updates.latest,
          });
          assert.equal(
            await page.evaluate(() => (window as any).forceWaits.length),
            2,
            "no mutation replay",
          );
          await page.locator("#lockStudio").click();
          await page.evaluate(() =>
            (window as any).forceWaits[1].finish(
              new Error("obsolete held Force"),
            ),
          );
        }
        assert.equal((await h.queue()).phase, "waiting-worker");
        assert.equal(h.applications.length, 0);
        assert.deepEqual(errors, []);
      } finally {
        await browser?.close();
        await h.close();
      }
    },
  );
}
