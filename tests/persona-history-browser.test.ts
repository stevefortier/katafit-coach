import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
test("synthetic real Studio history browses read-only and restores without saving connection drafts", async () => {
  const dir = await mkdtemp(tmpdir() + "/history-browser-");
  const evidence = process.env.PERSONA_HISTORY_EVIDENCE || dir + "/evidence";
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    persona: {
      ...store.publicConfig().persona,
      name: "Synthetic A",
      examples: "Synthetic line one\nSynthetic line two",
      markdown: "<script>synthetic only</script>",
    },
  });
  await store.save({
    ...store.publicConfig(),
    persona: { ...store.publicConfig().persona, name: "Synthetic B" },
  });
  const app = await admin(store, 0);
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 1000 },
    });
    await page.goto(app.origin + "/settings#" + store.secrets.admin);
    await page.locator("#studio").waitFor({ state: "visible" });
    await page.locator("#settings-models-tab").click();
    await page
      .locator('[data-provider="default"] [data-field="model"]')
      .fill("unsaved-model");
    await page.locator("#settings-katafit-tab").click();
    await page.locator("#token").fill("unsaved-token");
    await page.locator("#settings-persona-tab").click();
    await page.locator("#name").fill("unsaved-persona");
    await page.locator("#personaHistory summary").click();
    await page.getByRole("button", { name: /Revision 2 ·/ }).click();
    await page.locator("#historyDetail").waitFor({ state: "visible" });
    assert.equal(await page.locator("#historySnapshot dd").count(), 8);
    assert.equal(
      await page
        .getByRole("button", { name: /Revision 2 ·/ })
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(
      await page
        .locator("#historyList")
        .evaluate((el) => getComputedStyle(el).overflowY),
      "auto",
    );
    assert.equal(store.publicConfig().revision, 3);
    assert.equal(await page.locator("#name").inputValue(), "unsaved-persona");
    page.once("dialog", (d) => d.dismiss());
    await page.locator("#restorePersona").click();
    assert.equal(store.publicConfig().revision, 3);
    page.once("dialog", (d) => d.accept());
    await page.locator("#restorePersona").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#revision")?.textContent === "Saved revision 4",
    );
    assert.equal(await page.locator("#name").inputValue(), "Synthetic A");
    assert.equal(
      await page.evaluate(
        () =>
          document.activeElement ===
          document.querySelector("#personaHistory summary"),
      ),
      true,
    );
    assert.equal(
      await page
        .locator('[data-provider="default"] [data-field="model"]')
        .inputValue(),
      "unsaved-model",
    );
    assert.equal(await page.locator("#token").inputValue(), "unsaved-token");
    assert.notEqual(store.publicConfig().provider.model, "unsaved-model");
    assert.equal(store.secrets.token, "");
    await page.getByRole("button", { name: /Revision 2 ·/ }).click();
    await page.locator("#historyDetail").waitFor({ state: "visible" });
    assert.equal(
      await page
        .locator("#historySnapshot dd")
        .first()
        .evaluate((el) => getComputedStyle(el).whiteSpace),
      "pre-wrap",
    );
    await mkdir(evidence, { recursive: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: evidence + "/synthetic-history-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: evidence + "/synthetic-history-mobile.png",
      fullPage: true,
    });
    // A failed restore keeps both editor drafts and durable history intact.
    await page.route("**/api/persona-restore", (route) =>
      route.fulfill({
        status: 409,
        json: { error: "STOP_WORKER_BEFORE_CONFIGURE" },
      }),
    );
    page.once("dialog", (d) => d.accept());
    await page.locator("#restorePersona").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#notice")
        ?.textContent?.includes("STOP_WORKER_BEFORE_CONFIGURE"),
    );
    assert.equal(store.publicConfig().revision, 4);
    assert.equal(await page.locator("#token").inputValue(), "unsaved-token");
    await page.unroute("**/api/persona-restore");
    for (let i = 0; i < 22; i++) await store.save(store.publicConfig());
    await page.locator("#historyLatest").click();
    await page.getByRole("button", { name: /Revision 26 · Current/ }).waitFor();
    assert.equal(await page.locator("#historyList button").count(), 20);
    await page.locator("#historyOlder").click();
    await page.getByRole("button", { name: /Revision 1 ·/ }).waitFor();
    assert.equal(await page.locator("#historyList button").count(), 6);
    assert.equal(await page.locator("#historyOlder").isVisible(), false);
    // A late selected snapshot cannot repopulate a locked session.
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      started = new Promise<void>((r) => (entered = r));
    await page.route("**/api/persona-history/1", async (route) => {
      entered();
      await gate;
      await route.fulfill({ json: store.personaRevision(1) });
    });
    await page.getByRole("button", { name: /Revision 1 ·/ }).click();
    await started;
    await page.locator("#lockStudio").click();
    release();
    await page.waitForResponse("**/api/persona-history/1");
    assert.equal(await page.locator("#historySnapshot dd").count(), 0);
    assert.equal(await page.locator("#historyDetail").isVisible(), false);
  } finally {
    await browser?.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
