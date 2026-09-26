import { chromium } from "playwright-core";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { Updates } from "../src/update/updates.js";
import { AutoUpdateSetting } from "../src/update/auto.js";
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
const app = await admin(
  store,
  0,
  undefined,
  undefined,
  updates,
  new AutoUpdateSetting(home),
);
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
  await page.locator("#settingsTab").click();
  await page.getByRole("tab", { name: "Updates", exact: true }).click();
  const savedAuto = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/update/auto") &&
      response.request().method() === "POST",
  );
  await page.locator("#updateAuto").check();
  assert.equal((await savedAuto).status(), 200);
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLInputElement>("#updateAuto")?.checked === true,
  );
  assert.equal((await new AutoUpdateSetting(home).read()).enabled, true);
  for (const width of [320, 360]) {
    await page.setViewportSize({ width, height: 800 });
    const layout = await page.evaluate(() => {
      const input = document
        .querySelector("#updateAuto")!
        .getBoundingClientRect();
      const text = document
        .querySelector(".update-auto-control span")!
        .getBoundingClientRect();
      return {
        aligned: text.left > input.right && Math.abs(text.top - input.top) < 12,
        noOverflow: document.documentElement.scrollWidth <= innerWidth,
      };
    });
    assert.deepEqual(layout, { aligned: true, noOverflow: true });
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
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
  await page.route("**/api/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ state: "stopped", operatorChat: true }),
    }),
  );
  await page.waitForTimeout(4300);
  assert.equal(
    await page.locator("#updateApply").isDisabled(),
    true,
    "active operator turn blocks source upgrades",
  );
  await page.unroute("**/api/status");
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>("#updateApply")?.disabled,
  );
  await page
    .locator("#updates")
    .screenshot({ path: evidence + "/studio-updates-desktop.png" });
  await page.getByRole("tab", { name: "Updates", exact: true }).click();
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
  await page.getByRole("tab", { name: "Persona", exact: true }).click();
  await page.locator("#name").fill("Unsaved changes");
  await page.getByRole("tab", { name: "Updates", exact: true }).click();
  await page.locator("#updateApply").click();
  assert.match(await page.locator("#notice").innerText(), /Unsaved edits/);
  assert.equal(await page.locator("#updateConfirm").isVisible(), false);
  await page.getByRole("tab", { name: "Persona", exact: true }).click();
  await page.locator("#name").fill(store.publicConfig().persona.name);
  await page.getByRole("tab", { name: "Updates", exact: true }).click();
  await page.locator("#updateApply").click();
  const accepted = page.waitForResponse((r) =>
    r.url().endsWith("/api/update/apply"),
  );
  await page.locator("#updateConfirmApply").click();
  assert.equal((await accepted).status(), 202);
  assert.equal(applies, 1);
  await page.waitForFunction(
    () => document.querySelector("#state")?.textContent === "UPGRADING",
  );
  assert.equal(await page.locator("#state").getAttribute("data-tone"), "busy");
  await page.setViewportSize({ width: 360, height: 800 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: evidence + "/studio-upgrading-mobile.png",
    clip: { x: 0, y: 0, width: 360, height: 320 },
  });
  await page.setViewportSize({ width: 1280, height: 1000 });
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
  await page.waitForFunction(
    () => document.querySelector("#state")?.textContent === "STOPPED",
  );
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
  await page.getByRole("tab", { name: "Updates", exact: true }).click();
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
  // Old owners may only supply a failed receipt and stale deferred status.
  updates.autoOutcome = { sha: latest, state: "deferred" };
  updates.checkedAt = 0;
  await page.locator("#updateCheck").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#updateStatus")
      ?.textContent?.includes("Main differs"),
  );
  assert.equal(
    await page.locator("#updateOutcome").getAttribute("role"),
    "alert",
  );
  assert.equal(
    await page.locator("#updateOutcome").getAttribute("data-tone"),
    "error",
  );
  assert.equal(
    await page
      .locator("#updateOutcome")
      .evaluate((el) => getComputedStyle(el).color),
    "rgb(255, 180, 180)",
  );
  assert.match(
    await page.locator("#updateOutcome").innerText(),
    /reason was not recorded/i,
  );
  assert.doesNotMatch(
    await page.locator("#updateAutoStatus").innerText(),
    /was deferred|will verify/,
  );
  assert.doesNotMatch(
    await page.locator("#updateStatus").innerText(),
    /will verify/,
  );
  for (const state of ["failed", "suppressed", "restored-running"] as const) {
    updates.autoOutcome = { sha: latest, state };
    fixtureOperation = {
      ...fixtureOperation!,
      reason: "EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED",
    };
    const reply = page.waitForResponse("**/api/update/check");
    await page.locator("#updateCheck").click();
    await reply;
    await page.waitForFunction(() =>
      document
        .querySelector("#updateOutcome")
        ?.textContent?.includes("EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED"),
    );
    assert.match(
      await page.locator("#updateOutcome").innerText(),
      /outside Pi/,
    );
    assert.doesNotMatch(
      await page.locator("#updateAutoStatus").innerText(),
      /was deferred/,
    );
  }
  await page.getByRole("button", { name: "Diagnostics", exact: true }).click();
  await page.locator("#logRefresh").waitFor({ state: "visible" });
  const downloaded = page.waitForEvent("download");
  await page.locator("#logDownload").click();
  const diagnostic = JSON.parse(
    await readFile((await (await downloaded).path())!, "utf8"),
  );
  assert.equal(
    diagnostic.update.lastOperation.reason,
    "EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED",
  );
  assert.equal(diagnostic.update.lastOperation.sha, latest);
  assert.equal(
    JSON.stringify(diagnostic.update).includes(store.secrets.admin),
    false,
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Updates", exact: true }).click();
  for (const width of [320, 360, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page
      .locator("#updates")
      .screenshot({ path: evidence + `/studio-updates-failure-${width}.png` });
  }
  fixtureOperation = { ...fixtureOperation!, reason: "private-output" as any };
  await page.locator("#updateCheck").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#updateOutcome")
      ?.textContent?.includes("reason was not recorded"),
  );
  assert.equal(
    (await page.locator("#updates").innerText()).includes("private-output"),
    false,
  );
  fixtureOperation = {
    ...fixtureOperation!,
    state: "interrupted",
    reason: undefined,
  };
  await page.locator("#updateCheck").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#updateOutcome")
      ?.textContent?.includes("interrupted"),
  );
  assert.equal(
    await page.locator("#updateOutcome").getAttribute("role"),
    "alert",
  );
  fixtureOperation = {
    ...fixtureOperation!,
    state: "succeeded",
    reason: undefined,
  };
  updates.autoOutcome = undefined;
  await page.locator("#updateCheck").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#updateOutcome")
      ?.textContent?.includes("succeeded"),
  );
  assert.equal(
    await page.locator("#updateOutcome").getAttribute("role"),
    "status",
  );
  assert.notEqual(
    await page.locator("#updateOutcome").getAttribute("data-tone"),
    "error",
  );
  fixtureOperation = {
    ...fixtureOperation!,
    state: "failed",
    reason: "EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED",
  };
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
  await page.locator("#settingsTab").click();
  await page.getByRole("tab", { name: "Updates", exact: true }).click();
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
  await page.getByRole("tab", { name: "Updates", exact: true }).click();
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
  await page.locator("#settingsTab").click();
  await page.getByRole("tab", { name: "Updates", exact: true }).click();
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
  await page.locator("#settingsTab").click();
  await page.getByRole("tab", { name: "Updates", exact: true }).click();
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
  const oldLauncher = await admin(
    store,
    0,
    undefined,
    undefined,
    new Updates(
      installed,
      async () => {},
      async () => new Response(JSON.stringify({ object: { sha: installed } })),
    ),
  );
  try {
    const legacyPage = await context.newPage();
    await legacyPage.goto(oldLauncher.origin + "/#" + store.secrets.admin);
    await legacyPage.locator("#studio").waitFor({ state: "visible" });
    await legacyPage.locator("#settingsTab").click();
    await legacyPage.getByRole("tab", { name: "Updates", exact: true }).click();
    await legacyPage.waitForFunction(
      () =>
        document
          .querySelector("#updateAutoStatus")
          ?.textContent?.includes("launcher"),
      null,
      { timeout: 3000 },
    );
    assert.equal(await legacyPage.locator("#updateAuto").isDisabled(), true);
    assert.match(
      await legacyPage.locator("#updateAutoStatus").innerText(),
      /launcher/i,
    );
    await legacyPage.setViewportSize({ width: 360, height: 800 });
    await legacyPage.locator("#updates").screenshot({
      path: evidence + "/studio-old-launcher-mobile.png",
    });
    await legacyPage.close();
  } finally {
    await oldLauncher.close();
  }
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
