import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

test("real Studio confirms save restart, cancel retains draft, and resume failure retries without resaving", async () => {
  const dir = await mkdtemp(tmpdir() + "/apply-browser-");
  let fail = false;
  const backend = createServer(async (req, res) => {
    if (fail) return void res.writeHead(503).end();
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
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(backend.address() as any).port}`,
    token: "synthetic-browser-token",
    apiKey: "synthetic-browser-provider",
  });
  const app = await admin(store, 0);
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
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
    await page.locator("#settings-persona-tab").click();
    await page.locator("#name").fill("Synthetic retained draft");
    const revision = store.publicConfig().revision;
    let dialogs = 0;
    page.once("dialog", async (d) => {
      dialogs++;
      assert.match(d.message(), /restart/i);
      await d.dismiss();
    });
    await page.locator("#save").click();
    await page.waitForFunction(() =>
      document.querySelector("#notice")?.textContent?.includes("cancelled"),
    );
    assert.equal(dialogs, 1);
    assert.equal(store.publicConfig().revision, revision);
    assert.equal(
      await page.locator("#name").inputValue(),
      "Synthetic retained draft",
    );
    page.once("dialog", (d) => d.accept());
    await page.locator("#save").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#revision")?.textContent === "Saved revision 3",
    );
    assert.equal(store.publicConfig().persona.name, "Synthetic retained draft");
    await page.locator("#name").fill("Synthetic applied but stopped");
    page.once("dialog", async (d) => {
      fail = true;
      await d.accept();
    });
    await page.locator("#save").click();
    await page.locator("#restartRetry").waitFor({ state: "visible" });
    assert.equal(store.publicConfig().revision, revision + 2);
    assert.match(
      await page.locator("#restartStatus").innerText(),
      /applied.*not running/i,
    );
    fail = false;
    await page.locator("#restartRetry").click();
    await page.locator("#restartRetry").waitFor({ state: "hidden" });
    assert.equal(
      store.publicConfig().revision,
      revision + 2,
      "Retry never saves again",
    );
    // Response loss after a real accepted write: retain the draft, reconcile the
    // operation ID via status, never POST the save again.
    let saves = 0;
    await page.route("**/api/config", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      saves++;
      await route.fetch();
      await route.abort();
    });
    await page.locator("#name").fill("Synthetic lost response");
    page.once("dialog", (d) => d.accept());
    await page.locator("#save").click();
    await page.locator("#restartCheck").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#name").inputValue(),
      "Synthetic lost response",
    );
    await page.locator("#restartCheck").click();
    await page.locator("#restartCheck").waitFor({ state: "hidden" });
    assert.equal(saves, 1);
    assert.equal(store.publicConfig().revision, revision + 3);
    await page.unroute("**/api/config");
    // Auth/session changes fence late successful responses. The server-owned
    // operation still finishes, but cannot repopulate the locked UI.
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => (entered = r)),
      gate = new Promise<void>((r) => (release = r));
    await page.route("**/api/config", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      entered();
      await gate;
      await route.fulfill({ response });
    });
    await page.locator("#name").fill("Synthetic late save");
    page.once("dialog", (d) => d.accept());
    await page.locator("#save").click();
    await started;
    await page.locator("#lockStudio").click();
    release();
    await page.waitForResponse(
      (r) => r.url().endsWith("/api/config") && r.request().method() === "POST",
    );
    assert.equal(await page.locator("#studio").isVisible(), false);
    assert.match(await page.locator("#notice").innerText(), /locked/);
    await page.unroute("**/api/config");
    await page.locator("#adminKey").fill(store.secrets.admin);
    await page.locator("#unlock").click();
    await page.locator("#studio").waitFor({ state: "visible" });
    assert.equal(store.publicConfig().revision, revision + 4);
    if (process.env.APPLY_RESTART_EVIDENCE) {
      await mkdir(process.env.APPLY_RESTART_EVIDENCE, { recursive: true });
      await page.screenshot({
        path:
          process.env.APPLY_RESTART_EVIDENCE + "/synthetic-apply-desktop.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 360, height: 800 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path:
          process.env.APPLY_RESTART_EVIDENCE + "/synthetic-apply-mobile.png",
        fullPage: true,
      });
    }
  } finally {
    await browser?.close();
    await app.close();
    backend.closeAllConnections();
    await new Promise<void>((r) => backend.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
