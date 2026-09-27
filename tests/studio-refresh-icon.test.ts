import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

// Real Studio markup/styles; only authentication and roster data are synthetic.
test("roster refresh is a readable text button at narrow and desktop widths", async () => {
  const evidence = process.env.COACH_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  const server = createServer(async (req, res) => {
    const file = req.url === "/" ? "index.html" : req.url?.slice(1);
    if (
      ![
        "index.html",
        "style.css",
        "app.js",
        "terminal.js",
        "backend-performance.js",
      ].includes(file || "")
    )
      return void res.writeHead(404).end();
    res.setHeader(
      "Content-Type",
      file!.endsWith("js")
        ? "text/javascript"
        : file!.endsWith("css")
          ? "text/css"
          : "text/html",
    );
    res.end(await readFile(new URL("../ui/" + file, import.meta.url)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let rosterReads = 0;
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body: any = {};
      if (path === "/api/config")
        body = {
          revision: 1,
          origin: "https://synthetic.invalid",
          provider: {
            model: "synthetic",
            baseUrl: "https://synthetic.invalid",
          },
          persona: {},
        };
      if (path === "/api/status") body = { state: "stopped" };
      if (path === "/api/terminal/receipts") body = { actions: [] };
      if (path === "/api/members") {
        rosterReads++;
        body = {
          members: [
            {
              member_ref: "synthetic",
              display_name: "Synthetic member",
              access: "granted",
            },
          ],
          has_more: false,
        };
      }
      await route.fulfill({ json: body });
    });
    await page.goto(
      `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
    );
    await page.locator("#adminKey").fill("synthetic-admin");
    await page.locator("#unlock").click();
    const button = page.getByRole("button", {
      name: "Refresh Roster",
      exact: true,
    });
    await button.waitFor();
    await page
      .getByRole("button", { name: "Synthetic member", exact: true })
      .waitFor();
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const geometry = await button.evaluate((el) => {
        const btn = el.getBoundingClientRect();
        const row = el
          .closest(".conversation-toolbar")!
          .getBoundingClientRect();
        const tabs = document
          .getElementById("conversationTabs")!
          .getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(el);
        const text = range.getBoundingClientRect();
        return {
          button: {
            x: btn.x,
            right: btn.right,
            width: btn.width,
            height: btn.height,
          },
          rowRight: row.right,
          tabsRight: tabs.right,
          text: {
            x: text.x,
            right: text.right,
            top: text.top,
            bottom: text.bottom,
          },
          scrollWidth: document.documentElement.scrollWidth,
        };
      });
      assert.equal((await button.innerText()).trim(), "Refresh Roster");
      assert.equal(await button.locator("svg").count(), 0);
      assert.ok(geometry.button.width >= 44 && geometry.button.height >= 44);
      assert.ok(
        geometry.text.x > geometry.button.x &&
          geometry.text.right < geometry.button.right,
        "text is not clipped",
      );
      assert.ok(geometry.text.top >= 0 && geometry.text.bottom <= 900);
      assert.ok(
        geometry.tabsRight <= geometry.button.x &&
          Math.abs(geometry.button.right - geometry.rowRight) < 2,
        "button remains to the right of tabs",
      );
      assert.ok(geometry.scrollWidth <= width, "no document overflow");
      if (evidence)
        await page
          .locator(".conversation-toolbar")
          .screenshot({ path: `${evidence}/toolbar-${width}.png` });
    }
    await button.focus();
    const before = rosterReads;
    await Promise.all([
      page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/members",
      ),
      button.press("Enter"),
    ]);
    assert.equal(
      rosterReads,
      before + 1,
      "keyboard refresh requests roster once",
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
