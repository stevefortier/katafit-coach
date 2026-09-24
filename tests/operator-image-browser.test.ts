import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import sharp from "sharp";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

test("actual Studio document decodes authenticated Blob cards and revokes on clear", async () => {
  const dir = await mkdtemp(tmpdir() + "/operator-card-browser-");
  const backend = createServer((_req, res) =>
    res.end(
      "# Kata.fit external Coach agent v1\n## Chief-manager operator sessions and human Studio\nManager contract",
    ),
  );
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  let app: Awaited<ReturnType<typeof admin>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const store = new Store(dir);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin: `http://127.0.0.1:${(backend.address() as any).port}`,
      token: "synthetic-token",
      apiKey: ["synthetic", "key"].join("-"),
    });
    app = await admin(store, 0);
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    const bytes = await sharp({
      create: { width: 3, height: 2, channels: 3, background: "#123456" },
    })
      .png()
      .toBuffer();
    const page = await browser.newPage();
    let fetched = false;
    await page.route("**/api/operator/chat", (route) =>
      route.request().method() === "POST"
        ? route.request().postDataJSON().text === "Fail comparison"
          ? route.fulfill({
              status: 400,
              contentType: "application/json",
              body: JSON.stringify({ error: "READ_UNAVAILABLE", actions: [] }),
            })
          : route.request().postDataJSON().text === "Fail read"
            ? route.fulfill({
                status: 400,
                contentType: "application/json",
                body: JSON.stringify({
                  error: "PROVIDER_TIMEOUT",
                  actions: [],
                }),
              })
            : route.request().postDataJSON().text === "Fail send"
              ? route.fulfill({
                  status: 400,
                  contentType: "application/json",
                  body: JSON.stringify({
                    error: "MCP_TOOL_FAILED",
                    actions: [
                      {
                        status: "unknown",
                        member_ref: "member-photo",
                        action_id: "action-uncertain",
                      },
                    ],
                  }),
                })
              : route.fulfill({
                  status: 200,
                  contentType: "application/json",
                  body: JSON.stringify({
                    ephemeral: true,
                    text: "Synthetic two-image result; further roster pages were not read.",
                    coverage_notice:
                      "Partial photo coverage: a roster page has more results. Ask for another batch; do not assume every member was reviewed.",
                    images: [
                      {
                        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                        display_name: "Alex",
                        checkin_at: "2026-09-24T12:00:00.000Z",
                      },
                      {
                        id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                        display_name: "Morgan",
                        checkin_at: "2026-09-24T12:00:00.000Z",
                      },
                    ],
                    messages: [],
                    actions: [],
                  }),
                })
        : route.continue(),
    );
    await page.route("**/api/operator/image*", (route) => {
      fetched =
        route.request().headers().authorization ===
        "Bearer " + store.secrets.admin;
      return route.fulfill({
        status: 200,
        contentType: "image/png",
        body: bytes,
      });
    });
    await page.goto(app.origin + "/#" + store.secrets.admin);
    await page.locator("#studio").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#operatorTarget, #operatorReceipts").count(),
      0,
    );
    assert.equal(
      await page
        .locator("#operatorView")
        .getByText("Use as Coach instructions")
        .count(),
      0,
    );
    assert.equal(
      await page.locator("#operatorForm .hint, #operatorForm label").count(),
      0,
    );
    assert.equal(
      await page.locator("#operatorText").getAttribute("aria-label"),
      "Message your Coach",
    );
    assert.match(
      await page.locator("#operatorView .hint").first().innerText(),
      /Coach chooses the member/,
    );
    await page.locator("#operatorText").fill("Show photo");
    await page.locator("#operatorSend").click();
    await page
      .locator("#operatorCommandResult img")
      .first()
      .waitFor({ state: "visible", timeout: 4000 });
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#operatorCommandResult img").length === 2,
    );
    assert.match(
      await page.locator("#operatorCommandResult").innerText(),
      /Alex · Media date.*Morgan · Media date/s,
    );
    const evidence = new URL("../evidence/", import.meta.url).pathname;
    await mkdir(evidence, { recursive: true });
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
      await page
        .locator("#operatorCommandResult")
        .screenshot({ path: evidence + "operator-cards-" + width + ".png" });
    }
    assert.equal(fetched, true);
    assert.deepEqual(
      await page
        .locator("#operatorCommandResult img")
        .first()
        .evaluate((el: HTMLImageElement) => [
          el.naturalWidth,
          el.naturalHeight,
          el.src.startsWith("blob:"),
        ]),
      [3, 2, true],
    );
    const src = await page
      .locator("#operatorCommandResult img")
      .first()
      .getAttribute("src");
    await page.locator("#operatorClear").click();
    await page
      .locator("#operatorCommandResult img")
      .first()
      .waitFor({ state: "detached" });
    const revoked = await page.evaluate(async (url) => {
      try {
        await fetch(url!);
        return false;
      } catch {
        return true;
      }
    }, src);
    assert.equal(revoked, true);
    await page.waitForFunction(
      () =>
        !(document.querySelector("#operatorSend") as HTMLButtonElement)
          .disabled,
    );
    await page.locator("#operatorText").fill("Fail read");
    await page.locator("#operatorSend").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#operatorStatus")
        ?.textContent?.includes("could not complete"),
    );
    assert.doesNotMatch(
      await page.locator("#operatorStatus").innerText(),
      /member action|receipt|recipient conversation/i,
    );
    assert.equal(await page.locator("#operatorReconcile").isVisible(), false);
    await page.locator("#operatorText").fill("Fail comparison");
    await page.locator("#operatorSend").click();
    await page.waitForFunction(
      () =>
        document
          .querySelector("#operatorStatus")
          ?.textContent?.includes("Not enough authorized member data"),
      null,
      { timeout: 1200 },
    );
    if (process.env.COACH_EVIDENCE_DIR) {
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.locator("#operatorView").screenshot({
          path: `${process.env.COACH_EVIDENCE_DIR}/operator-composer-${width}.png`,
        });
      }
    }
    await page.locator("#operatorText").fill("Fail send");
    await page.locator("#operatorSend").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#operatorActions")
        ?.textContent?.includes("Delivery unknown"),
    );
    assert.match(
      await page.locator("#operatorActions").innerText(),
      /action-uncertain/,
    );
    assert.equal(await page.locator("#operatorReconcile").isVisible(), true);
    assert.match(
      await page.locator("#operatorStatus").innerText(),
      /delivery status/i,
    );
    await page.close();
  } finally {
    await browser?.close();
    await app?.close();
    backend.closeAllConnections();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
