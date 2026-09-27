import { chromium } from "playwright-core";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { Updates } from "../src/update/updates.js";
import { AutoUpdateSetting } from "../src/update/auto.js";

const home = await mkdtemp(tmpdir() + "/coach-update-status-");
const store = new Store(home);
await store.init();
const setting = new AutoUpdateSetting(home);
await setting.write(true);
const sha = "a".repeat(40);
const base = {
  installed: sha,
  latest: null,
  checkedAt: Date.now() - 300000,
  supported: true,
  applying: false,
  autoOutcome: { sha, state: "running" },
  guidance: "GitHub rate limit. Source check failed.",
  checkError: "RATE_LIMITED",
  checking: false,
  autoSchedule: { nextAttemptAt: Date.now() + 890000, reason: "check-failed" },
};
let fixture: any = { ...base };
let heldCheck: Promise<void> | undefined;
class FixtureUpdates extends Updates {
  snapshot() {
    return fixture;
  }
  async check() {
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
  setting,
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
  page.on("pageerror", (error) => errors.push(error.message));
  const evidence =
    process.env.COACH_EVIDENCE_DIR ??
    tmpdir() + "/coach-update-status-evidence";
  await mkdir(evidence, { recursive: true });
  await page.goto(app.origin + "/#" + store.secrets.admin);
  await page.locator("#studio").waitFor({ state: "visible" });
  await page.locator("#settingsTab").click();
  await page.getByRole("tab", { name: "Updates", exact: true }).click();
  const autoText = () => page.locator("#updateAutoStatus").innerText();
  assert.match(await autoText(), /GitHub rate limit/);
  assert.match(
    await page.locator("#updateSchedule").innerText(),
    /backoff.*Next automatic attempt in .*local time/i,
  );
  assert.doesNotMatch(
    await page.locator(".update-auto-control").innerText(),
    /90 seconds/,
  );
  let releaseCheck!: () => void;
  heldCheck = new Promise((resolve) => {
    releaseCheck = resolve;
  });
  await page.locator("#updateCheck").click();
  try {
    assert.match(await autoText(), /Source check requested/);
    assert.match(await autoText(), /Previous check:.*rate limit/);
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
          .querySelector("#updateAutoStatus")
          ?.textContent?.includes(text),
      expected,
    );
  };
  await refresh({ ...base, checking: true }, "Checking GitHub");
  assert.match(await autoText(), /Previous check:.*rate limit/);
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
  assert.match(await autoText(), /Last automatic result:/);
  await page
    .locator("#updates")
    .screenshot({ path: evidence + "/status-network.png" });
  // New child under an old owner: no check/schedule telemetry, guidance only.
  const old: any = {
    ...base,
    guidance:
      "GitHub rate limit. Wait before checking again (at least one minute).",
  };
  delete old.checkError;
  delete old.checking;
  delete old.autoSchedule;
  await refresh(old, "at least one minute");
  assert.match(
    await page.locator("#updateSchedule").innerText(),
    /retry time unknown.*older launcher/i,
  );
  await page
    .locator("#updates")
    .screenshot({ path: evidence + "/status-old-owner.png" });
  fixture = {
    ...base,
    autoSchedule: { nextAttemptAt: Date.now() - 1000, reason: "check-failed" },
  };
  await page.locator("#updateCheck").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#updateSchedule")
      ?.textContent?.includes("Awaiting launcher"),
  );
  assert.doesNotMatch(await autoText(), /Checking GitHub/);
  await page
    .locator("#updates")
    .screenshot({ path: evidence + "/status-due.png" });
  await setting.write(false);
  await page.locator("#updateCheck").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#updateSchedule")
      ?.textContent?.includes("No automatic retry"),
  );
  assert.doesNotMatch(
    await page.locator("#updateSchedule").innerText(),
    / in \d|local time/,
  );
  assert.match(await autoText(), /rate limit/);
  await page
    .locator("#updates")
    .screenshot({ path: evidence + "/status-disabled.png" });
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
  assert.doesNotMatch(await autoText(), /rate limit|unavailable/);
  await setting.write(true);
  await refresh(
    {
      ...base,
      serverNow: Date.now() - 3600000,
      autoSchedule: {
        nextAttemptAt: Date.now() - 3600000 + 890000,
        reason: "check-failed",
      },
    },
    "GitHub rate limit",
  );
  assert.match(
    await page.locator("#updateSchedule").innerText(),
    /in 14m/,
    "countdown uses server clock, not an hour-skewed browser clock",
  );
  assert.deepEqual(errors, []);
  console.log(
    "Update status fixtures passed: rate limit, checking, network, old owner, due, disabled, success; 320/360/1280 no overflow.",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(home, { recursive: true, force: true });
}
