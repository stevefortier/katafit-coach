import { test } from "node:test";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

test("Settings preview composer retains Enter, Shift+Enter and IME behavior", async () => {
  const server = createServer(async (req, res) => {
    const file = req.url === "/" ? "index.html" : req.url?.slice(1);
    if (
      !["index.html", "app.js", "terminal.js", "style.css"].includes(file || "")
    ) {
      res.writeHead(404).end();
      return;
    }
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
    const sent: { path: string; text: string }[] = [];
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
      if (path === "/api/status") body = { state: "stopped" };
      if (path === "/api/members")
        body = {
          members: [
            {
              member_ref: "synthetic-member",
              display_name: "Synthetic Alex",
              access: "granted",
            },
          ],
          has_more: false,
        };
      if (path === "/api/operator/chat") body = { messages: [] };
      if (
        route.request().method() === "POST" &&
        ["/api/operator/chat", "/api/preview"].includes(path)
      ) {
        const { text } = route.request().postDataJSON();
        sent.push({ path, text });
        body = {
          messages: [
            { role: "user", text },
            { role: "assistant", text: "Synthetic keyboard reply" },
          ],
          text: "Synthetic keyboard reply",
          prompt: "Synthetic instructions",
          revision: 1,
        };
        if (text === "Tell Alex to recover today")
          body = {
            messages: [],
            text: "Synthetic targeted command reply",
            ephemeral: true,
            actions: [
              {
                status: "delivered",
                action_id: "synthetic-action",
                message_id: "synthetic-message",
              },
            ],
          };
      }
      await route.fulfill({ json: body });
    });
    await page.goto(`http://127.0.0.1:${(server.address() as any).port}/`);
    await page.locator("#adminKey").fill("synthetic-admin");
    await page.locator("#unlock").click();
    await page.locator("#studio").waitFor({ state: "visible" });
    assert.match(
      await page.locator("#operatorView h2").innerText(),
      /^Operator · Native Pi$/,
    );
    assert.doesNotMatch(
      await page.locator("#operatorView").innerText(),
      /cannot recall a sent message|Enter to send/,
    );
    assert.equal(await page.locator("#operatorText").count(), 0);
    const evidence =
      process.env.COACH_EVIDENCE_DIR || `${tmpdir()}/katafit-studio-evidence`;
    await mkdir(evidence, { recursive: true });
    for (const [input, button, path] of [
      ["question", "previewButton", "/api/preview"],
    ]) {
      if (input === "question") await page.locator("#settingsTab").click();
      await page.getByRole("tab", { name: "Preview", exact: true }).click();
      const composer = page.locator("#" + input);
      await composer.fill("Keyboard message");
      const before = sent.length;
      await composer.press("Enter");
      await assert.doesNotReject(() =>
        page.waitForFunction(
          () => document.body.innerText.includes("Synthetic keyboard reply"),
          null,
          { timeout: 1500 },
        ),
      );
      assert.deepEqual(
        sent.slice(before),
        [{ path, text: "Keyboard message" }],
        input + " Enter equals Send",
      );
      await composer.fill("Line one");
      await composer.press("Shift+Enter");
      await composer.press("L");
      assert.equal(await composer.inputValue(), "Line one\nL");
      assert.equal(sent.length, before + 1);
      for (const init of [
        { isComposing: true },
        { keyCode: 229 },
        { repeat: true },
      ]) {
        await composer.dispatchEvent("keydown", { key: "Enter", ...init });
      }
      await page.waitForTimeout(50);
      assert.equal(sent.length, before + 1, "IME/repeat does not send");
      await page.locator("#" + button).evaluate((el: HTMLButtonElement) => {
        el.disabled = true;
      });
      await composer.press("Enter");
      assert.equal(sent.length, before + 1, "disabled Send does not send");
      await page.locator("#" + button).evaluate((el: HTMLButtonElement) => {
        el.disabled = false;
      });
      await composer.fill("   ");
      await composer.press("Enter");
      await page.locator("#" + button).click();
      await page.waitForTimeout(50);
      assert.equal(
        sent.length,
        before + 1,
        "empty keyboard and click submissions are ignored",
      );
      let held: any;
      await page.route("**" + path, (route) => {
        held = route;
      });
      await composer.fill("Pending turn");
      await composer.press("Enter");
      await page.waitForTimeout(50);
      assert.ok(held, "first turn dispatched");
      const first = held;
      await composer.fill("Do not duplicate");
      await composer.press("Enter");
      await composer.dispatchEvent("keydown", { key: "Enter", repeat: true });
      await page.waitForTimeout(50);
      assert.equal(
        held === first,
        true,
        "busy composer admits only one request",
      );
      await held.fulfill({
        json: { messages: [], text: "Done", prompt: "Synthetic", revision: 1 },
      });
      await page.unroute("**" + path);
      await page.waitForTimeout(50);
    }
    assert.equal(
      sent.some((s) => s.path === "/api/operator/chat"),
      false,
    );
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
