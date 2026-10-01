import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

test("late live-map detail denial purges a newer selected event snapshot of the same member", async () => {
  const home = await mkdtemp("/tmp/coach-event-denial-");
  const member = "aaaaaaaaaaaaaaaaaaaaaaaa";
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((r) => (release = r)),
    began = new Promise<void>((r) => (started = r));
  const backend = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/friends/dojo/day-events")
      res.end(
        JSON.stringify({
          users: [{ _id: member, display_name: "Fixture Ada" }],
          events: [
            {
              id: "eeeeeeeeeeeeeeeeeeeeeeee",
              user_id: member,
              occurred_at: new Date(
                Date.parse(url.searchParams.get("start")!) + 3600000,
              ).toISOString(),
              event_type: "workout.set_completed",
              subject: { type: "workout", id: "111111111111111111111111" },
              details: { exercise_index: 0, set_index: 0 },
              actor_type: "member",
              source: "interactive",
              position: {availability:"available",latitude:42,longitude:-71},
            },
          ],
          hasMore: false,
        }),
      );
    else if (url.pathname === "/api/friends/dojo/positioned-activities")
      res.end(
        JSON.stringify({
          users: [{ _id: member, display_name: "Fixture Ada" }],
          activities: [
            {
              _id: "111111111111111111111111",
              user_id: member,
              type: "workout",
              status: "complete",
              created_at: new Date(
                Date.parse(url.searchParams.get("start")!) + 3600000,
              ).toISOString(),
              position: { latitude: 42, longitude: -71 },
            },
          ],
          hasMore: false,
        }),
      );
    else if (url.pathname === "/api/friends/dojo/dashboard-members")
      res.end(
        JSON.stringify({
          members: [{ _id: member, display_name: "Fixture Ada" }],
        }),
      );
    else if (url.pathname.startsWith("/api/friends/activity/")) {
      started();
      await held;
      res.statusCode = 403;
      res.end("{}");
    } else
      res.end(JSON.stringify({ users: [], activities: [], hasMore: false }));
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
    await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (r) => r.abort());
    await page.goto(app.origin + "/dashboard");
    await page.evaluate(async (key) => {
      document.getElementById("studio")!.hidden = false;
      document.getElementById("login")!.hidden = true;
      await (window as any).CoachDashboard.load(null, key);
    }, store.secrets.admin);
    await page.locator(".dashboard-event-dot").waitFor();
    await page.locator(".dashboard-timeline-mark").waitFor();
    await page.locator(".dashboard-event-dot").click();
    await began;
    await page.locator(".dashboard-timeline-mark").click();
    assert.match(
      await page.locator("#dashboardMapSelection").innerText(),
      /Fixture Ada/,
    );
    assert.equal(
      await page
        .locator(".dashboard-event-dot")
        .getAttribute("aria-pressed"),
      "true",
    );
    const response = page.waitForResponse(
      (r) =>
        r.url().includes("/api/dashboard/activity?id=111111111111111111111111") &&
        r.status() === 403,
    );
    release();
    await response;
    await page.waitForFunction(
      () => document.querySelectorAll(".dashboard-timeline-mark").length === 0,
    );
    assert.equal(await page.locator("#dashboardMapSelection").innerText(), "");
    assert.equal(await page.locator(".dashboard-event-dot").count(), 0);
    assert.equal(
      await page.locator(".dashboard-timeline-count").textContent(),
      "0 visible · 0 loaded events across all members",
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
