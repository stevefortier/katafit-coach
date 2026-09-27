import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

test("served Memories UI manages protected boss-private memory and rejects member authority guesses", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-memory-browser-");
  const evidence =
    process.env.COACH_MEMORY_EVIDENCE ||
    "/home/kai/task-evidence/coach-long-term-memory/browser";
  const store = new Store(dir);
  await store.init();
  const app = await admin(store, 0);
  let browser;
  try {
    await mkdir(evidence, { recursive: true });
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 920 },
    });
    await page.goto(
      app.origin + "/settings?section=memories#" + store.secrets.admin,
    );
    await page.locator("#memories").waitFor({ state: "visible" });
    await page.locator("#memoryText").fill("Prefers detailed tradeoff notes.");
    await page
      .locator("#memorySourceNote")
      .fill("Synthetic browser correction");
    await page.locator("#memorySave").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#memoryStatus")
        ?.textContent?.includes("1 memories"),
    );
    assert.match(
      await page.locator("#memoryList").innerText(),
      /detailed tradeoff/i,
    );
    let stored = store.memories.list({ scope: "boss" }).items;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].protected, true);
    assert.equal(stored[0].pinned, true);

    await page
      .locator("#memoryText")
      .fill("Prefers concise executive summaries.");
    await page.locator("#memorySourceNote").fill("Synthetic edit");
    await page.locator("#memorySave").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#memoryList")
        ?.textContent?.includes("concise executive"),
    );
    stored = store.memories.list({ scope: "boss" }).items;
    assert.equal(stored[0].sources.length, 2);
    await page.locator("#memoryHistory summary").click();
    assert.match(
      await page.locator("#memoryHistoryList").innerText(),
      /Revision/,
    );

    await page.locator("#memoryNew").click();
    await page.locator("#memoryScope").selectOption("member");
    await page.locator("#memoryText").fill("Prefers morning workouts.");
    const rejected = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/memories") && response.status() === 409,
    );
    await page.locator("#memorySave").click();
    assert.equal(
      (await (await rejected).json()).error,
      "MEMORY_AUTHORITY_UNAVAILABLE",
    );
    assert.match(
      await page.locator("#notice").innerText(),
      /backend durable memory authority/i,
    );

    await page.screenshot({
      path: evidence + "/memories-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: evidence + "/memories-mobile.png",
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );

    await page.getByRole("button", { name: "Archive" }).first().click();
    await page.waitForFunction(() =>
      document
        .querySelector("#memoryStatus")
        ?.textContent?.includes("0 memories"),
    );
    assert.equal(store.memories.list({ scope: "boss" }).items.length, 0);
    await page.locator("#memoryArchivedFilter").check();
    await page.waitForFunction(() =>
      document
        .querySelector("#memoryStatus")
        ?.textContent?.includes("1 memories"),
    );
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Forget" }).first().click();
    await page.waitForFunction(() =>
      document
        .querySelector("#memoryStatus")
        ?.textContent?.includes("0 memories"),
    );
    assert.equal(
      store.memories.list({ scope: "boss", include_archived: true }).items
        .length,
      0,
    );
  } finally {
    await browser?.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
