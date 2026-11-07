import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

// Once an upgrade replaces the installed Studio, an open page offers a refresh
// from any view, floating over it so nothing beneath reflows.
test("an installed upgrade offers a refresh that reloads the page", async () => {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://localhost").pathname;
    const file = /\.(js|css|svg)$/.test(path) ? path.slice(1) : "index.html";
    try {
      res.setHeader(
        "Content-Type",
        file.endsWith("js")
          ? "text/javascript"
          : file.endsWith("css")
            ? "text/css"
            : "text/html",
      );
      res.end(await readFile(new URL("../ui/" + file, import.meta.url)));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let installed = "1".repeat(40);
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const body =
        path === "/api/config"
          ? {
              revision: 1,
              origin: "https://synthetic.invalid",
              provider: {
                model: "synthetic",
                baseUrl: "https://synthetic.invalid",
              },
              // A complete persona, so the page holds no unsaved edits.
              persona: await page.evaluate(() =>
                Object.fromEntries(
                  [
                    "name",
                    "voice",
                    "principles",
                    "examples",
                    "boundaries",
                    "initiative",
                    "verbosity",
                    "markdown",
                  ].map((f) => [
                    f,
                    (document.getElementById(f) as HTMLInputElement).value,
                  ]),
                ),
              ),
            }
          : path === "/api/status"
            ? {
                state: "stopped",
                safeToReplace: true,
                stopConfirmed: true,
                installed,
              }
            : path.startsWith("/api/update")
              ? { installed, latest: installed, checkedAt: 0, supported: true }
              : path === "/api/members"
                ? { members: [], has_more: false }
                : path === "/api/terminal/receipts"
                  ? { actions: [] }
                  : path === "/api/memories"
                    ? { revision: 0, items: [], total: 0 }
                    : {};
      await route.fulfill({ json: body });
    });
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    await page.goto(origin + "/settings");
    await page.locator("#adminKey").fill("synthetic-admin");
    await page.locator("#unlock").click();
    await page.waitForFunction(
      () => !document.getElementById("studio")!.hidden,
    );
    const notice = page.locator("#studioReloadNotice");
    // Wait past a status poll: the same revision offers nothing.
    await page.waitForTimeout(4500);
    assert.equal(await notice.isVisible(), false);

    const before = await page.evaluate(
      () => document.querySelector("main")!.getBoundingClientRect().height,
    );
    installed = "2".repeat(40);
    await notice.waitFor({ state: "visible", timeout: 10000 });
    assert.match(await notice.innerText(), /Studio update ready/);
    assert.equal(
      await page.evaluate(
        () => document.querySelector("main")!.getBoundingClientRect().height,
      ),
      before,
      "the notice floats without reflowing the page",
    );
    // The refresh offer belongs to the visible layout, not the clipped/inert
    // workspace behind Coach. All API/Pi state in this fixture is synthetic.
    const assertReachable = async (docked = false) => {
      const geometry = await page.evaluate(() => {
        const notice = document.getElementById("studioReloadNotice")!;
        const button = document.getElementById("studioReload")!;
        const box = notice.getBoundingClientRect();
        const control = button.getBoundingClientRect();
        const pane = document
          .getElementById("coachPane")!
          .getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          center: (box.left + box.right) / 2,
          paneLeft: pane.left,
          width: innerWidth,
          hit:
            document.elementFromPoint(
              control.left + control.width / 2,
              control.top + control.height / 2,
            ) === button,
          inert: !!button.closest("[inert]"),
          textFits: notice.scrollWidth <= notice.clientWidth,
        };
      });
      assert.ok(
        geometry.left >= 0 && geometry.right <= geometry.width,
        "notice fits viewport",
      );
      assert.equal(geometry.hit, true, "Refresh is not covered or clipped");
      assert.equal(geometry.inert, false, "Refresh remains interactive");
      assert.equal(geometry.textFits, true, "notice text and control fit");
      if (docked) {
        assert.ok(
          geometry.right <= geometry.paneLeft,
          "notice stays outside Coach",
        );
        assert.ok(
          Math.abs(geometry.center - geometry.paneLeft / 2) < 2,
          "notice centers in remaining workspace",
        );
      }
    };
    await page.locator("#coachLauncher").click();
    await assertReachable(true);
    const paneWidth = async () =>
      (await page.locator("#coachPane").boundingBox())!.width;
    const initialWidth = await paneWidth();
    await page.locator("#coachDivider").focus();
    await page.keyboard.press("ArrowLeft");
    const keyboardWidth = await paneWidth();
    assert.ok(keyboardWidth > initialWidth, "keyboard actually resizes Coach");
    await assertReachable(true);
    const divider = await page.locator("#coachDivider").boundingBox();
    await page.mouse.move(divider!.x + divider!.width / 2, divider!.y + 100);
    await page.mouse.down();
    await page.mouse.move(divider!.x - 140, divider!.y + 100);
    await page.mouse.up();
    assert.ok(
      (await paneWidth()) > keyboardWidth,
      "pointer actually resizes Coach",
    );
    await assertReachable(true);
    if (process.env.KATAFIT_UI_SCREENSHOT) {
      await page.screenshot({
        path: process.env.KATAFIT_UI_SCREENSHOT + "-docked.png",
      });
    }
    await page.setViewportSize({ width: 1000, height: 900 });
    await assertReachable(true);
    await page.locator("#coachPaneExpand").click();
    await assertReachable();
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await assertReachable();
      if (process.env.KATAFIT_UI_SCREENSHOT) {
        await page.screenshot({
          path: process.env.KATAFIT_UI_SCREENSHOT + `-mobile-${width}.png`,
        });
      }
      await page.locator("#studioReload").focus();
      assert.equal(
        await page
          .locator("#studioReload")
          .evaluate((node) => node === document.activeElement),
        true,
      );
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator("#coachPaneCollapse").click();
    await assertReachable();
    await page.evaluate(() => ((window as any).beforeRefresh = true));
    await Promise.all([
      page.waitForEvent("load"),
      page.locator("#studioReload").click(),
    ]);
    assert.equal(
      await page.evaluate(() => (window as any).beforeRefresh),
      undefined,
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});
