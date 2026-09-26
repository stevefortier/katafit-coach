import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium, type Page } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

const keyA = "synthetic-browser-registry-alpha";
const keyB = "synthetic-browser-registry-bravo";
const keyC = "synthetic-browser-registry-charlie";

const card = (page: Page, id: string) =>
  page.locator(`[data-provider="${id}"]`);
const field = (page: Page, id: string, name: string) =>
  card(page, id).locator(`[data-field="${name}"]`).first();

test("Models tab edits the registry with explicit Save and real Store readback", async () => {
  const dir = await mkdtemp(tmpdir() + "/registry-browser-");
  const evidence =
    process.env.COACH_EVIDENCE_DIR ?? dir + "/model-registry-evidence";
  // Provider endpoint: browsing, editing and saving must never contact it.
  const providerRequests: string[] = [];
  const provider = createServer((req, res) => {
    providerRequests.push(new URL(req.url ?? "/", "http://x.invalid").pathname);
    res.writeHead(500).end();
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(provider.address() as any).port}`;
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
          baseUrl: endpoint + "/alpha/v1",
          apiKey: keyA,
          models: [
            { id: "a1", name: "Alpha one", model: "alpha-1", vision: false },
          ],
        },
        {
          id: "bravo",
          name: "Bravo",
          baseUrl: endpoint + "/bravo/v1",
          apiKey: keyB,
          models: [
            { id: "b1", name: "Bravo one", model: "bravo-1", vision: true },
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
    const apiCalls: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/"))
        apiCalls.push(request.method() + " " + url.pathname);
    });
    // Old Connection deep link aliases to the Kata.fit tab.
    await page.goto(
      app.origin + "/settings?section=connection#" + store.secrets.admin,
    );
    await page.locator("#studio").waitFor({ state: "visible" });
    assert.equal(
      await page.getByRole("tab", { selected: true }).innerText(),
      "Kata.fit",
    );
    assert.equal(await page.locator("#katafit").isVisible(), true);
    assert.equal(await page.locator("#origin").isVisible(), true);
    assert.equal(await page.locator("#token").isVisible(), true);
    assert.equal(await page.locator("#connect").isVisible(), true);
    assert.equal(await page.getByRole("tab").count(), 7);
    await page.locator("#token").fill("unsaved-kata-token");
    // Roving keyboard focus reaches Models.
    await page
      .getByRole("tab", { name: "Kata.fit", exact: true })
      .press("ArrowRight");
    assert.equal(
      await page.getByRole("tab", { selected: true }).innerText(),
      "Models",
    );
    assert.equal(new URL(page.url()).search, "?section=models");
    assert.match(
      await page.locator("#activeModelBadge").innerText(),
      /Alpha.*Alpha one/,
    );
    assert.match(
      await page.locator("#models").innerText(),
      /OpenAI-compatible/,
    );
    assert.equal(await page.locator("[data-provider]").count(), 2);
    assert.equal(await field(page, "alpha", "apiKey").inputValue(), "");
    assert.match(
      (await field(page, "alpha", "apiKey").getAttribute("placeholder"))!,
      /keep/i,
    );
    // Browse and draft-select without any request.
    const before = apiCalls.length;
    await card(page, "bravo").getByRole("radio").check();
    assert.match(
      await page.locator("#activeModelBadge").innerText(),
      /Alpha/,
      "saved active badge is unchanged by browsing",
    );
    assert.match(
      await page.locator("#modelDraftStatus").innerText(),
      /Bravo.*Save/,
    );
    await field(page, "alpha", "name").fill("Alpha renamed");
    for (const name of ["Persona", "Preview", "Updates", "Worker", "Models"])
      await page.getByRole("tab", { name, exact: true }).click();
    assert.equal(
      await card(page, "bravo").getByRole("radio").isChecked(),
      true,
    );
    assert.equal(
      await field(page, "alpha", "name").inputValue(),
      "Alpha renamed",
    );
    await page.getByRole("tab", { name: "Kata.fit", exact: true }).click();
    assert.equal(
      await page.locator("#token").inputValue(),
      "unsaved-kata-token",
    );
    await page.getByRole("tab", { name: "Models", exact: true }).click();
    assert.deepEqual(
      apiCalls
        .slice(before)
        .filter((c) => !/^GET \/api\/(status|update)$/.test(c)),
      [],
    );
    assert.deepEqual(providerRequests, []);
    assert.equal(store.modelRegistry().active.provider, "alpha");
    // Explicit Save applies all tabs' drafts.
    await page.locator("#save").click();
    await page.waitForFunction(() =>
      /Bravo/.test(document.querySelector("#activeModelBadge")!.textContent!),
    );
    assert.equal(store.modelRegistry().active.provider, "bravo");
    assert.equal(store.modelRegistry().providers[0].name, "Alpha renamed");
    assert.equal(store.secrets.apiKey, keyB);
    assert.equal(store.secrets.token, "unsaved-kata-token");
    assert.equal(await page.locator("#modelDraftStatus").innerText(), "");
    // Reload shows the saved selection; switch back to A.
    await page.reload();
    await page.locator("#studio").waitFor({ state: "visible" });
    assert.equal(
      await page.getByRole("tab", { selected: true }).innerText(),
      "Models",
    );
    assert.equal(
      await card(page, "bravo").getByRole("radio").isChecked(),
      true,
    );
    await card(page, "alpha").getByRole("radio").check();
    await page.locator("#save").click();
    await page.waitForFunction(() =>
      /Alpha renamed/.test(
        document.querySelector("#activeModelBadge")!.textContent!,
      ),
    );
    assert.equal(store.secrets.apiKey, keyA);
    assert.deepEqual(store.publicConfig().provider, {
      baseUrl: endpoint + "/alpha/v1",
      model: "alpha-1",
      vision: false,
    });
    // Endpoint change requires explicit credential intent.
    const revision = store.publicConfig().revision;
    await field(page, "bravo", "baseUrl").fill(endpoint + "/moved/v1");
    assert.match(
      await card(page, "bravo").locator(".key-status").innerText(),
      /re-enter/i,
    );
    await page.locator("#save").click();
    await page.waitForFunction(() =>
      /re-enter/i.test(document.querySelector("#notice")!.textContent!),
    );
    assert.equal(store.publicConfig().revision, revision);
    await field(page, "bravo", "clearApiKey").check();
    await page.locator("#save").click();
    await page.waitForFunction(
      (r) =>
        document.querySelector("#revision")?.textContent ===
        "Saved revision " + (r + 1),
      revision,
    );
    assert.equal(store.modelRegistry().providers[1].hasCredential, false);
    assert.equal(
      store.modelRegistry().providers[1].baseUrl,
      endpoint + "/moved/v1",
    );
    // Add a provider with its own key and vision model, then save.
    await page.locator("#providerPreset").selectOption("custom");
    await page.locator("#addProvider").click();
    const added = page.locator("[data-provider]").last();
    const addedId = (await added.getAttribute("data-provider"))!;
    assert.match(addedId, /^[a-z0-9][a-z0-9_-]{0,63}$/);
    await field(page, addedId, "name").fill("Charlie");
    await field(page, addedId, "baseUrl").fill(endpoint + "/charlie/v1");
    await field(page, addedId, "apiKey").fill(keyC);
    await card(page, addedId).locator('[data-field="model"]').fill("charlie-1");
    await card(page, addedId).locator('[data-field="vision"]').check();
    await card(page, addedId).locator('[data-action="addModel"]').click();
    assert.equal(await card(page, addedId).locator(".model-row").count(), 2);
    await card(page, addedId)
      .locator(".model-row")
      .last()
      .locator('[data-action="removeModel"]')
      .click();
    await card(page, addedId).getByRole("radio").check();
    await page.locator("#save").click();
    await page.waitForFunction(() =>
      /Charlie/.test(document.querySelector("#activeModelBadge")!.textContent!),
    );
    assert.equal(store.secrets.apiKey, keyC);
    assert.equal(store.publicConfig().provider.vision, true);
    assert.equal(store.modelRegistry().providers.length, 3);
    assert.equal(await field(page, addedId, "apiKey").inputValue(), "");
    // Removing the saved active provider requires another selection.
    await card(page, addedId).locator('[data-action="removeProvider"]').click();
    await page.locator("#save").click();
    await page.waitForFunction(() =>
      /active model/i.test(document.querySelector("#notice")!.textContent!),
    );
    assert.equal(store.modelRegistry().providers.length, 3);
    await card(page, "alpha").getByRole("radio").check();
    await page.locator("#save").click();
    await page.waitForFunction(() =>
      /Alpha renamed/.test(
        document.querySelector("#activeModelBadge")!.textContent!,
      ),
    );
    assert.equal(store.modelRegistry().providers.length, 2);
    assert.equal(store.secrets.apiKey, keyA);
    // Persona restore keeps unsaved Models and Kata.fit drafts.
    await field(page, "bravo", "name").fill("Bravo draft");
    await page.getByRole("tab", { name: "Kata.fit", exact: true }).click();
    await page.locator("#token").fill("restore-token-draft");
    await page.getByRole("tab", { name: "Persona", exact: true }).click();
    await page.locator("#personaHistory summary").click();
    await page.getByRole("button", { name: /Revision 1 ·/ }).click();
    await page.locator("#historyDetail").waitFor({ state: "visible" });
    const restoredRevision = store.publicConfig().revision + 1;
    page.once("dialog", (d) => d.accept());
    await page.locator("#restorePersona").click();
    await page.waitForFunction(
      (r) =>
        document.querySelector("#revision")?.textContent ===
        "Saved revision " + r,
      restoredRevision,
    );
    await page.getByRole("tab", { name: "Models", exact: true }).click();
    assert.equal(
      await field(page, "bravo", "name").inputValue(),
      "Bravo draft",
    );
    assert.equal(
      await page.locator("#token").inputValue(),
      "restore-token-draft",
    );
    assert.equal(store.modelRegistry().providers[1].name, "Bravo");
    assert.equal(store.secrets.apiKey, keyA);
    // No key ever reaches the DOM, export or network responses.
    const exported = await page.evaluate(async (admin) => {
      const r = await fetch("/api/config", {
        headers: { Authorization: "Bearer " + admin },
      });
      return r.text();
    }, store.secrets.admin);
    const dom = await page.content();
    for (const secret of [keyA, keyB, keyC]) {
      assert.equal(dom.includes(secret), false);
      assert.equal(exported.includes(secret), false);
    }
    assert.deepEqual(providerRequests, []);
    const secretsFile = JSON.parse(
      await readFile(dir + "/secrets.json", "utf8"),
    );
    assert.ok(Object.values(secretsFile).every((v) => typeof v === "string"));
    // Geometry evidence (synthetic data only).
    await mkdir(evidence, { recursive: true });
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({
      path: evidence + "/models-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const name of ["Kata.fit", "Models"]) {
      await page.getByRole("tab", { name, exact: true }).click();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        name,
      );
      for (const tab of await page.getByRole("tab").all()) {
        const box = await tab.boundingBox();
        assert.ok(
          box && box.x >= 0 && box.x + box.width <= 390 && box.height >= 44,
        );
      }
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: `${evidence}/models-mobile-${name === "Models" ? "models" : "katafit"}.png`,
        fullPage: true,
      });
    }
    const radio = await card(page, "alpha").getByRole("radio").boundingBox();
    assert.ok(radio && radio.width <= 24);
    // Update locking disables every registry editor control.
    await page.route("**/api/update", (route) =>
      route.fulfill({
        json: {
          supported: true,
          applying: true,
          installed: "a".repeat(40),
          latest: "b".repeat(40),
          auto: { enabled: false, available: false },
        },
      }),
    );
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await page.waitForFunction(() =>
      [
        ...document.querySelectorAll(
          "#models input, #models button, #models select",
        ),
      ].every((el) => (el as HTMLInputElement).disabled),
    );
  } finally {
    await browser?.close();
    await app.close();
    provider.closeAllConnections();
    await new Promise<void>((r) => provider.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
