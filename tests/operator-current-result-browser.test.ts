import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";

// The same regression can exercise a production-only npm-installed artifact.
const root = process.env.COACH_PACKAGED_ROOT;
const moduleUrl = (path: string) =>
  root
    ? pathToFileURL(`${root}/dist/${path}.js`).href
    : new URL(`../src/${path}.js`, import.meta.url).href;
const { Store } = await import(moduleUrl("config/store"));
const { History } = await import(moduleUrl("chat/history"));
const { admin } = await import(moduleUrl("server/admin"));

for (const width of [390, 1280]) {
  test(`current ephemeral result is the latest safe chat bubble at ${width}px`, async () => {
    const home = await mkdtemp(tmpdir() + "/operator-current-result-");
    const evidence =
      process.env.COACH_EVIDENCE_DIR ??
      tmpdir() + "/operator-current-result-evidence";
    const backend = createServer((_req, res) =>
      res.end(
        "# Kata.fit external Coach agent v1\n## Chief-manager operator sessions and human Studio\nSynthetic browser policy",
      ),
    );
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    let app: any;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      const store = new Store(home);
      await store.init();
      await store.save({
        ...store.publicConfig(),
        origin: `http://127.0.0.1:${(backend.address() as any).port}`,
        token: "synthetic-token",
        apiKey: "synthetic-key",
      });
      const messages = [
        { role: "user", text: "Earlier question" },
        {
          role: "assistant",
          text:
            "Earlier refusal: I cannot compare those records.\n\n" +
            "Historical explanation. ".repeat(80),
        },
      ];
      new History(home).save(messages);
      const before = await readFile(home + "/operator-chat.json", "utf8");
      app = await admin(store, 0);
      browser = await chromium.launch({
        executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
        headless: true,
        args: ["--no-sandbox"],
      });
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const answer =
        "Current authorized comparison.\n\nFirst member: recent evidence is available.\n\nSecond member: compare authorized observations.\n<img src=x onerror=alert(1)>";
      let release: (() => void) | undefined;

      await page.route("**/api/operator/chat", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const text = route.request().postDataJSON().text;
        if (text === "Held result") {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        await route.fulfill({
          status: 200,
          contentType: "application/vnd.katafit.operator+json",
          body: JSON.stringify(
            text === "Fail result"
              ? { error: "PROVIDER_TIMEOUT", actions: [] }
              : {
                  ephemeral: true,
                  text:
                    text === "Long result"
                      ? answer + "\n" + "long-unbroken-value-".repeat(12)
                      : answer,
                  messages,
                  actions: [],
                  coverage_notice:
                    "Only currently authorized records were read.",
                },
          ),
        });
      });
      await page.goto(app.origin + "/#" + store.secrets.admin);
      await page.locator("#studio").waitFor({ state: "visible" });
      await page.waitForFunction(() =>
        document
          .querySelector("#operatorMessages")
          ?.textContent?.includes("Earlier refusal"),
      );
      assert.equal(
        await page
          .locator(
            "#operatorMessages > .chat-assistant:not(#operatorCommandResult) strong",
          )
          .first()
          .textContent(),
        "Coach · Saved history",
      );
      const send = async (text: string) => {
        await page.locator("#operatorText").fill(text);
        await page.locator("#operatorSend").click();
      };
      const ready = async () => {
        await page.waitForFunction(
          () =>
            !(document.querySelector("#operatorSend") as HTMLButtonElement)
              .disabled,
        );
      };
      await send("Compare current records");
      await ready();
      await mkdir(evidence, { recursive: true });
      await page.screenshot({
        path: `${evidence}/current-result-${width}.png`,
        fullPage: true,
      });
      const result = page.locator(
        "#operatorMessages > .chat-assistant:last-child",
      );
      assert.equal(
        await result.getAttribute("id"),
        "operatorCommandResult",
        "current authorized answer, not old refusal, must be the latest assistant bubble",
      );
      assert.equal(await result.locator("p").first().textContent(), answer);
      assert.equal(
        await result
          .locator("p")
          .first()
          .evaluate((el) => getComputedStyle(el).whiteSpace),
        "pre-wrap",
      );
      assert.equal(
        await result.locator("img, script").count(),
        0,
        "model text is never HTML",
      );
      assert.match(await result.innerText(), /not retained in chat/);
      assert.match(await result.innerText(), /Only currently authorized/);
      assert.equal(
        await page
          .locator("#operatorMessages")
          .evaluate(
            (el) => el.scrollHeight - el.clientHeight - el.scrollTop <= 2,
          ),
        true,
        "current answer is scrolled into view even after a tall old refusal",
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      assert.equal(
        await page
          .locator("#operatorMessages")
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
        true,
      );
      assert.match(
        (await page.locator("#operatorMessages").textContent()) ?? "",
        /Earlier refusal/,
      );
      assert.equal(
        await readFile(home + "/operator-chat.json", "utf8"),
        before,
      );
      await send("Long result");
      await ready();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      assert.equal(
        await page
          .locator("#operatorMessages")
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
        true,
      );
      // Next turn clears the result before its response, and error cannot restore it.
      await send("Fail result");
      await ready();
      assert.equal(
        await page.locator("#operatorCommandResult").isVisible(),
        false,
      );
      assert.match(
        await page.locator("#operatorStatus").innerText(),
        /provider timed out/,
      );
      await send("Compare again");
      await ready();
      await page.locator("#settingsTab").click();
      await page.locator("#coachTab").click();
      assert.equal(
        await page.locator("#operatorCommandResult").textContent(),
        "",
      );
      // A response arriving after navigation must not republish the private result.
      await send("Compare before pending turn");
      await ready();
      const heldRequest = page.waitForRequest(
        (request) =>
          request.url().endsWith("/api/operator/chat") &&
          request.method() === "POST" &&
          request.postDataJSON().text === "Held result",
      );
      await send("Held result");
      await heldRequest;
      await page.waitForFunction(
        () =>
          !(document.querySelector("#operatorPending") as HTMLElement).hidden,
      );

      assert.equal(
        await page.locator("#operatorCommandResult").textContent(),
        "",
      );
      await page.locator("#settingsTab").click();
      release!();
      await ready();
      await page.locator("#coachTab").click();
      assert.equal(
        await page.locator("#operatorCommandResult").textContent(),
        "",
      );
      await send("Final comparison");
      await ready();
      await page.reload();
      await page.waitForFunction(() =>
        document
          .querySelector("#operatorMessages")
          ?.textContent?.includes("Earlier refusal"),
      );
      assert.equal(
        await page.locator("#operatorCommandResult").textContent(),
        "",
      );
      assert.equal(
        await readFile(home + "/operator-chat.json", "utf8"),
        before,
      );
    } finally {
      await browser?.close();
      await app?.close();
      await new Promise<void>((resolve) => backend.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  });
}
