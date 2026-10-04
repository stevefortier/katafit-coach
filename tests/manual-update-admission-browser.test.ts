import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { Updates } from "../src/update/updates.js";
import { settingsTab } from "./helpers/settings-navigation.js";

test(
  "delayed preparation preserves pending and exposes cancellable idle-poll queue",
  { timeout: 15000 },
  async () => {
    const home = await mkdtemp(tmpdir() + "/coach-admission-browser-");
    let releasePoll: (() => void) | undefined;
    let polls = 0;
    const backend = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (!body)
        return void res.setHeader("Content-Type", "application/json").end("{}");
      const message = JSON.parse(body);
      if (message.method === "notifications/initialized")
        return void res.writeHead(202).end();
      if (message.params?.name === "coach_list_requests" && ++polls > 1)
        await new Promise<void>((r) => {
          releasePoll = r;
        });
      const result =
        message.method === "initialize"
          ? { protocolVersion: "2025-03-26" }
          : message.method === "tools/list"
            ? { tools: [] }
            : { structuredContent: { requests: [] } };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
    const store = new Store(home);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin: `http://127.0.0.1:${(backend.address() as any).port}`,
      token: "synthetic-admission-token",
      apiKey: "synthetic-key",
    });
    let releasePreparation: (() => void) | undefined;
    let preparations = 0,
      applications = 0,
      cancellations = 0;
    const updates = new Updates(
      "a".repeat(40),
      async () => {
        applications++;
      },
      async () =>
        new Response(JSON.stringify({ object: { sha: "b".repeat(40) } })),
      undefined,
      async () => {
        preparations++;
        await new Promise<void>((r) => {
          releasePreparation = r;
        });
      },
      async () => {
        cancellations++;
      },
    );
    updates.manualRestartSupported = true;
    const app = await admin(store, 0, undefined, undefined, updates);
    let browser;
    const headers = {
      Authorization: "Bearer " + store.secrets.admin,
      Origin: app.origin,
      "Content-Type": "application/json",
    };
    try {
      assert.equal(
        (
          await fetch(app.origin + "/api/run", {
            method: "POST",
            headers,
            body: "{}",
          })
        ).status,
        200,
      );
      for (let i = 0; i < 650 && !releasePoll; i++)
        await new Promise((r) => setTimeout(r, 10));
      assert.ok(releasePoll, "real worker is holding an idle poll");
      browser = await chromium.launch({
        executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
        headless: true,
        args: ["--no-sandbox"],
      });
      const page = await browser.newPage();
      // Scale only browser deadlines: real server preparation outlasts the old budget.
      await page.addInitScript(() => {
        const timeout = AbortSignal.timeout.bind(AbortSignal);
        AbortSignal.timeout = (ms) =>
          timeout(ms === 15000 ? 80 : ms === 900000 ? 3000 : ms);
      });
      await page.goto(app.origin + "/#" + store.secrets.admin);
      await page.locator("#studio").waitFor({ state: "visible" });
      await page.locator("#settingsTab").click();
      await settingsTab(page, "Updates");
      await page.waitForFunction(
        () =>
          !document.querySelector<HTMLButtonElement>("#updateApply")?.disabled,
      );
      await page.locator("#updateApply").click();
      await page.locator("#updateConfirmApply").click();
      await page.waitForTimeout(180);
      assert.equal(preparations, 1);
      await page.evaluate(() =>
        document.dispatchEvent(new Event("visibilitychange")),
      );
      await page.waitForTimeout(80);
      assert.equal(
        await page.locator("#run").isDisabled(),
        true,
        "preparation observation retains pending controls",
      );
      assert.equal(
        await page.locator("#updateConfirmApply").isDisabled(),
        true,
      );
      const response = page.waitForResponse("**/api/update/apply", {
        timeout: 3000,
      });
      releasePreparation!();
      assert.equal((await response).status(), 202);
      await page.waitForFunction(() =>
        document
          .querySelector("#updateQueueStatus")
          ?.textContent?.includes("Waiting for accepted worker work"),
      );
      const data = await (
        await fetch(app.origin + "/api/update", { headers })
      ).json();
      assert.equal(data.manualQueue.phase, "waiting-worker");
      assert.equal(data.manualQueue.persistence, "process-local");
      assert.equal(data.preparing, false);
      assert.equal(applications, 0);
      assert.equal(cancellations, 0);
      assert.equal(await page.locator("#updateApply").isDisabled(), true);
      await page.reload();
      await page.locator("#studio").waitFor({ state: "visible" });
      await page.locator("#settingsTab").click();
      await settingsTab(page, "Updates");
      await page.locator("#updateQueueCancel").waitFor({ state: "visible" });
      await page.locator("#updateQueueCancel").click();
      await page.waitForFunction(() =>
        document
          .querySelector("#updateQueueStatus")
          ?.textContent?.includes("Cancelled"),
      );
      assert.equal(cancellations, 1);
      assert.equal(applications, 0);
      assert.equal(await page.locator("#updateApply").isEnabled(), true);
    } finally {
      releasePreparation?.();
      releasePoll?.();
      await browser?.close();
      await app.close();
      backend.closeAllConnections();
      await new Promise<void>((r) => backend.close(() => r()));
      await rm(home, { recursive: true, force: true });
    }
  },
);
