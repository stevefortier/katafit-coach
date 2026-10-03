import { settingsTab } from "../tests/helpers/settings-navigation.js";
import { chromium } from "playwright-core";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { Updates } from "../src/update/updates.js";

const home = await mkdtemp(tmpdir() + "/coach-update-status-");
const store = new Store(home);
await store.init();
const sha = "a".repeat(40);
const base = {
  installed: sha,
  latest: null,
  checkedAt: Date.now() - 300000,
  supported: true,
  applying: false,
  guidance: "GitHub rate limit. Source check failed.",
  checkError: "RATE_LIMITED",
  checking: false,
};
let fixture: any = { ...base };
let heldCheck: Promise<void> | undefined;
let sourceChecks = 0;
class FixtureUpdates extends Updates {
  snapshot() {
    return fixture;
  }
  async check() {
    sourceChecks++;
    await heldCheck;
    return this.snapshot();
  }
}
const app = await admin(
  store,
  0,
  undefined,
  undefined,
  new FixtureUpdates(null, null),
);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  let applyRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/update/apply")
      applyRequests++;
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const evidence =
    process.env.COACH_EVIDENCE_DIR ??
    tmpdir() + "/coach-update-status-evidence";
  await mkdir(evidence, { recursive: true });
  await page.goto(app.origin + "/#" + store.secrets.admin);
  await page.locator("#studio").waitFor({ state: "visible" });
  await page.locator("#settingsTab").click();
  await settingsTab(page, "Updates");
  const checkText = () => page.locator("#updateCheckStatus").innerText();
  assert.match(await checkText(), /GitHub rate limit/);
  assert.equal(
    await page
      .locator("#updateAuto, #updateSchedule, #updateAutoStatus")
      .count(),
    0,
  );
  // Route entry now reads the queue before its automatic source check. Join
  // that complete workflow before installing the gate for the next manual check.
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>("#updateCheck")?.disabled,
  );
  assert.equal(sourceChecks, 1, "Updates entry must finish its source check");
  assert.equal(
    await page.locator("#updateInstalled").getAttribute("title"),
    sha,
  );
  let releaseCheck!: () => void;
  heldCheck = new Promise((resolve) => {
    releaseCheck = resolve;
  });
  try {
    await page.locator("#updateCheck").click();
    assert.equal(await page.locator("#updateCheck").isDisabled(), true);
    assert.match(await checkText(), /Source check requested/);
    assert.match(await checkText(), /Previous check:.*rate limit/);
  } finally {
    releaseCheck();
    heldCheck = undefined;
  }
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>("#updateCheck")?.disabled,
  );
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
      .screenshot({ path: `${evidence}/status-rate-limit-${width}.png` });
  }
  const refresh = async (next: any, expected: string) => {
    fixture = next;
    await page.locator("#updateCheck").click();
    await page.waitForFunction(
      (text) =>
        document
          .querySelector("#updateCheckStatus")
          ?.textContent?.includes(text),
      expected,
    );
  };
  await refresh({ ...base, checking: true }, "Checking GitHub");
  assert.match(await checkText(), /Previous check:.*rate limit/);
  await page
    .locator("#updates")
    .screenshot({ path: evidence + "/status-checking.png" });
  await refresh(
    {
      ...base,
      checkError: "UNAVAILABLE",
      guidance: "GitHub unavailable or timed out. Source check failed.",
    },
    "GitHub unavailable",
  );
  await page
    .locator("#updates")
    .screenshot({ path: evidence + "/status-network.png" });
  fixture = {
    ...base,
    latest: sha,
    checkError: null,
    guidance: "Installed source is current.",
  };
  await page.locator("#updateCheck").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#updateStatus")?.textContent ===
      "Installed source is current.",
  );
  assert.doesNotMatch(await checkText(), /rate limit|unavailable/);
  assert.equal(sourceChecks, 5, "entry plus four explicit source checks");
  assert.equal(applyRequests, 0, "source status checks never submit apply");
  assert.equal(
    await page.locator("#updateInstalled").getAttribute("title"),
    sha,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Manual update status fixtures passed: rate limit, checking, network, success; 320/360/1280 no overflow.",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(home, { recursive: true, force: true });
}
