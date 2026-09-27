import { chromium } from "playwright-core";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
// Allow narrow and broad browser checks against the same installed artifact.
const packagedRoot = process.env.COACH_PACKAGED_ROOT;
const moduleUrl = (path: string) =>
  packagedRoot
    ? pathToFileURL(`${packagedRoot}/dist/${path}.js`).href
    : new URL(`../src/${path}.js`, import.meta.url).href;
const { Store } = await import(moduleUrl("config/store"));
const { admin } = await import(moduleUrl("server/admin"));
const home = await mkdtemp(tmpdir() + "/coach-chat-browser-");
const evidence =
  process.env.COACH_EVIDENCE_DIR ?? tmpdir() + "/studio-chat-browser";
const store = new Store(home);
await store.init();
const { createServer } = await import("node:http");
let calls = 0;
let delay = false;
let evidenceReply = "";
const backend = createServer(async (req, res) => {
  if (req.method !== "POST")
    return res.end(
      "# Kata.fit external Coach agent v1\nSynthetic browser policy\n## Chief-manager operator sessions and human Studio\nThe operator manages the Coach.",
    );
  let raw = "";
  for await (const part of req) raw += part;
  const rpc = JSON.parse(raw);
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: rpc.id,
      result:
        rpc.method === "initialize"
          ? { protocolVersion: "2025-03-26" }
          : rpc.method === "tools/list"
            ? { tools: [] } // Pre-presence backend: polling remains available.
            : { structuredContent: { requests: [] } },
    }),
  );
});
const provider = createServer(async (req, res) => {
  for await (const _ of req) {
  }
  // Parse the path separately from any query string.
  if (
    new URL(req.url ?? "/", "http://fixture.invalid").pathname !==
    "/v1/chat/completions"
  )
    return void res.writeHead(404).end();
  calls++;
  if (delay) {
    res.on("close", () => {});
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.end(
    "data: " +
      JSON.stringify({
        id: "qa",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content:
                evidenceReply ||
                "Synthetic operator reply " +
                  calls +
                  " <img src=x onerror=alert(1)>",
            },
            finish_reason: null,
          },
        ],
      }) +
      "\n\ndata: " +
      JSON.stringify({
        id: "qa",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }) +
      "\n\ndata: [DONE]\n\n",
  );
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
await store.save({
  ...store.publicConfig(),
  origin: `http://127.0.0.1:${(backend.address() as any).port}`,
  provider: {
    ...store.publicConfig().provider,
    baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
    model: "synthetic-chat",
  },
  apiKey: "synthetic-private-key",
  token: "synthetic-worker-token",
});
// An inactive registered provider: never contacted, its key never displayed.
const inactiveKey = "synthetic-inactive-coach-key";
{
  const { origin, persona } = store.publicConfig();
  const registry = store.modelRegistry();
  await store.save({
    origin,
    persona,
    models: {
      active: registry.active,
      providers: [
        ...registry.providers.map(({ hasCredential, ...p }) => p),
        {
          id: "spare",
          name: "Synthetic spare",
          baseUrl: "https://spare.synthetic.invalid/v1",
          apiKey: inactiveKey,
          models: [{ id: "s1", name: "Spare", model: "spare-1" }],
        },
      ],
    },
  });
  assert.equal(store.secrets.apiKey, "synthetic-private-key");
}
const app = await admin(store, 0);
let browser;
try {
  await mkdir(evidence, { recursive: true });
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1000 },
  });
  const memberCalls: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/members(?:\/|\?|$)/.test(request.url()))
      memberCalls.push(request.url());
  });
  await page.goto(app.origin + "/#" + store.secrets.admin);
  await page.locator("#studio").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("header .brand").innerText(),
    "Kata.fit Coach",
  );
  await page.screenshot({ path: evidence + "/navigation-before.png" });
  assert.equal(
    await page.locator("#coachTab").count(),
    1,
    "Coach-first navigation is present",
  );
  assert.equal(await page.locator("#coachPanel").isVisible(), true);
  assert.equal(await page.locator("#settingsPanel").isVisible(), false);
  await page.locator("#settingsTab").click();
  assert.equal(await page.locator("#katafit").isVisible(), true);
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.waitForTimeout(200);
  let logs = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/logs")) logs++;
  });
  await page.locator("#coachTab").click();
  await page.waitForTimeout(2300);
  assert.equal(logs, 0, "Settings-hidden logs do not poll");
  await page.locator("#settingsTab").click();
  await page.getByRole("tab", { name: "Worker", exact: true }).click();
  await page.locator("#run").click();
  await page.waitForFunction(
    () => document.querySelector("#state")?.textContent === "IDLE",
  );
  await page.locator("#coachTab").click();
  assert.equal(await page.locator("#nativeStart").isEnabled(), true);
  assert.equal(await page.locator("#operatorText").count(), 0);
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  await page.locator("#settingsTab").click();
  await page.getByRole("tab", { name: "Persona", exact: true }).click();
  await page.locator("#name").fill("Unsaved operator draft");
  await page.locator("#coachTab").click();
  assert.match(
    await page.locator("#operatorSnapshot").innerText(),
    /saved.*revision|Saved.*revision/,
  );
  assert.doesNotMatch(
    await page.locator("#operatorSnapshot").innerText(),
    /Unsaved operator draft/,
  );
  assert.equal(await page.locator(".chat-assistant button").count(), 0);
  assert.equal(
    await page.locator(".chat-user button").count(),
    0,
    "operator messages offer no instruction draft action",
  );
  const revisionBeforeDraft = store.publicConfig().revision;
  await page.locator("#settingsTab").click();
  await page.getByRole("tab", { name: "Persona", exact: true }).click();
  await page.getByText("Advanced Markdown", { exact: true }).click();
  await page.getByRole("tab", { name: "Persona", exact: true }).click();
  await page.locator("#markdown").fill("Explicit Settings rule");
  await page.locator("#coachTab").click();
  assert.equal(await page.locator(".chat-user button").count(), 0);
  assert.equal(
    store.publicConfig().revision,
    revisionBeforeDraft,
    "chat never writes config",
  );
  await page.locator("#settingsTab").click();
  await page.getByRole("tab", { name: "Worker", exact: true }).click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#save").click();
  await page.waitForFunction(() =>
    document.querySelector("#notice")?.textContent?.includes("cancelled"),
  );
  assert.equal(store.publicConfig().revision, revisionBeforeDraft);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#save").click();
  await page.waitForFunction(() =>
    document.querySelector("#notice")?.textContent?.startsWith("Saved."),
  );
  assert.match(store.publicConfig().persona.markdown, /Explicit Settings rule/);
  assert.match(await page.locator("#restartStatus").innerText(), /restarted/);
  await page.locator("#stop").click();
  await page.waitForFunction(
    () => document.querySelector("#state")?.textContent === "STOPPED",
  );
  await page.locator("#coachTab").click();
  await page.screenshot({ path: evidence + "/coach-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({ path: evidence + "/coach-mobile.png" });
  // Native tool execution, cancellation and ticket revocation are exercised
  // by native-browser/native-terminal tests against actual Docker Pi.
  assert.equal(
    await page
      .locator("#operatorTab, #conversationTabs, #membersRefresh, #memberView")
      .count(),
    0,
  );
  assert.equal(
    await page.locator("#coachTab").innerText(),
    store.publicConfig().persona.name,
  );
  await page.goto(app.origin + "/chat/member/synthetic-person");
  await page.waitForURL("**/chat/operator");
  assert.equal(await page.locator("#nativeStart").isVisible(), true);
  assert.deepEqual(
    memberCalls,
    [],
    "legacy links and operator UI never request member data",
  );
  await page.locator("#nativeHistoryToggle").click();
  assert.equal(await page.locator("#nativeHistoryPanel").isVisible(), true);
  await page.locator("#settingsTab").click();
  await page.getByRole("tab", { name: "Persona", exact: true }).click();
  await page.locator("#name").fill("Synthetic authority reload");
  assert.notEqual(
    await page.locator("#coachTab").innerText(),
    "Synthetic authority reload",
  );
  await page.locator("#save").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#coachTab")?.textContent ===
      "Synthetic authority reload",
  );
  assert.deepEqual(memberCalls, []);
  await page.locator("#settingsTab").click();
  // Representative evidence uses the same real Pi transport; adversarial text
  // above remains tested, but does not stand in for the readable UI receipt.
  await page.getByRole("tab", { name: "Worker", exact: true }).click();
  await page.locator("#run").click();
  await page.waitForFunction(
    () => document.querySelector("#state")?.textContent !== "STOPPED",
  );
  await page.reload();
  await page.locator("#studio").waitFor({ state: "visible" });
  assert.equal(new URL(page.url()).pathname, "/settings");
  assert.equal(await page.locator("#settingsPanel").isVisible(), true);
  await page.locator("#coachTab").click();
  assert.equal(new URL(page.url()).pathname, "/chat/operator");
  assert.equal(await page.locator("#nativeStart").isVisible(), true);
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await page.screenshot({
    path: evidence + "/coach-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: evidence + "/coach-mobile.png",
    fullPage: true,
  });
  assert.equal((await page.content()).includes(inactiveKey), false);
  assert.equal(store.secrets.apiKey, "synthetic-private-key");
  console.log(
    "Coach browser PASS: navigation, hidden logs, native terminal entry while worker runs, Settings edits, mobile geometry, operator-only UI and no member reads. Actual Docker Pi covered separately by native-browser tests.",
  );
} finally {
  await browser?.close();
  await app.close();
  backend.closeAllConnections();
  provider.closeAllConnections();
  await Promise.all([
    new Promise((r) => backend.close(r)),
    new Promise((r) => provider.close(r)),
  ]);
  await rm(home, { recursive: true, force: true });
}
