import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

test(
  "served Studio has one persona-named operator panel and canonicalizes legacy member links without member reads",
  { timeout: 90000 },
  async () => {
    const dir = await mkdtemp(tmpdir() + "/operator-only-studio-");
    const store = new Store(dir);
    await store.init();
    const app = await admin(store, 0);
    let browser;
    try {
      browser = await chromium.launch({
        executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
        headless: true,
        args: ["--no-sandbox"],
      });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      });
      const memberCalls: string[] = [];
      const errors: string[] = [];
      page.on("request", (request) => {
        if (/\/api\/members(?:\/|\?|$)/.test(request.url()))
          memberCalls.push(request.url());
      });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/api/terminal/receipts", (route) =>
        route.fulfill({
          json: {
            actions: [
              {
                status: "unknown",
                tool_name: "synthetic-tool",
                action_id: "synthetic-id",
              },
            ],
          },
        }),
      );
      await page.goto(app.origin + "/chat/member/synthetic-person");
      await page.locator("#adminKey").fill(store.secrets.admin);
      await page.locator("#unlock").click();
      await page.locator("#nativeTerminal").waitFor({ state: "visible" });
      await page.waitForFunction(
        () =>
          document
            .querySelector("#operatorActions")
            ?.textContent?.includes("synthetic-tool"),
        null,
        { timeout: 3000 },
      );
      assert.equal(await page.locator("#operatorReconcile").isVisible(), true);
      await page.waitForURL("**/chat/operator");
      assert.equal(
        await page.locator("#coachTab").innerText(),
        store.publicConfig().persona.name,
      );
      assert.equal(
        await page
          .locator(
            "#operatorTab, #conversationTabs, #membersRefresh, #memberView",
          )
          .count(),
        0,
      );
      assert.deepEqual(memberCalls, []);
      await page.evaluate(() =>
        history.pushState(null, "", "/chat/member/legacy-forward"),
      );
      await page.goBack();
      await page.waitForURL("**/chat/operator");
      await page.goForward();
      await page.waitForURL("**/chat/operator");
      assert.deepEqual(
        memberCalls,
        [],
        "history navigation does not read members",
      );
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        const geometry = await page.evaluate(() => ({
          panel: document.querySelector("#coachPanel")!.getBoundingClientRect()
            .width,
          terminal: document
            .querySelector("#nativeTerminal")!
            .getBoundingClientRect().width,
          overflow: document.documentElement.scrollWidth > innerWidth,
        }));
        assert.ok(
          geometry.panel > Math.min(width * 0.7, 900) &&
            geometry.terminal > 0 &&
            !geometry.overflow,
          JSON.stringify({ width, ...geometry }),
        );
        assert.equal(
          await page
            .locator("#nativeStart, #nativeStop, #nativeHistoryToggle")
            .count(),
          3,
        );
      }
      await page.locator("#nativeHistoryToggle").click();
      assert.equal(await page.locator("#nativeHistoryPanel").isVisible(), true);
      await page.locator("#settingsTab").click();
      await page.getByRole("tab", { name: "Persona", exact: true }).click();
      await page.locator("#name").fill("Warden");
      assert.notEqual(
        await page.locator("#coachTab").innerText(),
        "Warden",
        "unsaved draft must not rename navigation",
      );
      await page.locator("#save").click();
      await page.waitForFunction(
        () =>
          document.querySelector("#coachTab")?.textContent?.trim() === "Warden",
      );
      await page.reload();
      if (await page.locator("#login").isVisible()) {
        await page.locator("#adminKey").fill(store.secrets.admin);
        await page.locator("#unlock").click();
      }
      await page.waitForFunction(
        () =>
          document.querySelector("#coachTab")?.textContent?.trim() === "Warden",
      );
      await page.locator("#coachTab").click();
      const evidence = process.env.COACH_EVIDENCE_DIR;
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate(() => scrollTo(0, 0));
          await page.screenshot({
            path: `${evidence}/synthetic-operator-only-${width}.png`,
            fullPage: true,
          });
        }
      }
      await page.locator("#settingsTab").click();
      const longName = "Persona " + "W".repeat(7990);
      await page.getByRole("tab", { name: "Persona", exact: true }).click();
      await page.locator("#name").fill(longName);
      assert.equal(await page.locator("#coachTab").innerText(), "Warden");
      await page.locator("#save").click();
      await page.waitForFunction(
        (name) => document.querySelector("#coachTab")?.textContent === name,
        longName,
      );
      await page.locator("#coachTab").click();
      await page.setViewportSize({ width: 320, height: 900 });
      assert.equal(
        await page.locator("#coachTab").getAttribute("title"),
        longName,
      );
      assert.equal(
        await page.locator("#coachTab").getAttribute("aria-pressed"),
        "true",
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await page.locator("#settingsTab").click();
      await page.getByRole("tab", { name: "Persona", exact: true }).click();
      await page.locator("#name").fill("Unsaved restoration draft");
      assert.equal(await page.locator("#coachTab").innerText(), longName);
      await page.locator("#personaHistory summary").click();
      await page.getByRole("button", { name: /Revision 2 ·/ }).click();
      page.once("dialog", (dialog) => dialog.accept());
      await page.locator("#restorePersona").click();
      await page.waitForFunction(
        () => document.querySelector("#coachTab")?.textContent === "Warden",
      );
      assert.equal(await page.locator("#name").inputValue(), "Warden");
      await page.locator("#lockStudio").click();
      assert.equal(await page.locator("#coachTab").innerText(), "Coach");
      assert.deepEqual(memberCalls, []);
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
