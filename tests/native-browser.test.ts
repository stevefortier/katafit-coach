import test from "node:test";
import { waitForPiReady } from "./helpers/native-ready.js";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { fixture } from "./helpers/native.js";

test(
  "served Operator is real isolated Pi terminal, not legacy composer; tool-derived answer",
  { skip: process.env.NATIVE_DOCKER_TEST !== "1", timeout: 60000 },
  async () => {
    const f = await fixture();
    const root = process.env.COACH_PACKAGED_ROOT;
    const { admin } = await import(
      root
        ? pathToFileURL(root + "/dist/server/admin.js").href
        : "../src/server/admin.js"
    );
    const app = await admin(f.store, 0);
    const browser = await chromium.launch({
      executablePath: "/opt/google/chrome/chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    // Observe actual Pi output, not the host's earlier transport-ready frame.
    let output = "";
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.type === "output") output += message.data;
      });
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.goto(app.origin + "/chat/operator");
      await page.locator("#adminKey").fill(f.store.secrets.admin);
      await page.locator("#unlock").click();
      await waitForPiReady(() => output, 20000);
      assert.equal(
        await page
          .locator(".xterm-rows")
          .evaluate((el) =>
            getComputedStyle(el).fontFamily.includes("monospace"),
          ),
        true,
        "xterm runtime style must render monospace, not an unstyled transcript",
      );
      assert.equal(await page.locator("#operatorText").count(), 0);
      assert.equal(await page.locator("#operatorMessages").count(), 0);
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type("List the authorized members.");
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () =>
          document
            .querySelector("#nativeTerminal")
            ?.textContent?.includes(
              "Authorized roster contains Synthetic Alice.",
            ),
        {},
        { timeout: 20000 },
      );
      assert.doesNotMatch(
        output,
        /(?:fd|ripgrep|rg) not found|skipping download/i,
      );
      assert.ok(
        f.calls.some(
          (c) =>
            c.body.params?.name === "studio_operator_list_members" &&
            c.body.params.arguments.session_id === "native-fixture-session",
        ),
      );
      assert.equal(
        f.calls.filter((c) => c.path === "/v1/chat/completions").length,
        2,
      );
      const evidence =
        process.env.COACH_EVIDENCE_DIR ?? "/tmp/operator-native-pi-evidence";
      await mkdir(evidence, { recursive: true });
      await page.screenshot({
        path: evidence + "/native-desktop.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: evidence + "/native-mobile.png",
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await app.close();
      await f.close();
    }
  },
);
