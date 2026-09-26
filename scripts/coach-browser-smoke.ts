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
  assert.equal(await page.locator("#connection").isVisible(), true);
  await page.getByRole("tab", { name: "Diagnostics", exact: true }).click();
  await page.locator("#logsView summary").click();
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
  await page.locator("#persona details summary").click();
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
  await page.locator("#stop").click();
  await page.waitForFunction(
    () => document.querySelector("#state")?.textContent === "STOPPED",
  );
  await page.locator("#save").click();
  await page.waitForFunction(() =>
    document.querySelector("#notice")?.textContent?.startsWith("Saved."),
  );
  assert.match(store.publicConfig().persona.markdown, /Explicit Settings rule/);
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
  // Synthetic member transport fixtures exercise the real UI without customer data.
  const member = (
    member_ref: string,
    display_name: string,
    access = "granted",
  ) => ({ member_ref, display_name, access });
  await page.route("**/api/members?*", (route) => {
    const more = new URL(route.request().url()).searchParams.has("cursor");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        members: more
          ? [member("c", "Synthetic Casey")]
          : [
              member("a", "Synthetic Alex"),
              member("b", "Synthetic Blair"),
              member("locked", "Synthetic Locked", "not_granted"),
            ],
        has_more: !more,
        next_cursor: more ? null : "roster-next",
      }),
    });
  });
  let memberDenied = false,
    memberEmpty = false,
    slowMember = false,
    delayedMember: any;
  await page.route("**/api/members/feed?*", (route) => {
    const url = new URL(route.request().url());
    const ref = url.searchParams.get("member_ref");
    const main = url.searchParams.get("view") === "main_conversation";
    if (slowMember && ref === "a") {
      delayedMember = route;
      return;
    }
    const more = new URL(route.request().url()).searchParams.has("cursor");
    return route.fulfill({
      status: memberDenied ? 403 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        memberDenied
          ? { error: "PRIVATE_DENIAL" }
          : {
              member_ref: ref,
              items: (memberEmpty
                ? []
                : main
                  ? ["direct-user", "direct-coach"]
                  : more
                    ? ["older"]
                    : [
                        "message",
                        "activity_event",
                        "insight",
                        "proposal_summary",
                      ]
              ).map((type, i) => ({
                id: type,
                type: type === "older" || main ? "message" : type,
                role: type === "direct-user" ? "user" : "coach",
                text: ref + " synthetic " + type,
                created_at: "2026-09-22T12:00:00Z",
                status: "completed",
              })),
              has_more: !memberEmpty && !main && !more,
              next_cursor: memberEmpty || main || more ? null : "feed-next",
            },
      ),
    });
  });
  await page.locator("#lockStudio").click();
  await page.locator("#adminKey").fill(store.secrets.admin);
  await page.locator("#unlock").click();
  await page.locator("#coachPanel").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#membersRefresh").count(),
    1,
    "read-only roster refresh exists",
  );
  await page.locator("#membersMore").click();
  await page
    .getByRole("button", { name: "Synthetic Casey", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "member strip scrolls without page overflow",
  );
  await page
    .getByRole("button", { name: "Synthetic Alex", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll(".member-item").length === 4,
  );
  assert.equal(
    await page
      .locator("#memberMainTab, #memberAllTab, #memberHint, #memberActivities")
      .count(),
    0,
  );
  assert.doesNotMatch(
    await page.locator("#coachPanel").innerText(),
    /read.only|Browse shared activities/i,
  );
  assert.equal(
    await page
      .locator("#operatorTab")
      .evaluate((e) => e.classList.contains("secondary")),
    true,
    "inactive Operator tab is not highlighted",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Synthetic Alex", exact: true })
      .evaluate((e) => e.classList.contains("secondary")),
    false,
  );
  await page.locator("#memberMore").click();
  await page.waitForFunction(
    () => document.querySelectorAll(".member-item").length === 5,
  );
  await page.waitForTimeout(15500);
  assert.equal(
    await page.locator(".member-item").count(),
    5,
    "authorization polling preserves loaded older pages when snapshot is unchanged",
  );
  await page.locator("#memberView").scrollIntoViewIfNeeded();
  await page.screenshot({ path: evidence + "/member-feed-mobile.png" });
  slowMember = true;
  await page.locator("#memberRefresh").click();
  await page.waitForTimeout(100);
  assert.ok(delayedMember);
  await page
    .getByRole("button", { name: "Synthetic Blair", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector("#memberItems")
      ?.textContent?.includes("b synthetic"),
  );
  await delayedMember.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      member_ref: "a",
      items: [
        {
          id: "late",
          type: "message",
          text: "STALE MEMBER SENTINEL",
          created_at: "",
        },
      ],
      has_more: false,
    }),
  });
  await page.waitForTimeout(100);
  assert.equal(
    (await page.locator("#memberItems").innerText()).includes(
      "STALE MEMBER SENTINEL",
    ),
    false,
  );
  assert.equal(
    await page.locator("#memberItems button").count(),
    0,
    "feed has no executable actions",
  );
  assert.equal(await page.locator("#nativeStart").isVisible(), false);
  await page
    .getByRole("button", { name: "Synthetic Blair", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector("#memberItems")
      ?.textContent?.includes("b synthetic"),
  );
  assert.equal(
    (await page.locator("#memberItems").innerText()).includes("a synthetic"),
    false,
  );
  memberEmpty = true;
  await page.locator("#memberRefresh").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#memberStatus")
      ?.textContent?.startsWith("No retained"),
  );
  assert.equal(
    await page.locator("#memberStatus").innerText(),
    "No retained Coach feed items are available.",
  );
  for (const [name, width, height] of [
    ["desktop", 1280, 1000],
    ["mobile", 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.locator("#memberView").scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      "membership empty state fits " + name,
    );
    await page.screenshot({
      path: evidence + "/membership-empty-" + name + ".png",
      fullPage: true,
    });
  }
  memberEmpty = false;
  memberDenied = true;
  await page.locator("#memberRefresh").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#memberStatus")
      ?.textContent?.includes("unavailable"),
  );
  assert.equal(
    await page.locator(".member-item").count(),
    0,
    "revocation erases old content",
  );
  await page
    .getByRole("button", { name: "Synthetic Locked", exact: true })
    .click();
  assert.equal(
    await page.locator("#memberStatus").innerText(),
    "Conversation unavailable. Check current dojo membership, chief authority and credential access in Kata.fit, then Refresh members. Category sharing controls activity records, not Coach messages.",
  );
  await page.screenshot({
    path: evidence + "/chief-sharing-unavailable.png",
    fullPage: true,
  });
  await page.locator("#operatorTab").click();
  assert.equal(await page.locator("#nativeStart").isVisible(), true);
  assert.equal(
    (await page.locator("#operatorMessages").innerText()).includes(
      "synthetic proposal_summary",
    ),
    false,
  );
  await page.locator("#settingsTab").click();
  await page.getByRole("tab", { name: "Persona", exact: true }).click();
  await page.locator("#name").fill("Synthetic authority reload");
  await page.locator("#save").click();
  await page.waitForFunction(() =>
    document.querySelector("#notice")?.textContent?.startsWith("Saved."),
  );
  assert.equal(
    await page.locator(".member-tab").count(),
    0,
    "configuration replacement clears old roster authority",
  );
  await page.unroute("**/api/members?*");
  await page.route("**/api/members?*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ members: [], has_more: false, next_cursor: null }),
    }),
  );
  await page.locator("#coachTab").click();
  await page.locator("#membersRefresh").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#membersStatus")
      ?.textContent?.startsWith("No member"),
  );
  assert.match(
    await page.locator("#membersStatus").innerText(),
    /dojo membership and credential access/,
  );
  await page.unroute("**/api/members?*");
  await page.route("**/api/members?*", (route) =>
    route.fulfill({ status: 403, contentType: "application/json", body: "{}" }),
  );
  await page.locator("#membersRefresh").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#membersStatus")
      ?.textContent?.startsWith("Member conversations unavailable"),
  );
  assert.match(
    await page.locator("#membersStatus").innerText(),
    /dojo membership, chief authority and credential access/,
  );
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
    document.querySelector("#operatorMessages")?.scrollTo(0, 0);
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
  console.log(
    "Coach browser PASS: navigation, hidden logs, native terminal entry while worker runs, explicit Settings edit, mobile geometry, synthetic member feed isolation and revoke. Actual Docker Pi covered separately by native-browser tests.",
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
