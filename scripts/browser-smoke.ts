import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { createServer } from "node:http";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { Store } from "../src/config/store.js";
import { Diagnostics } from "../src/diagnostics/log.js";
import { admin } from "../src/server/admin.js";
const dir = await mkdtemp(tmpdir() + "/coach-browser-");
const evidence =
  process.env.COACH_EVIDENCE_DIR ?? tmpdir() + "/coach-browser-evidence";
let providerCalls = 0;
const provider = createServer(async (req, res) => {
  providerCalls++;
  for await (const _ of req) {
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.end(
    "data: " +
      JSON.stringify({
        id: "qa",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content:
                "Synthetic QA response: choose an easy walk today, prioritize sleep, and reassess soreness tomorrow. This is a transport fixture, not live model inference.",
            },
            finish_reason: null,
          },
        ],
      }) +
      "\n\ndata: " +
      JSON.stringify({
        id: "qa",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }) +
      "\n\ndata: [DONE]\n\n",
  );
});
await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
const store = new Store(dir);
await store.init();
const syntheticRejected = "<tool_call>synthetic-not-json</tool_call>";
new Diagnostics(dir).record({
  source: "worker",
  stage: "task-output-correction",
  level: "warn",
  error: new Error("TASK_OUTPUT_JSON"),
  rejection: {
    kind: "activity_reaction",
    attempt: 2,
    reason: "Unexpected token '<' at position 0",
    text: syntheticRejected,
  },
});
const backend = createServer((_req, res) =>
  res.end(
    "# Kata.fit external Coach agent v1\nSynthetic browser backend policy",
  ),
);
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
await store.save({
  ...store.publicConfig(),
  origin: `http://127.0.0.1:${(backend.address() as any).port}`,
});
const app = await admin(store, 0);
let browser: Browser | undefined;
let context: BrowserContext | undefined;
try {
  browser = process.env.COACH_CDP
    ? await chromium.connectOverCDP(process.env.COACH_CDP)
    : await chromium.launch({
        executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
        headless: true,
        args: ["--no-sandbox"],
      });
  context = await browser.newContext();
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.origin);
  await page.locator("#adminKey").fill(store.secrets.admin);
  await page.locator("#unlock").click();
  await page.locator("#studio").waitFor({ state: "visible" });
  await page.locator("#settingsTab").click();
  assert.equal(await page.locator("#vision").isChecked(), false);
  assert.ok((await page.locator("#vision").boundingBox())!.width <= 24);
  await page.locator("#vision").check();
  await page
    .locator("#baseUrl")
    .fill(`http://127.0.0.1:${(provider.address() as any).port}/v1`);
  await page.locator("#model").fill("synthetic-qa");
  await page.locator("#apiKey").fill("synthetic-qa-key");
  await page.locator("#name").fill("Sage");
  await page.locator("#save").click();
  await page.waitForFunction(() =>
    document.querySelector("#notice")?.textContent?.startsWith("Saved."),
  );
  await page.locator("#name").fill("Unsaved name");
  assert.equal(store.publicConfig().provider.vision, true);
  await page.locator("#previewButton").click();
  await page.waitForFunction(() =>
    document.querySelector("#notice")?.textContent?.includes("Unsaved edits"),
  );
  assert.equal(providerCalls, 0);
  await page.locator("#name").fill("Sage");
  await page.locator("#previewButton").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#notice")
      ?.textContent?.startsWith("Preview complete"),
  );
  assert.match(
    await page.locator("#answer").innerText(),
    /Synthetic QA response/,
  );
  assert.match(
    (await page.locator("#prompt").textContent()) ?? "",
    /name: Sage/,
  );
  assert.equal(store.publicConfig().persona.name, "Sage");
  assert.match(
    (await page.locator("#prompt").textContent()) ?? "",
    /Synthetic browser backend policy/,
  );
  assert.match(
    (await page.locator("#notice").textContent()) ?? "",
    /fetched backend instructions/,
  );
  assert.equal(await page.locator("#apiKey").inputValue(), "");
  assert.match(
    (await page.locator("#notice").textContent()) ?? "",
    /no claimed-request data authority/,
  );
  await mkdir(evidence, { recursive: true });
  assert.equal(await page.locator("#logsView").count(), 1);
  let logRequests = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/logs")) logRequests++;
  });
  await page.locator("#logsView summary").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#logRows")
      ?.textContent?.includes("preview-completed"),
  );
  const rejected = page.locator(".log-entry", {
    hasText: "task-output-correction",
  });
  assert.equal(
    await rejected.locator(".rejected-output").textContent(),
    syntheticRejected,
  );
  assert.match(
    (await rejected.locator("details summary").textContent()) ?? "",
    /attempt 2.*private/,
  );
  await rejected.locator("details summary").click();
  assert.match(await rejected.innerText(), /Reject reason: Unexpected token/);
  await rejected.locator("details summary").click();
  await page.evaluate(async (key) => {
    await fetch("/api/config", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      },
      body: '{"private":"DO_NOT_LOG"}',
    });
  }, store.secrets.admin);
  await page.locator("#logRefresh").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#logRows")
      ?.textContent?.includes("INVALID_PERSONA"),
  );
  await page.locator("#logLevel").selectOption("error");
  assert.ok(
    !(await page.locator("#logRows").innerText()).includes("preview-completed"),
  );
  assert.ok(
    !(await page.locator("#logRows").innerText()).includes("DO_NOT_LOG"),
  );
  await page.locator("#logPause").click();
  await page.waitForTimeout(100);
  const pausedCount = logRequests;
  await page.waitForTimeout(2200);
  assert.equal(logRequests, pausedCount);
  assert.equal(
    await page
      .locator(".log-entry")
      .first()
      .evaluate((e) => getComputedStyle(e).backgroundColor),
    "rgb(16, 23, 21)",
  );
  const downloadWait = page.waitForEvent("download");
  await page.locator("#logDownload").click();
  const download = await downloadWait;
  await download.saveAs(evidence + "/logs-browser.json");
  await page.locator("#logsView").scrollIntoViewIfNeeded();
  await page.screenshot({ path: evidence + "/studio-logs-desktop.png" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.locator("#logCopy").click();
  assert.ok(
    (await page.evaluate(() => navigator.clipboard.readText())).includes(
      "INVALID_PERSONA",
    ),
  );
  await page.locator("#logPause").click();
  await page.waitForTimeout(100);
  await page.evaluate(
    "Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange'));",
  );
  const hiddenCount = logRequests;
  await page.waitForTimeout(2200);
  assert.equal(logRequests, hiddenCount);
  await page.evaluate(() => {
    delete (document as any).hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(100);
  await page.locator("#logsView summary").click();
  await page.waitForTimeout(100);
  const closedCount = logRequests;
  await page.waitForTimeout(2200);
  assert.equal(logRequests, closedCount);
  await page.evaluate(() => scrollTo(0, 0));
  await page.locator("#vision").scrollIntoViewIfNeeded();
  await page.screenshot({ path: evidence + "/data-vision-desktop.png" });
  await page.locator("#preview").scrollIntoViewIfNeeded();
  await page.screenshot({ path: evidence + "/data-preview.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo(0, 0));
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.locator("#vision").scrollIntoViewIfNeeded();
  await page.screenshot({ path: evidence + "/data-vision-mobile.png" });
  await page.locator("#logsView summary").click();
  await page.locator("#logsView").scrollIntoViewIfNeeded();
  await page.screenshot({ path: evidence + "/studio-logs-mobile.png" });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.locator("#rollback").click();
  await page.waitForFunction(() =>
    document.querySelector("#notice")?.textContent?.includes("restored"),
  );
  assert.equal(await page.locator("#vision").isChecked(), false);
  assert.ok((await page.locator("#vision").boundingBox())!.width <= 24);
  assert.equal(store.publicConfig().provider.vision, false);
  assert.deepEqual(errors, []);
  console.log(
    "Browser PASS: unlock, config persistence, actual Pi + synthetic HTTP preview, cleared secret inputs, desktop/mobile no overflow; 0 page errors.",
  );
  await page.close();
} finally {
  await context?.close();
  await browser?.close();
  await app.close();
  backend.closeAllConnections();
  await new Promise((r) => backend.close(r));
  provider.closeAllConnections();
  await new Promise((r) => provider.close(r));
  await rm(dir, { recursive: true, force: true });
}
