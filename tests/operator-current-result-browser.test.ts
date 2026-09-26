import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";
import { admin } from "../src/server/admin.js";
import { History } from "../src/chat/history.js";
import { fixture } from "./helpers/native.js";

// Supersedes bespoke ephemeral-bubble tests: native PTY result rendering is
// exercised in native-browser.test.ts, including actual Pi and authorized MCP.
for (const width of [390, 1280])
  test(`native cutover retains read-only legacy history at ${width}px without inference`, async () => {
    const f = await fixture();
    const history = new History(f.store.dir);
    history.save([
      { role: "user", text: "Historical question" },
      {
        role: "assistant",
        text: "Historical answer <script>not executable</script>",
      },
    ]);
    const before = await readFile(f.store.dir + "/operator-chat.json");
    const app = await admin(f.store, 0);
    const browser = await chromium.launch({
      executablePath: "/opt/google/chrome/chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(app.origin + "/chat/operator");
      await page.locator("#adminKey").fill(f.store.secrets.admin);
      await page.locator("#unlock").click();
      await page.locator("#nativeStart").waitFor({ state: "visible" });
      assert.equal(
        await page
          .locator("#operatorForm,#operatorText,#operatorCommandResult")
          .count(),
        0,
      );
      await page
        .getByText("Saved legacy chat · read-only · not sent to Pi", {
          exact: true,
        })
        .click();
      assert.match(
        (await page.locator("#operatorMessages").textContent()) || "",
        /Historical answer <script>not executable<\/script>/,
      );
      assert.equal(await page.locator("#operatorMessages script").count(), 0);
      assert.equal(
        f.calls.filter((c) => c.path === "/v1/chat/completions").length,
        0,
      );
      assert.deepEqual(
        await readFile(f.store.dir + "/operator-chat.json"),
        before,
      );
      assert.deepEqual(history.load(), [
        { role: "user", text: "Historical question" },
        {
          role: "assistant",
          text: "Historical answer <script>not executable</script>",
        },
      ]);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.locator("#lockStudio").click();
      assert.equal(await page.locator("#operatorMessages").textContent(), "");
    } finally {
      await browser.close();
      await app.close();
      await f.close();
    }
  });
