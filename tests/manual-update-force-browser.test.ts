import { readyBrowserFixture } from "./fixtures/legacy-source-check.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { forceHarness, until } from "./helpers/force-upgrade.js";
import { browserEvidence } from "./helpers/browser-evidence.js";
import { settingsTab } from "./helpers/settings-navigation.js";

// Served synthetic Studio: normal confirmation automatically closes owned Pi.
// Force remains beside Cancel for worker waits and reports accepted install
// or finite cleanup/receipt failure, without replay.
const queueText = (page: Page) =>
  page.locator("#updateQueueStatus").textContent();
async function openUpdates(
  h: Awaited<ReturnType<typeof forceHarness>>,
  width = 1280,
) {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(h.app.origin + "/#" + h.f.store.secrets.admin);
  await page.locator("#studio").waitFor({ state: "visible" });
  await settingsTab(page, "Updates");
  return { browser, page, errors };
}
async function queueBehindNeverEndingTurn(
  h: Awaited<ReturnType<typeof forceHarness>>,
) {
  readyBrowserFixture(h.updates);
  await h.post("/api/run");
  await h.connect();
  void h.neverEndingTurn().catch(() => {});
  await until(() => h.providerCalls === 1);
  const response = await h.post("/api/update/apply", {
    sha: h.updates.latest,
    confirm: true,
  });
  assert.equal(response.status, 202);
  await until(async () => (await h.queue())?.phase === "waiting-worker");
}

test(
  "Force confirmation can be dismissed, then interrupts Pi and installs once",
  { timeout: 30000 },
  async () => {
    const h = await forceHarness({ heldWorker: true });
    const evidence = await browserEvidence();
    let browser: Browser | undefined;
    try {
      await queueBehindNeverEndingTurn(h);
      const opened = await openUpdates(h);
      browser = opened.browser;
      const { page } = opened;
      await page.waitForFunction(() =>
        document
          .querySelector("#updateQueueStatus")
          ?.textContent?.includes("Waiting for accepted worker"),
      );
      // Offered immediately, alongside Cancel.
      assert.equal(await page.locator("#updateQueueForce").isVisible(), true);
      assert.equal(await page.locator("#updateQueueCancel").isVisible(), true);
      assert.equal(
        await page.locator("#updateForceConfirm").isVisible(),
        false,
      );
      await page.locator("#updateQueueStatus").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: join(evidence, "synthetic-force-01-waiting-worker.png"),
      });

      await page.locator("#updateQueueForce").click();
      const confirm = page.locator("#updateForceConfirm");
      await confirm.waitFor({ state: "visible" });
      assert.equal(
        await page.locator("#updateForceTarget").textContent(),
        h.updates.latest,
      );
      const warning = (await confirm.textContent()) ?? "";
      for (const phrase of [
        /Interrupt accepted Coach work/,
        /In-flight actions may already have happened/,
        /Nothing is replayed automatically/,
        /nothing is installed/,
      ])
        assert.match(warning.replace(/\s+/g, " "), phrase);
      await confirm.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: join(evidence, "synthetic-force-02-confirmation.png"),
      });

      // Dismiss: worker wait continues; normal confirmation already closed Pi.
      await page.locator("#updateForceCancel").click();
      await confirm.waitFor({ state: "hidden" });
      assert.equal((await h.queue()).phase, "waiting-worker");
      assert.equal(h.runtimes[0].stops, 1);

      const forceRequests: string[] = [];
      page.on("request", (request) => {
        if (request.url().endsWith("/api/update/force"))
          forceRequests.push(request.postData() ?? "");
      });
      await page.locator("#updateQueueForce").click();
      await confirm.waitFor({ state: "visible" });
      await page.locator("#updateForceConfirmApply").dblclick();
      await page.waitForFunction(
        () =>
          document
            .querySelector("#updateQueueStatus")
            ?.textContent?.includes("accepted the forced installation"),
        undefined,
        { timeout: 10000 },
      );
      assert.equal(forceRequests.length, 1, "double click sends one request");
      const sent = JSON.parse(forceRequests[0]);
      assert.deepEqual(Object.keys(sent).sort(), ["confirm", "id", "sha"]);
      assert.equal(sent.sha, h.updates.latest);
      assert.equal(sent.confirm, true);
      assert.deepEqual(h.applications, [h.updates.latest]);
      assert.equal(h.runtimes[0].stops, 1);
      assert.equal(h.runtimes.length, 1, "no runtime replay");
      assert.equal(h.providerCalls, 1, "interrupted turn not replayed");
      assert.equal(await page.locator("#updateQueueForce").isVisible(), false);
      assert.equal(await page.locator("#updateQueueCancel").isVisible(), false);
      assert.match(
        (await queueText(page)) ?? "",
        /Native Pi was interrupted; check Kata\.fit/,
      );
      await page.locator("#updateQueueStatus").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: join(evidence, "synthetic-force-03-accepted.png"),
      });
      assert.deepEqual(opened.errors, []);
    } finally {
      await browser?.close();
      await h.close();
    }
  },
);

test(
  "noncooperative teardown ends in a visible finite failure with controls",
  { timeout: 30000 },
  async () => {
    const h = await forceHarness({
      heldWorker: true,
      heldWorkerStop: true,
      forceStopMs: 400,
    });
    const evidence = await browserEvidence();
    let browser: Browser | undefined;
    try {
      await queueBehindNeverEndingTurn(h);
      const opened = await openUpdates(h, 390);
      browser = opened.browser;
      const { page } = opened;
      await page.locator("#updateQueueForce").waitFor({ state: "visible" });
      await page.locator("#updateQueueForce").click();
      await page.locator("#updateForceConfirm").waitFor({ state: "visible" });
      await page.locator("#updateForceConfirm").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: join(evidence, "synthetic-force-04-confirmation-mobile.png"),
      });
      const started = Date.now();
      await page.locator("#updateForceConfirmApply").click();
      await page.waitForFunction(
        () =>
          document
            .querySelector("#updateQueueStatus")
            ?.textContent?.includes("Upgrade stopped"),
        undefined,
        { timeout: 10000 },
      );
      assert.ok(Date.now() - started < 10000);
      assert.match(
        (await queueText(page)) ?? "",
        /Nothing was installed\. Use Worker Stop\/recovery/,
      );
      assert.deepEqual(h.applications, []);
      assert.equal(await page.locator("#updateQueueForce").isVisible(), false);
      // Not a spinner: the header leaves QUEUED/APPLYING before the 4s poll.
      await page.waitForFunction(
        () =>
          !/QUEUED|UPGRADING|APPLYING/.test(
            document.querySelector("#state")?.textContent ?? "",
          ),
        undefined,
        { timeout: 3000 },
      );
      // Controls: a fresh confirmation is available again.
      await page.waitForFunction(
        () =>
          !document.querySelector<HTMLButtonElement>("#updateApply")?.disabled,
      );
      await page.locator("#updateQueueStatus").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: join(evidence, "synthetic-force-05-teardown-failed-mobile.png"),
      });
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      );
      assert.equal(overflow, false, "no horizontal overflow at 390px");
      assert.deepEqual(opened.errors, []);
    } finally {
      h.releaseStop();
      await browser?.close();
      await h.close();
    }
  },
);

test(
  "normal upgrade confirmation warns and automatically interrupts owned Pi on desktop and mobile",
  { timeout: 30000 },
  async () => {
    for (const width of [1280, 390]) {
      const h = await forceHarness();
      let browser: Browser | undefined;
      try {
        readyBrowserFixture(h.updates);
        await h.connect();
        void h.neverEndingTurn().catch(() => {});
        await until(() => h.providerCalls === 1);
        const opened = await openUpdates(h, width);
        browser = opened.browser;
        const { page } = opened;
        await page.locator("#updateApply").click();
        const confirmation = page.locator("#updateConfirm");
        await confirmation.waitFor({ state: "visible" });
        const text = (await confirmation.textContent())!.replace(/\s+/g, " ");
        assert.match(text, /automatically closes its Pi session/);
        assert.match(text, /unsent work may be lost/);
        assert.match(text, /nothing is replayed automatically/);
        assert.match(text, /Other Pi sessions on this host are unaffected/);
        await confirmation.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(
            await browserEvidence(),
            `synthetic-normal-confirm-${width}.png`,
          ),
        });
        await page.locator("#updateConfirmApply").click();
        await until(async () => (await h.queue())?.phase === "accepted");
        assert.equal(h.runtimes[0].stops, 1);
        assert.equal(h.providerCalls, 1);
        assert.equal(h.applyCalls[0][1], false);
        assert.deepEqual(h.applications, [h.updates.latest]);
        assert.deepEqual(opened.errors, []);
      } finally {
        await browser?.close();
        await h.close();
      }
    }
  },
);

test(
  "held automatic Pi closure shows UPGRADING and no cancellation controls",
  { timeout: 20000 },
  async () => {
    const h = await forceHarness({ teardown: "never", forceStopMs: 8000 });
    let browser: Browser | undefined;
    try {
      readyBrowserFixture(h.updates);
      await h.connect();
      await h.post("/api/update/apply", {
        sha: h.updates.latest,
        confirm: true,
      });
      const opened = await openUpdates(h, 390);
      browser = opened.browser;
      const { page } = opened;
      await page.waitForFunction(() =>
        document
          .querySelector("#updateQueueStatus")
          ?.textContent?.includes("This interruption cannot be cancelled"),
      );
      assert.equal(await page.locator("#state").textContent(), "UPGRADING");
      assert.equal(await page.locator("#updateQueueCancel").isVisible(), false);
      assert.equal(await page.locator("#updateQueueForce").isVisible(), false);
      await page.locator("#updateQueueStatus").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: join(
          await browserEvidence(),
          "synthetic-normal-stopping-native-mobile.png",
        ),
      });
      assert.deepEqual(opened.errors, []);
      h.releaseStop();
      await until(async () => (await h.queue()).phase === "accepted");
    } finally {
      h.releaseStop();
      await browser?.close();
      await h.close();
    }
  },
);
