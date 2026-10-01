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
  let manyRoster = false;
  let rosterStatus = 0;
  let activityStatus = 0;
  let holdAdaDetail = false;
  let releaseAdaDetail: (() => void) | undefined;
  const heldAdaDetail = new Promise<void>(
    (resolve) => (releaseAdaDetail = resolve),
  );
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
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/leaflet.css"><section id="dashboardPanel"><label for="dashboardMapDate">Activity creation date (your device timezone)</label><input id="dashboardMapDate" type="date"><p id="dashboardMapStatus" role="status"></p><div class="dashboard-map-layout"><div id="dashboardMap" class="dashboard-map"></div><aside id="dashboardMapSelection" class="dashboard-map-selection"></aside></div><h3 id="dashboardMemberHeading">Members in loaded shared data</h3><div id="dashboardMemberCards" class="dashboard-member-cards" role="group" aria-label="Member filters"></div><p id="dashboardStatus"></p><div id="dashboardCoverage"></div><div id="dashboardRoster"></div><div id="dashboardCharts"></div></section><script src="/leaflet.js"></script><script src="/dashboard.js"></script>`,
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
    if (path.pathname === "/api/dashboard/members") {
      res.setHeader("content-type", "application/json");
      if (rosterStatus) {
        res.statusCode = rosterStatus;
        res.end("{}");
        return;
      }
      res.end(
        JSON.stringify({
          members: manyRoster
            ? Array.from({ length: 12 }, (_, i) => ({
                _id: (i + 20).toString(16).padStart(24, "0"),
                display_name: `Synthetic Member ${i}`,
                stats: {},
                last_position: {
                  activity_id: `dense-${i}`,
                  type: "workout",
                  occurred_at: "2026-09-29T12:00:00Z",
                  position: {
                    latitude: 40.7 + i * 0.002,
                    longitude: -73.9 + i * 0.002,
                  },
                },
              }))
            : [
                {
                  _id: ada,
                  display_name: "Synthetic Ada",
                  stats: {
                    weight: { value: 68, unit: "kg" },
                    height_cm: 170,
                    body_fat_percent: 21,
                    age_years: 30,
                  },
                  last_position: {
                    activity_id: "a2",
                    type: "workout",
                    occurred_at: "2026-09-27T12:00:00Z",
                    position: { latitude: 40.72, longitude: -73.91 },
                  },
                },
                {
                  _id: bob,
                  display_name: "Synthetic Bob",
                  stats: {},
                  last_position: {
                    activity_id: "b1",
                    type: "workout",
                    occurred_at: "2026-09-26T12:00:00Z",
                    position: { latitude: 40.73, longitude: -73.92 },
                  },
                },
              ],
        }),
      );
      return;
    }
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
      if (id === "a1" && holdAdaDetail) await heldAdaDetail;
      const source = activities.find((activity) => activity._id === id);
      if (activityStatus) {
        res.statusCode = activityStatus;
        res.end("{}");
      } else if (!source || (privateAda && source.user_id === ada)) {
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
      res.end(
        JSON.stringify({
          users: [
            { _id: ada, display_name: "Synthetic Ada" },
            { _id: bob, display_name: "Synthetic Bob" },
          ],
          activities,
          hasMore: false,
        }),
      );
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
      await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (route) => {
        tiles.push(route.request().url());
        return route.fulfill({
          status: 200,
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#273845"/><path d="M0 128H256M128 0V256" stroke="#49616b" stroke-width="2"/><text x="20" y="28" fill="#a8b5ba" font-size="13">SYNTHETIC TILE</text></svg>',
        });
      });
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
        "one simple pin per positioned activity",
      );
      assert.equal(
        await page.locator("#dashboardMap .dashboard-member-pin").count(),
        2,
        "one latest authorized position pin per member, independent of the selected date",
      );
      assert.equal(
        await page.locator("#dashboardMemberCards button").count(),
        3,
        "all-members toggle and authorized roster cards",
      );
      assert.equal(
        await page.locator("#dashboardMemberHeading").innerText(),
        "Dojo members",
      );
      assert.match(
        await page.locator("#dashboardMemberCards").innerText(),
        /Weight: 68 kg.*Height: 170 cm.*Body fat: 21 %.*Age: 30.*Weight: Unavailable.*Height: Unavailable.*Body fat: Unavailable.*Age: Unavailable/s,
      );
      assert.match(
        (await page
          .locator(".dashboard-member-pin")
          .first()
          .getAttribute("aria-label")) || "",
        /positioned activity.*ago/i,
      );
      const pinNotes = () =>
        page
          .locator("#dashboardMap .dashboard-member-pin-note")
          .evaluateAll((notes) =>
            notes.map((note) => ({
              member: (note.closest(".dashboard-member-pin") as HTMLElement)
                ?.dataset.memberId,
              text: note.textContent,
              visible: note.checkVisibility(),
            })),
          );
      assert.deepEqual(
        (await pinNotes()).sort((a, b) => a.member!.localeCompare(b.member!)),
        [
          {
            member: ada,
            text: "Position from activity 5 days ago · not live",
            visible: true,
          },
          {
            member: bob,
            text: "Position from activity 6 days ago · not live",
            visible: true,
          },
        ],
        "each portrait pin shows its elapsed positioned-activity note without a click",
      );
      assert.equal(
        await page.locator("#dashboardMap .dashboard-map-marker img").count(),
        0,
        "activity pins never repeat portraits",
      );
      await page.waitForFunction(
        () =>
          document.querySelectorAll(
            "#dashboardMemberCards .dashboard-member-portrait img",
          ).length === 1,
      );
      await page
        .locator(
          `#dashboardMemberCards .dashboard-member-portrait[data-member-id="${bob}"]`,
        )
        .locator("..")
        .click();
      assert.equal(
        await page
          .locator("#dashboardMemberCards .dashboard-member-portrait img")
          .count(),
        1,
        "switching a member must retain authorized card portraits",
      );
      assert.deepEqual(
        await page
          .locator("#dashboardCharts .dashboard-chart h4")
          .allTextContents(),
        ["Synthetic Bob — Completed workouts (workouts)"],
        "member filter narrows loaded charts",
      );
      assert.equal(
        await page
          .locator(
            "#dashboardMap .dashboard-activity-pin:not(.dashboard-filtered)",
          )
          .count(),
        1,
        "member selection filters selected-date activity pins",
      );
      assert.equal(
        await page
          .locator(
            "#dashboardMap .dashboard-member-pin:not(.dashboard-filtered)",
          )
          .count(),
        1,
        "member selection filters global latest pins",
      );
      await page.getByRole("button", { name: "All members" }).click();
      assert.equal(
        await page
          .locator(
            "#dashboardMap .dashboard-activity-pin:not(.dashboard-filtered)",
          )
          .count(),
        3,
      );
      assert.equal(
        await page
          .locator(
            "#dashboardMap .dashboard-member-pin:not(.dashboard-filtered)",
          )
          .count(),
        2,
      );
      assert.ok(
        tiles.some((url) =>
          /^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/.test(url),
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
      assert.deepEqual(await adaPins.allTextContents(), ["•", "•"]);
      assert.equal(
        await page
          .getByRole("button", { name: /Synthetic Bob activity:/i })
          .textContent(),
        "•",
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
        () =>
          !!document.querySelector(
            ".dashboard-member-pin .dashboard-map-avatar",
          ),
      );
      assert.equal(
        await page
          .locator(".dashboard-member-pin")
          .first()
          .locator("img")
          .count(),
        1,
      );
      assert.equal(await adaPins.first().locator("img").count(), 0);
      assert.equal(
        await page
          .locator(`.dashboard-member-pin[data-member-id="${bob}"] img`)
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
            calls.filter((url) => url.startsWith("/api/dashboard/members"))
              .length,
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
      const desktopLayout = await page
        .locator(".dashboard-map-layout")
        .evaluate((layout) => {
          const map = layout
            .querySelector("#dashboardMap")!
            .getBoundingClientRect();
          const detail = layout
            .querySelector("#dashboardMapSelection")!
            .getBoundingClientRect();
          return { right: detail.left >= map.right, top: detail.top };
        });
      assert.equal(
        desktopLayout.right,
        true,
        "activity detail sits to the right on desktop",
      );
      await page.screenshot({
        path: "/tmp/coach-dashboard-map-synthetic-1440.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 320, height: 850 });
      const mobileLayout = await page
        .locator(".dashboard-map-layout")
        .evaluate((layout) => {
          const map = layout
            .querySelector("#dashboardMap")!
            .getBoundingClientRect();
          const detail = layout
            .querySelector("#dashboardMapSelection")!
            .getBoundingClientRect();
          return detail.top >= map.bottom;
        });
      assert.equal(
        mobileLayout,
        true,
        "activity detail stacks below the map on mobile",
      );
      await page.waitForFunction(
        () => {
          const map = document
            .querySelector("#dashboardMap")
            ?.getBoundingClientRect();
          return (
            !!map &&
            [
              ...document.querySelectorAll<HTMLElement>(
                "#dashboardMap .dashboard-member-pin:not(.dashboard-filtered)",
              ),
            ].some((pin) => {
              const box = pin.getBoundingClientRect();
              return (
                box.right > map.left &&
                box.left < map.right &&
                box.bottom > map.top &&
                box.top < map.bottom
              );
            })
          );
        },
        {},
        { timeout: 5000 },
      );
      await page.screenshot({
        path: "/tmp/coach-dashboard-map-synthetic-320.png",
        fullPage: true,
      });
      const mobilePins = await page.evaluate(() => {
        const map = document
          .querySelector("#dashboardMap")!
          .getBoundingClientRect();
        return {
          map: [map.x, map.y, map.width, map.height],
          pins: [
            ...document.querySelectorAll<HTMLElement>(
              "#dashboardMap .dashboard-member-pin:not(.dashboard-filtered)",
            ),
          ].map((pin) => {
            const box = pin.getBoundingClientRect();
            return {
              x: box.x,
              y: box.y,
              w: box.width,
              h: box.height,
              hidden: pin.hidden,
              display: getComputedStyle(pin).display,
            };
          }),
        };
      });
      assert.ok(
        mobilePins.pins.some(
          ({ x, y, w, h, hidden, display }) =>
            !hidden &&
            display !== "none" &&
            x >= mobilePins.map[0] + 8 &&
            x + w <= mobilePins.map[0] + mobilePins.map[2] - 8 &&
            y >= mobilePins.map[1] + 8 &&
            y + h <= mobilePins.map[1] + mobilePins.map[3] - 8,
        ),
        JSON.stringify(mobilePins),
      );
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        "320px map fits viewport",
      );
      await page.setViewportSize({ width: 390, height: 850 });
      const rosterCards = () =>
        page.locator("#dashboardMemberCards .dashboard-member-card").count();
      // A throttled detail read is transient, not revoked sharing.
      const activityPinsBefore = await page
        .locator("#dashboardMap .dashboard-activity-pin")
        .count();
      activityStatus = 429;
      await page.getByRole("button", { name: /Synthetic a1/ }).click();
      await page
        .locator("#dashboardMapSelection")
        .getByText(/temporarily unavailable \(429\)/i)
        .waitFor();
      assert.doesNotMatch(
        (await page.locator("#dashboardMapSelection").textContent()) || "",
        /denied|revoked|removed/i,
      );
      assert.equal(await rosterCards(), 3, "429 keeps member cards");
      assert.equal(
        await page.locator("#dashboardMap .dashboard-activity-pin").count(),
        activityPinsBefore,
        "429 keeps activity pins",
      );
      assert.equal(
        await page
          .locator(
            `#dashboardMap .dashboard-member-pin[data-member-id="${ada}"]`,
          )
          .count(),
        1,
        "429 keeps the member position pin",
      );
      activityStatus = 0;
      await page.getByRole("button", { name: /Synthetic a1/ }).click();
      await page.getByText("Synthetic squat").waitFor({ state: "attached" });
      // A transient roster failure keeps previously authorized cards and pins.
      rosterStatus = 503;
      await page.locator("#dashboardMapDate").dispatchEvent("change");
      await page.waitForFunction(() =>
        /refresh failed \(503\)/i.test(
          document.querySelector("#dashboardMapStatus")?.textContent || "",
        ),
      );
      assert.doesNotMatch(
        await page.locator("#dashboardMapStatus").innerText(),
        /denied|revoked/i,
      );
      assert.equal(await rosterCards(), 3, "503 roster keeps member cards");
      assert.match(
        await page.locator("#dashboardMemberCards").innerText(),
        /Weight: 68 kg/,
      );
      assert.equal(
        await page.locator("#dashboardMap .dashboard-member-pin").count(),
        2,
        "503 roster keeps member position pins",
      );
      assert.equal((await pinNotes()).length, 2);
      // A true roster denial drops roster-derived stats and positions.
      rosterStatus = 403;
      await page.locator("#dashboardMapDate").dispatchEvent("change");
      await page.waitForFunction(() =>
        /roster access denied \(403\)/i.test(
          document.querySelector("#dashboardMapStatus")?.textContent || "",
        ),
      );
      assert.equal(
        await page.locator("#dashboardMap .dashboard-member-pin").count(),
        0,
      );
      assert.equal((await pinNotes()).length, 0);
      assert.doesNotMatch(
        await page.locator("#dashboardMemberCards").innerText(),
        /68 kg/,
      );
      rosterStatus = 0;
      await page.locator("#dashboardMapDate").dispatchEvent("change");
      await page.waitForFunction(
        () =>
          document.querySelectorAll("#dashboardMap .dashboard-member-pin")
            .length === 2 &&
          document.querySelectorAll("#dashboardMap .dashboard-activity-pin")
            .length === 3,
      );
      privateAda = true;
      holdAdaDetail = true;
      await Promise.all([
        page.waitForRequest((request) =>
          request.url().includes("/api/dashboard/activity?id=a1"),
        ),
        page.getByRole("button", { name: /Synthetic a1/ }).click(),
      ]);
      await page
        .locator(
          `#dashboardMemberCards .dashboard-member-portrait[data-member-id="${bob}"]`,
        )
        .click();
      releaseAdaDetail?.();
      await page.waitForFunction(
        (id) =>
          !document.querySelector(
            `#dashboardMap .dashboard-member-pin[data-member-id="${id}"]`,
          ),
        ada,
      );
      assert.equal(
        await page
          .locator(
            `#dashboardMemberCards .dashboard-member-portrait[data-member-id="${bob}"]`,
          )
          .locator("..")
          .getAttribute("aria-pressed"),
        "true",
        "late denial must not overwrite the operator's newer member selection",
      );
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
      assert.equal(
        await page
          .locator(
            `#dashboardMemberCards .dashboard-member-portrait[data-member-id="${ada}"]`,
          )
          .count(),
        0,
        "denied detail removes cached member portrait and stats",
      );
      assert.equal(
        await page
          .locator(
            `#dashboardMap .dashboard-member-pin[data-member-id="${ada}"]`,
          )
          .count(),
        0,
        "denied detail cannot retain a stale global position",
      );
      assert.deepEqual(
        (await pinNotes()).map(({ member, text }) => [member, text]),
        [[bob, "Position from activity 6 days ago · not live"]],
        "revoked member loses its position note; others keep theirs",
      );
      peakAvatars = 0;
      enforceAvatarLimit = true;
      await page.getByRole("button", { name: "All members" }).click();
      manyRoster = true;
      await page.locator("#dashboardMapDate").fill("2026-09-29");
      await page.locator("#dashboardMapDate").dispatchEvent("change");
      await page.waitForFunction(
        () => document.querySelectorAll(".dashboard-map-marker").length === 12,
      );
      await page.waitForFunction(
        () =>
          document.querySelectorAll(".dashboard-member-pin img").length === 12,
        undefined,
        { timeout: 2500 },
      );
      assert.ok(
        peakAvatars <= 4,
        `avatar concurrency bounded; observed ${peakAvatars}`,
      );
      assert.ok(
        avatars.every((id) => /^[0-9a-f]{24}$/.test(id)),
        "only canonical member IDs used for avatar calls",
      );
      await page
        .waitForFunction(
          () => {
            const map = document.querySelector("#dashboardMap");
            if (!map) return false;
            const bounds = map.getBoundingClientRect();
            const pins = [...map.querySelectorAll(".dashboard-map-marker")];
            return (
              pins.length === 12 &&
              pins.every((pin) => {
                const rect = pin.getBoundingClientRect();
                return (
                  rect.left >= bounds.left - 1 &&
                  rect.right <= bounds.right + 1 &&
                  rect.top >= bounds.top - 1 &&
                  rect.bottom <= bounds.bottom + 1
                );
              })
            );
          },
          undefined,
          { timeout: 2500 },
        )
        .catch(async () => {
          const geometry = await page
            .locator("#dashboardMap")
            .evaluate((map) => {
              const bounds = map.getBoundingClientRect();
              return [...map.querySelectorAll(".dashboard-map-marker")].map(
                (pin) => {
                  const rect = pin.getBoundingClientRect();
                  return {
                    member: (pin as HTMLElement).dataset.memberId,
                    x: rect.x - bounds.x,
                    y: rect.y - bounds.y,
                    width: rect.width,
                    hidden: (pin as HTMLElement).hidden,
                  };
                },
              );
            });
          throw new Error(
            `dense pins outside map: ${JSON.stringify(geometry)}`,
          );
        });
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
      manyRoster = false;
      await page.locator("#dashboardMapDate").fill("2026-09-25");
      await page.locator("#dashboardMapDate").dispatchEvent("change");
      await page.waitForFunction(() =>
        /2026-09-25.*complete selected date/i.test(
          document.querySelector("#dashboardMapStatus")?.textContent || "",
        ),
      );
      assert.equal(
        await page
          .locator(
            `#dashboardMap .dashboard-map-marker[data-member-id="${ada}"]`,
          )
          .count(),
        0,
        "confirmed denial stays suppressed across date/roster refreshes",
      );
      privateAda = false;
      await page.evaluate(() =>
        (window as any).CoachDashboard.load(null, "synthetic-key"),
      );
      await page.waitForFunction(
        () =>
          document.querySelectorAll("#dashboardMap .dashboard-member-pin")
            .length === 2,
      );
      for (const [day, expectedPins] of [
        ["2026-09-25", 2],
        ["2026-09-24", 1],
      ] as const) {
        await page.locator("#dashboardMapDate").fill(day);
        await page.locator("#dashboardMapDate").dispatchEvent("change");
        await page.waitForFunction(
          (count) =>
            document.querySelectorAll(".dashboard-map-marker").length ===
              count &&
            document.querySelectorAll(".dashboard-member-pin").length === 2,
          expectedPins,
        );
        assert.equal(
          await page.locator(".dashboard-member-pin").count(),
          2,
          "global latest profile pins survive selected-date changes",
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
        await Promise.all([
          page.waitForRequest((request) =>
            request.url().includes(`/api/dashboard/map?date=${day}&`),
          ),
          (async () => {
            await page.locator("#dashboardMapDate").fill(day);
            await page.locator("#dashboardMapDate").dispatchEvent("change");
          })(),
        ]);
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
      await page.unroute(/^https:\/\/tile\.openstreetmap\.org\//);
      try {
        const realTile = page.waitForResponse(
          (response) =>
            /^https:\/\/tile\.openstreetmap\.org\//.test(response.url()) &&
            response.ok(),
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

test("roster cards load independently when the map endpoint fails or Leaflet is unavailable", async () => {
  const calls: string[] = [];
  let releaseMap: (() => void) | undefined;
  let mapHeld = new Promise<void>((resolve) => (releaseMap = resolve));
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://localhost");
    if (path.pathname === "/leaflet.js" || path.pathname === "/leaflet.css") {
      res.setHeader(
        "content-type",
        path.pathname.endsWith(".css") ? "text/css" : "text/javascript",
      );
      res.end(await readFile(new URL(path.pathname.slice(1), leaflet)));
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
        `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><section id="dashboardPanel"><input id="dashboardMapDate" type="date"><p id="dashboardMapStatus" role="status"></p><div class="dashboard-map-layout"><div id="dashboardMap" class="dashboard-map"></div><aside id="dashboardMapSelection"></aside></div><h3 id="dashboardMemberHeading"></h3><div id="dashboardMemberCards"></div><p id="dashboardStatus"></p><div id="dashboardCoverage"></div><div id="dashboardRoster"></div><div id="dashboardCharts"></div></section>${path.searchParams.has("noleaflet") ? "" : '<link rel="stylesheet" href="/leaflet.css"><script src="/leaflet.js"></script>'}<script src="/dashboard.js"></script>`,
      );
      return;
    }
    calls.push(path.pathname);
    res.setHeader("content-type", "application/json");
    if (path.pathname === "/api/dashboard/map") {
      await mapHeld;
      res.statusCode = 503;
      res.end("{}");
    } else if (path.pathname === "/api/dashboard/members")
      res.end(
        JSON.stringify({
          members: [
            {
              _id: ada,
              display_name: "Synthetic Ada",
              stats: {
                weight: { value: 68, unit: "kg" },
                height_cm: 170,
                body_fat_percent: 21,
                age_years: 30,
              },
              last_position: {
                activity_id: "a2",
                type: "workout",
                occurred_at: "2026-09-27T12:00:00Z",
                position: { latitude: 40.72, longitude: -73.91 },
              },
            },
            { _id: bob, display_name: "Synthetic Bob", stats: {} },
          ],
        }),
      );
    else if (path.pathname === "/api/dashboard")
      res.end(JSON.stringify({ users: [], activities: [], hasMore: false }));
    else {
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
    for (const variant of ["map-503", "noleaflet"]) {
      const page = await browser.newPage({
        viewport: { width: 390, height: 850 },
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (route) =>
        route.fulfill({ status: 404, body: "" }),
      );
      await page.goto(
        `http://127.0.0.1:${(server.address() as any).port}/${variant === "noleaflet" ? "?noleaflet" : ""}`,
      );
      await page.evaluate(() => {
        void (window as any).CoachDashboard.load(null, "synthetic-key");
      });
      // Cards arrive while the date-scoped map read is still pending.
      await page.waitForFunction(() =>
        /Synthetic Ada.*Weight: 68 kg.*Height: 170 cm.*Body fat: 21 %.*Age: 30.*Synthetic Bob.*Weight: Unavailable/s.test(
          (document.querySelector("#dashboardMemberCards") as HTMLElement)
            ?.innerText || "",
        ),
      );
      assert.equal(
        await page.locator("#dashboardMemberHeading").innerText(),
        "Dojo members",
      );
      releaseMap!();
      await page.waitForFunction(() =>
        /Map unavailable/.test(
          document.querySelector("#dashboardMapStatus")?.textContent || "",
        ),
      );
      const status = await page.locator("#dashboardMapStatus").innerText();
      assert.match(
        status,
        variant === "noleaflet" ? /Leaflet could not load/ : /\(503\)/,
      );
      assert.doesNotMatch(status, /denied|revoked/i);
      assert.match(status, /separately authorized roster/i);
      assert.equal(
        await page
          .locator("#dashboardMemberCards .dashboard-member-card")
          .count(),
        3,
        "all-members toggle plus complete authorized roster",
      );
      assert.equal(await page.locator(".dashboard-activity-pin").count(), 0);
      assert.equal(await page.locator(".dashboard-member-pin").count(), 0);
      assert.ok(calls.includes("/api/dashboard/members"));
      assert.deepEqual(errors, []);
      await page.close();
      mapHeld = new Promise<void>((resolve) => (releaseMap = resolve));
      calls.length = 0;
    }
  } finally {
    releaseMap!();
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("served compact day timeline works without Leaflet and places tied activity instants on local DST scale", async () => {
  const { Store } = await import("../src/config/store.js");
  const { admin } = await import("../src/server/admin.js");
  const { mkdtemp, rm, mkdir } = await import("node:fs/promises");
  const home = await mkdtemp("/tmp/coach-timeline-");
  let detailStatus = 200;
  let timelineStatus = 200;
  let sixTypes = false;
  let detailOverride: Record<string, unknown> = {};
  let holdDetail = false;
  let releaseDetail: (() => void) | undefined;
  let detailStarted: (() => void) | undefined;
  let beganDetail = new Promise<void>((r) => {
    detailStarted = r;
  });
  let heldDetail = new Promise<void>((r) => {
    releaseDetail = r;
  });
  const items = ["workout", "meal", "metric"].map((type, i) => ({
    _id: `point-${i}`,
    user_id: i === 2 ? bob : ada,
    type,
    status: "complete",
    name: `Synthetic ${type}`,
    created_at: "2026-11-01T06:30:00.000Z",
  }));
  const calls: string[] = [];
  const backend = createServer(async (req, res) => {
    calls.push(req.url!);
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/api/friends/dojo/day-activities?")) {
      if (timelineStatus !== 200) {
        res.statusCode = timelineStatus;
        res.end("{}");
        return;
      }
      res.end(
        JSON.stringify({
          users: [
            { _id: ada, display_name: "Synthetic Ada" },
            { _id: bob, display_name: "Synthetic Bob" },
          ],
          activities: (sixTypes
            ? [
                ...items,
                ...["media", "survey", "status_change"].map((type, i) => ({
                  ...items[0],
                  _id: `extra-${i}`,
                  type,
                })),
              ]
            : items
          ).map((item) => ({
            ...item,
            created_at: new Date(
              Date.parse(
                new URL(req.url!, "http://fixture").searchParams.get("start")!,
              ) +
                2.5 * 3600000,
            ).toISOString(),
          })),
          hasMore: false,
          nextCursor: null,
        }),
      );
    } else if (req.url === "/api/friends/dojo/dashboard-members")
      res.end(
        JSON.stringify({
          members: [
            { _id: ada, display_name: "Synthetic Ada" },
            { _id: bob, display_name: "Synthetic Bob" },
          ],
        }),
      );
    else if (req.url?.startsWith("/api/friends/activity/")) {
      if (holdDetail) {
        detailStarted?.();
        await heldDetail;
      }
      res.statusCode = detailStatus;
      const item = items.find((i) => req.url?.endsWith(i._id));
      res.end(
        JSON.stringify({
          activity: { ...item, ...detailOverride },
          owner: { _id: item?.user_id },
        }),
      );
    } else
      res.end(JSON.stringify({ users: [], activities: [], hasMore: false }));
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(backend.address() as any).port}`,
    token: "synthetic-token",
  });
  const app = await admin(store, 0);
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const context = await browser.newContext({
      timezoneId: "America/New_York",
    });
    const page = await context.newPage();
    await page.goto(app.origin + "/dashboard");
    await page.evaluate(async (key) => {
      document.getElementById("studio")!.hidden = false;
      document.getElementById("login")!.hidden = true;
      (window as any).L = undefined;
      await (window as any).CoachDashboard.load(null, key);
    }, store.secrets.admin);
    await page.locator("#dashboardMapDate").fill("2026-11-01");
    await page.locator("#dashboardMapDate").dispatchEvent("change");
    await page.locator(".dashboard-timeline-mark").nth(2).waitFor();
    assert.ok(
      calls.some((c) =>
        c.includes(
          "day-activities?start=2026-11-01T04%3A00%3A00.000Z&end=2026-11-02T05%3A00%3A00.000Z",
        ),
      ),
    );
    const geometry = await page
      .locator(".dashboard-timeline-mark")
      .evaluateAll((nodes) =>
        nodes.map((n) => ({
          left: (n as HTMLElement).style.left,
          top: (n as HTMLElement).style.top,
          color: getComputedStyle(n).backgroundColor,
        })),
      );
    assert.equal(new Set(geometry.map((g) => g.left)).size, 1);
    assert.equal(new Set(geometry.map((g) => g.top)).size, 3);
    assert.equal(new Set(geometry.map((g) => g.color)).size, 3);
    assert.ok(
      Math.abs(parseFloat(geometry[0].left) - 10) < 0.001,
      "2.5 elapsed hours on 25-hour day",
    );
    await page
      .locator('[data-activity-id="point-0"].dashboard-timeline-mark')
      .click();
    await page.getByText("Position unavailable.", { exact: true }).waitFor();
    assert.doesNotMatch(
      await page.locator("#dashboardMapSelection").innerText(),
      /Position reauthorized/,
      "absent position does not claim authorized location",
    );
    assert.equal(
      await page
        .locator('[data-activity-id="point-0"].dashboard-timeline-mark')
        .getAttribute("aria-pressed"),
      "true",
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    const desktopTrack = await page
      .locator(".dashboard-timeline-scroll")
      .evaluate((el) => ({
        client: el.clientWidth,
        scroll: el.scrollWidth,
        last: el.querySelector(".dashboard-timeline-tick:last-child")
          ?.textContent,
      }));
    assert.equal(
      desktopTrack.scroll <= desktopTrack.client,
      true,
      "desktop fits complete day without horizontal scrolling",
    );
    assert.equal(
      desktopTrack.last,
      "00:00",
      "explicit next-midnight end tick on 25-hour day",
    );
    const tickRects = await page
      .locator(".dashboard-timeline-tick")
      .evaluateAll((nodes) =>
        nodes.map((n) => {
          const r = n.getBoundingClientRect();
          return { left: r.left, right: r.right, height: r.height };
        }),
      );
    assert.ok(
      tickRects.every((r) => r.height < 24),
      "tick labels remain one line",
    );
    for (let i = 1; i < tickRects.length; i++)
      assert.ok(
        tickRects[i].left >= tickRects[i - 1].right,
        "local tick labels do not overlap, including next midnight",
      );

    await mkdir("/tmp/coach-day-timeline/screenshots", { recursive: true });
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const rects = await page
        .locator(".dashboard-timeline-mark")
        .evaluateAll((nodes) =>
          nodes.map((n) => {
            const r = n.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          }),
        );
      for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++)
          assert.ok(
            Math.abs(rects[i].x - rects[j].x) >= rects[i].width ||
              Math.abs(rects[i].y - rects[j].y) >= rects[i].height,
            "tied targets do not overlap",
          );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: `/tmp/coach-day-timeline/screenshots/timeline-full-${width}.png`,
        fullPage: true,
      });
    }
    holdDetail = true;
    await page
      .locator('[data-activity-id="point-0"].dashboard-timeline-mark')
      .click();
    await beganDetail;
    await page
      .locator(
        `#dashboardMemberCards .dashboard-member-portrait[data-member-id="${bob}"]`,
      )
      .locator("..")
      .click();
    assert.equal(
      await page.locator(".dashboard-timeline-mark:visible").count(),
      1,
      "member filters timeline without map",
    );
    const completedDetail = page.waitForResponse((r) =>
      r.url().includes("/api/dashboard/activity?id=point-0"),
    );
    releaseDetail?.();
    await completedDetail;
    await page.waitForFunction(
      () =>
        !document
          .getElementById("dashboardMapSelection")!
          .textContent?.includes("Synthetic workout"),
    );
    assert.equal(
      await page.locator("#dashboardMapSelection").innerText(),
      "",
      "member switch fences in-flight detail even without map",
    );
    holdDetail = false;
    await page
      .getByRole("button", { name: "All members", exact: true })
      .click();
    holdDetail = true;
    detailStatus = 404;
    beganDetail = new Promise<void>((r) => {
      detailStarted = r;
    });
    heldDetail = new Promise<void>((r) => {
      releaseDetail = r;
    });
    await page
      .locator('[data-activity-id="point-0"].dashboard-timeline-mark')
      .click();
    await beganDetail;
    await page.locator("#dashboardMapDate").fill("2026-11-02");
    await page.locator("#dashboardMapDate").dispatchEvent("change");
    await page.waitForFunction(
      () =>
        document
          .querySelector("#dashboardTimeline > p")
          ?.textContent?.includes("2026-11-02") &&
        document.querySelectorAll(".dashboard-timeline-mark").length === 3,
    );
    const normalTicks = await page
      .locator(".dashboard-timeline-tick")
      .evaluateAll((nodes) =>
        nodes.map((n) => {
          const r = n.getBoundingClientRect();
          return { left: r.left, right: r.right };
        }),
      );
    for (let i = 1; i < normalTicks.length; i++)
      assert.ok(
        normalTicks[i].left - normalTicks[i - 1].right >= 4,
        "24-hour tick labels have a visible gap including midnight",
      );
    const oldDetail = page.waitForResponse((r) =>
      r.url().includes("/api/dashboard/activity?id=point-0"),
    );
    releaseDetail?.();
    await oldDetail;
    await page.waitForTimeout(50);
    assert.equal(
      await page.locator(".dashboard-timeline-mark").count(),
      3,
      "old date 404 cannot remove newly-authorized same activity on new date",
    );
    holdDetail = false;
    detailStatus = 200;
    await page.locator("#dashboardMapDate").fill("2026-03-08");
    await page.locator("#dashboardMapDate").dispatchEvent("change");
    await page.waitForFunction(() =>
      document
        .querySelector("#dashboardTimeline > p")
        ?.textContent?.includes("2026-03-08"),
    );
    assert.ok(
      calls.some((c) =>
        c.includes(
          "day-activities?start=2026-03-08T05%3A00%3A00.000Z&end=2026-03-09T04%3A00%3A00.000Z",
        ),
      ),
      "spring forward 23-hour bounds",
    );
    assert.ok(
      Math.abs(
        parseFloat(
          await page
            .locator(".dashboard-timeline-mark")
            .first()
            .evaluate((el) => (el as HTMLElement).style.left),
        ) -
          (2.5 / 23) * 100,
      ) < 0.001,
    );
    assert.equal(
      await page.locator(".dashboard-timeline-end").textContent(),
      "00:00",
    );
    await page.locator("#dashboardMapDate").fill("2026-11-01");
    await page.locator("#dashboardMapDate").dispatchEvent("change");
    await page.waitForFunction(
      () =>
        document
          .querySelector("#dashboardTimeline > p")
          ?.textContent?.includes("2026-11-01") &&
        document.querySelectorAll(".dashboard-timeline-mark").length === 3,
    );
    detailOverride = { created_at: "2026-11-02T06:30:00.000Z" };
    await page
      .locator('[data-activity-id="point-0"].dashboard-timeline-mark')
      .click();
    await page.getByText(/Activity unavailable/).waitFor();
    assert.equal(
      await page
        .locator('[data-activity-id="point-0"].dashboard-timeline-mark')
        .count(),
      0,
      "moved-day detail removes stale point",
    );
    detailOverride = {};
    await page.locator("#dashboardMapDate").dispatchEvent("change");
    await page.locator(".dashboard-timeline-mark").nth(2).waitFor();
    detailOverride = { status: "pending" };
    await page
      .locator('[data-activity-id="point-1"].dashboard-timeline-mark')
      .click();
    await page.getByText(/Activity unavailable/).waitFor();
    assert.equal(
      await page
        .locator('[data-activity-id="point-1"].dashboard-timeline-mark')
        .count(),
      0,
      "unpublished detail removes stale point",
    );
    detailOverride = {};
    await page.locator("#dashboardMapDate").dispatchEvent("change");
    await page.locator(".dashboard-timeline-mark").nth(2).waitFor();
    timelineStatus = 429;
    await page.locator("#dashboardMapDate").dispatchEvent("change");
    await page.getByText("Timeline unavailable (429); try again.").waitFor();
    assert.equal(
      await page.locator(".dashboard-timeline-mark").count(),
      3,
      "transient same-date refresh retains authorized points",
    );
    timelineStatus = 200;
    await page
      .getByRole("button", { name: "Retry timeline", exact: true })
      .click();
    await page.getByText(/Created-time points/).waitFor();
    detailStatus = 429;
    await page
      .locator('[data-activity-id="point-1"].dashboard-timeline-mark')
      .click();
    await page.getByText(/temporarily unavailable.*429/).waitFor();
    assert.equal(await page.locator(".dashboard-timeline-mark").count(), 3);
    detailStatus = 404;
    await page
      .locator('[data-activity-id="point-1"].dashboard-timeline-mark')
      .click();
    await page.getByText(/Activity unavailable/).waitFor();
    assert.equal(await page.locator(".dashboard-timeline-mark").count(), 2);
    detailStatus = 403;
    await page
      .locator('[data-activity-id="point-0"].dashboard-timeline-mark')
      .click();
    await page.getByText(/Activity access denied/).waitFor();
    assert.equal(await page.locator(".dashboard-timeline-mark").count(), 1);
    await mkdir("/tmp/coach-day-timeline/screenshots", { recursive: true });
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: `/tmp/coach-day-timeline/screenshots/timeline-${width}.png`,
        fullPage: true,
      });
    }
    sixTypes = true;
    detailStatus = 200;
    await page.evaluate(async (key) => {
      await (window as any).CoachDashboard.load(null, key);
    }, store.secrets.admin);
    await page.locator("#dashboardMapDate").fill("2026-11-01");
    await page.locator("#dashboardMapDate").dispatchEvent("change");
    await page.locator(".dashboard-timeline-mark").nth(5).waitFor();
    assert.equal(
      await page.locator(".dashboard-timeline-legend").innerText(),
      "workout\nmeal\nmedia\nmetric\nsurvey\nStatus/Readiness",
    );
    assert.equal(
      await page
        .getByRole("button", { name: /status_change.*created/ })
        .count(),
      1,
    );
    await context.close();
  } finally {
    releaseDetail?.();
    await browser.close();
    await app.close();
    await new Promise<void>((r) => backend.close(() => r()));
    await rm(home, { recursive: true, force: true });
  }
});
