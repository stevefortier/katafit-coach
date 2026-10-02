import { settingsTab } from "./helpers/settings-navigation.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

// Synthetic safe receipt DTOs; the document, assets, and admin are production.
const delivered = Array.from({ length: 4 }, () => ({ status: "delivered" }));
const mixed = [
  ...delivered,
  {
    status: "pending",
    member_ref: "synthetic-member",
    action_id: "pending-id",
  },
  {
    status: "unknown",
    tool_name: "synthetic_generic_write",
    action_id: "unknown-id",
  },
  {
    status: "completed",
    tool_name: "synthetic_generic_write",
    action_id: "completed-id",
  },
];

test(
  "served Studio keeps settled receipts in accessible collapsed delivery history",
  { timeout: 90000 },
  async () => {
    const dir = await mkdtemp(tmpdir() + "/studio-delivery-history-");
    const store = new Store(dir);
    await store.init();
    const app = await admin(store, 0);
    let browser;
    const evidence = process.env.COACH_EVIDENCE_DIR;
    let actions: {
      status: string;
      member_ref?: string;
      action_id?: string;
      tool_name?: string;
      message_id?: string;
      recipient_id?: string;
    }[] = delivered;
    let failRead = false;
    const receiptSnapshots: {
      actions: typeof actions;
      failed: boolean;
      held: boolean;
    }[] = [];
    let release: (() => void) | undefined;
    let holdRead = false;
    const errors: string[] = [];
    try {
      browser = await chromium.launch({
        executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
        headless: true,
        args: ["--no-sandbox"],
      });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/api/terminal/receipts", async (route) => {
        const snapshot = actions;
        receiptSnapshots.push({
          actions: snapshot,
          failed: failRead,
          held: holdRead,
        });
        if (holdRead)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        await route.fulfill(
          failRead
            ? { status: 503, json: { error: "synthetic unavailable" } }
            : { json: { actions: snapshot } },
        );
      });
      const capture = async (name: string) => {
        if (!evidence) return;
        await mkdir(evidence, { recursive: true });
        await page.screenshot({
          path: `${evidence}/${name}.png`,
          fullPage: true,
        });
      };
      await page.goto(app.origin + "/chat/operator");
      await page.locator("#adminKey").fill(store.secrets.admin);
      await page.locator("#unlock").click();
      await page.locator("#nativeTerminal").waitFor({ state: "visible" });
      await page.waitForFunction(
        () =>
          document
            .querySelector("#operatorActions")
            ?.textContent?.includes("Delivered") ||
          document
            .querySelector("#operatorDeliveryHistorySummary")
            ?.textContent?.includes("4"),
      );
      await capture("after-synthetic-four-delivered-1440");
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
        assert.equal(
          await page
            .locator("#operatorDeliveryHistory")
            .evaluate((el) => el.scrollWidth > el.clientWidth),
          false,
        );
        await capture(`after-synthetic-four-delivered-${width}`);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      {
        assert.equal(
          await page.locator("#operatorActions p:visible").count(),
          0,
        );
        assert.equal(
          await page.locator("#operatorDeliveryHistoryRows p:visible").count(),
          0,
        );
        assert.equal(
          await page.locator("#operatorReconcile").isVisible(),
          false,
        );
        await page.locator("#coachPaneExpand").click();
        await page.locator("#settingsTab").click();
        await settingsTab(page, "Updates");
        await capture("after-synthetic-four-delivered-docked-updates-1440");
        await page.locator("#coachPaneExpand").click();
      }
      actions = mixed;
      // Load the mixed snapshot through the actual receipt refresh.
      await page.evaluate(() => (window as any).loadNativeReceipts());
      await page.waitForFunction(() =>
        document
          .querySelector("#operatorActions")
          ?.textContent?.includes("unknown-id"),
      );
      await capture("after-synthetic-mixed-1440");
      if (evidence)
        await writeFile(
          `${evidence}/synthetic-receipts.json`,
          JSON.stringify({ delivered, mixed }, null, 2),
        );
      assert.equal(
        await page.locator("#operatorActions p").count(),
        2,
        "only pending/unknown may remain immediately visible; settled rows belong in collapsed history",
      );
      const history = page.locator("#operatorDeliveryHistory");
      const summary = page.locator("#operatorDeliveryHistorySummary");
      assert.equal(
        await history.evaluate((el) => (el as HTMLDetailsElement).open),
        false,
      );
      assert.equal(
        await page.locator("#operatorDeliveryHistoryRows p:visible").count(),
        0,
      );
      assert.match(await summary.innerText(), /Delivery history · 5/);
      assert.equal(await page.locator("#operatorReconcile").isVisible(), true);
      assert.match(
        await page.locator("#operatorActions").innerText(),
        /Pending confirmation — do not resend/,
      );
      assert.match(
        await page.locator("#operatorActions").innerText(),
        /Action outcome unknown — do not retry; backend confirmation required/,
      );
      await summary.focus();
      await page.keyboard.press("Enter");
      assert.equal(
        await page.locator("#operatorDeliveryHistoryRows p:visible").count(),
        5,
      );
      assert.match(
        await page.locator("#operatorDeliveryHistoryRows").innerText(),
        /Completed — backend receipt confirmed · synthetic_generic_write · completed-id/,
      );
      await capture("after-synthetic-history-open-1440");
      await page.evaluate(() => {
        (window as any).retainedTerminalForTest =
          document.querySelector("#nativeTerminal");
      });
      await page.locator("#coachPaneExpand").click();
      await settingsTab(page, "Persona");
      await page.locator("#name").fill("Unsaved delivery-history draft");
      await page.locator("#coachPaneCollapse").click();
      await page.locator("#diagnosticsTab").click();
      await page.locator("#coachSettingsTab").click();
      await settingsTab(page, "Persona");
      assert.equal(
        await page.locator("#name").inputValue(),
        "Unsaved delivery-history draft",
      );
      await page.locator("#coachLauncher").click();
      assert.equal(
        await history.evaluate((el) => (el as HTMLDetailsElement).open),
        true,
      );
      assert.equal(
        await page.evaluate(
          () =>
            (window as any).retainedTerminalForTest ===
            document.querySelector("#nativeTerminal"),
        ),
        true,
        "pane/navigation preserves the mounted terminal",
      );
      await page.locator("#coachPaneExpand").click();
      for (let i = 0; i < 3; i++)
        await page.evaluate(() => (window as any).loadNativeReceipts());
      await page.waitForFunction(
        () =>
          document.querySelectorAll("#operatorDeliveryHistoryRows p").length ===
          5,
      );
      assert.equal(
        await history.evaluate((el) => (el as HTMLDetailsElement).open),
        true,
      );
      assert.equal(await page.locator("#operatorActions p").count(), 2);
      actions = mixed.map((action) =>
        action.status === "pending"
          ? { ...action, status: "delivered" }
          : action,
      );
      await page.locator("#operatorReconcile").click();
      await page.waitForFunction(
        () => document.querySelectorAll("#operatorActions p").length === 1,
      );
      assert.equal(
        await page.locator("#operatorDeliveryHistoryRows p").count(),
        6,
      );
      failRead = true;
      await page.locator("#operatorReconcile").click();
      await page.waitForFunction(() =>
        document
          .querySelector("#operatorStatus")
          ?.textContent?.includes("unavailable"),
      );
      assert.equal(
        await page.locator("#operatorDeliveryHistoryRows p").count(),
        6,
        "uncertain reads retain the last snapshot",
      );
      assert.match(
        await page.locator("#operatorActions").innerText(),
        /do not retry/,
      );
      failRead = false;
      actions = [...mixed, { status: "not_found", action_id: "not-found-id" }];
      await page.locator("#operatorReconcile").click();
      await page.waitForFunction(() =>
        document
          .querySelector("#operatorDeliveryHistoryRows")
          ?.textContent?.includes("not-found-id"),
      );
      assert.match(
        await page.locator("#operatorDeliveryHistoryRows").innerText(),
        /No delivery found after session closed · not-found-id/,
      );
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
        assert.equal(
          await history.evaluate((el) => el.scrollWidth > el.clientWidth),
          false,
        );
        await capture(`after-synthetic-mixed-open-${width}`);
      }
      await summary.focus();
      await page.keyboard.press("Space");
      assert.equal(
        await history.evaluate((el) => (el as HTMLDetailsElement).open),
        false,
      );
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await capture(`after-synthetic-mixed-${width}`);
      }
      await page.reload();
      await page.locator("#studio").waitFor({ state: "visible" });
      await page.waitForFunction(
        () =>
          document.querySelectorAll("#operatorDeliveryHistoryRows p").length ===
          6,
      );
      assert.equal(
        await history.evaluate((el) => (el as HTMLDetailsElement).open),
        false,
      );
      await page.setViewportSize({ width: 1440, height: 900 });
      await summary.click();
      const metadataProbe = [
        {
          status: "delivered",
          recipient_id: "recipient-" + "r".repeat(300),
          message_id: "<synthetic-message>",
          installation_id: "PRIVATE-installation",
          origin: "PRIVATE-origin",
          account_owner_id: "PRIVATE-owner",
          payload_sha256: "PRIVATE-payload",
          idempotency_key: "PRIVATE-key",
        },
        {
          status: "unknown",
          recipient_id: "other-authority-recipient",
          installation_id: "PRIVATE-other-installation",
        },
      ];
      actions = metadataProbe;
      await page.evaluate(() => (window as any).loadNativeReceipts());
      assert.match(
        await page.locator("#operatorDeliveryHistoryRows").innerText(),
        /recipient recipient-r+ · message <synthetic-message>/,
      );
      assert.equal(
        await page
          .locator("#operatorDeliveryHistoryRows synthetic-message")
          .count(),
        0,
        "safe fields are text, never HTML",
      );
      assert.doesNotMatch((await history.textContent()) ?? "", /PRIVATE-/);
      assert.match(
        await page.locator("#operatorActions").innerText(),
        /Delivery unknown — refresh receipts before sending again · recipient other-authority-recipient/,
      );
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await history.evaluate((el) => el.scrollWidth > el.clientWidth),
          false,
        );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
      }
      actions = [];
      await page.evaluate(() => (window as any).loadNativeReceipts());
      assert.equal(await history.isVisible(), false);
      assert.equal(
        await history.evaluate((el) => (el as HTMLDetailsElement).open),
        true,
        "refreshing an empty snapshot preserves deliberate expansion until lock",
      );
      actions = metadataProbe;
      await page.evaluate(() => (window as any).loadNativeReceipts());
      await page.setViewportSize({ width: 1440, height: 900 });
      holdRead = true;
      await page.locator("#operatorReconcile").click();
      for (let i = 0; !release && i < 50; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(release);
      await page.locator("#lockStudio").click();
      assert.equal(
        await history.evaluate((el) => (el as HTMLDetailsElement).open),
        false,
      );
      assert.equal(
        await page.locator("#operatorDeliveryHistoryRows p").count(),
        0,
      );
      const lateResponse = page.waitForResponse((response) =>
        response.url().endsWith("/api/terminal/receipts"),
      );
      release();
      holdRead = false;
      await lateResponse;
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      assert.equal(
        await page.locator("#operatorDeliveryHistoryRows p").count(),
        0,
        "late receipt read cannot revive locked data",
      );
      actions = [];
      await page.locator("#adminKey").fill(store.secrets.admin);
      await page.locator("#unlock").click();
      await page.locator("#studio").waitFor({ state: "visible" });
      await page.evaluate(() => (window as any).loadNativeReceipts());
      assert.equal(await history.isVisible(), false);
      assert.equal(
        await history.evaluate((el) => el.getBoundingClientRect().height),
        0,
      );
      assert.equal(
        await page
          .locator("#operatorActions")
          .evaluate((el) => el.getBoundingClientRect().height),
        0,
      );
      assert.deepEqual(errors, []);
    } finally {
      release?.();
      await browser?.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        await writeFile(
          `${evidence}/receipt-read-snapshots.json`,
          JSON.stringify(receiptSnapshots, null, 2),
        );
      }
    }
  },
);
