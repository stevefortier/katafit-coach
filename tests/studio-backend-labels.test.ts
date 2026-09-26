import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { fixture } from "./helpers/native.js";
import { admin } from "../src/server/admin.js";
import { Client } from "../src/katafit/client.js";
import { Diagnostics } from "../src/diagnostics/log.js";

test("Client receipts survive disk and HTTP into named browser rows with exact Info default", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const log = new Diagnostics(f.store.dir);
  const client = new Client(
    f.store.publicConfig().origin,
    "synthetic-backend-credential",
    new AbortController().signal,
    (e) => log.record(e),
  );
  await client.connect();
  await client.call("unknown_PRIVATE_TOOL_MARKER", {
    url: "https://private.invalid/PRIVATE_URL_MARKER",
  });
  await client.call("studio_operator_list_members", {
    private: "PRIVATE_ARGUMENT_MARKER",
  });
  // Historical entries without a descriptor must remain honest generic entries.
  log.record({ source: "backend", stage: "backend-call", level: "info" });
  log.record({ source: "studio", stage: "connecting", level: "warn" });
  const restarted = new Diagnostics(f.store.dir).snapshot();
  const app = await admin(f.store, 0);
  let browser;
  try {
    const snapshot = await (
      await fetch(app.origin + "/api/logs", {
        headers: { Authorization: "Bearer " + f.store.secrets.admin },
      })
    ).json();
    const receipts = snapshot.entries.filter((e: any) => e.backendCall);
    assert.deepEqual(
      receipts,
      restarted.entries.filter((e) => e.backendCall),
    );
    assert.equal(receipts.length, 4);
    assert.equal(receipts[3].backendCall?.tool, "studio_operator_list_members");
    assert.equal(receipts[2].backendCall?.tool, "other");
    assert.doesNotMatch(
      JSON.stringify(receipts),
      /PRIVATE_|synthetic-backend-credential|127\.0\.0/,
    );
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(app.origin + "/diagnostics#" + f.store.secrets.admin);
    await page.waitForFunction(() =>
      document.querySelector("#logStatus")?.textContent?.includes("retained"),
    );
    assert.equal(await page.locator("#logLevel").inputValue(), "info");
    assert.equal(
      await page.locator("#logLevel option[value=verbose]").innerText(),
      "Verbose",
    );
    assert.equal(
      await page
        .locator(
          "#logRows .log-verbose, #logRows .log-warn, #logRows .log-error",
        )
        .count(),
      0,
    );
    assert.ok((await page.locator("#logRows .log-info").count()) > 0);
    assert.ok(
      (await page.locator("#logRows strong").allTextContents()).includes(
        "Backend call — name unavailable · INFO",
      ),
    );
    await page.locator("#logLevel").selectOption("verbose");
    assert.equal(await page.locator("#logRows article").count(), 4);
    assert.equal(
      await page.locator("#logRows .log-info, #logRows .log-warn").count(),
      0,
    );
    const named = page.locator("#logRows article").filter({
      has: page.locator("strong", {
        hasText: "studio_operator_list_members",
      }),
    });
    assert.equal(await named.count(), 1);
    assert.equal(
      await named.locator("strong").innerText(),
      "studio_operator_list_members · VERBOSE",
    );
    assert.match(
      await named.locator(".backend-call-summary").innerText(),
      /POST mcp.*tools\/call.*\d+ ms.*HTTP 200.*ok/,
    );
    assert.ok(
      (await page.locator("#logRows strong").allTextContents()).includes(
        "initialize · VERBOSE",
      ),
    );
    assert.ok(
      (await page.locator("#logRows strong").allTextContents()).includes(
        "notifications/initialized · VERBOSE",
      ),
    );
    assert.ok(
      (await page.locator("#logRows strong").allTextContents()).includes(
        "tools/call — tool name unavailable · VERBOSE",
      ),
    );
    await page.locator("#logLevel").selectOption("warn");
    assert.equal(await page.locator("#logRows article").count(), 1);
    await page.locator("#logLevel").selectOption("all");
    assert.equal(
      await page.locator("#logRows article").count(),
      snapshot.entries.length,
    );
    const evidence =
      process.env.COACH_EVIDENCE_DIR ||
      tmpdir() + "/coach-backend-labels-evidence";
    await mkdir(evidence, { recursive: true });
    await page.evaluate(() => {
      const label = document.createElement("p");
      label.textContent = "SYNTHETIC LOCAL HTTP CALLS — no production data";
      document.querySelector("#diagnostics")!.prepend(label);
    });
    for (const level of ["info", "verbose"]) {
      await page.locator("#logLevel").selectOption(level);
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(() => scrollTo(0, 0));
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        );
        await page.screenshot({
          path: `${evidence}/synthetic-client-${level}-${width}.png`,
          fullPage: true,
        });
      }
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await app.close();
  }
});
