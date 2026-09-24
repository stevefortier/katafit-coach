import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const config = {
  revision: 1,
  origin: "https://synthetic.invalid",
  provider: {
    model: "synthetic",
    baseUrl: "https://synthetic.invalid",
    vision: false,
  },
  persona: Object.fromEntries(
    [
      "name",
      "voice",
      "principles",
      "examples",
      "boundaries",
      "initiative",
      "verbosity",
      "markdown",
    ].map((name) => [name, name === "verbosity" ? "Balanced" : ""]),
  ),
};

test("Studio header remains visible on scroll and shows semantic worker state", async () => {
  const server = createServer(async (req, res) => {
    const file = req.url === "/" ? "index.html" : req.url?.slice(1);
    if (!["index.html", "app.js", "style.css"].includes(file || ""))
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
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    for (const width of [320, 390, 1024]) {
      const page = await browser.newPage({
        viewport: { width, height: 650 },
        isMobile: width < 600,
      });
      let state = "idle";
      let applying = false;
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        const body =
          path === "/api/config"
            ? config
            : path === "/api/status"
              ? { state, lastError: null }
              : path === "/api/update" || path === "/api/update/check"
                ? { supported: true, applying }
                : path === "/api/operator/chat"
                  ? { messages: [] }
                  : path === "/api/members"
                    ? { members: [], has_more: false }
                    : {};
        await route.fulfill({ json: body });
      });
      await page.goto(
        `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
      );
      await page.locator("#adminKey").fill("synthetic-admin");
      await page.locator("#unlock").click();
      await page.locator("#studio").waitFor({ state: "visible" });
      const header = page.locator("header");
      const badge = page.locator("#state");
      async function refresh(next: string) {
        state = next;
        await page.evaluate(async () => {
          await status();
        });
        assert.equal(await badge.innerText(), next.toUpperCase());
        return badge.evaluate((node) => ({
          tone: node.getAttribute("data-tone"),
          color: getComputedStyle(node).color,
          background: getComputedStyle(node).backgroundColor,
        }));
      }
      const idle = await refresh("idle");
      assert.equal(idle.tone, "ready");
      const busy = await refresh("working");
      assert.equal(busy.tone, "busy");
      assert.notEqual(busy.color, idle.color);
      const stopped = await refresh("stopped");
      assert.equal(stopped.tone, "danger");
      assert.notEqual(stopped.color, idle.color);
      assert.notEqual(stopped.color, busy.color);
      applying = true;
      await page.evaluate(() => refreshUpdate());
      state = "stopped";
      await page.evaluate(() => status());
      assert.equal(await badge.innerText(), "UPGRADING");
      assert.equal(await badge.getAttribute("data-tone"), "busy");
      await page.reload();
      await page.locator("#studio").waitFor({ state: "visible" });
      await page.waitForFunction(
        () => document.querySelector("#state")?.textContent === "UPGRADING",
      );
      applying = false;
      await page.evaluate(() => refreshUpdate());
      assert.equal(await badge.innerText(), "STOPPED");
      assert.equal(await badge.getAttribute("data-tone"), "danger");
      assert.equal((await refresh("task-failure-reported")).tone, "danger");
      assert.equal((await refresh("error")).tone, "danger");
      assert.equal((await refresh("failed")).tone, "danger");
      assert.equal((await refresh("task-result-unknown")).tone, "caution");
      assert.equal((await refresh("connecting")).tone, "busy");
      assert.equal((await refresh("an-unrecognized-state")).tone, "caution");
      await page.locator("#lockStudio").click();
      assert.equal(await badge.innerText(), "LOCKED");
      assert.equal(await badge.getAttribute("data-tone"), "neutral");
      await page.locator("#adminKey").fill("synthetic-admin");
      await page.locator("#unlock").click();
      await page.locator("#studio").waitFor({ state: "visible" });
      await refresh("idle");
      await page.evaluate(() =>
        window.scrollTo(0, document.documentElement.scrollHeight),
      );
      await page.waitForFunction(() => window.scrollY > 150);
      const geometry = await page.evaluate(() => {
        const header = document.querySelector("header")!;
        const badge = document.querySelector("#state")!;
        return {
          scrollY: window.scrollY,
          top: header.getBoundingClientRect().top,
          bottom: header.getBoundingClientRect().bottom,
          badgeTop: badge.getBoundingClientRect().top,
          pageWidth: document.documentElement.scrollWidth,
          viewport: document.documentElement.clientWidth,
          hit: document.elementFromPoint(
            badge.getBoundingClientRect().x + 4,
            badge.getBoundingClientRect().y + 4,
          )?.id,
        };
      });
      assert.ok(
        geometry.top >= -1 && geometry.top < 2,
        JSON.stringify(geometry),
      );
      assert.ok(
        geometry.badgeTop >= 0 && geometry.badgeTop < 150,
        JSON.stringify(geometry),
      );
      assert.equal(geometry.hit, "state", JSON.stringify(geometry));
      assert.ok(
        geometry.pageWidth <= geometry.viewport,
        JSON.stringify(geometry),
      );
      await page.locator("#settingsTab").click();
      await page.locator('a[href="#updates"]').click();
      const anchor = await page.evaluate(() => ({
        headerBottom: document.querySelector("header")!.getBoundingClientRect()
          .bottom,
        sectionTop: document.querySelector("#updates")!.getBoundingClientRect()
          .top,
      }));
      assert.ok(
        anchor.sectionTop >= anchor.headerBottom,
        JSON.stringify(anchor),
      );
      await refresh("task-publication-confirmed");
      await page.locator('a[href="#logsView"]').click();
      const tallAnchor = await page.evaluate(() => ({
        headerBottom: document.querySelector("header")!.getBoundingClientRect()
          .bottom,
        sectionTop: document.querySelector("#logsView")!.getBoundingClientRect()
          .top,
      }));
      assert.ok(
        tallAnchor.sectionTop >= tallAnchor.headerBottom,
        JSON.stringify(tallAnchor),
      );
      if (process.env.COACH_EVIDENCE_DIR) {
        await mkdir(process.env.COACH_EVIDENCE_DIR, { recursive: true });
        await refresh(width === 1024 ? "idle" : "working");
        await page.screenshot({
          path: `${process.env.COACH_EVIDENCE_DIR}/studio-sticky-${width}.png`,
        });
      }
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
