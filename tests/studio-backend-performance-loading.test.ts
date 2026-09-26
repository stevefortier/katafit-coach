import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium, type Page } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

async function setup(t: TestContext) {
  const dir = await mkdtemp(tmpdir() + "/performance-loading-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  await store.init();
  const app = await admin(store, 0);
  t.after(() => app.close());
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const original = window.fetch;
    (window as any).pendingLogs = [];
    window.fetch = (input, init) => {
      if (String(input).endsWith("/api/logs")) {
        // Deliberately ignore AbortSignal: the UI must fence late completions.
        return new Promise((resolve) => {
          (window as any).pendingLogs.push((body: any, status = 200) =>
            resolve(new Response(JSON.stringify(body), { status })),
          );
        });
      }
      return original(input, init);
    };
    (window as any).downloads = [];
    URL.createObjectURL = (blob) => {
      (window as any).downloads.push(blob);
      return "blob:synthetic-export";
    };
    HTMLAnchorElement.prototype.click = () => {};
  });
  await page.goto(app.origin + "/diagnostics#" + store.secrets.admin);
  await page.waitForFunction(() => (window as any).pendingLogs.length === 1);
  return { page, adminKey: store.secrets.admin };
}
async function settle(page: Page, body: any, status = 200) {
  await page.evaluate(
    ({ body, status }) => {
      (window as any).pendingLogs.shift()(body, status);
    },
    { body, status },
  );
  await page.waitForFunction(() => {
    // @ts-expect-error Studio's classic script owns this lexical binding.
    return !logController;
  });
}
async function controls(page: Page) {
  await page.locator("#performanceSort").selectOption("calls");
  await page.locator("#logLevel").selectOption("all");
}
async function blocked(page: Page) {
  assert.equal(await page.locator("#performanceExport").isDisabled(), true);
  await page.evaluate(async () => {
    await (document.querySelector("#performanceExport") as any).onclick();
  });
  assert.equal(await page.evaluate(() => (window as any).downloads.length), 0);
  assert.doesNotMatch(
    await page.locator("#performanceWindow").innerText(),
    /0 receipts|0 retained/,
  );
  assert.doesNotMatch(
    await page.locator("#performanceRows").innerText(),
    /No retained backend receipts/,
  );
}

test("unread delayed or failed snapshot cannot export; successful empty retry can", async (t) => {
  const { page } = await setup(t);
  assert.match(await page.locator("#performanceWindow").innerText(), /Loading/);
  await controls(page);
  await blocked(page);
  await page.evaluate("logPaused = true");
  await settle(page, { error: "synthetic read failure" }, 503);
  await controls(page);
  assert.match(
    await page.locator("#performanceWindow").innerText(),
    /Unable to load/,
  );
  await blocked(page);
  await page.locator("#logRefresh").click();
  await page.waitForFunction(() => (window as any).pendingLogs.length === 1);
  await blocked(page);
  await settle(page, { entries: [], capacity: 5000 });
  assert.equal(await page.locator("#performanceExport").isDisabled(), false);
  assert.match(
    await page.locator("#performanceWindow").innerText(),
    /0 receipts/,
  );
  assert.match(
    await page.locator("#performanceRows").innerText(),
    /No retained backend receipts/,
  );
  await page.locator("#performanceExport").click();
  const data = await page.evaluate(async () =>
    JSON.parse(await (window as any).downloads[0].text()),
  );
  assert.equal(data.window.receiptCount, 0);
  assert.equal(data.window.retainedEntries, 0);
  assert.deepEqual(data.groups, []);
  const html = await readFile(
    new URL("../ui/index.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /<button[^>]*id="performanceExport"[^>]*disabled/);
});

const snapshot = {
  entries: [
    {
      source: "backend",
      stage: "backend-call",
      level: "info",
      time: "2026-01-01T00:00:00Z",
      metadata: { elapsedMs: 123 },
    },
  ],
  capacity: 5000,
};

test("loaded refresh retains and labels the last snapshot through failure and cancellation", async (t) => {
  const { page } = await setup(t);
  await page.evaluate("logPaused = true");
  await settle(page, snapshot);
  const rows = await page.locator("#performanceRows").innerText();
  await page.locator("#logRefresh").click();
  await controls(page);
  assert.match(
    await page.locator("#performanceWindow").innerText(),
    /Last loaded snapshot.*Refreshing/,
  );
  assert.equal(await page.locator("#performanceExport").isDisabled(), false);
  assert.equal(await page.locator("#performanceRows").innerText(), rows);
  await settle(page, { error: "synthetic refresh failure" }, 503);
  await controls(page);
  assert.match(
    await page.locator("#performanceWindow").innerText(),
    /Last loaded snapshot.*Refresh failed/,
  );
  await page.locator("#performanceExport").click();
  assert.equal(
    await page.evaluate(
      async () =>
        JSON.parse(await (window as any).downloads[0].text()).window
          .receiptCount,
    ),
    1,
  );
  await page.locator("#logRefresh").click();
  await page.locator("#settingsTab").click();
  await settle(page, { entries: [] });
  await page.locator("#diagnosticsTab").click();
  assert.match(
    await page.locator("#performanceWindow").innerText(),
    /Last loaded snapshot.*1 receipts/,
  );
  assert.doesNotMatch(
    await page.locator("#performanceWindow").innerText(),
    /Refreshing|Loading/,
  );
  assert.equal(await page.locator("#performanceRows").innerText(), rows);
});

test("pause, hidden view and lock fence late reads and reset snapshot eligibility", async (t) => {
  const { page, adminKey } = await setup(t);
  await page.locator("#logPause").click();
  await controls(page);
  assert.match(
    await page.locator("#performanceWindow").innerText(),
    /not loaded/,
  );
  await settle(page, snapshot);
  await blocked(page);
  await page.locator("#logRefresh").click();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await settle(page, snapshot);
  await blocked(page);
  assert.doesNotMatch(
    await page.locator("#performanceWindow").innerText(),
    /Loading/,
  );
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.locator("#logRefresh").click();
  await settle(page, snapshot);
  assert.equal(await page.locator("#performanceExport").isDisabled(), false);
  await page.locator("#logRefresh").click();
  await page.locator("#lockStudio").click();
  await settle(page, snapshot);
  await blocked(page);
  assert.equal(await page.locator("#performanceRows").textContent(), "");
  await page.locator("#adminKey").fill(adminKey);
  await page.locator("#unlock").click();
  await page.locator("#diagnosticsTab").click();
  await controls(page);
  await blocked(page);
  await page.locator("#logRefresh").click();
  await settle(page, { entries: [] });
  assert.equal(await page.locator("#performanceExport").isDisabled(), false);
  assert.match(
    await page.locator("#performanceWindow").innerText(),
    /0 receipts/,
  );
});
