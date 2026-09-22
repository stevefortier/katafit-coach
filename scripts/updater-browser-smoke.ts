import { chromium } from "playwright-core";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { Updates } from "../src/update/updates.js";
import type { Operation } from "../src/update/journal.js";
const home = await mkdtemp(tmpdir() + "/coach-update-browser-");
const store = new Store(home);
await store.init();
const installed = "a".repeat(40);
let latest = "b".repeat(40),
  failNext = false;
let checks = 0,
  applies = 0;
let fixtureOperation: Operation | undefined;
class BrowserUpdates extends Updates {
  snapshot() {
    return {
      ...super.snapshot(),
      ...(fixtureOperation ? { lastOperation: fixtureOperation } : {}),
    };
  }
}
let release: (() => void) | undefined;
const updates = new BrowserUpdates(
  installed,
  async () => {
    applies++;
    if (failNext) throw new Error("synthetic-private-installer-error");
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  },
  async () => {
    checks++;
    return new Response(JSON.stringify({ object: { sha: latest } }));
  },
);
const app = await admin(store, 0, undefined, undefined, updates);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const evidence =
    process.env.COACH_EVIDENCE_DIR ??
    tmpdir() + "/coach-updater-browser-evidence";
  await mkdir(evidence, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 1000 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.origin + "/#" + store.secrets.admin);
  await page.locator("#studio").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#updates").count(),
    1,
    "Studio exposes source updates",
  );
  await page.waitForFunction(() =>
    document
      .querySelector("#updateLatest")
      ?.textContent?.includes("bbbbbbbbbbbb"),
  );
  assert.equal(checks, 1, "unlock automatically checks GitHub once");
  assert.equal(applies, 0, "check never installs");
  assert.match(
    await page.locator("#updateInstalled").innerText(),
    /aaaaaaaaaaaa/,
  );
  assert.equal(await page.locator("#updateApply").isEnabled(), true);
  await page
    .locator("#updates")
    .screenshot({ path: evidence + "/studio-updates-desktop.png" });
  await page.locator("#updateApply").click();
  await page.locator("#updateConfirm").waitFor({ state: "visible" });
  await page.setViewportSize({ width: 360, height: 800 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "mobile confirmation does not overflow",
  );
  await page
    .locator("#updates")
    .screenshot({ path: evidence + "/studio-updates-mobile.png" });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.locator("#updateCancel").click();
  assert.equal(applies, 0, "dismissed confirmation never installs");
  await page.locator("#name").fill("Unsaved changes");
  await page.locator("#updateApply").click();
  assert.match(await page.locator("#notice").innerText(), /Unsaved edits/);
  assert.equal(await page.locator("#updateConfirm").isVisible(), false);
  await page.locator("#name").fill(store.publicConfig().persona.name);
  await page.locator("#updateApply").click();
  const accepted = page.waitForResponse((r) =>
    r.url().endsWith("/api/update/apply"),
  );
  await page.locator("#updateConfirmApply").click();
  assert.equal((await accepted).status(), 202);
  assert.equal(applies, 1);
  assert.equal(await page.locator("#run").isDisabled(), true);
  assert.equal(await page.locator("#save").isDisabled(), true);
  await page.route("**/api/update", (route) => route.abort());
  await page.waitForFunction(() =>
    document
      .querySelector("#updateStatus")
      ?.textContent?.includes("unavailable"),
  );
  assert.equal(await page.locator("#run").isDisabled(), true);
  await page.unroute("**/api/update");
  release?.();
  await page.waitForFunction(() =>
    document
      .querySelector("#updateStatus")
      ?.textContent?.includes("Upgrade healthy"),
  );
  assert.match(
    await page.locator("#updateInstalled").innerText(),
    /bbbbbbbbbbbb/,
  );
  assert.equal(await page.locator("#updateApply").isDisabled(), true);
  assert.equal(await page.locator("#run").isEnabled(), true);
  latest = "c".repeat(40);
  fixtureOperation = {
    id: "11111111-1111-1111-1111-111111111111",
    sha: latest,
    state: "failed",
    at: Date.now(),
  };
  failNext = true;
  updates.checkedAt = 0;
  await page.locator("#updateCheck").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#updateLatest")
      ?.textContent?.includes("cccccccccccc"),
  );
  await page.locator("#updateApply").click();
  await page.locator("#updateConfirmApply").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#updateStatus")
      ?.textContent?.includes("Upgrade failed"),
  );
  assert.match(
    await page.locator("#updateInstalled").innerText(),
    /bbbbbbbbbbbb/,
  );
  assert.equal(
    (await page.locator("body").innerText()).includes(
      "synthetic-private-installer-error",
    ),
    false,
  );
  await page
    .locator("#updates")
    .screenshot({ path: evidence + "/studio-updates-failure.png" });
  assert.equal(
    await page.locator("#updateReload").count(),
    1,
    "verified upgrades offer refreshed Studio assets",
  );
  await Promise.all([
    page.waitForNavigation(),
    page.locator("#updateReload").click(),
  ]);
  await page.locator("#studio").waitFor({ state: "visible", timeout: 5000 });
  assert.equal(
    await page.locator("#updateOutcome").count(),
    1,
    "durable upgrade outcome has its own display",
  );
  await page.waitForFunction(() =>
    document
      .getElementById("updateOutcome")
      ?.textContent?.includes("Last upgrade failed"),
  );
  assert.equal(await page.locator("#adminKey").inputValue(), "");
  assert.equal(page.url().includes(store.secrets.admin), false);
  // A status reply from an old authentication epoch cannot repaint Lock.
  let lateStatus: any;
  let captured!: () => void;
  const statusCaptured = new Promise<void>((resolve) => {
    captured = resolve;
  });
  await page.route("**/api/status", async (route) => {
    lateStatus = route;
    captured();
  });
  await page.locator("#updateApply").click();
  await statusCaptured;
  await page.locator("#lockStudio").click();
  const finishedStatus = page.waitForResponse("**/api/status");
  await lateStatus.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ state: "stopped", lastError: null }),
  });
  await finishedStatus;
  await page.waitForTimeout(100);
  assert.equal(
    await page.locator("#state").innerText(),
    "LOCKED",
    "late status cannot repaint a locked session",
  );
  await page.unroute("**/api/status");
  assert.equal(await page.locator("#login").isVisible(), true);
  await page.reload();
  assert.equal(await page.locator("#login").isVisible(), true);
  // An expired remembered credential must stop all authenticated polling.
  await page.evaluate(() =>
    sessionStorage.setItem("katafit-coach-admin", "0".repeat(64)),
  );
  await page.reload();
  await page.waitForFunction(
    () => sessionStorage.getItem("katafit-coach-admin") === null,
  );
  assert.match(await page.locator("#notice").innerText(), /Unlock again/);
  let afterExpiry = 0;
  const countAuthenticated = (request: any) => {
    if (request.url().includes("/api/")) afterExpiry++;
  };
  page.on("request", countAuthenticated);
  await page.waitForTimeout(4500);
  assert.equal(
    afterExpiry,
    0,
    "expired reload stops repeated unauthorized requests",
  );
  page.off("request", countAuthenticated);
  await page.locator("#adminKey").fill(store.secrets.admin);
  await page.locator("#unlock").click();
  await page.waitForFunction(
    () =>
      !document.querySelector<HTMLButtonElement>("#updateCheck")?.disabled &&
      !document.querySelector<HTMLElement>("#studio")?.hidden,
  );
  await page.route("**/api/update/check", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: '{"error":"UNAUTHORIZED"}',
    }),
  );
  await page.locator("#updateCheck").click();
  await page.locator("#login").waitFor({ state: "visible" });
  assert.match(await page.locator("#notice").innerText(), /Unlock again/);
  afterExpiry = 0;
  page.on("request", countAuthenticated);
  await page.waitForTimeout(4500);
  assert.equal(
    afterExpiry,
    0,
    "active-session auth loss stops both updater and status polling",
  );
  page.off("request", countAuthenticated);
  await page.unroute("**/api/update/check");
  // A delayed 401 from an earlier unlock cannot clear a newer valid session,
  // even when both attempts used the same credential.
  let oldConfig: any,
    firstConfig = true,
    configCaptured!: () => void;
  const oldConfigReady = new Promise<void>((resolve) => {
    configCaptured = resolve;
  });
  await page.route("**/api/config", async (route) => {
    if (firstConfig) {
      firstConfig = false;
      oldConfig = route;
      configCaptured();
    } else await route.continue();
  });
  await page.locator("#adminKey").fill(store.secrets.admin);
  await page.locator("#unlock").click();
  await oldConfigReady;
  await page.locator("#adminKey").fill(store.secrets.admin);
  await page.locator("#unlock").click();
  await page.locator("#studio").waitFor({ state: "visible" });
  const oldConfigResponse = page.waitForResponse("**/api/config");
  await oldConfig.fulfill({
    status: 401,
    contentType: "application/json",
    body: '{"error":"UNAUTHORIZED"}',
  });
  await oldConfigResponse;
  await page.waitForTimeout(100);
  assert.equal(
    await page.locator("#studio").isVisible(),
    true,
    "old 401 cannot revoke a newer unlock",
  );
  assert.equal(
    await page.evaluate(
      (expected) => sessionStorage.getItem("katafit-coach-admin") === expected,
      store.secrets.admin,
    ),
    true,
  );
  await page.locator("#lockStudio").click();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      updateBrowser: "passed",
      automaticCheck: true,
      explicitConfirmation: true,
      reconnectVerified: true,
      reloadAuthentication: true,
      lastOperationDisplay: true,
      authExpiryStopsPolling: true,
      staleAuthenticationFenced: true,
    }),
  );
} finally {
  release?.();
  await browser?.close();
  await app.close();
  await rm(home, { recursive: true, force: true });
}
