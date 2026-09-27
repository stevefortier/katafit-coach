import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const html = await readFile(
  new URL("../ui/index.html", import.meta.url),
  "utf8",
);
const css = await readFile(new URL("../ui/style.css", import.meta.url), "utf8");

for (const width of [320, 390]) {
  test(`operator page reflows all content at ${width}px without document panning`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage({
        viewport: { width, height: 760 },
        isMobile: true,
      });
      await page.setContent(
        html
          .replace(
            '<link rel="stylesheet" href="/style.css" />',
            `<style>${css}</style>`,
          )
          .replace('<script src="/app.js"></script>', ""),
      );
      await page.evaluate(() => {
        document.querySelector<HTMLElement>("#login")!.hidden = true;
        document.querySelector<HTMLElement>("#studio")!.hidden = false;
        const terminal =
          document.querySelector<HTMLElement>("#nativeTerminal")!;
        terminal.textContent = "Native Pi terminal";
        document.querySelector<HTMLElement>("#operatorStatus")!.textContent =
          "Receipt " + "a".repeat(150);
      });
      const measured = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        page: document.documentElement.scrollWidth,
        chat: document.querySelector<HTMLElement>("#nativeTerminal")!
          .scrollWidth,
        chatClient:
          document.querySelector<HTMLElement>("#nativeTerminal")!.clientWidth,
        status:
          document.querySelector<HTMLElement>("#operatorStatus")!.scrollWidth,
        statusClient:
          document.querySelector<HTMLElement>("#operatorStatus")!.clientWidth,
        main: document.querySelector("main")!.getBoundingClientRect().toJSON(),
        coach: document
          .querySelector("#coachPanel")!
          .getBoundingClientRect()
          .toJSON(),
        form: document
          .querySelector("#nativeTerminal")!
          .getBoundingClientRect()
          .toJSON(),
      }));
      assert.ok(measured.page <= measured.viewport, JSON.stringify(measured));
      assert.ok(measured.chat <= measured.chatClient, JSON.stringify(measured));
      assert.ok(
        measured.status <= measured.statusClient,
        JSON.stringify(measured),
      );
      for (const name of ["main", "coach", "form"] as const) {
        assert.ok(
          measured[name].left >= 0 && measured[name].right <= measured.viewport,
          `${name} escaped viewport: ${JSON.stringify(measured)}`,
        );
      }
      if (process.env.COACH_EVIDENCE_DIR) {
        await page.screenshot({
          path: `${process.env.COACH_EVIDENCE_DIR}/studio-${width}.png`,
          fullPage: true,
        });
      }
    } finally {
      await browser.close();
    }
  });
}
