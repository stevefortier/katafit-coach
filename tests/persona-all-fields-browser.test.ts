import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { settingsTab } from "./helpers/settings-navigation.js";
import canonical from "./fixtures/kata-persona-presets.json" with { type: "json" };

test("all eight builtin fields use exact saved projections without mutation, across selections and widths", async () => {
  const dir = await mkdtemp(tmpdir() + "/persona-all-fields-");
  const store = new Store(dir);
  let app;
  let browser;
  try {
    await store.init();
    const custom = {
      name: "Synthetic Preview Coach",
      voice: "Literal <b>voice</b>",
      verbosity: "Exactly three bullets",
      initiative: "Ask first",
      principles: "Synthetic principles\nSecond line",
      examples: "Synthetic example",
      boundaries: "Synthetic boundary",
      markdown: "Synthetic **instructions** <script>throw 1</script>",
    };
    const id = await store.createPersona({
      label: "Synthetic full-field persona",
      persona: custom,
    });
    await store.selectPersona(id);
    const before = store.personaView();
    app = await admin(store, 0);
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const mutations: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/personas") && request.method() !== "GET")
        mutations.push(request.url());
    });
    await page.goto(app.origin + "/settings#" + store.secrets.admin);
    await page.locator("#studio").waitFor({ state: "visible" });
    await settingsTab(page, "Persona");
    const labels = [
      "Coach name",
      "Voice",
      "Verbosity",
      "Initiative",
      "Coaching principles",
      "Example guidance",
      "Boundaries",
      "Additional instructions (Markdown)",
    ];
    const keys = [
      "name",
      "voice",
      "verbosity",
      "initiative",
      "principles",
      "examples",
      "boundaries",
      "markdown",
    ];
    for (const preset of canonical.presets) {
      await page
        .locator(`#personaList [data-persona-id="${preset.id}"]`)
        .click();
      assert.deepEqual(
        await page.locator("#personaBuiltin dt").allTextContents(),
        labels,
      );
      assert.equal(
        await page.locator("#personaDetailTitle").textContent(),
        preset.label,
      );
      assert.equal(
        await page.locator("#personaDescription").textContent(),
        preset.description,
      );
      for (const key of keys) {
        const field = page.locator(`[data-persona-field="${key}"]`);
        assert.equal(await field.isVisible(), true);
        assert.equal(
          await field.textContent(),
          key === "name"
            ? "Coach"
            : key === "markdown"
              ? preset.instructions
              : "Not separately specified",
        );
      }
      assert.equal(await page.locator("#personaEditor").isHidden(), true);
      assert.equal(await page.locator("#savePersona").isHidden(), true);
      assert.equal(await page.locator("#deletePersona").isDisabled(), true);
      assert.match(
        await page.locator("#personaActive").innerText(),
        /Synthetic full-field persona/,
      );
      await page.locator(`#personaList [data-persona-id="${id}"]`).click();
      assert.equal(await page.locator("#personaBuiltin").isHidden(), true);
      for (const [key, value] of Object.entries(custom))
        assert.equal(await page.locator("#" + key).inputValue(), value);
    }
    const evidence =
      process.env.PERSONA_ALL_FIELDS_EVIDENCE || dir + "/evidence";
    await mkdir(evidence, { recursive: true });
    await page
      .locator('#personaList [data-persona-id="supportive_mentor"]')
      .click();
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => window.scrollTo(0, 0));
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      for (const key of keys) {
        const box = await page
          .locator(`[data-persona-field="${key}"]`)
          .boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= width);
      }
      await page.screenshot({
        path: `${evidence}/synthetic-builtin-all-fields-${width}.png`,
        fullPage: true,
      });
    }
    assert.deepEqual(store.personaView(), before);
    assert.deepEqual(mutations, []);
    await page.locator("#lockStudio").click();
    assert.equal(await page.locator("#personaDetail").isHidden(), true);
    assert.deepEqual(
      await page.locator("[data-persona-field]").allTextContents(),
      keys.map(() => ""),
    );
  } finally {
    await browser?.close();
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
