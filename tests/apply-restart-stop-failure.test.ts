import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { NativeTerminal } from "../src/server/terminal.js";

test("native teardown failure preserves actual running status and the unsaved Studio draft", async () => {
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
    await page.locator("#settings-persona-tab").click();
    await page.locator("#name").fill("Synthetic draft after unsafe stop");
    const revision = store.publicConfig().revision;
    NativeTerminal.prototype.stop = () =>
      Promise.reject(new Error("synthetic native cleanup failure"));
    page.once("dialog", (dialog) => dialog.accept());
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/config") &&
        response.request().method() === "POST",
    );
    await page.locator("#save").click();
    const response = await responsePromise;
    const result = await response.json();
    const status = (await (
      await fetch(app.origin + "/api/status", {
        headers: { Authorization: "Bearer " + store.secrets.admin },
      })
    ).json()) as any;
    assert.equal(response.status(), 400);
    assert.notEqual(status.state, "stopped");
    assert.equal(
      result.lifecycle.running,
      true,
      "teardown failure did not stop the original worker",
    );
    assert.equal(
      result.lifecycle.resumed,
      false,
      "the worker was never restarted",
    );
    assert.equal(result.lifecycle.applied, false);
    assert.equal(store.publicConfig().revision, revision);
    await page.waitForFunction(() =>
      document
        .querySelector("#restartStatus")
        ?.textContent?.includes("still running"),
    );
    assert.doesNotMatch(
      await page.locator("#restartStatus").innerText(),
      /not running|restarted/,
    );
    assert.equal(await page.locator("#restartRetry").isVisible(), false);
    assert.equal(
      await page.locator("#name").inputValue(),
      "Synthetic draft after unsafe stop",
    );
    const disk = new Store(home);
    await disk.init();
    assert.equal(disk.publicConfig().revision, revision);
  } finally {
    NativeTerminal.prototype.stop = original;
    await browser?.close();
    await app.close();
    backend.closeAllConnections();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
