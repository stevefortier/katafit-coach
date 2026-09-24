import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { createServer } from "node:http";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
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
new Diagnostics(dir).record({
  source: "provider",
  stage: "provider-response",
  metadata: { turn: 3, nativeCalls: 0, textParts: 1 },
  texts: [
    {
      role: "assistant",
      text: "Synthetic assessment: steady progress <function=coach_read_media>",
    },
  ],
  calls: [{ name: "coach_read_media", argumentKeys: ["activity_id"] }],
});
new Diagnostics(dir).record({
  source: "provider",
  stage: "tool-execution",
  metadata: { turn: 2 },
  receipt: { name: "coach_read_media", outcome: "error", media: false },
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
  await page.setViewportSize({ width: 320, height: 700 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#adminKey").fill(store.secrets.admin);
  await page.locator("#unlock").click();
  await page.locator("#studio").waitFor({ state: "visible" });
  assert.equal(await page.locator(".hero").count(), 0);
  assert.equal(await page.locator("footer").count(), 0);
  assert.equal(
    (await page.locator("body").innerText()).includes("YOUR RUNTIME"),
    false,
  );
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 700 });
    for (const panel of ["coachTab", "settingsTab"]) {
      await page.locator("#" + panel).click();
      const overflow = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
      }));
      assert.ok(
        overflow.document <= overflow.viewport &&
          overflow.body <= overflow.viewport,
        `${panel} at ${width}px overflows: ${JSON.stringify(overflow)}`,
      );
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
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
  const savedBeforeReset = store.publicConfig();
  await page.locator("#name").fill("Unsaved name");
  await page.locator("#persona details > summary").click();
  await page.locator("#markdown").fill("Unsaved custom instruction");
  await page.locator("#resetPersona").click();
  await page.waitForFunction(() =>
    document.querySelector("#notice")?.textContent?.includes("stock persona"),
  );
  const defaultResponse = await fetch(app.origin + "/api/persona-defaults", {
    headers: { Authorization: "Bearer " + store.secrets.admin },
  });
  assert.equal(defaultResponse.status, 200);
  assert.equal(
    (await fetch(app.origin + "/api/persona-defaults")).status,
    401,
    "stock persona route must require Studio auth",
  );
  const stock = (await defaultResponse.json()).persona as Record<
    string,
    string
  >;
  assert.equal(
    Object.keys(stock).length,
    Object.keys(savedBeforeReset.persona).length,
  );
  for (const [field, value] of Object.entries(stock))
    assert.equal(await page.locator("#" + field).inputValue(), value);
  assert.deepEqual(
    store.publicConfig(),
    savedBeforeReset,
    "reset must not save",
  );
  assert.equal(
    await page.locator("#baseUrl").inputValue(),
    savedBeforeReset.provider.baseUrl,
  );
  assert.equal(
    await page.locator("#model").inputValue(),
    savedBeforeReset.provider.model,
  );
  assert.equal(
    await page.locator("#origin").inputValue(),
    savedBeforeReset.origin,
  );
  assert.equal(await page.locator("#vision").isChecked(), true);
  await page.locator("#previewButton").click();
  await page.waitForFunction(() =>
    document.querySelector("#notice")?.textContent?.includes("Unsaved edits"),
  );
  assert.equal(providerCalls, 0);
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
  assert.equal(await page.locator("#apiKey").inputValue(), "");
  assert.match(
    (await page.locator("#notice").textContent()) ?? "",
    /^Preview complete · revision \d+$/,
  );
  await mkdir(evidence, { recursive: true });
  assert.equal(await page.locator("#logsView").count(), 1);
  let logRequests = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/logs")) logRequests++;
  });
  await page.locator("#logsView > summary").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#logRows")
      ?.textContent?.includes("preview-completed"),
  );
  for (const width of [320, 360, 390]) {
    await page.setViewportSize({ width, height: 700 });
    const layout = await page.evaluate(() => {
      const viewport = document.documentElement.clientWidth;
      const wide = [...document.querySelectorAll("#settingsPanel *")]
        .filter((node) => node.getClientRects().length)
        .filter((node) => {
          const box = node.getBoundingClientRect();
          return box.left < -1 || box.right > viewport + 1;
        })
        .slice(0, 5)
        .map((node) => ({
          tag: node.tagName,
          id: node.id,
          className: node.className,
        }));
      return { viewport, document: document.documentElement.scrollWidth, wide };
    });
    assert.ok(
      layout.document <= width && !layout.wide.length,
      `Logs at ${width}px: ${JSON.stringify(layout)}`,
    );
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const modelRow = page.locator(".log-entry", {
    hasText: "Synthetic assessment: steady progress",
  });
  await modelRow.locator("details summary").click();
  assert.match(
    await modelRow.innerText(),
    /assistant.*Synthetic assessment.*coach_read_media/s,
  );
  const receiptRow = page.locator(".log-entry", { hasText: "tool-execution" });
  await receiptRow.locator("details summary").click();
  assert.match(await receiptRow.innerText(), /coach_read_media.*error/);
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
  await page.locator("#logLevel").selectOption("all");
  const downloadWait = page.waitForEvent("download");
  await page.locator("#logDownload").click();
  const download = await downloadWait;
  await download.saveAs(evidence + "/logs-browser.json");
  const exported = JSON.parse(
    await readFile(evidence + "/logs-browser.json", "utf8"),
  );
  assert.ok(
    exported.entries.some((e: any) =>
      e.texts?.some((t: any) => t.text.includes("Synthetic assessment")),
    ),
  );
  assert.ok(
    exported.entries.some((e: any) => e.receipt?.name === "coach_read_media"),
  );
  await page
    .locator(".log-entry", { hasText: "Synthetic assessment: steady progress" })
    .locator("details summary")
    .click();
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
  await page.locator("#logsView > summary").click();
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
  await page.locator("#logsView > summary").click();
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
  const beforeSaveReset = store.publicConfig();
  await page.locator("#name").fill("Another custom name");
  await page.locator("#resetPersona").click();
  await page.waitForFunction(() =>
    document.querySelector("#notice")?.textContent?.includes("stock persona"),
  );
  assert.deepEqual(store.publicConfig(), beforeSaveReset);
  await page.locator("#persona").scrollIntoViewIfNeeded();
  await page.evaluate(() => scrollBy(0, 220));
  await page.screenshot({ path: evidence + "/persona-reset-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#persona").scrollIntoViewIfNeeded();
  await page.evaluate(() => scrollBy(0, 220));
  await page.screenshot({ path: evidence + "/persona-reset-desktop.png" });
  await page.locator("#save").click();
  await page.waitForFunction(() =>
    document.querySelector("#notice")?.textContent?.startsWith("Saved."),
  );
  assert.deepEqual(store.publicConfig().persona, stock);
  assert.equal(store.publicConfig().revision, beforeSaveReset.revision + 1);
  assert.deepEqual(store.publicConfig().provider, beforeSaveReset.provider);
  assert.equal(store.publicConfig().origin, beforeSaveReset.origin);
  assert.equal(await page.locator("#apiKey").inputValue(), "");
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
