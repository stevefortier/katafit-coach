import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

test("model radios stay square with visible selection and native keyboard semantics", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <style>${await readFile("ui/style.css", "utf8")}</style>
      <div id="modelChoices">
        <label class="model-choice"><input type="radio" name="model" checked>First model</label>
        <label class="model-choice"><input type="radio" name="model">Second model</label>
      </div>
    `);
    const first = page.getByRole("radio", { name: "First model" });
    const second = page.getByRole("radio", { name: "Second model" });
    for (const forcedColors of ["none", "active"] as const) {
      await page.emulateMedia({ forcedColors });
      await first.check();
      const styles = await page.locator("input").evaluateAll((inputs) =>
        inputs.map((input) => {
          const style = getComputedStyle(input);
          return {
            radius: style.borderRadius,
            background: style.backgroundColor,
            width: input.getBoundingClientRect().width,
            height: input.getBoundingClientRect().height,
          };
        }),
      );
      for (const style of styles) {
        assert.equal(style.radius, "0px");
        assert.equal(style.width, 18);
        assert.equal(style.height, 18);
      }
      assert.notEqual(styles[0].background, styles[1].background);
      await first.focus();
      await first.press("ArrowRight");
      assert.equal(await second.isChecked(), true);
      assert.equal(await first.isChecked(), false);
      assert.equal(
        await second.evaluate((input) => input === document.activeElement),
        true,
      );
      assert.notEqual(
        await second.evaluate((input) => getComputedStyle(input).outlineStyle),
        "none",
      );
      await first.click();
      assert.equal(await first.isChecked(), true);
      assert.equal(await second.isChecked(), false);
    }
  } finally {
    await browser.close();
  }
});
