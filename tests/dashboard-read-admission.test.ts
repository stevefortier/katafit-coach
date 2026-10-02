import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

// Real admin admission/restGet/HTTP/browser; only upstream data and timing are
// synthetic. Gates keep the race deterministic rather than relying on latency.
test(
  "dashboard admits at most three held reads across initial load and date cancellation",
  { timeout: 45000 },
  async () => {
    const home = await mkdtemp(tmpdir() + "/dashboard-admission-");
    const member = "aaaaaaaaaaaaaaaaaaaaaaaa";
    const second = "bbbbbbbbbbbbbbbbbbbbbbbb";
    const calls: string[] = [];
    const held = new Map<ServerResponse, () => void>();
    const avatarReads = new WeakSet<ServerResponse>();
    let active = 0,
      maximum = 0;
    let activeAvatars = 0,
      maximumAvatars = 0;
    let holdPrimary = true;
    let holdAvatars = true;
    let holdDate = "";
    const upstream = createServer((req, res) => {
      const url = new URL(req.url!, "http://localhost");
      calls.push(url.pathname + url.search);
      active++;
      maximum = Math.max(maximum, active);
      const avatar = url.pathname.includes("/avatar/");
      if (avatar) {
        avatarReads.add(res);
        maximumAvatars = Math.max(maximumAvatars, ++activeAvatars);
      }
      res.once("close", () => {
        active--;
        if (avatar) activeAvatars--;
        held.delete(res);
      });
      const roster = url.pathname.endsWith("dashboard-members");
      const dayRead = /day-events|positioned-activities/.test(url.pathname);
      const finish = () => {
        held.delete(res);
        res.setHeader("Content-Type", "application/json");
        if (avatar) {
          res.statusCode = 404;
          res.end("{}");
          return;
        }
        if (roster) {
          res.end(
            JSON.stringify({
              members: [member, second].map((_id) => ({
                _id,
                display_name: "Synthetic member",
                stats: {},
              })),
              hasMore: false,
            }),
          );
          return;
        }
        const entry = {
          _id: "synthetic-activity",
          user_id: member,
          type: "workout",
          name: "Synthetic workout",
          status: "complete",
          created_at:
            (url.searchParams.get("start") || new Date().toISOString()).slice(
              0,
              10,
            ) + "T12:00:00.000Z",
          position: { latitude: 42, longitude: -71 },
        };
        res.end(
          JSON.stringify({
            users: [{ _id: member, display_name: "Synthetic member" }],
            activities: dayRead ? [entry] : [],
            events: url.pathname.endsWith("day-events")
              ? [
                  {
                    id: "synthetic-event",
                    user_id: member,
                    event_type: "workout.created",
                    occurred_at: entry.created_at,
                    subject: { type: "workout", id: entry._id },
                    details: {},
                    // The map plots the event's own canonical recorded fix.
                    position: {
                      availability: "available",
                      latitude: 42,
                      longitude: -71,
                      accuracy: 5,
                      captured_at: entry.created_at,
                      source: "gps",
                    },
                  },
                ]
              : [],
            hasMore: false,
          }),
        );
      };
      if (
        (avatar && holdAvatars) ||
        (!roster && !avatar && holdPrimary) ||
        (dayRead &&
          url.searchParams.get("start")?.startsWith(holdDate) &&
          holdDate)
      )
        held.set(res, finish);
      else finish();
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    let app: Awaited<ReturnType<typeof admin>> | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    const release = () => {
      for (const finish of [...held.values()]) finish();
    };
    try {
      const store = new Store(home);
      await store.init();
      await store.save({
        ...store.publicConfig(),
        origin: `http://127.0.0.1:${(upstream.address() as any).port}`,
        token: "synthetic-only-token",
      });
      app = await admin(store, 0);
      browser = await chromium.launch({
        executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
        args: ["--no-sandbox"],
      });
      const page = await browser.newPage({ timezoneId: "UTC" });
      const statuses: number[] = [];
      page.on("response", (response) => {
        if (response.url().includes("/api/dashboard"))
          statuses.push(response.status());
      });
      await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (route) =>
        route.abort(),
      );
      await page.goto(app.origin + "/dashboard");
      await page.locator("#adminKey").fill(store.secrets.admin);
      await page.locator("#unlock").click();
      await assertEventually(() => held.size >= 3);
      // Every initial primary is deliberately held; roster may free a slot for
      // avatars but must not create a fifth BFF request or a fourth admitted read.
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.ok(
        maximum <= 3,
        `initial held upstream concurrency ${maximum}; statuses ${statuses}`,
      );
      assert.ok(!statuses.includes(429), `initial self-throttle: ${statuses}`);
      holdPrimary = false;
      // Map and timeline share one day-events read, so an avatar may already
      // hold the third lane; release only primaries and keep avatars held.
      for (const [res, finish] of [...held])
        if (!avatarReads.has(res)) finish();
      await assertEventually(() => [...held.keys()].length === 2);
      await page.waitForFunction(
        () => document.querySelectorAll(".dashboard-event-dot").length === 1,
      );
      const change = async (date: string) => {
        await page.locator("#dashboardMapDate").fill(date);
        await page.locator("#dashboardMapDate").dispatchEvent("change");
      };
      // Two old avatar reads remain held across a date change. They cannot be
      // prematurely removed from admission just because their caller aborts.
      await change("2026-09-28");
      await assertEventually(() =>
        calls.some((url) => url.includes("day-events?start=2026-09-28")),
      );
      await page.waitForFunction(
        () =>
          document
            .querySelector("#dashboardTimeline")
            ?.textContent?.includes("2026-09-28") &&
          document.querySelectorAll(".dashboard-event-dot").length === 1,
      );
      assert.ok(!statuses.includes(429), `date self-throttle: ${statuses}`);
      assert.ok(maximum <= 3, `date held upstream concurrency ${maximum}`);
      holdDate = "2026-09-29";
      await change(holdDate);
      await assertEventually(
        () =>
          held.size === 3 &&
          calls.some((url) => url.includes("start=2026-09-29")),
      );
      assert.ok(
        maximumAvatars <= 2,
        `old/new avatar reads blocked the primary lane: ${maximumAvatars}`,
      );
      assert.equal(
        activeAvatars,
        2,
        "old avatars remain held while the new primary read starts",
      );
      await page.evaluate(() => {
        const input = document.getElementById(
          "dashboardMapDate",
        ) as HTMLInputElement;
        for (const date of ["2026-11-01", "2026-11-02"]) {
          input.value = date;
          input.dispatchEvent(new Event("change"));
        }
        (window as any).CoachDashboard.clear();
      });
      holdAvatars = false;
      holdDate = "";
      release();
      await assertEventually(() => active === 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(
        !calls.some((url) => /start=2026-11-01|start=2026-11-02/.test(url)),
        `canceled dates dispatched: ${calls}`,
      );
      const clearedCalls = [...calls];
      await page.evaluate(() => {
        const input = document.getElementById(
          "dashboardMapDate",
        ) as HTMLInputElement;
        input.value = "2026-11-03";
        input.dispatchEvent(new Event("change"));
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(
        calls,
        clearedCalls,
        "locked date handler must not dispatch more reads",
      );
      assert.equal(await page.locator(".dashboard-timeline-mark").count(), 0);
      assert.equal(await page.locator(".dashboard-event-dot").count(), 0);
      assert.ok(!statuses.includes(429), `self-throttle: ${statuses}`);
      console.log(
        JSON.stringify({
          maximum,
          statuses,
          canceledDatesNotDispatched: true,
          active,
        }),
      );
    } finally {
      release();
      await browser?.close();
      await app?.close();
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
      await rm(home, { recursive: true, force: true });
    }
  },
);

async function assertEventually(check: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "held-read condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
