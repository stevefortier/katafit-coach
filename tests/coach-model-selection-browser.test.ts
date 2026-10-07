import { settingsTab } from "./helpers/settings-navigation.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium, type Page } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

const keyA = "synthetic-selection-alpha-key";
const keyB = "synthetic-selection-bravo-key";
const keyRotated = "synthetic-selection-bravo-rotated";
const longId = "synthetic-provider/" + "long-model-identifier-".repeat(8);

const card = (page: Page, id: string) =>
  page.locator(`#models [data-provider="${id}"]`);
const choice = (page: Page, provider: string, model: string) =>
  page.locator(
    `#model .model-choice[data-choice-provider="${provider}"][data-choice-model="${model}"]`,
  );
const selectedTab = (page: Page) =>
  page
    .locator("#serverSettingsTabs, #coachSettingsTabs")
    .getByRole("tab", { selected: true })
    .innerText();

async function savedBadgeOn(page: Page, provider: string, model: string) {
  assert.equal(await page.locator(".saved-badge").count(), 1);
  const badge = choice(page, provider, model).locator(".saved-badge");
  assert.equal(await badge.innerText(), "Saved active");
  assert.deepEqual(
    await badge.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.color, style.backgroundColor, style.borderTopColor];
    }),
    ["rgb(158, 227, 174)", "rgb(25, 56, 38)", "rgb(57, 119, 83)"],
    "Saved active uses Studio's success-green palette",
  );
}

test("Coach Settings chooses the active model while Server Models only registers", async () => {
  const dir = await mkdtemp(tmpdir() + "/model-selection-");
  const store = new Store(dir);
  await store.init();
  const { origin, persona } = store.publicConfig();
  await store.save({
    origin,
    persona,
    models: {
      active: { provider: "alpha", model: "a1" },
      providers: [
        {
          id: "alpha",
          name: "Alpha",
          baseUrl: "https://alpha.invalid/v1",
          apiKey: keyA,
          models: [
            { id: "a1", name: "Alpha one", model: "alpha-1", vision: false },
            {
              id: "long",
              name: "Long identifier vision model",
              model: longId,
              vision: true,
            },
          ],
        },
        {
          id: "bravo",
          name: "Bravo",
          baseUrl: "https://bravo.invalid/v1",
          apiKey: keyB,
          models: [
            { id: "b1", name: "Bravo one", model: "bravo-1", vision: false },
          ],
        },
      ],
    },
  });
  const app = await admin(store, 0, async () => "must not run");
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 1000 },
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const apiCalls: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/"))
        apiCalls.push(request.method() + " " + url.pathname);
    });
    await page.goto(
      app.origin + "/settings?section=models#" + store.secrets.admin,
    );
    await page.locator("#studio").waitFor({ state: "visible" });

    // Placement: registration stays in Server Settings without activation.
    assert.deepEqual(
      (
        await page.locator("#serverSettingsTabs [role=tab]").allTextContents()
      ).map((name) => name.trim()),
      ["Kata.fit", "Models", "Updates", "Log"],
    );
    assert.deepEqual(
      (
        await page.locator("#coachSettingsTabs [role=tab]").allTextContents()
      ).map((name) => name.trim()),
      [
        "Persona",
        "Model",
        "Preview",
        "Skills",
        "Memories",
        "Autonomy",
        "Worker",
      ],
    );
    assert.equal(await page.locator("#models .provider-card").count(), 2);
    assert.equal(await page.locator('#models input[type="radio"]').count(), 0);
    assert.equal(await page.locator("#models .saved-badge").count(), 0);
    assert.equal(await page.locator("#models #activeModelBadge").count(), 0);
    assert.match(
      await page.locator("#models").innerText(),
      /Coach Settings → Model/,
    );

    // Active choice lives in Coach Settings with explicit identity.
    await settingsTab(page, "Model");
    assert.equal(new URL(page.url()).search, "?section=model");
    assert.equal(await page.getByRole("tabpanel").getAttribute("id"), "model");
    assert.equal(
      await page.locator("#activeModelBadge").innerText(),
      "Saved active model: Alpha · Alpha one (alpha-1)",
    );
    assert.equal(await page.locator("#modelDraftStatus").innerText(), "");
    const radios = page.locator("#model").getByRole("radio");
    assert.equal(await radios.count(), 3);
    assert.equal(
      await page
        .locator("#model")
        .getByRole("radiogroup", { name: "Active model" })
        .count(),
      1,
    );
    assert.equal(
      await choice(page, "alpha", "a1").getByRole("radio").isChecked(),
      true,
    );
    assert.match(
      await choice(page, "alpha", "a1").innerText(),
      /Alpha one[\s\S]*Provider: Alpha[\s\S]*Model ID: alpha-1/,
    );
    assert.match(
      await choice(page, "alpha", "long").innerText(),
      /Vision/,
      "vision capability is visible where the model is chosen",
    );
    assert.equal(
      await choice(page, "bravo", "b1")
        .getByRole("radio")
        .getAttribute("aria-label"),
      "Use Bravo · Bravo one (bravo-1) after Save",
    );
    await savedBadgeOn(page, "alpha", "a1");

    // Choosing is a draft: no request, no Store change, saved status kept.
    const before = apiCalls.length;
    await choice(page, "bravo", "b1").getByRole("radio").check();
    await savedBadgeOn(page, "alpha", "a1");
    assert.match(
      await page.locator("#activeModelBadge").innerText(),
      /Alpha one/,
    );
    assert.match(
      await page.locator("#modelDraftStatus").innerText(),
      /Draft selection: Bravo · Bravo one \(bravo-1\).*after Save/,
    );
    assert.deepEqual(
      apiCalls
        .slice(before)
        .filter((c) => !/^GET \/api\/(status|update)$/.test(c)),
      [],
    );
    assert.equal(store.modelRegistry().active.provider, "alpha");

    // Registry drafts flow into the choice list without resetting drafts.
    await settingsTab(page, "Models");
    await card(page, "alpha")
      .locator('[data-field="name"]')
      .first()
      .fill("Alpha renamed");
    await card(page, "bravo").locator('[data-field="apiKey"]').fill(keyRotated);
    await card(page, "bravo").locator('[data-action="addModel"]').click();
    const addedRow = card(page, "bravo").locator(".model-row").last();
    const addedId = (await addedRow.getAttribute("data-model"))!;
    await addedRow.locator('[data-field="model"]').fill("bravo-2");
    await addedRow
      .locator('[data-field="name"]')
      .fill('<img src=x onerror="alert(1)">');
    await settingsTab(page, "Model");
    assert.equal(await radios.count(), 4);
    assert.match(
      await choice(page, "alpha", "a1").innerText(),
      /Provider: Alpha renamed/,
    );
    assert.match(
      await choice(page, "bravo", addedId).innerText(),
      /<img src=x onerror="alert\(1\)">[\s\S]*Model ID: bravo-2/,
    );
    assert.equal(await page.locator("#model img").count(), 0, "safe text");
    assert.equal(
      await choice(page, "bravo", "b1").getByRole("radio").isChecked(),
      true,
      "registry edits keep the draft choice",
    );
    await settingsTab(page, "Models");
    assert.equal(
      await card(page, "bravo").locator('[data-field="apiKey"]').inputValue(),
      keyRotated,
    );
    assert.equal(
      await card(page, "alpha")
        .locator('[data-field="name"]')
        .first()
        .inputValue(),
      "Alpha renamed",
    );

    // Removing the chosen model never silently picks a fallback.
    await card(page, "bravo")
      .locator('[data-model="b1"] [data-action="removeModel"]')
      .click();
    assert.match(
      await page.locator("#registryModelNote").innerText(),
      /Coach Settings → Model/,
    );
    await settingsTab(page, "Model");
    assert.equal(await radios.count(), 3);
    assert.equal(
      await page
        .locator("#model")
        .getByRole("radio", { checked: true })
        .count(),
      0,
    );
    assert.match(
      await page.locator("#modelDraftStatus").innerText(),
      /No draft active model/,
    );
    const revision = store.publicConfig().revision;
    await page.locator("#save").click();
    await page.waitForFunction(() =>
      /Coach Settings → Model/.test(
        document.querySelector("#notice")!.textContent!,
      ),
    );
    assert.equal(store.publicConfig().revision, revision);
    assert.equal(
      await page
        .locator("#model")
        .getByRole("radio", { checked: true })
        .count(),
      0,
    );

    // Keyboard choice keeps focus on the radio group across updates.
    await choice(page, "alpha", "a1").getByRole("radio").focus();
    await page.keyboard.press("Space");
    assert.equal(
      await choice(page, "alpha", "a1").getByRole("radio").isChecked(),
      true,
    );
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    const addedRadio = choice(page, "bravo", addedId).getByRole("radio");
    assert.equal(await addedRadio.isChecked(), true);
    assert.equal(
      await addedRadio.evaluate((el) => el === document.activeElement),
      true,
    );
    assert.match(
      await page.locator("#modelDraftStatus").innerText(),
      /Draft selection: Bravo · .*\(bravo-2\)/,
    );

    // Explicit Save persists choice and registry; secrets stay private.
    await page.locator("#save").click();
    await page.waitForFunction(() =>
      /bravo-2/.test(document.querySelector("#activeModelBadge")!.textContent!),
    );
    assert.deepEqual(store.modelRegistry().active, {
      provider: "bravo",
      model: addedId,
    });
    assert.equal(store.publicConfig().provider.model, "bravo-2");
    assert.equal(store.modelRegistry().providers[0].name, "Alpha renamed");
    assert.equal(store.secrets.apiKey, keyRotated);
    assert.equal(await page.locator("#modelDraftStatus").innerText(), "");
    await savedBadgeOn(page, "bravo", addedId);

    // Reload restores the route and the persisted selection.
    await page.reload();
    await page.locator("#studio").waitFor({ state: "visible" });
    assert.equal(await selectedTab(page), "Model");
    assert.equal(await addedRadio.isChecked(), true);
    await savedBadgeOn(page, "bravo", addedId);

    // Keyboard tabs and history.
    await page
      .getByRole("tab", { name: "Model", exact: true })
      .press("ArrowLeft");
    assert.equal(await selectedTab(page), "Persona");
    await page
      .getByRole("tab", { name: "Persona", exact: true })
      .press("ArrowRight");
    assert.equal(await selectedTab(page), "Model");
    // Entering Server Settings opens its remembered Kata.fit, then Models.
    await settingsTab(page, "Models");
    await page.goBack();
    assert.equal(await selectedTab(page), "Kata.fit");
    await page.goBack();
    assert.equal(await selectedTab(page), "Model");
    assert.equal(new URL(page.url()).search, "?section=model");
    await page.goForward();
    await page.goForward();
    assert.equal(await selectedTab(page), "Models");
    await page.locator("#coachSettingsTab").click();
    assert.equal(await selectedTab(page), "Model", "group remembers Model");

    for (const secret of [keyA, keyB, keyRotated])
      assert.equal((await page.content()).includes(secret), false);

    // Mobile containment and evidence for both pages.
    const evidence = process.env.COACH_EVIDENCE_DIR;
    if (evidence) await mkdir(evidence, { recursive: true });
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({
        width,
        height: width === 1440 ? 1000 : 844,
      });
      for (const name of ["Model", "Models"]) {
        await settingsTab(page, name);
        await page.evaluate(() => {
          (document.activeElement as HTMLElement)?.blur();
          scrollTo(0, 0);
        });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
          `${name} ${width}px document containment`,
        );
        const panel = name === "Model" ? "#model" : "#models";
        const boxes = await page
          .locator(
            `${panel} .model-choice, ${panel} .model-choice *, ${panel} input:visible, ${panel} button:visible, ${panel} p`,
          )
          .evaluateAll((els) =>
            els
              .filter((el) => el.getClientRects().length)
              .map((el) => {
                const rect = el.getBoundingClientRect();
                return { x: rect.x, right: rect.right };
              }),
          );
        assert.ok(
          boxes.every((rect) => rect.x >= 0 && rect.right <= width + 0.5),
          `${name} ${width}px control containment`,
        );
        if (name === "Model") {
          for (const radio of await radios.all()) {
            const box = await radio.boundingBox();
            assert.ok(box && box.width <= 24);
          }
          const row = await choice(page, "alpha", "long").boundingBox();
          assert.ok(row && row.height >= 44, "comfortable touch target");
        }
        if (evidence)
          await page.screenshot({
            path: `${evidence}/${name === "Model" ? "coach-model" : "server-models"}-${width}.png`,
            fullPage: true,
          });
      }
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
