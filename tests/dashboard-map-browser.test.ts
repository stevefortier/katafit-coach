import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import sharp from "sharp";

const ui = new URL("../ui/", import.meta.url);
const leaflet = new URL("../node_modules/leaflet/dist/", import.meta.url);
const ada = "aaaaaaaaaaaaaaaaaaaaaaaa";
const bob = "bbbbbbbbbbbbbbbbbbbbbbbb";

test("synthetic authorized map: local date, separate member pins, fresh detail, stale and private reads", async () => {
  const avatarPng = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#385c80"/><circle cx="32" cy="24" r="13" fill="#dcb998"/><path d="M7 64 Q32 30 57 64" fill="#dcb998"/></svg>',
    ),
  )
    .png()
    .toBuffer();
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
    user_id: _id === "b1" ? bob : ada,
    type: "workout",
    status: "complete",
    name: `Synthetic ${_id}`,
    created_at: "2026-09-28T12:00:00Z",
    position: positions[_id],
  }));
  const avatars: string[] = [];
  const tiles: string[] = [];
  let activeAvatars = 0;
  let peakAvatars = 0;
  let enforceAvatarLimit = false;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://localhost");
    if (
      path.pathname === "/leaflet.js" ||
      path.pathname === "/leaflet.css" ||
      path.pathname.startsWith("/images/")
    ) {
      res.setHeader(
        "content-type",
        path.pathname.endsWith(".css")
          ? "text/css"
          : path.pathname.endsWith(".png")
            ? "image/png"
            : "text/javascript",
      );
      res.end(
        await readFile(
          new URL(
            path.pathname === "/leaflet.js"
              ? "leaflet.js"
              : path.pathname === "/leaflet.css"
                ? "leaflet.css"
                : path.pathname.slice(1),
            leaflet,
          ),
        ),
      );
      return;
    }
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
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/leaflet.css"><section id="dashboardPanel"><label for="dashboardMapDate">Activity creation date (your device timezone)</label><input id="dashboardMapDate" type="date"><p id="dashboardMapStatus" role="status"></p><div id="dashboardMap" class="dashboard-map"></div><div id="dashboardMapSelection" class="dashboard-map-selection"></div><p id="dashboardStatus"></p><div id="dashboardCoverage"></div><div id="dashboardRoster"></div><div id="dashboardCharts"></div></section><script src="/leaflet.js"></script><script src="/dashboard.js"></script>`,
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
    if (path.pathname === "/api/dashboard/avatar") {
      avatars.push(path.searchParams.get("id") || "");
      activeAvatars++;
      peakAvatars = Math.max(peakAvatars, activeAvatars);
      await new Promise((resolve) => setTimeout(resolve, 40));
      activeAvatars--;
      res.statusCode =
        enforceAvatarLimit && activeAvatars >= 4
          ? 429
          : path.searchParams.get("id") === bob
            ? 404
            : 200;
      res.setHeader("content-type", "image/png");
      res.end(res.statusCode === 404 ? "" : avatarPng);
      return;
    }
    res.setHeader("content-type", "application/json");
    if (path.pathname === "/api/dashboard/map") {
      if (path.searchParams.get("date") === holdDate) await held;
      if (
        ["2026-09-25", "2026-09-24"].includes(
          path.searchParams.get("date") || "",
        )
      ) {
        const day = path.searchParams.get("date");
        const points = day === "2026-09-25" ? [179, -179] : [179];
        res.end(
          JSON.stringify({
            users: [{ _id: ada, display_name: "Synthetic Ada" }],
            activities: points.map((longitude, index) => ({
              _id: (index + 200).toString(16).padStart(24, "0"),
              user_id: ada,
              type: "workout",
              status: "complete",
              name: `Synthetic Pacific ${index}`,
              created_at: `${day}T12:00:00Z`,
              position: { latitude: 10, longitude },
            })),
            hasMore: false,
            nextCursor: null,
          }),
        );
        return;
      }
      if (path.searchParams.get("date") === "2026-09-29") {
        const ids = Array.from({ length: 12 }, (_, i) =>
          (i + 20).toString(16).padStart(24, "0"),
        );
        res.end(
          JSON.stringify({
            users: ids.map((_id) => ({
              _id,
              display_name: `Synthetic Member ${_id}`,
            })),
            activities: ids.map((user_id, i) => ({
              _id: (i + 100).toString(16).padStart(24, "0"),
              user_id,
              type: "workout",
              status: "complete",
              name: `Synthetic ${i}`,
              created_at: "2026-09-29T12:00:00Z",
              position: {
                latitude: 40.7 + i * 0.002,
                longitude: -73.9 + i * 0.002,
              },
            })),
            hasMore: false,
            nextCursor: null,
          }),
        );
        return;
      }
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
            { _id: ada, display_name: "Synthetic Ada" },
            { _id: bob, display_name: "Synthetic Bob" },
          ],
          activities:
            path.searchParams.get("date") === "2026-09-28" ? activities : [],
          hasMore: false,
          nextCursor: null,
        }),
      );
    } else if (path.pathname === "/api/dashboard/activity") {
      const id = path.searchParams.get("id")!;
      const source = activities.find((activity) => activity._id === id);
      if (!source || (privateAda && source.user_id === ada)) {
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
      await page.clock.install({ time: new Date("2026-10-02T12:00:00Z") });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route(
        /^https:\/\/[abc]\.tile\.openstreetmap\.org\//,
        (route) => {
          tiles.push(route.request().url());
          return route.fulfill({
            status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#273845"/><path d="M0 128H256M128 0V256" stroke="#49616b" stroke-width="2"/><text x="20" y="28" fill="#a8b5ba" font-size="13">SYNTHETIC TILE</text></svg>',
          });
        },
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
      assert.ok(
        tiles.some((url) =>
          /^https:\/\/[abc]\.tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/.test(
            url,
          ),
        ),
        "OSM tiles requested",
      );
      assert.match(
        await page
          .locator("#dashboardMap .leaflet-control-attribution")
          .innerText(),
        /OpenStreetMap/,
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
      const pinCenters = await adaPins.evaluateAll((pins) =>
        pins.map((pin) => pin.getBoundingClientRect().x),
      );
      assert.notEqual(
        pinCenters[0],
        pinCenters[1],
        "different geographic anchors visible at local zoom",
      );
      assert.ok(
        tiles.some((url) => Number(new URL(url).pathname.split("/")[1]) >= 5),
        "local zoom, not world scale",
      );
      await page.waitForFunction(
        () => !!document.querySelector(".dashboard-map-avatar"),
      );
      assert.equal(await adaPins.first().locator("img").count(), 1);
      assert.equal(
        await page
          .getByRole("button", { name: /Synthetic Bob activity:/i })
          .locator("img")
          .count(),
        0,
      );
      assert.ok(
        avatars.includes(ada) && avatars.includes(bob),
        "visible members request avatars",
      );
      assert.ok(
        avatars.length <=
          2 *
            calls.filter((url) =>
              url.startsWith("/api/dashboard/map?date=2026-09-28&"),
            ).length,
        "not per-activity avatar reads",
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
      await page.locator(".leaflet-control-zoom-in").click();
      await page
        .locator("#dashboardMap")
        .dragTo(page.locator("#dashboardMap"), {
          sourcePosition: { x: 160, y: 150 },
          targetPosition: { x: 190, y: 170 },
        });
      await page.locator(".leaflet-control-zoom-out").click();
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
      peakAvatars = 0;
      enforceAvatarLimit = true;
      await page.locator("#dashboardMapDate").fill("2026-09-29");
      await page.locator("#dashboardMapDate").dispatchEvent("change");
      await page.waitForFunction(
        () => document.querySelectorAll(".dashboard-map-marker").length === 12,
      );
      await page.waitForFunction(
        () => document.querySelectorAll(".dashboard-map-avatar").length === 12,
        undefined,
        { timeout: 2500 },
      );
      assert.ok(
        peakAvatars <= 3,
        `avatar concurrency bounded; observed ${peakAvatars}`,
      );
      assert.ok(
        avatars.every((id) => /^[0-9a-f]{24}$/.test(id)),
        "only canonical member IDs used for avatar calls",
      );
      const denseInside = await page
        .locator("#dashboardMap")
        .evaluate((map) => {
          const bounds = map.getBoundingClientRect();
          return [...map.querySelectorAll(".dashboard-map-marker")].every(
            (pin) => {
              const rect = pin.getBoundingClientRect();
              return (
                rect.left >= bounds.left - 1 &&
                rect.right <= bounds.right + 1 &&
                rect.top >= bounds.top - 1 &&
                rect.bottom <= bounds.bottom + 1
              );
            },
          );
        });
      assert.ok(denseInside, "dense pins remain inside narrow map");
      const displaced = await page.locator("#dashboardMap").evaluate((map) => {
        const link = map.querySelector(".dashboard-map-pin-link:not([hidden])");
        const anchor = link?.nextElementSibling;
        const marker = anchor?.nextElementSibling;
        if (!link || !anchor || !marker) return false;
        (window as any).__revokedGeometry = [link, anchor];
        (marker as HTMLButtonElement).click();
        return true;
      });
      assert.ok(displaced, "fixture includes a displaced activity pin");
      await page
        .locator("#dashboardMapSelection")
        .getByText(/denied|unavailable/i)
        .waitFor();
      assert.equal(
        await page.evaluate(() =>
          (window as any).__revokedGeometry.every(
            (element: Element) => !element.isConnected,
          ),
        ),
        true,
        "denied detail removes its true-location dot and connector immediately",
      );
      for (const [day, expectedPins] of [
        ["2026-09-25", 2],
        ["2026-09-24", 1],
      ] as const) {
        await page.locator("#dashboardMapDate").fill(day);
        await page.locator("#dashboardMapDate").dispatchEvent("change");
        await page.waitForFunction(
          (count) =>
            document.querySelectorAll(".dashboard-map-marker").length === count,
          expectedPins,
        );
        const geometry = await page.locator("#dashboardMap").evaluate((map) => {
          const bounds = map.getBoundingClientRect();
          return [...map.querySelectorAll(".dashboard-map-marker")].map(
            (pin) => {
              const rect = pin.getBoundingClientRect();
              return {
                x: rect.x - bounds.x,
                y: rect.y - bounds.y,
                width: bounds.width,
                height: bounds.height,
              };
            },
          );
        });
        assert.ok(
          geometry.every(
            ({ x, y, width, height }) =>
              x >= -1 && x + 34 <= width + 1 && y >= -1 && y + 34 <= height + 1,
          ),
          "Pacific points visible within narrow viewport",
        );
        assert.ok(
          tiles
            .slice(-12)
            .some(
              (url) =>
                Number(new URL(url).pathname.split("/")[1]) >=
                (expectedPins === 1 ? 15 : 5),
            ),
          "antimeridian and singleton remain local scale",
        );
        if (expectedPins === 1) {
          const box = await page.locator("#dashboardMap").boundingBox();
          assert.ok(box);
          const x = box.x + box.width * 0.1,
            y = box.y + box.height / 2;
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(x + box.width * 0.8, y, { steps: 8 });
          await page.mouse.up();
          assert.equal(
            await page
              .locator("#dashboardMap .dashboard-map-marker:visible")
              .count(),
            0,
            "panning cannot show a displaced pin after its true anchor leaves the viewport",
          );
          await page.mouse.move(x + box.width * 0.8, y);
          await page.mouse.down();
          await page.mouse.move(x, y, { steps: 8 });
          await page.mouse.up();
          await page.waitForFunction(
            () =>
              document
                .querySelector("#dashboardMap .dashboard-map-marker")
                ?.getClientRects().length,
          );
        }
      }
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
      const changeDay = (day: string) =>
        page.locator("#dashboardMapDate").evaluate((input, value) => {
          (input as HTMLInputElement).value = value;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }, day);
      await Promise.all([
        page.waitForRequest((request) =>
          request.url().includes("/api/dashboard/map?date=2026-09-27&"),
        ),
        changeDay(holdDate),
      ]);
      await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().includes("/api/dashboard/map?date=2026-09-26&") &&
            response.ok(),
        ),
        changeDay("2026-09-26"),
      ]);
      releaseHeld!();
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardMapStatus")
          ?.textContent?.startsWith("2026-09-26 activity creation date"),
      );
      assert.ok(
        !(await page.locator("#dashboardMapStatus").textContent())?.includes(
          "2026-09-27",
        ),
        "late day cannot replace current day",
      );
      // Optional visual evidence with real OSM tiles: only synthetic fixture positions.
      await page.unroute(/^https:\/\/[abc]\.tile\.openstreetmap\.org\//);
      try {
        const realTile = page.waitForResponse(
          (response) =>
            /^https:\/\/[abc]\.tile\.openstreetmap\.org\//.test(
              response.url(),
            ) && response.ok(),
          { timeout: 5000 },
        );
        await page.locator("#dashboardMapDate").fill("2026-09-25");
        await page.locator("#dashboardMapDate").dispatchEvent("change");
        await realTile;
        await page.screenshot({
          path: "/tmp/coach-dashboard-map-synthetic-real-osm-390.png",
          fullPage: true,
        });
      } catch {
        /* Network unavailable: intercepted-tile screenshots remain deterministic. */
      }
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
