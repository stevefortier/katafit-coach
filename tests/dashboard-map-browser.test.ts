import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const ui = new URL("../ui/", import.meta.url);

test("synthetic authorized map: local date, separate member pins, fresh detail, stale and private reads", async () => {
  const calls: string[] = [];
  let privateAda = false;
  let holdDate = "";
  let releaseHeld: (() => void) | undefined;
  const held = new Promise<void>((resolve) => (releaseHeld = resolve));
  const positions: Record<string, { latitude: number; longitude: number }> = {
    a1: { latitude: 40.7, longitude: -73.9 },
    a2: { latitude: 40.7, longitude: -71.9 },
    b1: { latitude: 40.7, longitude: -73.9 },
  };
  const activities = Object.keys(positions).map((_id) => ({
    _id,
    user_id: _id === "b1" ? "bob" : "ada",
    type: "workout",
    status: "complete",
    name: `Synthetic ${_id}`,
    created_at: "2026-09-28T12:00:00Z",
    position: positions[_id],
  }));
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://localhost");
    if (path.pathname === "/dashboard.js" || path.pathname === "/style.css") {
      res.setHeader(
        "content-type",
        path.pathname.endsWith(".js") ? "text/javascript" : "text/css",
      );
      res.end(await readFile(new URL("." + path.pathname, ui)));
      return;
    }
    if (path.pathname === "/") {
      res.setHeader("content-type", "text/html");
      res.end(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><section id="dashboardPanel"><label for="dashboardMapDate">Activity creation date (your device timezone)</label><input id="dashboardMapDate" type="date"><p id="dashboardMapStatus" role="status"></p><div id="dashboardMap" class="dashboard-map"></div><div id="dashboardMapSelection" class="dashboard-map-selection"></div><p id="dashboardStatus"></p><div id="dashboardCoverage"></div><div id="dashboardRoster"></div><div id="dashboardCharts"></div></section><script src="/dashboard.js"></script>`,
      );
      return;
    }
    if (!path.pathname.startsWith("/api/")) {
      res.statusCode = 404;
      res.end();
      return;
    }
    calls.push(path.pathname + path.search);
    assert.equal(req.headers.authorization, "Bearer synthetic-key");
    res.setHeader("content-type", "application/json");
    if (path.pathname === "/api/dashboard/map") {
      if (path.searchParams.get("date") === holdDate) await held;
      if (path.searchParams.get("date") === "2026-09-30") {
        const offset = Number(path.searchParams.get("cursor") || "0");
        const many = Array.from({ length: 201 }, (_, index) => ({
          _id: `many-${index}`,
          user_id: "ada",
          type: "workout",
          status: "complete",
          name: `Synthetic activity ${index}`,
          created_at: "2026-09-30T12:00:00Z",
          position: {
            latitude: 35 + index * 0.1,
            longitude: -150 + index * 1.4,
          },
        }));
        res.end(
          JSON.stringify({
            users: [{ _id: "ada", display_name: "Synthetic Ada" }],
            activities: many.slice(offset, offset + 100),
            hasMore: offset + 100 < many.length,
            nextCursor:
              offset + 100 < many.length ? String(offset + 100) : null,
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          users: [
            { _id: "ada", display_name: "Synthetic Ada" },
            { _id: "bob", display_name: "Synthetic Bob" },
          ],
          activities,
          hasMore: false,
          oldestDate: null,
        }),
      );
    } else if (path.pathname === "/api/dashboard/activity") {
      const id = path.searchParams.get("id")!;
      const source = activities.find((activity) => activity._id === id);
      if (!source || (privateAda && source.user_id === "ada")) {
        res.statusCode = 403;
        res.end("{}");
      } else
        res.end(
          JSON.stringify({
            owner: { _id: source.user_id },
            activity: {
              ...source,
              position: positions[id],
              data:
                id === "a1"
                  ? {
                      exercises: [
                        {
                          name: "Synthetic squat",
                          sets: [{ reps: 8, weight: 60 }],
                        },
                      ],
                      internal_token: "fixture-secret",
                    }
                  : {},
              ...(id === "b1"
                ? { workout_progress: { completed_sets: 5 } }
                : {}),
            },
          }),
        );
    } else if (path.pathname === "/api/dashboard") {
      res.end(JSON.stringify({ users: [], activities: [], hasMore: false }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 850 },
      timezoneId: "America/New_York",
    });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) =>
        assert.ok(
          new URL(request.url()).origin ===
            `http://127.0.0.1:${(server.address() as any).port}`,
          "no third-party map/tile requests",
        ),
      );
      await page.goto(`http://127.0.0.1:${(server.address() as any).port}/`);
      await page.evaluate(() =>
        (window as any).CoachDashboard.load(null, "synthetic-key"),
      );
      await page.locator("#dashboardMapDate").waitFor();
      const localToday = await page.evaluate(() => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      });
      assert.equal(
        await page.locator("#dashboardMapDate").inputValue(),
        localToday,
      );
      const firstMap = calls.find((url) =>
        url.startsWith("/api/dashboard/map?"),
      );
      assert.ok(firstMap);
      assert.equal(
        new URL(firstMap!, "http://fixture").searchParams.get("date"),
        localToday,
      );
      await page.locator("#dashboardMapDate").fill("2026-09-28");
      await page.locator("#dashboardMapDate").dispatchEvent("change");
      await page.waitForFunction(
        () =>
          document
            .querySelector("#dashboardMapStatus")
            ?.textContent?.includes("2026-09-28") &&
          !!document.querySelector(".dashboard-map-marker"),
      );
      const dated = calls.find((url) =>
        url.startsWith("/api/dashboard/map?date=2026-09-28&"),
      );
      assert.ok(dated, "date request includes local boundaries");
      const bounds = new URL(dated!, "http://fixture").searchParams;
      assert.equal(bounds.get("start"), "2026-09-28T04:00:00.000Z");
      assert.equal(bounds.get("end"), "2026-09-29T04:00:00.000Z");
      await page
        .getByRole("button", { name: /Synthetic Ada activity: Synthetic a1/i })
        .waitFor();
      assert.equal(
        await page.locator("#dashboardMap .dashboard-map-marker").count(),
        3,
        "one pin per positioned activity",
      );
      const adaPins = page.getByRole("button", {
        name: /Synthetic Ada activity:/i,
      });
      assert.equal(await adaPins.count(), 2);
      assert.deepEqual(await adaPins.allTextContents(), ["SA", "SA"]);
      assert.equal(
        await page
          .getByRole("button", { name: /Synthetic Bob activity:/i })
          .textContent(),
        "SB",
      );
      assert.equal(
        await adaPins.first().getAttribute("data-member-id"),
        await adaPins.last().getAttribute("data-member-id"),
      );
      assert.notEqual(
        await adaPins.first().getAttribute("data-member-id"),
        await page
          .getByRole("button", { name: /Synthetic Bob activity:/i })
          .getAttribute("data-member-id"),
      );
      assert.equal(
        await adaPins
          .first()
          .evaluate((pin) => getComputedStyle(pin).backgroundColor),
        await adaPins
          .last()
          .evaluate((pin) => getComputedStyle(pin).backgroundColor),
      );
      assert.notEqual(
        await adaPins
          .first()
          .evaluate((pin) => getComputedStyle(pin).backgroundColor),
        await page
          .getByRole("button", { name: /Synthetic Bob activity:/i })
          .evaluate((pin) => getComputedStyle(pin).backgroundColor),
        "members use distinct pin colors in addition to labeled initials",
      );
      assert.match(
        (await adaPins.first().getAttribute("style")) || "",
        /left: 29\./,
      );
      assert.match(
        (await adaPins.last().getAttribute("style")) || "",
        /left: (?:calc\()?30\./,
        "second Ada activity retains its different geographic anchor",
      );
      assert.equal(
        calls.filter((url) => url.startsWith("/api/dashboard/activity?"))
          .length,
        0,
        "feed positions must not trigger N+1 detail reads",
      );
      positions.b1.longitude = -73.8; // nearby but not identical, still overlaps on a world map
      await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().includes("/api/dashboard/map?date=2026-09-28") &&
            response.ok(),
        ),
        page.locator("#dashboardMapDate").dispatchEvent("change"),
      ]);
      await page.waitForFunction(
        () =>
          document.querySelectorAll("#dashboardMap .dashboard-map-marker")
            .length === 3,
      );
      const separation = await page
        .locator("#dashboardMap .dashboard-map-marker")
        .evaluateAll((pins) => {
          const [a, b] = [pins[0], pins[2]].map((pin) =>
            pin.getBoundingClientRect(),
          );
          return {
            dx: Math.abs(a.x - b.x),
            dy: Math.abs(a.y - b.y),
            width: Math.max(a.width, b.width),
          };
        });
      assert.ok(
        separation.dx >= separation.width || separation.dy >= separation.width,
        "nearby members remain independently visible, not overlaid",
      );
      assert.ok(
        (await page.locator(".dashboard-map-pin-link").count()) >= 2,
        "offset activity badges retain visible connections to geographic anchors",
      );
      positions.b1.longitude = -73.9;
      await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().includes("/api/dashboard/map?date=2026-09-28") &&
            response.ok(),
        ),
        page.locator("#dashboardMapDate").dispatchEvent("change"),
      ]);
      await page.waitForFunction(
        () =>
          document.querySelectorAll("#dashboardMap .dashboard-map-marker")
            .length === 3,
      );
      await page.getByRole("button", { name: "Zoom in" }).click();
      await page.getByRole("button", { name: "Pan right" }).click();
      assert.match(
        (await page.locator(".dashboard-map-canvas").getAttribute("style")) ||
          "",
        /translate\(/,
      );
      await page.getByRole("button", { name: "Zoom out" }).click();
      await page
        .getByRole("button", { name: /Synthetic Ada activity: Synthetic a1/i })
        .click();
      await page.getByText("Synthetic a1").waitFor();
      await page.locator("#dashboardMapSelection details summary").click();
      const workoutDetail = await page
        .locator("#dashboardMapSelection details pre")
        .innerText();
      assert.match(workoutDetail, /Synthetic squat/);
      assert.match(workoutDetail, /"reps": 8/);
      assert.doesNotMatch(workoutDetail, /internal_token|fixture-secret/);
      assert.equal(
        await page.locator("#dashboardMapSelection button").count(),
        0,
        "the pin opens its activity directly",
      );
      await page.screenshot({
        path: "/tmp/coach-dashboard-map-synthetic-390.png",
        fullPage: true,
      });
      await page
        .getByRole("button", { name: /Synthetic Ada activity: Synthetic a2/i })
        .click();
      await page.getByText("Synthetic a2").waitFor();
      await page
        .getByRole("button", { name: /Synthetic Bob activity: Synthetic b1/i })
        .click();
      await page.getByText("Completed sets: 5").waitFor();
      assert.match(
        (await page.locator("#dashboardMapSelection").textContent()) || "",
        /Synthetic b1.*workout.*2026-09-28/s,
      );
      positions.b1.longitude = -73.7;
      await page
        .getByRole("button", { name: /Synthetic Bob activity: Synthetic b1/i })
        .click();
      await page.getByText(/location changed|refresh the map/i).waitFor();
      positions.b1.longitude = -73.9;
      await page
        .getByRole("button", { name: /Synthetic Ada activity: Synthetic a1/i })
        .click();
      await page.getByText("Synthetic a1").waitFor();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({
        path: "/tmp/coach-dashboard-map-synthetic-1440.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 320, height: 850 });
      await page.screenshot({
        path: "/tmp/coach-dashboard-map-synthetic-320.png",
        fullPage: true,
      });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        "320px map fits viewport",
      );
      await page.setViewportSize({ width: 390, height: 850 });
      privateAda = true;
      await page.getByRole("button", { name: /Synthetic a1/ }).click();
      await page.getByText(/denied|unavailable/i).waitFor();
      assert.ok(
        !(await page.locator("#dashboardMapSelection").textContent())?.includes(
          "40.7",
        ),
        "no coordinates after revoked detail",
      );
      assert.ok(
        calls.filter((url) => url === "/api/dashboard/activity?id=a1").length >=
          2,
        "fresh detail on click",
      );
      for (const [day, start, end] of [
        ["2026-03-08", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"],
        ["2026-11-01", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
      ]) {
        await page.locator("#dashboardMapDate").fill(day);
        await page.locator("#dashboardMapDate").dispatchEvent("change");
        await page.waitForFunction(
          (value) =>
            document
              .querySelector("#dashboardMapStatus")
              ?.textContent?.includes(value),
          day,
        );
        const query = new URL(
          calls.findLast((url) =>
            url.startsWith(`/api/dashboard/map?date=${day}&`),
          )!,
          "http://fixture",
        ).searchParams;
        assert.equal(query.get("start"), start);
        assert.equal(query.get("end"), end);
      }
      await page.locator("#dashboardMapDate").fill("2026-09-30");
      await page.locator("#dashboardMapDate").dispatchEvent("change");
      await page.waitForFunction(
        () =>
          document.querySelectorAll("#dashboardMap .dashboard-map-marker")
            .length === 201,
      );
      assert.match(
        await page.locator("#dashboardMapStatus").innerText(),
        /201 activities.*complete selected date/i,
      );
      assert.deepEqual(
        new Set(
          calls
            .filter((url) =>
              url.startsWith("/api/dashboard/map?date=2026-09-30&"),
            )
            .map(
              (url) =>
                new URL(url, "http://fixture").searchParams.get("cursor") ||
                "first",
            ),
        ),
        new Set(["first", "100", "200"]),
        "all authorized activities across opaque pages are loaded, beyond the former cap",
      );
      holdDate = "2026-09-27";
      await page.locator("#dashboardMapDate").fill(holdDate);
      await page.locator("#dashboardMapDate").dispatchEvent("change");
      await page.locator("#dashboardMapDate").fill("2026-09-26");
      await page.locator("#dashboardMapDate").dispatchEvent("change");
      releaseHeld!();
      await page.getByText(/2026-09-26/).waitFor();
      assert.ok(
        !(await page.locator("#dashboardMapStatus").textContent())?.includes(
          "2026-09-27",
        ),
        "late day cannot replace current day",
      );
      await page.evaluate(() => (window as any).CoachDashboard.clear());
      assert.equal(
        await page.locator("#dashboardMap .dashboard-map-marker").count(),
        0,
      );
      assert.equal(
        await page.locator("#dashboardMapSelection").textContent(),
        "",
      );
      assert.deepEqual(errors, []);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        "mobile no overflow",
      );
    } finally {
      await context.close();
    }
  } finally {
    releaseHeld!();
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
