import { settingsTab } from "./helpers/settings-navigation.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium, type Page, type WebSocketRoute } from "playwright-core";
import sharp from "sharp";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { attachmentHarness } from "./helpers/attachments.js";

// Real served Studio and real xterm; only the Pi ticket/socket and the
// attachment bytes are synthetic.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const session = "a".repeat(32);
const attachment = {
  id: "at_" + "b".repeat(32),
  filename: "synthetic-chart.png",
  caption: "Synthetic chart",
  preview: "image",
  mime_type: "image/png",
  byte_count: png.length,
  sha256: createHash("sha256").update(png).digest("hex"),
};
const evidence = process.env.COACH_PANE_EVIDENCE_DIR;

async function harness(viewport = { width: 1440, height: 900 }) {
  const dir = await mkdtemp(tmpdir() + "/coach-pane-");
  const store = new Store(dir);
  await store.init();
  const app = await admin(store, 0);
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    headless: true,
    // Keep native tracks visible in evidence instead of Chromium's headless
    // default --hide-scrollbars; ownership must be visible as well as measured.
    ignoreDefaultArgs: ["--hide-scrollbars"],
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport });
  const counts = { tickets: 0, sockets: 0, stops: 0, logs: 0, members: 0 };
  const inputs: string[] = [];
  const resizes: { cols: number; rows: number }[] = [];
  const errors: string[] = [];
  let server: WebSocketRoute | undefined;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/terminal/stop") counts.stops++;
    if (path === "/api/logs") counts.logs++;
    // Member data: legacy member reads and the Dojo dashboard's reads.
    if (/^\/api\/(?:members|dashboard)(?:\/|$)/.test(path)) counts.members++;
  });
  await page.route("**/api/terminal/ticket", (route) => {
    counts.tickets++;
    return route.fulfill({ json: { path: "/synthetic-pi", ticket: "t" } });
  });
  await page.route("**/api/terminal/attachments/**", (route) =>
    route.fulfill({
      status: 200,
      body: png,
      headers: { "content-type": "image/png" },
    }),
  );
  await page.routeWebSocket("**/synthetic-pi", (ws) => {
    counts.sockets++;
    server = ws;
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.ticket) {
        ws.send(JSON.stringify({ type: "ready" }));
        ws.send(
          JSON.stringify({
            type: "attachments",
            session,
            items: [attachment],
            context_expires_in_ms: null,
          }),
        );
      } else if (message.type === "input") {
        inputs.push(message.data);
        // A PTY echoes typed input; the draft lives in Pi, not the browser.
        ws.send(JSON.stringify({ type: "output", data: message.data }));
      } else if (message.type === "resize")
        resizes.push({ cols: message.cols, rows: message.rows });
    });
  });
  const output = (data: string) =>
    server!.send(JSON.stringify({ type: "output", data }));
  // An abnormal loss (not a Stop): the client would normally retry.
  const dropFromServer = () => server!.close({ code: 4001, reason: "lost" });
  const stopFromServer = () =>
    server!.close({ code: 1008, reason: "Session stopped" });
  async function unlock(path: string) {
    await page.goto(app.origin + path);
    await page.locator("#adminKey").fill(store.secrets.admin);
    await page.locator("#unlock").click();
    await page.locator("#studio").waitFor({ state: "visible" });
  }
  async function close() {
    await browser.close().catch(() => {});
    await app.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
  return {
    store,
    app,
    page,
    counts,
    inputs,
    resizes,
    errors,
    output,
    stopFromServer,
    dropFromServer,
    unlock,
    close,
  };
}

const connected = (page: Page) =>
  page.waitForFunction(() =>
    document
      .querySelector("#nativeStatus")
      ?.textContent?.startsWith("Connected"),
  );
const paneMode = (page: Page) =>
  page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>("#coachPane");
    return !pane || pane.hidden ? "closed" : pane.dataset.mode;
  });
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
const primaryNav = (page: Page) =>
  page
    .locator(".studio-tabs button")
    .evaluateAll((buttons) =>
      buttons.map((button) => (button as HTMLElement).innerText.trim()),
    );
async function shot(page: Page, name: string) {
  if (!evidence) return;
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/${name}.png` });
}

test(
  "workspace and Coach own independent wheel scroll regions without a root scrollbar",
  { timeout: 60000 },
  async () => {
    const h = await harness({ width: 1440, height: 700 });
    try {
      const { page } = h;
      await h.unlock("/settings?section=persona");
      await page.locator("#name").fill("Synthetic retained draft");
      // Tall synthetic content exercises ownership, not production records.
      await page.locator("#settingsPanel").evaluate((panel) => {
        const fixture = document.createElement("div");
        fixture.setAttribute("aria-label", "Synthetic scroll fixture");
        for (let i = 1; i <= 60; i++) {
          const row = document.createElement("p");
          row.textContent = `Synthetic workspace row ${i} — local scroll-ownership evidence, not production data.`;
          row.style.padding = "16px";
          row.style.borderBottom = "1px solid #303030";
          fixture.append(row);
        }
        panel.append(fixture);
      });
      await page.evaluate(() => scrollTo(0, 800));
      await page.locator("#coachLauncher").click();
      await connected(page);
      assert.equal(
        await page.locator("#workspaceScroll").getAttribute("tabindex"),
        "0",
        "docked workspace is keyboard scrollable",
      );
      const geometry = await page.evaluate(() => {
        const workspace = document.querySelector("#workspaceScroll")!;
        const pane = document.querySelector("#coachPane")!;
        return {
          rootHeight: document.documentElement.scrollHeight,
          height: innerHeight,
          workspaceRight: workspace?.getBoundingClientRect().right,
          paneLeft: pane.getBoundingClientRect().left,
          scroll: workspace?.scrollTop,
        };
      });
      assert.equal(
        geometry.rootHeight,
        geometry.height,
        "no document scrollbar while docked",
      );
      assert.equal(
        geometry.workspaceRight,
        geometry.paneLeft,
        "left scroll track is at divider",
      );
      assert.equal(
        geometry.scroll,
        800,
        "document offset transfers to workspace",
      );
      const positions = () =>
        page.evaluate(() => ({
          root: scrollY,
          left: document.querySelector("#workspaceScroll")!.scrollTop,
          right: document.querySelector(".xterm-viewport")!.scrollTop,
        }));
      for (let i = 1; i <= 120; i++) h.output(`synthetic-history-${i}\r\n`);
      await page.waitForFunction(() =>
        document
          .querySelector("#nativeTerminal")
          ?.textContent?.includes("synthetic-history-120"),
      );
      await page.waitForTimeout(250);
      let before = await positions();
      await page.locator("#workspaceScroll").focus();
      await page.keyboard.press("PageDown");
      await page.waitForTimeout(250);
      let after = await positions();
      assert.ok(after.left > before.left, "keyboard scrolls focused workspace");
      assert.equal(after.right, before.right);
      assert.equal(after.root, 0);
      before = after;
      await page.mouse.move(200, 500);
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(250);
      after = await positions();
      assert.ok(after.left > before.left, "left wheel scrolls workspace");
      assert.equal(
        after.right,
        before.right,
        "left wheel does not scroll Coach",
      );
      assert.equal(after.root, 0);
      before = after;
      await page.locator("#nativeTerminal .xterm-screen").hover();
      await page.mouse.wheel(0, -1000);
      await page.waitForTimeout(250);
      after = await positions();
      assert.ok(
        after.right < before.right,
        "right wheel scrolls real xterm history",
      );
      assert.equal(
        after.left,
        before.left,
        "right wheel does not scroll workspace",
      );
      assert.equal(after.root, 0);
      await page.locator("#workspaceScroll").evaluate((owner) => {
        owner.scrollTop = owner.scrollHeight;
      });
      before = await positions();
      await page.mouse.move(200, 500);
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(150);
      after = await positions();
      assert.deepEqual(
        after,
        before,
        "left wheel at bottom cannot chain into root or Coach",
      );
      await page
        .locator("#workspaceScroll")
        .evaluate((owner) => (owner.scrollTop = 1200));
      await page.locator("#nativeTerminal .xterm-screen").hover();
      await page.mouse.wheel(0, -10000);
      await page.waitForTimeout(250);
      before = await positions();
      assert.equal(before.right, 0, "real terminal is at its history boundary");
      await page.mouse.wheel(0, -400);
      await page.waitForTimeout(150);
      assert.deepEqual(
        await positions(),
        before,
        "right wheel at top cannot chain into workspace or root",
      );
      after = await positions();
      await page.evaluate(() => {
        // Render a labeled synthetic notice through the real shared surface.
        const bar = document.querySelector<HTMLElement>("#noticeBar")!;
        bar.dataset.severity = "info";
        document.querySelector("#notice")!.textContent =
          "Synthetic scroll-ownership verification — local fixture only.";
      });
      await page.waitForTimeout(100);
      const chrome = await page.evaluate(() => {
        const header = document
          .querySelector("header")!
          .getBoundingClientRect();
        const notice = document
          .querySelector("#noticeBar")!
          .getBoundingClientRect();
        return {
          headerTop: header.top,
          headerBottom: header.bottom,
          noticeTop: notice.top,
          noticeBottom: notice.bottom,
        };
      });
      assert.equal(chrome.headerTop, 0, "workspace header remains sticky");
      assert.ok(
        chrome.noticeTop < chrome.headerBottom &&
          chrome.noticeBottom <= chrome.headerBottom,
        "notice sticks beneath header",
      );
      await page
        .locator("#workspaceScroll")
        .evaluate((owner) => (owner as HTMLElement).blur());
      await shot(page, "independent-scroll-docked-1440-synthetic");
      const offset = after.left;
      await page.locator("#coachPaneExpand").click();
      await page.locator("#coachPaneExpand").click();
      assert.equal(
        (await positions()).left,
        offset,
        "expand/restore preserves workspace offset",
      );
      await page.locator("#workspaceScroll").focus();
      for (const width of [1000, 390, 1440]) {
        await page.setViewportSize({ width, height: 700 });
        await page.waitForTimeout(150);
        if (width === 390) {
          assert.equal(
            await page.locator("#workspaceScroll").getAttribute("tabindex"),
            null,
          );
          assert.equal(
            await page
              .locator("#workspaceScroll")
              .evaluate((owner) => (owner as HTMLElement).inert),
            true,
          );
          assert.equal(
            await page
              .locator("#coachPaneBack")
              .evaluate((button) => button === document.activeElement),
            true,
            "newly covered scroll-region focus moves into Coach",
          );
          await shot(page, "independent-scroll-mobile-390-synthetic");
        }
      }
      assert.equal(
        (await positions()).left,
        offset,
        "resize and mobile round trip preserves workspace offset",
      );
      await page.locator("#coachPaneCollapse").click();
      assert.equal(
        await page.evaluate(() => scrollY),
        offset,
        "collapse restores document scrolling",
      );
      await page.mouse.move(200, 500);
      await page.mouse.wheel(0, 200);
      await page.waitForTimeout(250);
      assert.ok(
        (await page.evaluate(() => scrollY)) > offset,
        "collapsed page scrolls normally",
      );
      const collapsedOffset = await page.evaluate(() => scrollY);
      // Coordinate click the already-visible sticky launcher. Playwright's
      // locator click may scroll it before pointerdown, changing the very
      // document offset this ownership regression is meant to preserve.
      const launcherBox = (await page.locator("#coachLauncher").boundingBox())!;
      await page.mouse.click(
        launcherBox.x + launcherBox.width / 2,
        launcherBox.y + launcherBox.height / 2,
      );
      assert.equal(
        (await positions()).left,
        collapsedOffset,
        "reopen transfers current document offset",
      );
      assert.equal(
        await page.locator("#name").inputValue(),
        "Synthetic retained draft",
      );
      assert.equal(h.counts.tickets, 1);
      assert.equal(h.counts.sockets, 1);
      assert.deepEqual(h.errors, []);
    } finally {
      await h.close();
    }
  },
);

test(
  "short dock and mobile keep Coach overflow inside its own accessible viewport",
  { timeout: 60000 },
  async () => {
    const h = await harness({ width: 1440, height: 260 });
    try {
      const { page } = h;
      await h.unlock("/settings?section=persona");
      await page.locator("#coachLauncher").click();
      await connected(page);
      for (const viewport of [
        { width: 1440, height: 260 },
        { width: 390, height: 568 },
        { width: 320, height: 568 },
      ]) {
        await page.setViewportSize(viewport);
        await page.waitForTimeout(200);
        const geometry = await page.evaluate(() => {
          const panel = document.querySelector("#coachPanel")!;
          const pane = document
            .querySelector("#coachPane")!
            .getBoundingClientRect();
          const terminal = document
            .querySelector("#nativeTerminal")!
            .getBoundingClientRect();
          const attachments = document
            .querySelector("#nativeAttachments")!
            .getBoundingClientRect();
          return {
            rootHeight: document.documentElement.scrollHeight,
            rootWidth: document.documentElement.scrollWidth,
            height: innerHeight,
            width: innerWidth,
            paneBottom: pane.bottom,
            panelBottom: panel.getBoundingClientRect().bottom,
            overflow: getComputedStyle(panel).overflowY,
            overlap: terminal.bottom > attachments.top,
          };
        });
        assert.equal(geometry.rootHeight, geometry.height);
        assert.equal(geometry.rootWidth, geometry.width);
        assert.equal(geometry.paneBottom, geometry.height);
        assert.ok(geometry.panelBottom <= geometry.height);
        assert.equal(geometry.overflow, "auto");
        assert.equal(
          geometry.overlap,
          false,
          "attachments remain below terminal",
        );
        const download = page
          .locator("#nativeAttachmentList")
          .getByRole("button", { name: "Download", exact: true });
        await download.scrollIntoViewIfNeeded();
        await download.focus();
        const downloadBox = (await download.boundingBox())!;
        assert.ok(
          downloadBox.y >= 0 &&
            downloadBox.y + downloadBox.height <= viewport.height,
          "attachment action remains visibly reachable even in a short pane",
        );
        assert.equal(await page.evaluate(() => scrollY), 0);
        await shot(
          page,
          `scroll-contained-${viewport.width}x${viewport.height}-synthetic`,
        );
      }
      assert.equal(h.counts.tickets, 1);
      assert.equal(h.counts.sockets, 1);
      assert.deepEqual(h.errors, []);
    } finally {
      await h.close();
    }
  },
);

test(
  "reloading an expanded Coach pane never reads the covered Dojo",
  { timeout: 60000 },
  async () => {
    const h = await harness();
    try {
      await h.unlock("/chat/operator");
      await connected(h.page);
      assert.equal(h.counts.members, 0);
      await h.page.reload();
      await h.page.locator("#studio").waitFor({ state: "visible" });
      await connected(h.page);
      await h.page.waitForTimeout(500);
      assert.equal(await paneMode(h.page), "expanded");
      assert.equal(h.counts.members, 0, "reload must not read a covered page");
      assert.deepEqual(h.errors, []);
    } finally {
      await h.close();
    }
  },
);

test(
  "pane fits retain history without pinning its reader to the prompt",
  { timeout: 60000 },
  async () => {
    const h = await harness();
    try {
      const { page } = h;
      await (
        await page.context().newCDPSession(page)
      ).send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await h.unlock("/");
      await page.evaluate(() => {
        const Base = (window as any).Terminal;
        (window as any).Terminal = class extends Base {
          constructor(options: any) {
            super(options);
            (window as any).__scrollTestTerminal = this;
          }
        };
      });
      await page.locator("#coachLauncher").click();
      await connected(page);
      for (let i = 1; i <= 80; i++) h.output(`history-${i}\r\n`);
      await page.waitForFunction(() =>
        document
          .querySelector("#nativeTerminal")
          ?.textContent?.includes("history-80"),
      );
      await page.locator("#nativeTerminal .xterm-screen").hover();
      await page.mouse.wheel(0, -2000);
      await page.waitForFunction(() => {
        const terminal = (window as any).__scrollTestTerminal;
        return (
          terminal.buffer.active.viewportY === 0 &&
          document.querySelector("#nativeTerminal .xterm-viewport")
            ?.scrollTop === 0
        );
      });
      await page.locator("#coachPaneExpand").click();
      await page.locator("#coachPaneExpand").click();
      await page.locator("#coachPaneCollapse").click();
      await page.locator("#coachLauncher").click();
      await page.setViewportSize({ width: 390, height: 900 });
      await page.waitForTimeout(150);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(2000);
      assert.ok(
        await page.evaluate(() => {
          const buffer = (window as any).__scrollTestTerminal.buffer.active;
          return buffer.viewportY < buffer.baseY;
        }),
        "fits must not drag a reader back to the prompt",
      );
      assert.deepEqual(
        await page.evaluate(() => {
          const buffer = (window as any).__scrollTestTerminal.buffer.active;
          return Array.from({ length: buffer.length }, (_, i) =>
            buffer.getLine(i).translateToString(true),
          ).filter(Boolean);
        }),
        Array.from({ length: 80 }, (_, i) => `history-${i + 1}`),
        "all ordered history survives xterm's native reflow",
      );
      assert.equal(h.counts.tickets, 1);
      assert.equal(h.counts.sockets, 1);
      assert.deepEqual(h.errors, []);
    } finally {
      await h.close();
    }
  },
);

test(
  "Dojo is the default view and the persona-named header launcher starts Pi lazily",
  { timeout: 60000 },
  async () => {
    const h = await harness();
    try {
      await h.unlock("/");
      const { page } = h;
      assert.equal(await page.locator("#coachTab").count(), 0);
      assert.deepEqual(await primaryNav(page), [
        "Dojo",
        "Activity",
        "Server Settings",
        "Coach Settings",
      ]);
      assert.equal(
        await page.locator("#dashboardTab").getAttribute("aria-pressed"),
        "true",
      );
      assert.equal(await page.locator("#dashboardPanel").isVisible(), true);
      const launcher = page.locator("header #coachLauncher");
      assert.equal(await launcher.isVisible(), true);
      assert.equal(
        await page.locator("#coachLauncherName").innerText(),
        h.store.publicConfig().persona.name,
      );
      assert.equal(await launcher.getAttribute("aria-expanded"), "false");
      await page.locator("#settingsTab").click();
      await page.locator("#diagnosticsTab").click();
      await page.waitForTimeout(600);
      assert.equal(h.counts.tickets, 0, "unlock and navigation never start Pi");
      assert.equal(await paneMode(page), "closed");
      await launcher.click();
      await connected(page);
      assert.equal(await paneMode(page), "docked");
      assert.equal(await launcher.getAttribute("aria-expanded"), "true");
      assert.equal(
        await page.locator("#coachPaneName").innerText(),
        h.store.publicConfig().persona.name,
      );
      assert.match(
        await page.locator("#coachPaneStatus").innerText(),
        /connected/i,
      );
      assert.notEqual(
        await page.locator("#coachPaneStatus").innerText(),
        await page.locator("#state").innerText(),
        "native session status is not the worker pill",
      );
      assert.equal(h.counts.tickets, 1);
      assert.equal(new URL(page.url()).pathname, "/diagnostics");
      assert.deepEqual(h.errors, []);
    } finally {
      await h.close();
    }
  },
);

test(
  "one terminal, socket and ticket survive navigation, collapse, expansion and viewport changes",
  { timeout: 90000 },
  async () => {
    const h = await harness();
    try {
      const { page } = h;
      // Slow rendering exposes asynchronous xterm viewport resync after fits.
      const rendering = await page.context().newCDPSession(page);
      await rendering.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await h.unlock("/");
      await page.locator("#coachLauncher").click();
      await connected(page);
      const preview = page.locator(
        "#nativeAttachmentList .attachment-preview img",
      );
      await page.waitForFunction(() =>
        document
          .querySelector("#nativeAttachmentList .attachment-preview img")
          ?.getAttribute("src")
          ?.startsWith("blob:"),
      );
      const blob = await preview.getAttribute("src");
      for (let i = 1; i <= 80; i++)
        h.output(`scrollback-line-${String(i).padStart(2, "0")}\r\n`);
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type("unsent-draft");
      await page.waitForFunction(() =>
        document
          .querySelector("#nativeTerminal")
          ?.textContent?.includes("unsent-draft"),
      );
      await page.evaluate(() => {
        (window as any).__xterm = document.querySelector(
          "#nativeTerminal .xterm",
        );
      });
      const inputsBefore = h.inputs.length;
      const same = () =>
        page.evaluate(
          () =>
            document.querySelectorAll(".xterm").length === 1 &&
            document.querySelector("#nativeTerminal .xterm") ===
              (window as any).__xterm,
        );
      for (const tab of [
        "#settingsTab",
        "#coachSettingsTab",
        "#diagnosticsTab",
        "#dashboardTab",
      ]) {
        await page.locator(tab).click();
        assert.equal(await paneMode(page), "docked", tab);
        assert.equal(await same(), true, tab);
      }
      await page.locator("#coachPaneCollapse").click();
      assert.equal(await paneMode(page), "closed");
      assert.equal(await same(), true, "collapse keeps the terminal");
      await page.locator("#coachLauncher").click();
      assert.equal(await paneMode(page), "docked");
      await page.locator("#coachPaneExpand").click();
      assert.equal(await paneMode(page), "expanded");
      await page.locator("#coachPaneExpand").click();
      assert.equal(await paneMode(page), "docked");
      // Page focus that becomes covered moves into the pane, not <body>.
      await page.locator("#dashboardTab").focus();
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(150);
        if (width === 390)
          assert.ok(
            await page
              .locator("#coachPaneBack")
              .evaluate((el) => el === document.activeElement),
            "focus follows the full-screen pane",
          );
        assert.equal(
          await paneMode(page),
          width < 900 ? "mobile" : "docked",
          String(width),
        );
        assert.equal(await same(), true, String(width));
      }
      await page.waitForTimeout(2000);
      assert.equal(h.counts.tickets, 1, "one ticket");
      assert.equal(h.counts.sockets, 1, "one socket");
      assert.equal(h.counts.stops, 0, "never stopped");
      assert.equal(
        h.inputs.length,
        inputsBefore,
        "no screen data forwarded automatically",
      );
      assert.ok(
        h.resizes.every(({ cols, rows }) => cols > 1 && rows > 1),
        JSON.stringify(h.resizes),
      );
      assert.equal(await preview.getAttribute("src"), blob, "attachment kept");
      assert.match(
        await page.locator("#nativeTerminal").innerText(),
        /unsent-draft/,
      );
      await page.locator("#nativeTerminal .xterm-viewport").evaluate((el) => {
        el.scrollTop = 0;
        el.dispatchEvent(new Event("scroll"));
      });
      await page.waitForFunction(() =>
        document
          .querySelector("#nativeTerminal")
          ?.textContent?.includes("scrollback-line-01"),
      );
      assert.equal(
        await page.locator("#nativeStatus").innerText(),
        "Connected to isolated Pi.",
      );
      assert.deepEqual(h.errors, []);
    } finally {
      await h.close();
    }
  },
);

test(
  "collapsed pane shows a subtle new-output cue and an explicit Stop never restarts from navigation",
  { timeout: 60000 },
  async () => {
    const h = await harness();
    try {
      const { page } = h;
      await h.unlock("/");
      const launcher = page.locator("#coachLauncher");
      await launcher.click();
      await connected(page);
      h.output("while-open\r\n");
      await page.waitForTimeout(200);
      assert.equal(await launcher.getAttribute("data-new-output"), null);
      await page.locator("#coachPaneCollapse").click();
      assert.ok(
        await launcher.evaluate((el) => el === document.activeElement),
        "collapse returns focus to the launcher",
      );
      h.output("while-collapsed\r\n");
      await page.waitForFunction(
        () =>
          document
            .querySelector("#coachLauncher")
            ?.getAttribute("data-new-output") === "true",
      );
      assert.equal(
        await page.locator("#coachLauncherIndicator").isVisible(),
        true,
      );
      assert.equal(
        await page.locator("#coachLauncherName").innerText(),
        h.store.publicConfig().persona.name,
        "no fake count",
      );
      await shot(page, "collapsed-new-output-1440");
      await launcher.click();
      assert.equal(await launcher.getAttribute("data-new-output"), null);
      assert.equal(
        await page.locator("#coachLauncherIndicator").isVisible(),
        false,
      );
      await page.locator("#coachPaneCollapse").click();
      h.stopFromServer();
      await page.waitForFunction(
        () =>
          !document
            .querySelector("#nativeStatus")
            ?.textContent?.startsWith("Connected"),
      );
      for (const tab of [
        "#settingsTab",
        "#coachSettingsTab",
        "#diagnosticsTab",
        "#dashboardTab",
      ])
        await page.locator(tab).click();
      for (const width of [390, 1440])
        await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(2500);
      assert.equal(h.counts.tickets, 1, "no surprise restart after Stop");
      assert.match(
        await page.locator("#nativeStatus").innerText(),
        /open/i,
        "stopped status explains how to start again",
      );
      await launcher.click();
      await connected(page);
      assert.equal(h.counts.tickets, 2, "explicit open starts a new session");
      assert.deepEqual(h.errors, []);
    } finally {
      await h.close();
    }
  },
);

test(
  "docked pane shrinks the page, divider is bounded and keyboard accessible, terminal fits",
  { timeout: 60000 },
  async () => {
    const h = await harness();
    try {
      const { page } = h;
      await h.unlock("/");
      await page.locator("#coachLauncher").click();
      await connected(page);
      const geometry = () =>
        page.evaluate(() => {
          const [main, pane, terminal, map] = [
            "main",
            "#coachPane",
            "#nativeTerminal",
            "#dashboardMap",
          ].map((s) => document.querySelector(s)!.getBoundingClientRect());
          const rows = document.querySelectorAll(".xterm-rows > div");
          return {
            main,
            pane,
            terminal,
            lastRow: rows[rows.length - 1].getBoundingClientRect(),
            map,
            innerWidth: document.documentElement.clientWidth,
            innerHeight,
          };
        });
      // Attachment cards settle the layout; the refit must then show the last row.
      await page.waitForFunction(() => {
        const rows = document.querySelectorAll(".xterm-rows > div");
        const last = rows[rows.length - 1].getBoundingClientRect();
        return (
          document
            .querySelector("#nativeAttachmentList .attachment-preview img")
            ?.getAttribute("src")
            ?.startsWith("blob:") &&
          last.bottom <=
            document.querySelector("#nativeTerminal")!.getBoundingClientRect()
              .bottom +
              1
        );
      });
      let g = await geometry();
      assert.ok(g.main.right <= g.pane.left + 1, "page shrinks, no overlay");
      assert.ok(Math.abs(g.pane.right - g.innerWidth) <= 1, "docked right");
      assert.ok(g.map.right <= g.pane.left + 1 && g.map.width > 200);
      assert.ok(
        g.lastRow.bottom <= g.terminal.bottom + 1,
        "bottom row visible",
      );
      assert.ok(g.terminal.bottom <= g.innerHeight, JSON.stringify(g));
      assert.equal(await overflow(page), false);
      await shot(page, "docked-1440");
      const divider = page.locator("#coachDivider");
      assert.equal(await divider.getAttribute("role"), "separator");
      assert.equal(await divider.getAttribute("aria-orientation"), "vertical");
      await divider.focus();
      const value = async () =>
        Number(await divider.getAttribute("aria-valuenow"));
      const start = await value();
      const cols = h.resizes.at(-1)?.cols;
      await page.keyboard.press("ArrowLeft");
      assert.ok((await value()) > start, "ArrowLeft widens the pane");
      await page.keyboard.press("End");
      const max = Number(await divider.getAttribute("aria-valuemax"));
      assert.equal(await value(), max);
      g = await geometry();
      assert.ok(Math.abs(g.pane.width - max) <= 1);
      assert.ok(g.main.right <= g.pane.left + 1 && g.main.width >= 440);
      assert.equal(await overflow(page), false);
      await page.keyboard.press("Home");
      const min = Number(await divider.getAttribute("aria-valuemin"));
      assert.equal(await value(), min);
      assert.ok(min >= 320);
      const box = (await divider.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 200);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 - 120, box.y + 200, {
        steps: 4,
      });
      await page.mouse.up();
      assert.ok(Math.abs((await value()) - (min + 120)) <= 4, "drag resizes");
      await page.waitForTimeout(300);
      assert.ok(cols, "initial fit was sent");
      assert.notEqual(h.resizes.at(-1)?.cols, cols, "terminal refits");
      g = await geometry();
      assert.ok(g.lastRow.bottom <= g.terminal.bottom + 1);
      await page.locator("#settingsTab").click();
      await page.locator("#save").scrollIntoViewIfNeeded();
      await page.locator("#save").click({ trial: true });
      assert.equal(h.counts.tickets, 1);
      assert.deepEqual(h.errors, []);
    } finally {
      await h.close();
    }
  },
);

test(
  "expanded and mobile full-screen views restore page, scroll, focus and pause hidden polling",
  { timeout: 90000 },
  async () => {
    const h = await harness({ width: 1440, height: 600 });
    try {
      const { page } = h;
      await h.unlock("/diagnostics");
      await page.locator("#coachLauncher").click();
      await connected(page);
      const logs = h.counts.logs;
      await page.waitForTimeout(2600);
      assert.ok(h.counts.logs > logs, "docked pane keeps page polling");
      await page.locator("#settingsTab").click();
      await settingsTab(page, "Persona");
      await page.locator("#name").fill("Unsaved pane draft");
      await page
        .locator("#workspaceScroll")
        .evaluate((owner) => owner.scrollTo(0, 400));
      const y = await page
        .locator("#workspaceScroll")
        .evaluate((owner) => owner.scrollTop);
      assert.ok(y > 100, "workspace scrolls");
      await page.locator("#coachPaneExpand").click();
      assert.equal(await paneMode(page), "expanded");
      assert.equal(
        await page.locator("#coachPaneExpand").innerText(),
        "Restore",
      );
      const cover = await page.evaluate(() => {
        const r = document.querySelector("#coachPane")!.getBoundingClientRect();
        return {
          full: r.left <= 0 && r.right >= innerWidth && r.bottom >= innerHeight,
          // The header (Lock, launcher) stays usable; pages are out of reach.
          inert: (document.querySelector("#studio") as HTMLElement).inert,
          header: !(document.querySelector("main") as HTMLElement).inert,
        };
      });
      assert.deepEqual(cover, { full: true, inert: true, header: true });
      await shot(page, "expanded-1440");
      await page.locator("#coachPaneExpand").click();
      assert.equal(await paneMode(page), "docked");
      assert.equal(
        await page
          .locator("#workspaceScroll")
          .evaluate((owner) => owner.scrollTop),
        y,
        "scroll restored",
      );
      assert.ok(
        await page
          .locator("#coachPaneExpand")
          .evaluate((el) => el === document.activeElement),
      );
      assert.equal(new URL(page.url()).search, "?section=persona");
      assert.equal(
        await page.locator("#name").inputValue(),
        "Unsaved pane draft",
      );
      await page.locator("#diagnosticsTab").click();
      await page.locator("#coachPaneExpand").click();
      await page.waitForTimeout(300);
      const hidden = h.counts.logs;
      await page.waitForTimeout(2600);
      assert.equal(
        h.counts.logs,
        hidden,
        "expanded pane pauses covered polling",
      );
      await page.locator("#coachPaneExpand").click();
      await page.waitForTimeout(600);
      assert.ok(h.counts.logs > hidden, "restoring resumes polling");
      await page.locator("#coachPaneCollapse").click();
      await page.locator("#settingsTab").click();
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 700 });
        await page.evaluate(() => scrollTo(0, 300));
        const before = await page.evaluate(() => scrollY);
        await page.locator("#coachLauncher").click();
        assert.equal(await paneMode(page), "mobile");
        const r = await page.evaluate(() => {
          const r = document
            .querySelector("#coachPane")!
            .getBoundingClientRect();
          const rows = document.querySelectorAll(".xterm-rows > div");
          const t = document
            .querySelector("#nativeTerminal")!
            .getBoundingClientRect();
          return {
            full:
              r.left <= 0 && r.right >= innerWidth && r.bottom >= innerHeight,
            fits:
              rows[rows.length - 1].getBoundingClientRect().bottom <=
                t.bottom + 1 && t.bottom <= innerHeight,
          };
        });
        assert.deepEqual(r, { full: true, fits: true }, String(width));
        assert.equal(await page.locator("#coachPaneExpand").isVisible(), false);
        assert.equal(
          await page.locator("#coachPaneBack").innerText(),
          "Back to Server Settings",
        );
        assert.equal(await overflow(page), false);
        await shot(page, `mobile-${width}`);
        await page.locator("#coachPaneBack").click();
        assert.equal(await paneMode(page), "closed");
        assert.equal(await page.evaluate(() => scrollY), before);
        assert.ok(
          await page
            .locator("#coachLauncher")
            .evaluate((el) => el === document.activeElement),
        );
        assert.equal(await overflow(page), false);
      }
      assert.equal(
        await page.locator("#name").inputValue(),
        "Unsaved pane draft",
      );
      assert.equal(h.counts.tickets, 1);
      assert.equal(h.counts.stops, 0);
      assert.deepEqual(h.errors, []);
    } finally {
      await h.close();
    }
  },
);

test(
  "legacy chat links expand the pane over Dojo without member reads; history and Lock keep boundaries",
  { timeout: 90000 },
  async () => {
    const h = await harness();
    try {
      const { page } = h;
      await h.unlock("/chat/member/synthetic-person");
      await page.waitForURL("**/dashboard");
      assert.equal(await paneMode(page), "expanded");
      await connected(page);
      await page.waitForTimeout(500);
      assert.equal(h.counts.members, 0, "no member reads while covered");
      await page.locator("#coachPaneExpand").click();
      assert.equal(await paneMode(page), "docked");
      await page.waitForFunction(
        () =>
          document.querySelector("#dashboardStatus")?.textContent !==
          "Open Dojo to load shared data.",
      );
      await page.locator("#settingsTab").click();
      await settingsTab(page, "Persona");
      await page.locator("#name").fill("History draft");
      await page.locator("#diagnosticsTab").click();
      await page.goBack();
      await page
        .getByRole("tabpanel", { name: "Persona", exact: true })
        .waitFor();
      assert.equal(await page.locator("#name").inputValue(), "History draft");
      assert.equal(await paneMode(page), "docked");
      await page.goForward();
      await page.waitForURL("**/diagnostics**");
      const members = h.counts.members;
      await page.evaluate(() =>
        history.pushState(null, "", "/chat/member/legacy-forward"),
      );
      await page.goBack();
      await page.goForward();
      await page.waitForURL("**/diagnostics**");
      assert.equal(await paneMode(page), "expanded");
      assert.equal(h.counts.members, members);
      assert.equal(h.counts.tickets, 1, "history navigation keeps the session");
      await page.locator("#coachPaneExpand").click();
      await page.locator("#lockStudio").click();
      assert.equal(h.counts.stops, 1, "Lock still stops Pi");
      assert.equal(await paneMode(page), "closed");
      assert.equal(await page.locator("#coachLauncher").isVisible(), false);
      assert.equal(
        await page
          .locator("#nativeTerminal")
          .evaluate((el) => el.childElementCount),
        0,
      );
      assert.equal(await page.locator("#nativeAttachmentList > li").count(), 0);
      await page.locator("#adminKey").fill(h.store.secrets.admin);
      await page.locator("#unlock").click();
      await page.locator("#studio").waitFor({ state: "visible" });
      await page.waitForTimeout(600);
      assert.equal(await paneMode(page), "closed");
      assert.equal(h.counts.tickets, 1, "unlock after Lock starts lazily");
      await page.goto(h.app.origin + "/chat/operator");
      await page.locator("#studio").waitFor({ state: "visible" });
      await page.waitForURL("**/dashboard");
      assert.equal(await paneMode(page), "expanded");
      assert.deepEqual(h.errors, []);
    } finally {
      await h.close();
    }
  },
);

test(
  "Escape reaches the terminal; pane chrome is keyboard operable",
  { timeout: 60000 },
  async () => {
    const h = await harness();
    try {
      const { page } = h;
      await h.unlock("/");
      await page.locator("#coachLauncher").focus();
      await page.keyboard.press("Enter");
      await connected(page);
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      assert.ok(h.inputs.includes("\x1b"), "Escape is terminal input");
      assert.equal(await paneMode(page), "docked");
      await page.locator("#coachPaneExpand").focus();
      await page.keyboard.press("Enter");
      assert.equal(await paneMode(page), "expanded");
      await page.keyboard.press("Enter");
      assert.equal(await paneMode(page), "docked");
      await page.keyboard.press("Escape");
      assert.equal(
        await paneMode(page),
        "closed",
        "Escape on pane chrome collapses",
      );
      assert.ok(
        await page
          .locator("#coachLauncher")
          .evaluate((el) => el === document.activeElement),
      );
      assert.equal(h.counts.tickets, 1);
      assert.deepEqual(h.errors, []);
    } finally {
      await h.close();
    }
  },
);

test(
  "a reconnect queued while visible never fires after the pane collapses",
  { timeout: 60000 },
  async () => {
    const h = await harness();
    try {
      const { page } = h;
      await h.unlock("/");
      await page.locator("#coachLauncher").click();
      await connected(page);
      h.dropFromServer();
      await page.waitForFunction(() =>
        /Reconnecting automatically/.test(
          document.querySelector("#nativeStatus")?.textContent ?? "",
        ),
      );
      // The 1.5 s retry is now queued; leave before it fires.
      await page.locator("#coachPaneCollapse").click();
      await page.waitForTimeout(3500);
      assert.equal(h.counts.tickets, 1, "collapsed pane acquired no ticket");
      assert.match(
        await page.locator("#nativeStatus").innerText(),
        /open Coach/i,
      );
      await page.locator("#coachLauncher").click();
      await connected(page);
      assert.equal(h.counts.tickets, 2, "explicit open reconnects");
      assert.deepEqual(h.errors, []);
    } finally {
      await h.close();
    }
  },
);

test(
  "an explicit native Stop is not undone while the pane stays visible; only a deliberate start restarts",
  { timeout: 60000 },
  async () => {
    const h = await harness();
    try {
      const { page } = h;
      await h.unlock("/");
      await page.locator("#coachLauncher").click();
      await connected(page);
      assert.equal(await page.locator("#coachPaneStart").isVisible(), false);
      h.stopFromServer();
      await page.waitForFunction(
        () =>
          !document
            .querySelector("#nativeStatus")
            ?.textContent?.startsWith("Connected"),
      );
      await page.waitForTimeout(2500);
      assert.equal(h.counts.tickets, 1, "visible pane does not restart Pi");
      for (const tab of [
        "#settingsTab",
        "#coachSettingsTab",
        "#diagnosticsTab",
        "#dashboardTab",
      ])
        await page.locator(tab).click();
      await page.locator("#coachPaneExpand").click();
      await page.locator("#coachPaneExpand").click();
      for (const width of [390, 1440])
        await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(2000);
      assert.equal(h.counts.tickets, 1, "navigation does not restart Pi");
      assert.equal(await paneMode(page), "docked");
      assert.equal(
        await page.locator("#coachPaneStatus").innerText(),
        "Session ended",
      );
      await page.locator("#coachPaneStart").click();
      await connected(page);
      assert.equal(h.counts.tickets, 2, "deliberate start restarts once");
      assert.equal(await page.locator("#coachPaneStart").isVisible(), false);
      assert.deepEqual(h.errors, []);
    } finally {
      await h.close();
    }
  },
);

test(
  "divider keyboard and drag start from the rendered width after a narrower viewport clamps it",
  { timeout: 60000 },
  async () => {
    const h = await harness();
    try {
      const { page } = h;
      await h.unlock("/");
      await page.locator("#coachLauncher").click();
      await connected(page);
      const divider = page.locator("#coachDivider");
      const value = async () =>
        Number(await divider.getAttribute("aria-valuenow"));
      const paneWidth = () =>
        page.evaluate(
          () =>
            document.querySelector("#coachPane")!.getBoundingClientRect().width,
        );
      await divider.focus();
      await page.keyboard.press("End");
      assert.equal(await value(), 960);
      await page.setViewportSize({ width: 1000, height: 900 });
      await page.waitForFunction(
        () =>
          document
            .querySelector("#coachDivider")
            ?.getAttribute("aria-valuenow") === "520",
      );
      await divider.focus();
      await page.keyboard.press("ArrowRight");
      assert.equal(await value(), 504, "first ArrowRight narrows");
      assert.equal(Math.round(await paneWidth()), 504);
      // Re-establish a wide preference, then narrow without any keypress so
      // the drag starts from a stale 960 preference clamped to 520 on screen.
      await page.setViewportSize({ width: 1440, height: 900 });
      await divider.focus();
      await page.keyboard.press("End");
      assert.equal(await value(), 960);
      await page.setViewportSize({ width: 1000, height: 900 });
      await page.waitForFunction(
        () =>
          document
            .querySelector("#coachDivider")
            ?.getAttribute("aria-valuenow") === "520",
      );
      const box = (await divider.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 200);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 40, box.y + 200, {
        steps: 4,
      });
      await page.mouse.up();
      assert.ok(Math.abs((await value()) - 480) <= 2, "drag has no dead zone");
      assert.ok(Math.abs((await paneWidth()) - (await value())) <= 1);
      assert.deepEqual(h.errors, []);
    } finally {
      await h.close();
    }
  },
);

// Real admin server, ticketed WebSocket and NativeTerminal admission; only the
// Docker runtime is an in-memory stand-in.
test(
  "returning to a browser tab never reclaims or restarts Pi while Coach stays collapsed",
  { timeout: 90000 },
  async () => {
    const h = await attachmentHarness();
    const browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    try {
      const open = async () => {
        const page = await browser.newPage({
          viewport: { width: 1440, height: 900 },
        });
        const tickets: string[] = [];
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
          if (new URL(request.url()).pathname === "/api/terminal/ticket")
            tickets.push(request.url());
        });
        // Settings avoids Dojo reads the synthetic backend does not serve.
        await page.goto(h.app.origin + "/settings");
        await page.locator("#adminKey").fill(h.f.store.secrets.admin);
        await page.locator("#unlock").click();
        await page.locator("#coachLauncher").click();
        await connected(page);
        return { page, tickets, errors };
      };
      // Emulated tab visibility (string form avoids transpiler helpers).
      const setHidden = (page: Page, hidden: boolean) =>
        page.evaluate(`(() => {
          Object.defineProperty(document, "hidden", {
            configurable: true,
            get: () => ${hidden},
          });
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => (${hidden} ? "hidden" : "visible"),
          });
          document.dispatchEvent(new Event("visibilitychange"));
        })()`);
      const a = await open();
      await a.page.locator("#coachPaneCollapse").click();
      await setHidden(a.page, true);
      const b = await open();
      const runtimes = h.runtimes.length;
      await setHidden(a.page, false);
      await a.page.waitForTimeout(2500);
      assert.equal(a.tickets.length, 1, "collapsed tab did not reclaim Pi");
      assert.equal(
        await b.page.locator("#nativeStatus").innerText(),
        "Connected to isolated Pi.",
        "the other tab keeps its session",
      );
      // Stopped while this tab was away: returning must not start a new Pi.
      await setHidden(a.page, true);
      await b.page.evaluate(() => (window as any).api("terminal/stop", {}));
      await b.page.waitForFunction(
        () =>
          !document
            .querySelector("#nativeStatus")
            ?.textContent?.startsWith("Connected"),
      );
      await setHidden(a.page, false);
      await a.page.waitForTimeout(2500);
      assert.equal(a.tickets.length, 1);
      assert.equal(b.tickets.length, 1, "visible Stop is not undone");
      assert.equal(h.runtimes.length, runtimes, "no replacement runtime");
      assert.deepEqual([...a.errors, ...b.errors], []);
    } finally {
      await browser.close();
      await h.close();
    }
  },
);

test(
  "docked, expanded and full-screen Coach panes stay above the Dojo map and its controls",
  { timeout: 60000 },
  async () => {
    const h = await harness();
    try {
      const { page } = h;
      // Distinctive tiles make any map painting through the pane detectable.
      const magenta = await sharp({
        create: {
          width: 256,
          height: 256,
          channels: 3,
          background: "#ff00ff",
        },
      })
        .png()
        .toBuffer();
      await page.route("https://tile.openstreetmap.org/**", (route) =>
        route.fulfill({ status: 200, contentType: "image/png", body: magenta }),
      );
      await h.unlock("/dashboard");
      await page.locator("#dashboardMap .leaflet-control-zoom").waitFor();
      await page.locator("#coachLauncher").click();
      await connected(page);
      const pixel = async (x: number, y: number) => {
        const shot = await page.screenshot({
          clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 },
        });
        const { data } = await sharp(shot)
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        return [data[0], data[1], data[2]];
      };
      // Covered page content is inert, which hides it from hit testing even
      // when it paints on top; lift inert only while measuring paint order.
      const probe = () =>
        page.evaluate(() => {
          const main = document.querySelector("main") as HTMLElement;
          const studio = document.querySelector("#studio") as HTMLElement;
          const inert = [main.inert, studio.inert];
          main.inert = studio.inert = false;
          try {
            const pane = document
              .querySelector("#coachPane")!
              .getBoundingClientRect();
            const map = document
              .querySelector("#dashboardMap")!
              .getBoundingClientRect();
            const zoom = document
              .querySelector("#dashboardMap .leaflet-control-zoom a")!
              .getBoundingClientRect();
            const points: [string, number, number][] = [
              ["zoom", zoom.left + zoom.width / 2, zoom.top + zoom.height / 2],
              [
                "mapCenter",
                map.left + map.width / 2,
                Math.min(map.top + map.height / 2, innerHeight - 4),
              ],
            ];
            for (const fx of [0.05, 0.5, 0.95])
              for (const fy of [0.2, 0.5, 0.9])
                points.push([
                  "pane",
                  pane.left + pane.width * fx,
                  pane.top + pane.height * fy,
                ]);
            const inside = points.filter(
              ([, x, y]) =>
                x > pane.left + 1 &&
                x < pane.right - 1 &&
                y > pane.top + 1 &&
                y < Math.min(pane.bottom, innerHeight) - 1,
            );
            return {
              points: inside.map(([name, x, y]) => ({ name, x, y })),
              misses: inside
                .filter(
                  ([, x, y]) =>
                    !document.elementFromPoint(x, y)?.closest("#coachPane"),
                )
                .map(([name, x, y]) => {
                  const hit = document.elementFromPoint(x, y);
                  return `${name} ${Math.round(x)},${Math.round(y)} ${hit?.tagName}.${hit?.className}`;
                }),
            };
          } finally {
            [main.inert, studio.inert] = inert;
          }
        });
      const check = async (label: string, covering: boolean) => {
        const { points, misses } = await probe();
        assert.deepEqual(misses, [], label + ": nothing stacks over the pane");
        if (!covering) return;
        const names = points.map((p) => p.name);
        assert.ok(names.includes("mapCenter") && names.includes("zoom"), label);
        for (const { name, x, y } of points.filter((p) => p.name !== "pane")) {
          const [r, g, b] = await pixel(x, y);
          assert.ok(
            !(r > 200 && g < 80 && b > 200) && !(r > 200 && g > 200 && b > 200),
            `${label}: ${name} pixel ${r},${g},${b} shows the map through the pane`,
          );
        }
      };
      await check("docked", false);
      await page.locator("#coachPaneExpand").click();
      await page.waitForTimeout(200);
      await check("expanded", true);
      await page.locator("#coachPaneExpand").click();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      assert.equal(await paneMode(page), "mobile");
      await check("mobile", true);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.locator("#coachPaneCollapse").click();
      // The map is kept, not destroyed, to hide it.
      assert.equal(
        await page.locator("#dashboardMap .leaflet-control-zoom").isVisible(),
        true,
      );
      const [r, g, b] = await (async () => {
        const map = (await page.locator("#dashboardMap").boundingBox())!;
        return pixel(map.x + map.width / 2, map.y + map.height / 2);
      })();
      assert.ok(r > 200 && g < 80 && b > 200, "uncovered map still paints");
      assert.deepEqual(h.errors, []);
    } finally {
      await h.close();
    }
  },
);

test(
  "a native Stop survives a back/forward cache round trip while a healthy session still reattaches",
  { timeout: 60000 },
  async () => {
    const h = await harness();
    try {
      const { page } = h;
      await h.unlock("/");
      await page.locator("#coachLauncher").click();
      await connected(page);
      const bfcache = () =>
        page.evaluate(() => {
          dispatchEvent(
            new PageTransitionEvent("pagehide", { persisted: true }),
          );
          dispatchEvent(
            new PageTransitionEvent("pageshow", { persisted: true }),
          );
        });
      h.stopFromServer();
      await page.waitForFunction(
        () =>
          document.querySelector("#coachPaneStatus")?.textContent ===
          "Session ended",
      );
      await bfcache();
      await page.waitForTimeout(2500);
      assert.equal(h.counts.tickets, 1, "Stop is not undone by BFCache return");
      assert.equal(
        await page.locator("#coachPaneStatus").innerText(),
        "Session ended",
      );
      assert.equal(await page.locator("#coachPaneStart").isVisible(), true);
      await page.locator("#coachPaneStart").click();
      await connected(page);
      assert.equal(h.counts.tickets, 2);
      await bfcache();
      await connected(page);
      assert.equal(h.counts.tickets, 3, "a healthy session reattaches");
      assert.deepEqual(h.errors, []);
    } finally {
      await h.close();
    }
  },
);
