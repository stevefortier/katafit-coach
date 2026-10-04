import test from "node:test";
import { timelineCounts } from "./helpers/timeline-counts.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

test("map-independent member filtering clears event selection and fences held old event pages", async () => {
  const home = await mkdtemp("/tmp/coach-event-scopes-");
  const ada = "aaaaaaaaaaaaaaaaaaaaaaaa",
    bob = "bbbbbbbbbbbbbbbbbbbbbbbb";
  let release!: () => void, started!: () => void, finished!: () => void;
  const held = new Promise<void>((r) => (release = r)),
    began = new Promise<void>((r) => (started = r)),
    ended = new Promise<void>((r) => (finished = r));
  const backend = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/api/friends/dojo/day-events?")) {
      const start = new URL(req.url!, "http://fixture").searchParams.get(
        "start",
      )!;
      if (start.startsWith("2026-11-02")) {
        started();
        await held;
      }
      res.end(
        JSON.stringify({
          users: [
            { _id: ada, display_name: "Fixture Ada" },
            { _id: bob, display_name: "Fixture Bob" },
          ],
          events: [ada, ada, bob].map((user_id, i) => ({
            id: `${start.slice(0, 10)}-${i}`,
            user_id,
            occurred_at: new Date(Date.parse(start) + 3600000).toISOString(),
            event_type: "workout.set_completed",
            subject: { type: "workout", id: "deleted" },
            details: {
              exercise_index: 0,
              set_index: i,
              changed_fields: ["complete"],
            },
            actor_type: "member",
            source: "interactive",
          })),
          hasMore: false,
        }),
      );
      if (start.startsWith("2026-11-02")) finished();
    } else if (req.url === "/api/friends/dojo/dashboard-members")
      res.end(
        JSON.stringify({
          members: [
            { _id: ada, display_name: "Fixture Ada" },
            { _id: bob, display_name: "Fixture Bob" },
          ],
        }),
      );
    else res.end(JSON.stringify({ users: [], activities: [], hasMore: false }));
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(backend.address() as any).port}`,
    token: "fixture-token",
  });
  const app = await admin(store, 0);
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage({ timezoneId: "UTC" });
    await page.clock.setFixedTime(new Date("2026-12-01T12:00:00Z"));
    await page.goto(app.origin + "/dashboard");
    await page.evaluate(async (key) => {
      document.getElementById("studio")!.hidden = false;
      document.getElementById("login")!.hidden = true;
      (window as any).L = undefined;
      await (window as any).CoachDashboard.load(null, key);
    }, store.secrets.admin);
    const change = async (day: string) => {
      await page.locator("#dashboardMapDate").fill(day);
      await page.locator("#dashboardMapDate").dispatchEvent("change");
    };
    await change("2026-11-01");
    await page
      .locator('[data-event-id="2026-11-01-2"]')
      .waitFor({ state: "attached" });
    await page.locator(".dashboard-timeline-cluster").click();
    await page
      .locator('.dashboard-timeline-choice[data-event-id="2026-11-01-0"]')
      .click();
    await page
      .locator(
        `#dashboardMemberCards .dashboard-member-portrait[data-member-id="${bob}"]`,
      )
      .locator("..")
      .click();
    assert.equal(
      await page.locator(".dashboard-timeline-mark:visible").count(),
      1,
    );
    assert.deepEqual(await timelineCounts(page), { represented: 1, loaded: 3 });
    assert.equal(await page.locator("#dashboardMapSelection").innerText(), "");
    await page.locator('[data-event-id="2026-11-01-2"]').click();
    await page.getByRole("button", { name: "Select All", exact: true }).click();
    assert.equal(await page.locator(".dashboard-timeline-mark").count(), 3);
    assert.equal(await page.locator("#dashboardMapSelection").innerText(), "");
    await change("2026-11-02");
    await began;
    await change("2026-11-03");
    await page
      .locator('[data-event-id="2026-11-03-2"]')
      .waitFor({ state: "attached" });
    await page
      .locator(
        `#dashboardMemberCards .dashboard-member-portrait[data-member-id="${bob}"]`,
      )
      .locator("..")
      .click();
    await page.locator('[data-event-id="2026-11-03-2"]').click();
    release();
    await ended;
    // Await browser animation frames so any late completion has an opportunity to commit.
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    assert.equal(
      await page.locator('[data-event-id^="2026-11-02"]').count(),
      0,
    );
    assert.equal(
      await page.locator(".dashboard-timeline-mark:visible").count(),
      1,
    );
    assert.match(
      await page.locator("#dashboardMapSelection").innerText(),
      /Fixture Bob/,
    );
    assert.match(
      await page.locator("#dashboardMapSelection").innerText(),
      /2026-11-03/,
    );
  } finally {
    release();
    await browser.close();
    await app.close();
    backend.closeAllConnections();
    await new Promise<void>((r) => backend.close(() => r()));
    await rm(home, { recursive: true, force: true });
  }
});
