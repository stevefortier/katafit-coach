import { settingsTab } from "./helpers/settings-navigation.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { NativeTerminal } from "../src/server/terminal.js";

test("native teardown failure still saves at once; restart stays pending with a visible warning", async () => {
  const home = await mkdtemp(tmpdir() + "/apply-stop-failure-");
  const backend = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const msg = JSON.parse(raw);
    if (msg.method === "notifications/initialized")
      return void res.writeHead(202).end();
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result:
          msg.method === "initialize"
            ? { protocolVersion: "2025-03-26" }
            : msg.method === "tools/list"
              ? { tools: [] }
              : { structuredContent: { requests: [] } },
      }),
    );
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(backend.address() as any).port}`,
    token: "synthetic-stop-token",
    apiKey: "synthetic-stop-key",
  });
  const app = await admin(store, 0);
  const original = NativeTerminal.prototype.stop;
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage();
    await page.goto(
      app.origin + "/settings?section=worker#" + store.secrets.admin,
    );
    await page.locator("#studio").waitFor({ state: "visible" });
    await page.locator("#run").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#notice")
        ?.textContent?.includes("Worker started"),
    );
    await settingsTab(page, "Persona");
    await page.locator("#name").fill("Synthetic draft after unsafe stop");
    const revision = store.publicConfig().revision;
    NativeTerminal.prototype.stop = () =>
      Promise.reject(new Error("synthetic native cleanup failure"));
    // No consent or reconciliation-risk prompt of any kind.
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.accept();
    });
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/config") &&
        response.request().method() === "POST",
    );
    await page.locator("#save").click();
    const response = await responsePromise;
    const result = await response.json();
    // Settings policy: saved and acknowledged before any cleanup settles.
    assert.equal(response.status(), 200, JSON.stringify(result));
    assert.equal(result.lifecycle.applied, true);
    assert.equal(result.lifecycle.resumed, false, "no restart claimed");
    assert.equal(store.publicConfig().revision, revision + 1);
    assert.equal(
      store.publicConfig().persona.name,
      "Synthetic draft after unsafe stop",
    );
    // Settings policy: Save asks no consent at all, even with Coach running.
    assert.deepEqual(dialogs, []);
    await page.waitForFunction(() =>
      document.querySelector("#notice")?.textContent?.startsWith("Saved."),
    );
    assert.doesNotMatch(
      await page.locator("#notice").innerText(),
      /restarted/,
      "never a seamless restart claim",
    );
    // The continuation's outcome and warning arrive by status polling, and
    // survive the canonical refresh.
    await page.waitForFunction(
      () =>
        document
          .querySelector("#restartStatus")
          ?.textContent?.includes("Coach restart pending"),
      undefined,
      { timeout: 15000 },
    );
    const restartText = await page.locator("#restartStatus").innerText();
    assert.match(
      restartText,
      /^Saved\. Coach restart pending; Coach is not running\./,
    );
    assert.match(restartText, /Warning: A native session could not confirm/);
    assert.doesNotMatch(restartText, /restarted with/);
    assert.equal(await page.locator("#restartRetry").isVisible(), true);
    await page.waitForResponse(
      (r) => r.url().endsWith("/api/status") && r.request().method() === "GET",
    );
    await page.waitForTimeout(100);
    assert.equal(await page.locator("#restartStatus").innerText(), restartText);
    const status = (await (
      await fetch(app.origin + "/api/status", {
        headers: { Authorization: "Bearer " + store.secrets.admin },
      })
    ).json()) as any;
    assert.equal(status.state, "stopped");
    assert.equal(status.lifecycle.restartPending, true);
    assert.deepEqual(
      status.lifecycle.warnings.map((w: any) => w.code),
      ["NATIVE_CLEANUP_UNCONFIRMED"],
    );
    assert.equal(
      await page.locator("#name").inputValue(),
      "Synthetic draft after unsafe stop",
    );
    // Retry is the explicit user action that starts the saved revision.
    await page.locator("#restartRetry").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#restartStatus")
        ?.textContent?.includes("Coach restarted with the saved configuration"),
    );
    assert.deepEqual(dialogs, [], "Retry needs no confirmation");
    const disk = new Store(home);
    await disk.init();
    assert.equal(disk.publicConfig().revision, revision + 1);
  } finally {
    NativeTerminal.prototype.stop = original;
    await browser?.close();
    await app.close();
    backend.closeAllConnections();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

test("a pending restart is rendered as saved-but-not-running, never as a restart", async () => {
  const home = await mkdtemp(tmpdir() + "/apply-restart-pending-");
  const store = new Store(home);
  await store.init();
  const app = await admin(store, 0);
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage();
    const lifecycle = {
      id: "6aca152e-e20c-4fc1-a686-2a9b97a14b5f",
      operation: "/api/config",
      phase: "complete",
      wasRunning: true,
      running: false,
      applied: true,
      resumed: false,
      rebinding: false,
      restartPending: true,
      hint: "Coach was not restarted because the previous Coach's stop or reply publication is unconfirmed.",
      warnings: [
        {
          code: "WORKER_STOP_UNCONFIRMED",
          hint: "A reply may already have been posted, and it will not be re-sent.",
        },
      ],
    };
    // Real served UI; only the operation outcome is synthetic.
    await page.route("**/api/config", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ json: { ok: true, lifecycle } })
        : route.continue(),
    );
    await page.route("**/api/status", async (route) => {
      const real = await route.fetch();
      route.fulfill({ json: { ...(await real.json()), lifecycle } });
    });
    await page.goto(
      app.origin + "/settings?section=persona#" + store.secrets.admin,
    );
    await page.locator("#studio").waitFor({ state: "visible" });
    await settingsTab(page, "Persona");
    await page.locator("#save").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#notice")
        ?.textContent?.includes("restart pending"),
    );
    const noticeText = await page.locator("#notice").innerText();
    assert.match(noticeText, /^Saved\. Check Coach status below\./);
    assert.match(noticeText, /Warning: A reply may already have been posted/);
    assert.doesNotMatch(noticeText, /Coach restarted/);
    assert.equal(
      await page.locator("#noticeBar").getAttribute("data-severity"),
      "warning",
    );
    const restartText = await page.locator("#restartStatus").innerText();
    assert.match(
      restartText,
      /^Saved\. Coach restart pending; Coach is not running\./,
    );
    assert.match(restartText, /Warning: A reply may already have been posted/);
    assert.doesNotMatch(restartText, /restarted with/);
    assert.equal(await page.locator("#restartRetry").isVisible(), true);
  } finally {
    await browser?.close();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
