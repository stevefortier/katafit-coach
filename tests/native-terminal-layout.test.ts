import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Render the production Studio CSS with the real xterm and FitAddon. No Coach
// credentials, backend, or live Pi session are involved.
test("Pi terminal keeps its last row visible after fit at desktop and mobile widths", async () => {
  const browser = await chromium.launch({
    executablePath: "/opt/google/chrome/chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.setContent(
          `<main><div class="native-workbench"><div id="nativeTerminal"></div><aside id="nativeAttachments">Attachments from Pi</aside></div></main>`,
        );
        await page.addStyleTag({ path: resolve(root, "ui/style.css") });
        await page.addStyleTag({
          path: resolve(root, "node_modules/@xterm/xterm/css/xterm.css"),
        });
        await page.addScriptTag({
          path: resolve(root, "node_modules/@xterm/xterm/lib/xterm.js"),
        });
        await page.addScriptTag({
          path: resolve(root, "node_modules/@xterm/addon-fit/lib/addon-fit.js"),
        });
        const geometry = await page.evaluate(async () => {
          const term = new (window as any).Terminal({
            fontSize: 13,
            scrollback: 1000,
          });
          const fit = new (window as any).FitAddon.FitAddon();
          term.loadAddon(fit);
          term.open(document.getElementById("nativeTerminal")!);
          fit.fit();
          await new Promise<void>((done) =>
            term.write(
              "top\r\n".repeat(term.rows + 2) +
                "BOTTOM ROW MARKER " +
                "long terminal output ".repeat(20),
              done,
            ),
          );
          await new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          );
          const host = document.getElementById("nativeTerminal")!;
          const viewport = host.querySelector(".xterm-viewport")!;
          const last = [...host.querySelectorAll(".xterm-rows > div")].at(-1)!;
          const marker = host.textContent?.includes("BOTTOM ROW MARKER");
          const result = {
            host: host.getBoundingClientRect().toJSON(),
            viewport: viewport.getBoundingClientRect().toJSON(),
            screen: host
              .querySelector(".xterm-screen")!
              .getBoundingClientRect()
              .toJSON(),
            last: last.getBoundingClientRect().toJSON(),
            marker,
            rows: term.rows,
          };
          return result;
        });
        assert.ok(geometry.marker, `missing terminal marker at ${width}px`);
        assert.ok(
          geometry.last.bottom <= geometry.host.bottom - 1,
          `last row clipped at ${width}px: ${JSON.stringify(geometry)}`,
        );
        assert.ok(
          geometry.last.bottom <= geometry.viewport.bottom - 1,
          `last row outside viewport at ${width}px: ${JSON.stringify(geometry)}`,
        );
        assert.ok(
          geometry.viewport.right - geometry.screen.right >= 40,
          `scrollbar crowds terminal text at ${width}px: ${JSON.stringify(geometry)}`,
        );
        if (process.env.COACH_LAYOUT_SCREENSHOTS) {
          await page.screenshot({ path: `/tmp/coach-terminal-${width}.png` });
        }
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});
