import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright-core";
import { Store } from "../src/config/store.js";
import { closeLeaked } from "./helpers/autonomy-cycle.js";
import { autonomyAdmin, until } from "./helpers/autonomy-admin.js";
import { chromePath } from "./helpers/chrome.js";

// C5 Autonomy section (work-packages §4 C5): Coach Settings shows local
// participation, the backend mandate, monitoring status apart from terminal
// presence, blocked items and content-free cycle receipts, at 320/390 px and
// by keyboard. The mandate is edited by CAS with an idempotency key.

after(closeLeaked);

const evidence =
  process.env.COACH_AUTONOMY_EVIDENCE || "/tmp/autonomy-browser-evidence";

async function open(width: number) {
  const env = await autonomyAdmin();
  const browser: Browser = await chromium.launch({
    executablePath: chromePath(),
    headless: true,
    args: ["--no-sandbox"],
  });
  const page: Page = await browser.newPage({
    viewport: { width, height: 844 },
  });
  return {
    env,
    page,
    async close() {
      await browser.close();
      await env.close();
    },
  };
}

const text = (page: Page, selector: string) =>
  page.locator(selector).innerText();
const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("C5 UI: Autonomy shows participation, mandate, monitoring apart from presence, blocked items and receipts, and edits by CAS", async () => {
  const { env, page, close } = await open(390);
  try {
    await mkdir(evidence, { recursive: true });
    const blockedId = env.fake.enqueue({ kind: "event" });
    Object.assign(env.fake.state.work.get(blockedId), {
      status: "blocked",
      blocked_reason: "uncertain_write",
    });
    env.fake.state.reports.unshift({
      id: "0000000000000000000000a1",
      work_id: blockedId,
      kind: "reconcile",
      result: "completed",
      coverage: {
        members_considered: 3,
        members_read: 1,
        partial: true,
        unobserved: ["images", "pages_truncated"],
      },
      counts: { acted: 1, no_action: 2, deferred: 0, escalated: 0 },
      action_slots: ["r1"],
      created_at: "2026-10-03T07:00:00.000Z",
    });
    const before = structuredClone(env.fake.state.mandate);

    await page.goto(
      env.app.origin + "/settings?section=autonomy#" + env.store.secrets.admin,
    );
    await page.locator("#autonomy").waitFor({ state: "visible" });
    assert.equal(
      await page
        .locator("#settings-autonomy-tab")
        .getAttribute("aria-selected"),
      "true",
    );
    assert.equal(await page.locator("#coachSettingsTabs").isVisible(), true);
    await page.waitForFunction(
      () =>
        (document.querySelector("#autonomyMode") as HTMLSelectElement)
          ?.value === "observe",
    );
    assert.equal(
      await page.locator("#autonomyTimezone").inputValue(),
      "Europe/Paris",
    );
    assert.equal(
      await page.locator("#autonomyQuietStart").inputValue(),
      "21:00",
    );
    assert.equal(await page.locator("#autonomyQuietEnd").inputValue(), "08:00");
    assert.equal(await page.locator("#autonomyParticipate").isChecked(), false);
    await page.waitForFunction(() =>
      document
        .querySelector("#autonomyMonitoring")
        ?.textContent?.includes("revision 1"),
    );
    assert.match(await text(page, "#autonomyLocalState"), /stopped/i);
    // Terminal presence is its own line, never folded into monitoring.
    assert.equal(await text(page, "#autonomyPresence"), "unconfirmed");
    assert.doesNotMatch(await text(page, "#autonomyMonitoring"), /presence/i);
    assert.match(await text(page, "#autonomyMonitoring"), /1 blocked/);
    assert.match(await text(page, "#autonomyBudgets"), /Checks every 60 s/);
    assert.match(
      await text(page, "#autonomyBudgets"),
      /reconciliation every 360 min/,
    );
    assert.match(await text(page, "#autonomyBudgets"), /event debounce 10 min/);
    assert.match(await text(page, "#autonomyBlocked"), /uncertain_write/);
    assert.match(await text(page, "#autonomyBlocked"), new RegExp(blockedId));
    const reports = await text(page, "#autonomyReports");
    assert.match(reports, /completed/);
    assert.match(reports, /1 acted/);
    assert.match(reports, /1 receipt/);
    assert.match(reports, /1\/3 members read/);
    assert.match(reports, /partial coverage/);
    assert.match(reports, /not observed: images, truncated pages/);
    assert.equal(await noOverflow(page), true);
    await page.screenshot({
      path: evidence + "/autonomy-390.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    assert.equal(await noOverflow(page), true);
    await page.screenshot({
      path: evidence + "/autonomy-1440.png",
      fullPage: true,
    });

    // Edit and save by CAS: unedited cadence and budgets are preserved.
    await page.locator("#autonomyPaused").check();
    await page.locator("#autonomyMemberDaily").fill("2");
    await page.locator("#autonomyDigestDay0").uncheck();
    await page.locator("#autonomyInstructions").fill("Be brief.");
    const operations = env.fake.state.operations.size;
    await page.locator("#autonomySave").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#autonomyMandateStatus")
        ?.textContent?.includes("Saved revision 2"),
    );
    const saved = env.fake.state.mandate;
    assert.equal(saved.revision, 2);
    assert.equal(saved.paused, true);
    assert.equal(saved.contact_limits.member_daily, 2);
    assert.deepEqual(saved.digest.weekdays, [1, 2, 3, 4, 5, 6]);
    assert.equal(saved.instructions, "Be brief.");
    assert.deepEqual(saved.cadence, before.cadence);
    assert.deepEqual(saved.budgets, before.budgets);
    assert.deepEqual(saved.delegated_actions, before.delegated_actions);
    assert.equal(env.fake.state.operations.size, operations + 1);
    const put = JSON.parse(
      [...env.fake.state.operations.values()].at(-1)!.body,
    );
    assert.equal(put.expected_revision, 1);
    assert.match(put.idempotency_key, /^[A-Za-z0-9_-]{16,}$/);
    await page.waitForFunction(() =>
      document
        .querySelector("#autonomyMonitoring")
        ?.textContent?.includes("paused"),
    );

    // A concurrent manager edit wins: the stale save is refused and reloaded.
    const {
      capabilities,
      protocol,
      mandate_id,
      dojo_id,
      chief_id,
      revision,
      status,
      suspended_reason,
      updated_at,
      updated_by,
      ...fields
    } = structuredClone(env.fake.state.mandate);
    void [
      capabilities,
      protocol,
      mandate_id,
      dojo_id,
      chief_id,
      revision,
      status,
      suspended_reason,
      updated_at,
      updated_by,
    ];
    const other = await env.call("PUT", "/api/autonomy/mandate", {
      idempotency_key: "concurrent-manager-edit",
      expected_revision: 2,
      mandate: { ...fields, paused: false },
    });
    assert.equal(other.status, 200);
    await page.locator("#autonomyMemberDaily").fill("3");
    await page.locator("#autonomySave").click();
    await page.waitForFunction(() =>
      /changed elsewhere/i.test(
        document.querySelector("#autonomyMandateStatus")?.textContent ?? "",
      ),
    );
    await page.waitForFunction(
      () =>
        !(document.querySelector("#autonomyPaused") as HTMLInputElement)
          .checked,
    );
    assert.equal(env.fake.state.mandate.revision, 3);
    assert.equal(env.fake.state.mandate.contact_limits.member_daily, 2);
    assert.equal(await page.locator("#autonomyMemberDaily").inputValue(), "2");

    // Participation is local to this installation and starts the host.
    await page.locator("#autonomyParticipate").check();
    await until(
      async () =>
        (await (async () => {
          const s = new Store(env.store.dir);
          await s.init();
          return s.autonomySettings().participate;
        })()) === true,
      "participation persisted",
    );
    await page.waitForFunction(
      () =>
        !/stopped/i.test(
          document.querySelector("#autonomyLocalState")?.textContent ?? "",
        ),
    );
    await page.locator("#autonomyParticipate").uncheck();
    await page.waitForFunction(() =>
      /stopped/i.test(
        document.querySelector("#autonomyLocalState")?.textContent ?? "",
      ),
    );
    assert.equal(env.store.autonomySettings().participate, false);
    assert.equal(
      (await page.content()).includes(env.store.secrets.token!),
      false,
    );
  } finally {
    await close();
  }
});

test("C5 UI: the Autonomy tab is keyboard reachable and fits 320 px", async () => {
  const { env, page, close } = await open(320);
  try {
    await mkdir(evidence, { recursive: true });
    // Hold the section's first status read so participation toggles while
    // the initial mandate load is still pending: it must still render.
    let held = false;
    await page.route("**/api/autonomy/status", async (route) => {
      if (!held) {
        held = true;
        await new Promise((r) => setTimeout(r, 1500));
      }
      await route.continue();
    });
    await page.goto(
      env.app.origin + "/settings?section=persona#" + env.store.secrets.admin,
    );
    await page.locator("#settings-persona-tab").focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "settings-autonomy-tab",
    );
    await page.locator("#autonomy").waitFor({ state: "visible" });
    assert.match(page.url(), /section=autonomy/);
    let reached = false;
    for (let i = 0; i < 6 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached =
        (await page.evaluate(() => document.activeElement?.id)) ===
        "autonomyParticipate";
    }
    assert.equal(reached, true, "participation toggle reachable by Tab");
    await page.keyboard.press("Space");
    await until(
      async () => env.store.autonomySettings().participate === true,
      "keyboard participation",
    );
    await page.waitForFunction(
      () =>
        (document.querySelector("#autonomyMode") as HTMLSelectElement)
          ?.value === "observe",
    );
    assert.equal(await noOverflow(page), true);
    await page.screenshot({
      path: evidence + "/autonomy-320.png",
      fullPage: true,
    });
  } finally {
    await close();
  }
});
