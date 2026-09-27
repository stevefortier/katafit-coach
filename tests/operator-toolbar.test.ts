import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

// Real served document, CSS, app, terminal.js and xterm. Only native transport
// is synthetic: this does not certify Docker/Pi or live model execution.
test(
  "compact native Operator toolbar, responsive tooltips and transport states",
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(tmpdir() + "/operator-toolbar-");
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
        viewport: { width: 1280, height: 900 },
        hasTouch: true,
      });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(app.origin);
      await page.locator("#adminKey").fill(store.secrets.admin);
      await page.locator("#unlock").click();
      await page.locator("#operatorView").waitFor({ state: "visible" });
      assert.equal(
        await page.locator("#operatorView h2").count(),
        0,
        "remove redundant Operator heading",
      );
      assert.deepEqual(
        await page
          .locator(".native-toolbar button")
          .evaluateAll((nodes) => nodes.map((n) => n.id)),
        ["nativeStart", "nativeStop", "nativeConnection", "nativeInfo"],
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Start / reconnect Pi", exact: true })
          .count(),
        1,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Stop & erase workspace", exact: true })
          .count(),
        1,
      );
      assert.equal(
        await page.locator("#nativeInfoTooltip #operatorSnapshot").count(),
        1,
      );
      await page.waitForFunction(() =>
        document
          .querySelector("#operatorSnapshot")
          ?.textContent?.includes("Saved default:"),
      );
      const savedBefore = await page.locator("#operatorSnapshot").textContent();
      await page.locator("#settingsTab").click();
      await page.getByRole("tab", { name: "Persona", exact: true }).click();
      await page.locator("#name").fill("Synthetic toolbar QA");
      await page.locator("#save").click();
      await page.waitForFunction(() =>
        document.querySelector("#notice")?.textContent?.startsWith("Saved."),
      );
      await page.locator("#coachTab").click();
      await page.waitForFunction(
        (before) =>
          document.querySelector("#operatorSnapshot")?.textContent !== before,
        savedBefore,
      );
      assert.match(
        (await page.locator("#operatorSnapshot").textContent())!,
        new RegExp(`revision ${store.publicConfig().revision}`),
      );
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        const layout = await page.locator(".native-toolbar").evaluate((row) => {
          const boxes = [...row.querySelectorAll("button")].map((b) =>
            b.getBoundingClientRect(),
          );
          return {
            tops: boxes.map((b) => b.top),
            right: boxes.at(-1)!.right,
            left: boxes[0].left,
            overflow: document.documentElement.scrollWidth > innerWidth,
            gap:
              document.querySelector("#nativeTerminal")!.getBoundingClientRect()
                .top - row.getBoundingClientRect().bottom,
          };
        });
        assert.equal(new Set(layout.tops).size, 1, JSON.stringify(layout));
        const startButton = page.locator("#nativeStart");
        assert.ok(
          (await startButton.getAttribute("aria-label"))!.includes(
            (await startButton.innerText()).trim(),
          ),
          "accessible name contains compact visible label",
        );
        assert.ok(
          !layout.overflow &&
            layout.left >= 0 &&
            layout.right <= width &&
            layout.gap <= 12,
          JSON.stringify(layout),
        );
        assert.doesNotMatch(
          await page.locator("#operatorView").innerText(),
          /Isolated Pi|Saved default|Connected · ephemeral/,
        );
      }
      const info = page.locator("#nativeInfo");
      const infoTip = page.locator("#nativeInfoTooltip");
      await info.hover();
      assert.equal(
        await infoTip.isVisible(),
        true,
        "hover reveals information",
      );
      await page.keyboard.press("Escape");
      assert.equal(await infoTip.isVisible(), false);
      await page.mouse.move(0, 0);
      await info.focus();
      assert.equal(
        await infoTip.isVisible(),
        true,
        "focus reveals information",
      );
      await page.keyboard.press("Escape");
      await info.tap();
      assert.equal(await infoTip.isVisible(), true, "touch toggles open");
      await info.tap();
      assert.equal(
        await infoTip.isVisible(),
        false,
        "touch toggles closed even while focused",
      );
      await page.keyboard.press("Enter");
      assert.equal(await infoTip.isVisible(), true);
      await page.keyboard.press("Tab");
      assert.equal(
        await infoTip.isVisible(),
        false,
        "keyboard-pinned tooltip closes on focus departure",
      );
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await info.tap();
        const box = (await infoTip.boundingBox())!;
        assert.ok(
          box.x >= 0 &&
            box.x + box.width <= width &&
            box.y >= 0 &&
            box.y + box.height <= 900,
        );
        assert.match(
          await infoTip.innerText(),
          /No private Pi transcript is saved.*\/model.*\/mcp/s,
        );
        await page.keyboard.press("Escape");
      }
      await info.tap();
      await page.locator("#nativeTerminal").click();
      assert.equal(
        await infoTip.isVisible(),
        false,
        "outside click closes info",
      );
      const connection = page.locator("#nativeConnection");
      const connectionTip = page.locator("#nativeConnectionTooltip");
      await connection.hover();
      assert.equal(await connectionTip.isVisible(), true);
      await page.keyboard.press("Escape");
      assert.equal(await connectionTip.isVisible(), false);
      await page.mouse.move(0, 0);
      await connection.focus();
      assert.equal(await connectionTip.isVisible(), true);
      await page.keyboard.press("Escape");
      assert.equal(await connectionTip.isVisible(), false);
      // Exercise the real terminal lifecycle with only its transport replaced.
      await page.evaluate(() => {
        const w = window as any;
        w.sockets = [];
        w.WebSocket = class {
          static OPEN = 1;
          readyState = 1;
          bufferedAmount = 0;
          sent: string[] = [];
          onmessage?: (e: any) => void;
          onclose?: (e: { code: number }) => void;
          onerror?: () => void;
          constructor() {
            w.sockets.push(this);
          }
          send(data: string) {
            this.sent.push(data);
          }
          close() {
            this.readyState = 3;
            this.onclose?.({ code: 1000 });
          }
        };
      });
      let ticketFail = false;
      let stopFail = false;
      let releaseStop: (() => void) | undefined;
      await page.route("**/api/terminal/ticket", (route) =>
        route.fulfill({
          status: ticketFail ? 503 : 200,
          json: ticketFail
            ? { error: "unavailable" }
            : { ticket: "synthetic", path: "/synthetic-terminal" },
        }),
      );
      await page.route("**/api/terminal/stop", async (route) => {
        await new Promise<void>((resolve) => {
          releaseStop = resolve;
        });
        await route.fulfill({
          status: stopFail ? 503 : 200,
          json: stopFail ? { error: "stop unconfirmed" } : {},
        });
      });
      const state = async (name: string, detail: RegExp) => {
        await page.waitForFunction(
          (name) =>
            document.querySelector<HTMLElement>("#nativeConnection")?.dataset
              .state === name,
          name,
        );
        assert.match(
          (await page.locator("#nativeStatus").textContent())!,
          detail,
        );
        assert.match(
          (await page.locator("#nativeConnectionTooltip").textContent())!,
          detail,
        );
        assert.match(
          (await page.locator("#nativeConnection").getAttribute("aria-label"))!,
          new RegExp(name.replace("-", " "), "i"),
        );
        assert.equal(
          await page.locator("#nativeStatus").getAttribute("aria-live"),
          "polite",
        );
        return page
          .locator("#nativeConnection")
          .evaluate((el) => getComputedStyle(el).color);
      };
      const emit = (message: object) =>
        page.evaluate(
          (message) =>
            (window as any).sockets
              .at(-1)
              .onmessage({ data: JSON.stringify(message) }),
          message,
        );
      const start = async () => {
        const count = await page.evaluate(() => (window as any).sockets.length);
        await page.locator("#nativeStart").click();
        await state("starting", /Starting isolated/);
        await page.waitForFunction(
          (count) => (window as any).sockets.length > count,
          count,
        );
      };
      await state("stopped", /Stopped/);
      await page.evaluate("native.reset()");
      assert.equal(
        await page.locator("#nativeConnection").getAttribute("data-state"),
        "stopped",
        "idle reset preserves stopped state",
      );
      await start();
      await emit({ type: "ready" });
      const green = await state("connected", /Connected/);
      assert.doesNotMatch(
        (await page.locator("#nativeConnectionTooltip").textContent())!,
        /ephemeral|\/model|\/mcp/,
        "connection tooltip does not repeat the removed workspace/command suffix",
      );
      await emit({
        type: "output",
        data: "Synthetic transport fixture — not a live Pi session\r\n",
      });
      assert.equal(await page.locator(".xterm").count(), 1);
      assert.equal(await page.locator("#nativeStart").isEnabled(), true);
      const evidence = process.env.COACH_EVIDENCE_DIR;
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        for (const width of [320, 390, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          await page.mouse.move(0, 0);
          await page.screenshot({
            path: `${evidence}/toolbar-${width}.png`,
            fullPage: true,
          });
          await page.locator("#operatorView").screenshot({
            path: `${evidence}/toolbar-compact-${width}.png`,
          });
          assert.equal(
            await page
              .locator("#operatorView")
              .evaluate(
                (view) =>
                  document
                    .querySelector("#nativeTerminal")!
                    .getBoundingClientRect().top -
                  view.getBoundingClientRect().top,
              ),
            56,
          );
          await info.tap();
          await page.screenshot({
            path: `${evidence}/toolbar-info-${width}.png`,
            fullPage: true,
          });
          await page.keyboard.press("Escape");
          await page.locator("#nativeConnection").tap();
          await page.screenshot({
            path: `${evidence}/toolbar-status-${width}.png`,
            fullPage: true,
          });
          await page.keyboard.press("Escape");
        }
      }
      await emit({ type: "error", message: "Synthetic server error" });
      assert.notEqual(await state("error", /Synthetic server error/), green);
      await page.evaluate(() => (window as any).sockets.at(-1).onerror());
      await state("error", /connection failed/);
      await page.evaluate(() => (window as any).sockets.at(-1).close());
      await state("error", /connection failed/);
      await start();
      await emit({ type: "ready" });
      await page.evaluate(() => (window as any).sockets.at(-1).close());
      assert.notEqual(
        await state("disconnected", /30 seconds.*No input is replayed/),
        green,
      );
      await page.evaluate("native.reset()");
      assert.doesNotMatch(
        (await page.locator("#nativeStatus").textContent())!,
        /30 seconds/,
      );
      await start();
      await emit({ type: "ready" });
      await page.evaluate("native.reset()");
      assert.notEqual(
        await state("disconnected", /Disconnected/),
        green,
        "reset must never leave stale green",
      );
      await emit({ type: "ready" });
      await state("disconnected", /Disconnected/);
      ticketFail = true;
      await page.locator("#nativeStart").click();
      assert.notEqual(
        await state("unavailable", /Docker.*pinned sandbox/),
        green,
      );
      ticketFail = false;
      await start();
      await emit({ type: "ready" });
      await emit({ type: "output", data: "x".repeat(256 * 1024 + 1) });
      await state("overflow", /overflow.*never replayed/);
      await page.evaluate(() =>
        (window as any).sockets.at(-1).onclose({ code: 1000 }),
      );
      await state("overflow", /overflow.*never replayed/);
      for (const fail of [false, true]) {
        stopFail = fail;
        releaseStop = undefined;
        await page.locator("#nativeStop").click();
        assert.notEqual(await state("stopping", /Stopping/), green);
        while (!releaseStop)
          await new Promise((resolve) => setTimeout(resolve, 10));
        (releaseStop as () => void)();
        await state(
          fail ? "stop-unconfirmed" : "stopped",
          fail
            ? /Stop unconfirmed.*possibly committed/
            : /workspace erased.*not undone/,
        );
      }
      await page.evaluate("native.reset()");
      await state("stop-unconfirmed", /Stop unconfirmed.*possibly committed/);
      await start();
      await emit({ type: "ready" });
      await page.unroute("**/api/terminal/stop");
      await page.route("**/api/terminal/stop", (route) =>
        route.fulfill({ json: {} }),
      );
      await page.locator("#lockStudio").click();
      await page.locator("#login").waitFor({ state: "visible" });
      await state("disconnected", /Disconnected/);
      assert.doesNotMatch(
        (await page.locator("#nativeStatus").textContent())!,
        /30 seconds/,
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
