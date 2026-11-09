import { settingsTab } from "./helpers/settings-navigation.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium, type Page } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import canonical from "./fixtures/kata-persona-presets.json" with { type: "json" };

const mentor = canonical.presets.find((p) => p.id === "supportive_mentor")!;
const drill = canonical.presets.find((p) => p.id === "drill_sergeant")!;

async function noOverflow(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= innerWidth,
  );
}

test("synthetic real Studio manages saved persona configs by saved identity without committing other drafts", async () => {
  const dir = await mkdtemp(tmpdir() + "/persona-browser-");
  const evidence = process.env.PERSONA_CONFIGS_EVIDENCE || dir + "/evidence";
  const store = new Store(dir);
  await store.init();
  const app = await admin(store, 0);
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    await page.goto(app.origin + "/settings#" + store.secrets.admin);
    await page.locator("#studio").waitFor({ state: "visible" });
    // Unsaved shared drafts in other tabs.
    await settingsTab(page, "Models");
    await page
      .locator('[data-provider="default"] [data-field="model"]')
      .fill("unsaved-model");
    await settingsTab(page, "Kata.fit");
    await page.locator("#token").fill("unsaved-token");
    await settingsTab(page, "Persona");
    const active = page.locator("#personaActive");
    assert.equal(
      (await active.textContent())?.trim(),
      "Active persona: Kata.fit default",
    );
    // Every canonical builtin is listed read-only; the active one is badged.
    const items = page.locator("#personaList [data-persona-id]");
    assert.deepEqual(
      await items.evaluateAll((els) =>
        els.map((el) => (el as HTMLElement).dataset.personaId),
      ),
      canonical.presets.map((p) => p.id),
    );
    const activeItem = page.locator(
      '#personaList [data-persona-id="kata_default"]',
    );
    assert.equal(
      (await activeItem.locator(".saved-badge").textContent())?.trim(),
      "Saved active",
    );
    assert.equal(await page.locator("#personaList .saved-badge").count(), 1);
    // Builtin detail is read-only with exact canonical instructions.
    await page
      .locator('#personaList [data-persona-id="supportive_mentor"]')
      .click();
    assert.equal(
      await page.locator("#personaInstructions").textContent(),
      mentor.instructions,
    );
    assert.equal(await page.locator("#personaEditor").isHidden(), true);
    assert.equal(await page.locator("#deletePersona").isDisabled(), true);
    assert.equal(await page.locator("#savePersona").isHidden(), true);
    // Duplicate a builtin into a saved custom config (real Store readback).
    await page.locator("#duplicatePersona").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#notice")
        ?.textContent?.includes("Supportive mentor copy"),
    );
    const copy = store.personaView().custom[0];
    assert.equal(copy.label, "Supportive mentor copy");
    assert.equal(copy.persona.markdown, mentor.instructions);
    assert.equal(
      await page.locator("#personaEditor").isVisible(),
      true,
      "duplicate opens the saved copy for editing",
    );
    assert.equal(
      await page.locator("#personaLabel").inputValue(),
      "Supportive mentor copy",
    );
    // Edit and save the custom config.
    await page.locator("#personaLabel").fill("Synthetic Dawn coach");
    await page.locator("#name").fill("Dawn");
    await page.locator("#voice").fill("Synthetic sunrise voice");
    await page.locator("#savePersona").click();
    await page.waitForFunction(
      (id) =>
        document
          .querySelector(`#personaList [data-persona-id="${id}"]`)
          ?.textContent?.includes("Synthetic Dawn coach"),
      copy.id,
    );
    let saved = store.personaView().custom[0];
    assert.equal(saved.label, "Synthetic Dawn coach");
    assert.equal(saved.persona.name, "Dawn");
    assert.equal(saved.persona.voice, "Synthetic sunrise voice");
    assert.equal(store.personaView().active.id, "kata_default");
    // Select by saved identity.
    await page.locator("#selectPersona").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#personaActive")?.textContent?.trim() ===
        "Active persona: Synthetic Dawn coach",
    );
    assert.equal(store.personaView().active.id, copy.id);
    assert.equal(
      (
        await page
          .locator(`#personaList [data-persona-id="${copy.id}"] .saved-badge`)
          .textContent()
      )?.trim(),
      "Saved active",
    );
    assert.equal(await page.locator("#deletePersona").isDisabled(), true);
    // New custom persona, then delete it (confirmation required).
    await page.locator("#newPersona").click();
    await page.locator("#personaLabel").fill("Synthetic Spare");
    await page.locator("#name").fill("Spare");
    await page.locator("#savePersona").click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("#personaList [data-persona-id]")].some(
        (el) => el.textContent?.includes("Synthetic Spare"),
      ),
    );
    assert.equal(store.personaView().custom.length, 2);
    const spare = store
      .personaView()
      .custom.find((p: any) => p.label === "Synthetic Spare");
    assert.equal(await page.locator("#deletePersona").isDisabled(), false);
    page.once("dialog", (d) => d.dismiss());
    await page.locator("#deletePersona").click();
    assert.equal(store.personaView().custom.length, 2);
    page.once("dialog", (d) => d.accept());
    await page.locator("#deletePersona").click();
    await page.waitForFunction(
      (id) => !document.querySelector(`#personaList [data-persona-id="${id}"]`),
      spare.id,
    );
    assert.equal(store.personaView().custom.length, 1);
    assert.equal(store.personaView().active.id, copy.id);
    // Shared drafts were never committed by persona actions.
    assert.equal(await page.locator("#token").inputValue(), "unsaved-token");
    assert.equal(
      await page
        .locator('[data-provider="default"] [data-field="model"]')
        .inputValue(),
      "unsaved-model",
    );
    assert.equal(store.secrets.token, "");
    assert.notEqual(store.publicConfig().provider.model, "unsaved-model");
    // Retired history and stock reset controls are gone.
    for (const id of ["personaHistory", "restorePersona", "resetPersona"])
      assert.equal(await page.locator("#" + id).count(), 0, id);
    assert.ok(
      !(await page.locator("#settingsSaveHint").textContent())?.includes(
        "Persona",
      ) ||
        (await page.locator("#settingsSaveHint").textContent())?.includes(
          "Persona actions",
        ),
    );
    // Screenshots of the reloaded saved state: no transient notice, and the
    // launcher shows the saved coach name of the active config.
    await mkdir(evidence, { recursive: true });
    await page.reload();
    await page.locator("#studio").waitFor({ state: "visible" });
    await settingsTab(page, "Persona");
    await page.waitForFunction(
      () =>
        document.querySelector("#personaActive")?.textContent?.trim() ===
        "Active persona: Synthetic Dawn coach",
    );
    assert.equal((await page.locator("#notice").textContent())?.trim(), "");
    assert.equal(await page.locator("#coachLauncherName").innerText(), "Dawn");
    await page.locator(`#personaList [data-persona-id="${copy.id}"]`).click();
    assert.equal(await page.locator("#name").inputValue(), "Dawn");
    for (const [width, name] of [
      [1440, "desktop-1440"],
      [390, "mobile-390"],
      [320, "narrow-320"],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => window.scrollTo(0, 0));
      assert.equal(await noOverflow(page), true, `overflow at ${width}`);
      assert.equal(await active.isVisible(), true);
      assert.equal(
        (await active.textContent())?.trim(),
        "Active persona: Synthetic Dawn coach",
      );
      const box = await active.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 0.5);
      // The Drill Sergeant builtin is listed and fully on screen.
      const drillItem = page.locator(
        '#personaList [data-persona-id="drill_sergeant"]',
      );
      assert.equal(await drillItem.isVisible(), true);
      assert.ok((await drillItem.innerText()).includes("Drill Sergeant"));
      const drillBox = await drillItem.boundingBox();
      assert.ok(
        drillBox &&
          drillBox.x >= 0 &&
          drillBox.x + drillBox.width <= width + 0.5,
      );
      await page.screenshot({
        path: `${evidence}/synthetic-persona-configs-${name}.png`,
        fullPage: true,
      });
    }
    // A builtin selected for viewing is read-only.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page
      .locator('#personaList [data-persona-id="supportive_mentor"]')
      .click();
    assert.equal(await page.locator("#personaEditor").isHidden(), true);
    assert.equal(await noOverflow(page), true, "overflow on builtin view");
    await page.screenshot({
      path: `${evidence}/synthetic-persona-configs-builtin-readonly-1440.png`,
      fullPage: true,
    });
    // The saved identity survives a reload (fresh readback).
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    await page.locator("#studio").waitFor({ state: "visible" });
    await settingsTab(page, "Persona");
    await page.waitForFunction(
      () =>
        document.querySelector("#personaActive")?.textContent?.trim() ===
        "Active persona: Synthetic Dawn coach",
    );
    saved = store.personaView().custom[0];
    assert.equal(saved.persona.voice, "Synthetic sunrise voice");
    // The shared Save neither sends nor discards an unsaved persona draft.
    const personaRevision = store.personaView().revision;
    await page.locator(`#personaList [data-persona-id="${copy.id}"]`).click();
    await page.locator("#voice").fill("Synthetic unsaved voice");
    await page.locator("#save").click();
    await page.waitForFunction(
      (r) =>
        document.querySelector("#revision")?.textContent ===
        "Saved revision " + r,
      personaRevision + 1,
    );
    assert.equal(
      await page.locator("#voice").inputValue(),
      "Synthetic unsaved voice",
    );
    assert.equal(
      store.personaView().custom[0].persona.voice,
      "Synthetic sunrise voice",
    );
    // A saved free-form verbosity (API or legacy) shows as saved, not dirty.
    const freeForm = await store.createPersona({
      label: "Synthetic free-form verbosity",
      persona: {
        ...store.publicConfig().persona,
        verbosity: "Exactly three short bullets",
      },
    });
    await page.reload();
    await page.locator("#studio").waitFor({ state: "visible" });
    await settingsTab(page, "Persona");
    await page.locator(`#personaList [data-persona-id="${freeForm}"]`).click();
    assert.equal(
      await page.locator("#verbosity").inputValue(),
      "Exactly three short bullets",
    );
    let prompted = false;
    page.once("dialog", (dialog) => {
      prompted = true;
      void dialog.dismiss();
    });
    await page.locator('#personaList [data-persona-id="kata_default"]').click();
    assert.equal(prompted, false, "an untouched saved persona is not dirty");
    assert.equal(await page.locator("#personaBuiltin").isVisible(), true);
    // Select the Drill Sergeant builtin by its saved identity; it stays read-only.
    await page
      .locator('#personaList [data-persona-id="drill_sergeant"]')
      .click();
    await page.locator("#selectPersona").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#personaActive")?.textContent?.trim() ===
        "Active persona: Drill Sergeant",
    );
    assert.equal(store.personaView().active.id, "drill_sergeant");
    await page.reload();
    await page.locator("#studio").waitFor({ state: "visible" });
    await settingsTab(page, "Persona");
    await page.waitForFunction(
      () =>
        document.querySelector("#personaActive")?.textContent?.trim() ===
        "Active persona: Drill Sergeant",
    );
    assert.equal((await page.locator("#notice").textContent())?.trim(), "");
    await page
      .locator('#personaList [data-persona-id="drill_sergeant"]')
      .click();
    assert.equal(
      await page.locator("#personaInstructions").textContent(),
      drill.instructions,
    );
    assert.equal(
      (
        await page
          .locator(
            '#personaList [data-persona-id="drill_sergeant"] .saved-badge',
          )
          .textContent()
      )?.trim(),
      "Saved active",
    );
    assert.equal(await page.locator("#personaEditor").isHidden(), true);
    assert.equal(await page.locator("#savePersona").isHidden(), true);
    assert.equal(await page.locator("#deletePersona").isDisabled(), true);
    assert.equal(
      (await page.locator("#selectPersona").textContent())?.trim(),
      "In use",
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.equal(await noOverflow(page), true, "overflow on Drill Sergeant");
    await page.screenshot({
      path: `${evidence}/synthetic-persona-configs-drill-sergeant-readonly-1440.png`,
      fullPage: true,
    });
  } finally {
    await browser?.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// Draft identity regressions (independent review R1–R3): every case drives the
// real served Studio against an isolated real Store with synthetic data.
const personaFieldIds = [
  "name",
  "voice",
  "principles",
  "examples",
  "boundaries",
  "initiative",
  "verbosity",
  "markdown",
] as const;
type Fields = Record<(typeof personaFieldIds)[number], string>;
const savedFields = (tag: string): Fields => ({
  name: tag,
  voice: `Saved ${tag} voice`,
  principles: `Saved ${tag} principles`,
  examples: `Saved ${tag} examples`,
  boundaries: `Saved ${tag} boundaries`,
  initiative: `Saved ${tag} initiative`,
  verbosity: "Concise",
  markdown: `Saved ${tag} markdown`,
});
const draftFields = (tag: string): Fields => ({
  name: `${tag} draft`,
  voice: `UNSAVED ${tag} voice`,
  principles: `UNSAVED ${tag} principles`,
  examples: `UNSAVED ${tag} examples`,
  boundaries: `UNSAVED ${tag} boundaries`,
  initiative: `UNSAVED ${tag} initiative`,
  verbosity: "Detailed",
  markdown: `UNSAVED ${tag} markdown`,
});

async function editor(page: Page) {
  return page
    .evaluate(
      (ids) =>
        Object.fromEntries(
          ["personaLabel", ...ids].map((id) => [
            id,
            (document.getElementById(id) as HTMLInputElement).value,
          ]),
        ),
      personaFieldIds,
    )
    .then(({ personaLabel, ...persona }) => ({ label: personaLabel, persona }));
}
async function fillEditor(page: Page, label: string, persona: Fields) {
  await page.locator("#personaLabel").fill(label);
  const details = page.locator("#personaEditor details");
  if (!(await details.evaluate((d) => (d as HTMLDetailsElement).open)))
    await details.locator("summary").click();
  for (const f of personaFieldIds)
    if (f === "verbosity")
      await page.locator("#verbosity").selectOption(persona.verbosity);
    else await page.locator("#" + f).fill(persona[f]);
}
const pressedIds = (page: Page) =>
  page
    .locator('#personaList [data-persona-id][aria-pressed="true"]')
    .evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).dataset.personaId),
    );
const row = (page: Page, id: string) =>
  page.locator(`#personaList [data-persona-id="${id}"]`);
const customById = (store: Store, id: string) =>
  store.personaView().custom.find((p: { id: string }) => p.id === id);
async function until(check: () => boolean, message: string) {
  for (let i = 0; i < 200 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(check(), message);
}
async function noticeIncludes(page: Page, text: string) {
  await page.waitForFunction(
    (t) => document.querySelector("#notice")?.textContent?.includes(t),
    text,
  );
}

async function withPersonaStudio(
  run: (ctx: {
    page: Page;
    store: Store;
    alpha: string;
    beta: string;
    gamma: string;
    dialogs: string[];
    writes: { method: string; path: string; body: unknown }[];
  }) => Promise<void>,
) {
  const dir = await mkdtemp(tmpdir() + "/persona-draft-identity-");
  const store = new Store(dir);
  await store.init();
  const base = store.publicConfig().persona;
  const create = (label: string, tag: string) =>
    store.createPersona({ label, persona: { ...base, ...savedFields(tag) } });
  const alpha = await create("Review Alpha", "Alpha");
  const beta = await create("Review Beta", "Beta");
  const gamma = await create("Review Gamma", "Gamma");
  await store.selectPersona(alpha);
  const app = await admin(store, 0);
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    page.setDefaultTimeout(10000);
    const dialogs: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.accept();
    });
    const writes: { method: string; path: string; body: unknown }[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() !== "GET" && url.pathname.startsWith("/api/"))
        writes.push({
          method: request.method(),
          path: url.pathname,
          body: request.postDataJSON(),
        });
    });
    await page.goto(app.origin + "/settings#" + store.secrets.admin);
    await page.locator("#studio").waitFor({ state: "visible" });
    await settingsTab(page, "Persona");
    await page.waitForFunction(
      () =>
        document.querySelector("#personaActive")?.textContent?.trim() ===
        "Active persona: Review Alpha",
    );
    await run({ page, store, alpha, beta, gamma, dialogs, writes });
  } finally {
    await browser?.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("R1: deleting an inactive custom persona never moves its editor contents to the active custom persona", async () => {
  await withPersonaStudio(
    async ({ page, store, alpha, beta, gamma, dialogs }) => {
      // Unedited inactive Beta.
      await row(page, beta).click();
      assert.deepEqual(await editor(page), {
        label: "Review Beta",
        persona: savedFields("Beta"),
      });
      await page.locator("#deletePersona").click();
      await page.waitForFunction(
        (id) =>
          !document.querySelector(`#personaList [data-persona-id="${id}"]`),
        beta,
      );
      await noticeIncludes(page, "Deleted persona “Review Beta”");
      assert.deepEqual(await pressedIds(page), [alpha]);
      assert.equal(
        await page.locator("#personaDetailTitle").textContent(),
        "Review Alpha",
      );
      assert.deepEqual(await editor(page), {
        label: "Review Alpha",
        persona: savedFields("Alpha"),
      });
      assert.equal(store.personaView().active.id, alpha);
      // The next save stores only the intentional Alpha edit under Alpha's ID.
      await page.locator("#voice").fill("Alpha voice after Beta delete");
      await page.locator("#savePersona").click();
      await until(
        () =>
          customById(store, alpha)?.persona.voice ===
          "Alpha voice after Beta delete",
        "Alpha edit saved",
      );
      let saved = customById(store, alpha)!;
      assert.equal(saved.label, "Review Alpha");
      assert.deepEqual(
        { ...saved.persona },
        { ...savedFields("Alpha"), voice: "Alpha voice after Beta delete" },
      );
      assert.deepEqual(
        store.personaView().custom.map((p: { id: string }) => p.id),
        [alpha, gamma],
      );
      await noticeIncludes(page, "Saved persona “Review Alpha”");
      // Edited inactive Gamma: its draft is discarded with it, never transferred.
      await row(page, gamma).click();
      await fillEditor(page, "Gamma unsaved label", draftFields("Gamma"));
      await page.locator("#deletePersona").click();
      await page.waitForFunction(
        (id) =>
          !document.querySelector(`#personaList [data-persona-id="${id}"]`),
        gamma,
      );
      await noticeIncludes(page, "Deleted persona “Review Gamma”");
      assert.deepEqual(await pressedIds(page), [alpha]);
      const alphaNow = {
        ...savedFields("Alpha"),
        voice: "Alpha voice after Beta delete",
      };
      assert.deepEqual(await editor(page), {
        label: "Review Alpha",
        persona: alphaNow,
      });
      await page.locator("#examples").fill("Alpha examples after Gamma delete");
      await page.locator("#savePersona").click();
      await until(
        () =>
          customById(store, alpha)?.persona.examples ===
          "Alpha examples after Gamma delete",
        "second Alpha edit saved",
      );
      saved = customById(store, alpha)!;
      assert.equal(saved.label, "Review Alpha");
      assert.deepEqual(
        { ...saved.persona },
        { ...alphaNow, examples: "Alpha examples after Gamma delete" },
      );
      assert.deepEqual(
        store.personaView().custom.map((p: { id: string }) => p.id),
        [alpha],
      );
      assert.equal(store.personaView().active.id, alpha);
      // Only the two delete confirmations; no discard prompts after deletion.
      assert.deepEqual(
        dialogs.map((d) => d.split("?")[0]),
        [
          "Delete the custom persona “Review Beta”",
          "Delete the custom persona “Review Gamma”",
        ],
      );
    },
  );
});

test("R2: activating the already-selected persona row by mouse or keyboard keeps its unsaved draft", async () => {
  await withPersonaStudio(async ({ page, store, alpha, dialogs, writes }) => {
    assert.deepEqual(await pressedIds(page), [alpha]);
    const draft = {
      label: "Alpha unsaved label",
      persona: draftFields("Alpha"),
    };
    await fillEditor(page, draft.label, draft.persona);
    const writesBefore = writes.length;
    const revision = store.personaView().revision;
    await row(page, alpha).click();
    assert.deepEqual(await editor(page), draft, "mouse click");
    await row(page, alpha).focus();
    await page.keyboard.press("Enter");
    assert.deepEqual(await editor(page), draft, "Enter");
    await page.keyboard.press("Space");
    assert.deepEqual(await editor(page), draft, "Space");
    assert.deepEqual(await pressedIds(page), [alpha]);
    assert.deepEqual(dialogs, []);
    assert.equal(writes.length, writesBefore, "no writes");
    assert.equal(store.personaView().revision, revision);
    assert.deepEqual(
      { ...customById(store, alpha)!.persona },
      savedFields("Alpha"),
    );
    assert.equal(customById(store, alpha)!.label, "Review Alpha");
  });
});

test("R3: an existing custom draft survives a transient persona-list failure after shared Save and a safe retry", async () => {
  await withPersonaStudio(async ({ page, store, alpha, beta, writes }) => {
    await row(page, beta).click();
    const draft = { label: "Beta unsaved label", persona: draftFields("Beta") };
    await fillEditor(page, draft.label, draft.persona);
    await page.route("**/api/personas", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "TEMPORARY_FAILURE" }),
          })
        : route.continue(),
    );
    await page.locator("#save").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#personaActive")
        ?.textContent?.includes("Could not load saved personas"),
    );
    // Still counted as unsaved: Preview refuses while the draft is held.
    await settingsTab(page, "Preview");
    await page.locator("#question").fill("Synthetic preview question");
    await page.locator("#previewButton").click();
    await noticeIncludes(page, "Unsaved edits");
    await settingsTab(page, "Persona");
    assert.equal(await page.locator("#retryPersonas").isVisible(), true);
    await page.unroute("**/api/personas");
    await page.locator("#retryPersonas").click();
    await page.locator("#personaEditor").waitFor({ state: "visible" });
    assert.deepEqual(await pressedIds(page), [beta]);
    assert.equal(await page.locator("#retryPersonas").isHidden(), true);
    assert.deepEqual(await editor(page), draft);
    assert.deepEqual(
      { ...customById(store, beta)!.persona },
      savedFields("Beta"),
    );
    // Neither shared Save nor the retry sent persona fields.
    for (const write of writes) {
      assert.ok(!write.path.startsWith("/api/personas"), write.path);
      assert.equal((write.body as any)?.persona, undefined);
      assert.equal((write.body as any)?.personas, undefined);
    }
    // The held draft saves to its own owner.
    await page.locator("#savePersona").click();
    await until(
      () => customById(store, beta)?.label === draft.label,
      "Beta draft saved",
    );
    assert.deepEqual({ ...customById(store, beta)!.persona }, draft.persona);
    assert.equal(store.personaView().active.id, alpha);
    assert.deepEqual(
      { ...customById(store, alpha)!.persona },
      savedFields("Alpha"),
    );
  });
});

test("R3: a New persona draft survives a transient persona-list failure and a later shared Save refresh", async () => {
  await withPersonaStudio(async ({ page, store, alpha }) => {
    await page.locator("#newPersona").click();
    const draft = { label: "Unsaved New label", persona: draftFields("New") };
    await fillEditor(page, draft.label, draft.persona);
    await page.route("**/api/personas", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "TEMPORARY_FAILURE" }),
          })
        : route.continue(),
    );
    await page.locator("#save").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#personaActive")
        ?.textContent?.includes("Could not load saved personas"),
    );
    await page.unroute("**/api/personas");
    const revision = store.personaView().revision;
    await page.locator("#save").click();
    await page.waitForFunction(
      (r) =>
        document.querySelector("#revision")?.textContent ===
        "Saved revision " + r,
      revision + 1,
    );
    await page.locator("#personaEditor").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#personaDetailTitle").textContent(),
      "New custom persona",
    );
    assert.deepEqual(await pressedIds(page), []);
    assert.deepEqual(await editor(page), draft);
    assert.equal(store.personaView().custom.length, 3);
    await page.locator("#savePersona").click();
    await until(
      () => store.personaView().custom.length === 4,
      "New draft saved",
    );
    const created = store.personaView().custom[3];
    assert.equal(created.label, draft.label);
    assert.deepEqual({ ...created.persona }, draft.persona);
    assert.equal(store.personaView().active.id, alpha);
  });
});

test("R3: a draft whose target was deleted elsewhere is kept until explicitly saved as new or discarded", async () => {
  await withPersonaStudio(
    async ({ page, store, alpha, beta, gamma, dialogs, writes }) => {
      const failList = () =>
        page.route("**/api/personas", (route) =>
          route.request().method() === "GET"
            ? route.fulfill({
                status: 503,
                contentType: "application/json",
                body: JSON.stringify({ error: "TEMPORARY_FAILURE" }),
              })
            : route.continue(),
        );
      const orphan = async (
        id: string,
        draft: { label: string; persona: Fields },
      ) => {
        await row(page, id).click();
        await fillEditor(page, draft.label, draft.persona);
        await failList();
        await page.locator("#save").click();
        await page.waitForFunction(() =>
          document
            .querySelector("#personaActive")
            ?.textContent?.includes("Could not load saved personas"),
        );
        await store.deletePersona(id); // deleted elsewhere
        await page.unroute("**/api/personas");
        await page.locator("#retryPersonas").click();
        await page.locator("#personaEditor").waitFor({ state: "visible" });
        assert.equal(await row(page, id).count(), 0);
        assert.deepEqual(await pressedIds(page), [], "never reassigned");
        assert.deepEqual(await editor(page), draft);
        assert.match(
          (await page.locator("#personaDetailTitle").textContent()) ?? "",
          /deleted elsewhere/i,
        );
        assert.equal(
          await page.locator("#discardPersonaDraft").isVisible(),
          true,
        );
        assert.equal(
          (await page.locator("#savePersona").textContent())?.trim(),
          "Save as new persona",
        );
        assert.equal(await page.locator("#deletePersona").isVisible(), false);
        assert.equal(await page.locator("#selectPersona").isVisible(), false);
      };
      const betaDraft = {
        label: "Beta orphan label",
        persona: draftFields("Beta"),
      };
      await orphan(beta, betaDraft);
      // Navigating away still asks before discarding the orphaned draft.
      page.removeAllListeners("dialog");
      let asked = "";
      page.once("dialog", (d) => {
        asked = d.message();
        void d.dismiss();
      });
      await row(page, alpha).click();
      assert.match(asked, /Discard unsaved changes/);
      assert.deepEqual(await editor(page), betaDraft);
      page.on("dialog", async (d) => {
        dialogs.push(d.message());
        await d.accept();
      });
      // Explicit resolution 1: save as a new persona (a new ID, not Beta's).
      await page.locator("#savePersona").click();
      await until(
        () =>
          store
            .personaView()
            .custom.some((p: { label: string }) => p.label === betaDraft.label),
        "orphan saved as new",
      );
      const created = store
        .personaView()
        .custom.find((p: { label: string }) => p.label === betaDraft.label)!;
      assert.notEqual(created.id, beta);
      assert.deepEqual({ ...created.persona }, betaDraft.persona);
      assert.equal(store.personaView().active.id, alpha);
      assert.deepEqual(
        { ...customById(store, alpha)!.persona },
        savedFields("Alpha"),
      );
      await row(page, created.id).waitFor();
      await page.waitForFunction(
        (id) =>
          document
            .querySelector(`#personaList [data-persona-id="${id}"]`)
            ?.getAttribute("aria-pressed") === "true",
        created.id,
      );
      assert.deepEqual(await editor(page), betaDraft);
      // Explicit resolution 2: discard.
      const gammaDraft = {
        label: "Gamma orphan label",
        persona: draftFields("Gamma"),
      };
      await orphan(gamma, gammaDraft);
      const writesBefore = writes.length;
      dialogs.length = 0;
      await page.locator("#discardPersonaDraft").click();
      assert.equal(dialogs.length, 1);
      assert.match(dialogs[0], /Discard/);
      assert.deepEqual(await pressedIds(page), [alpha]);
      assert.deepEqual(await editor(page), {
        label: "Review Alpha",
        persona: savedFields("Alpha"),
      });
      assert.equal(
        await page.locator("#discardPersonaDraft").isVisible(),
        false,
      );
      assert.equal(writes.length, writesBefore, "discard writes nothing");
      assert.equal(
        store
          .personaView()
          .custom.some((p: { label: string }) => p.label === gammaDraft.label),
        false,
      );
    },
  );
});

test("R3: locking or an expired session clears persona drafts, and late persona reads stay fenced", async () => {
  await withPersonaStudio(async ({ page, store, alpha, beta }) => {
    const emptyEditor = {
      label: "",
      persona: Object.fromEntries(personaFieldIds.map((f) => [f, ""])),
    };
    const unlock = async () => {
      await page.locator("#adminKey").fill(store.secrets.admin);
      await page.locator("#unlock").click();
      await page.locator("#studio").waitFor({ state: "visible" });
      await settingsTab(page, "Persona");
      await page.waitForFunction(
        () =>
          document.querySelector("#personaActive")?.textContent?.trim() ===
          "Active persona: Review Alpha",
      );
      assert.deepEqual(await pressedIds(page), [alpha]);
      assert.deepEqual(await editor(page), {
        label: "Review Alpha",
        persona: savedFields("Alpha"),
      });
    };
    // Authorization expiry while refreshing the list after shared Save.
    await row(page, beta).click();
    await fillEditor(page, "Beta unsaved label", draftFields("Beta"));
    await page.route("**/api/personas", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "UNAUTHORIZED" }),
      }),
    );
    await page.locator("#save").click();
    await page.locator("#login").waitFor({ state: "visible" });
    assert.deepEqual(await editor(page), emptyEditor, "expired session");
    assert.equal(
      (await page.locator("#personaActive").textContent())?.trim(),
      "",
    );
    await page.unroute("**/api/personas");
    await unlock();
    // Explicit lock while a persona read is still in flight.
    await row(page, beta).click();
    await fillEditor(page, "Beta unsaved label", draftFields("Beta"));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let intercepted!: () => void;
    const pending = new Promise<void>((resolve) => (intercepted = resolve));
    await page.route("**/api/personas", async (route) => {
      intercepted();
      await released;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "TEMPORARY_FAILURE" }),
      });
    });
    await page.locator("#save").click();
    await pending;
    await page.locator("#lockStudio").click();
    await page.locator("#login").waitFor({ state: "visible" });
    release();
    await page.waitForTimeout(300);
    assert.deepEqual(await editor(page), emptyEditor, "explicit lock");
    assert.equal(
      (await page.locator("#personaActive").textContent())?.trim(),
      "",
      "late failure is fenced",
    );
    assert.equal(await page.locator("#retryPersonas").isVisible(), false);
    await page.unroute("**/api/personas");
    await unlock();
    assert.deepEqual(
      { ...customById(store, beta)!.persona },
      savedFields("Beta"),
    );
  });
});
