// Studio's Updates panel shows the bootstrap's real rollback marker, served by
// the real supervisor and application, and dismisses exactly what it shows.
import { browserEvidence } from "./helpers/browser-evidence.js";
import { chromePath } from "./helpers/chrome.js";
import { settingsTab } from "./helpers/settings-navigation.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { Store } from "../src/config/store.js";
import { sandboxModeFile } from "../src/sandbox/mode.js";
import { supervise } from "./helpers/legacy-supervisor.js";

const failed = "a".repeat(40);
const previous = "b".repeat(40);
const first = { revision: failed, restored: previous, at: 1762400000000 };

const visibleNotice = (page: Page) =>
  page.locator("#updateRollbackText").innerText();
const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("Updates shows the real bootstrap rollback and dismisses only the notice it shows", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-rollback-browser-"));
  const store = new Store(home);
  await store.init();
  await writeFile(sandboxModeFile(home), '{"mode":"workspace"}');
  const marker = join(home, "boot-rollback.json");
  const write = (value: unknown) =>
    writeFile(marker, JSON.stringify(value), { mode: 0o600 });
  const offline = async () => new Response("", { status: 503 });
  await write(first);
  let owner = await supervise(store, 0, undefined, { request: offline });
  const port = Number(new URL(owner.origin).port);
  // The bootstrap writes a marker only while no supervisor runs.
  const restart = async (value: unknown) => {
    await owner.close();
    await write(value);
    owner = await supervise(store, port, undefined, { request: offline });
  };
  const evidence = await browserEvidence();
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: chromePath(),
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    page.setDefaultTimeout(10000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const mutations: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (/^\/api\/update\/(apply|prepare|force|quiesce)/.test(path))
        mutations.push(path);
    });
    await page.goto(owner.origin + "/#" + store.secrets.admin);
    await page.locator("#studio").waitFor({ state: "visible" });
    await settingsTab(page, "Updates");
    await page.locator("#updateRollback").waitFor({ state: "visible" });
    const shown = await visibleNotice(page);
    assert.match(
      shown,
      /^Version aaaaaaaaaaaa didn't start; Coach went back to bbbbbbbbbbbb at .+\.$/,
    );
    assert.match(
      (await page.locator("#updateRollbackText").getAttribute("title")) ?? "",
      new RegExp(`${failed}.*${previous}`),
    );
    for (const width of [1280, 360]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await noOverflow(page), true, `no overflow at ${width}`);
      await page
        .locator("#updates")
        .screenshot({ path: `${evidence}/rollback-notice-${width}.png` });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    const shownDiagnostic = await page.evaluate("JSON.parse(logJSON())");
    assert.deepEqual((shownDiagnostic as any).update.bootRollback, first);

    // A removal the supervisor cannot complete keeps the notice and says so.
    if (process.getuid?.() !== 0) {
      await chmod(home, 0o500);
      try {
        await page.locator("#updateRollbackDismiss").click();
        await page
          .locator("#updateRollbackStatus")
          .filter({ hasText: "could not be removed" })
          .waitFor();
      } finally {
        await chmod(home, 0o700);
      }
      assert.equal(await page.locator("#updateRollback").isVisible(), true);
      assert.equal(await visibleNotice(page), shown);
      assert.equal(await readFile(marker, "utf8"), JSON.stringify(first));
      await page
        .locator("#updates")
        .screenshot({ path: `${evidence}/rollback-dismiss-failed.png` });
    }

    // The same upgrade failed again while this page still shows the first
    // rollback: dismissing the old notice must not remove the new one.
    const second = { ...first, at: first.at + 3600000 };
    await restart(second);
    assert.equal(await visibleNotice(page), shown);
    await page.locator("#updateRollbackDismiss").click();
    await page
      .locator("#updateRollbackStatus")
      .filter({ hasText: "changed" })
      .waitFor();
    await page.waitForFunction(
      (old) =>
        document.querySelector("#updateRollbackText")?.textContent !== old,
      shown,
    );
    assert.match(await visibleNotice(page), /^Version aaaaaaaaaaaa didn't/);
    assert.equal(await readFile(marker, "utf8"), JSON.stringify(second));

    await page.locator("#updateRollbackDismiss").click();
    await page.locator("#updateRollback").waitFor({ state: "hidden" });
    await assert.rejects(lstat(marker), { code: "ENOENT" });
    await page.reload();
    await page.locator("#studio").waitFor({ state: "visible" });
    await page
      .locator("#updateChecked")
      .filter({ hasText: "Last check" })
      .waitFor();
    assert.equal(await page.locator("#updateRollback").isHidden(), true);

    // A rollback to the bootstrap's own package names no revision.
    await restart({ revision: failed, restored: null, at: first.at + 7200000 });
    await page.reload();
    await page.locator("#studio").waitFor({ state: "visible" });
    await page.locator("#updateRollback").waitFor({ state: "visible" });
    assert.match(
      await visibleNotice(page),
      /^Version aaaaaaaaaaaa didn't start; Coach went back to the bundled version at .+\.$/,
    );
    await page.setViewportSize({ width: 360, height: 900 });
    assert.equal(await noOverflow(page), true);
    await page
      .locator("#updates")
      .screenshot({ path: `${evidence}/rollback-notice-bundled-360.png` });
    await page.locator("#updateRollbackDismiss").click();
    await page.locator("#updateRollback").waitFor({ state: "hidden" });
    await assert.rejects(lstat(marker), { code: "ENOENT" });

    const diagnostic = await page.evaluate("JSON.parse(logJSON())");
    assert.equal((diagnostic as any).update.bootRollback, undefined);
    assert.deepEqual(mutations, [], "a notice never starts an update");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await owner.close();
    await rm(home, { recursive: true, force: true });
  }
});
