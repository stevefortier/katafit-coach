import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  fixture,
  ada,
  bob,
  id,
  ev,
  gps,
  type Event,
} from "./helpers/exact-map-fixture.js";

// Map camera focus: a double activation (real mouse double-click, CDP touch
// double tap or Shift+Enter) on a member selection card tightly fits that member's
// shown event locations; on an event it centres its exact recorded point.

const cy = "cccccccccccccccccccccccc",
  dee = "dddddddddddddddddddddddd",
  eve = "eeeeeeeeeeeeeeeeeeeeeeee";
const users = [
  { _id: ada, display_name: "Synthetic Ada" },
  { _id: bob, display_name: "Synthetic Bob" },
  { _id: cy, display_name: "Synthetic Cy" },
  { _id: dee, display_name: "Synthetic Dee" },
  { _id: eve, display_name: "Synthetic Eve" },
];
const FOCUS_ZOOM = 18;
const evidence = process.env.MAP_FOCUS_EVIDENCE_DIR;

const row = (
  n: number,
  user: string,
  stamp: string,
  type: string,
  position?: [number, number] | Record<string, unknown>,
): Event => ({
  id: ev(n),
  user_id: user,
  occurred_at: stamp,
  event_type: type,
  subject: { type: type.split(".")[0], id: id(n) },
  details: {},
  ...(Array.isArray(position)
    ? { position: gps(position[0], position[1], stamp) }
    : position
      ? { position }
      : {}),
});
const at = (hour: number, minute = 0, day = 28) =>
  `2026-09-${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
const missing = { availability: "unavailable", reason: "missing" };
const withheld = { availability: "unavailable", reason: "private" };

// Coordinates keep their exact fractional precision on purpose.
const A1: [number, number] = [40.7, -73.9],
  A2: [number, number] = [40.7012345, -73.9021987],
  A3: [number, number] = [40.7031234, -73.8994321],
  BOSTON: [number, number] = [42.3601, -71.0589],
  TOKYO: [number, number] = [35.6812345, 139.7671234],
  PARIS: [number, number] = [48.8566123, 2.3522456];
const events: Event[] = [
  row(1, ada, at(1), "workout.set_completed", A1),
  row(2, ada, at(2), "meal.food_added", A2),
  row(3, ada, at(3), "meal.food_added", A3),
  row(4, ada, at(4), "metric.recorded", BOSTON),
  row(5, ada, at(5), "survey.completed", missing),
  row(6, bob, at(2, 30), "workout.set_completed", TOKYO),
  row(7, bob, at(3, 30), "survey.completed", missing),
  // Another member at exactly Ada's first coordinate.
  row(8, cy, at(1, 30), "workout.set_completed", A1),
  // A private Position withholds every loaded fix for that member.
  row(9, dee, at(6), "workout.set_completed", [40.71, -73.95]),
  row(10, dee, at(7), "meal.food_added", withheld),
  row(11, eve, at(8), "survey.completed", missing),
  // The previous day, elsewhere: never part of the 28th's focus.
  row(12, ada, at(9, 0, 27), "workout.set_completed", PARIS),
];
// The day stream returns only the requested civil day's events.
const byDay = (url: URL, all: Event[]) =>
  url.pathname === "/api/dashboard/timeline"
    ? {
        body: {
          users,
          events: all.filter(
            (e) =>
              e.occurred_at >= url.searchParams.get("start")! &&
              e.occurred_at < url.searchParams.get("end")!,
          ),
          hasMore: false,
        },
      }
    : undefined;

// Settle Leaflet: no zoom animation, then a late transition window.
async function settle(page: any) {
  await page.waitForFunction(
    () => !document.querySelector(".leaflet-zoom-anim"),
  );
  await page.waitForTimeout(400);
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}
const view = (page: any) =>
  page.evaluate(() => {
    const map = (window as any).fixtureMap;
    return { ...map.getCenter(), zoom: map.getZoom() };
  });
// Container pixel of a coordinate in the world copy nearest the centre.
const points = (page: any, coords: [number, number][]) =>
  page.evaluate((list: [number, number][]) => {
    const map = (window as any).fixtureMap;
    const centre = map.getCenter().lng;
    return list.map(([lat, lng]) => {
      const p = map.latLngToContainerPoint([
        lat,
        lng + 360 * Math.round((centre - lng) / 360),
      ]);
      return { x: p.x, y: p.y };
    });
  }, coords);
const mapSize = (page: any) =>
  page.locator("#dashboardMap").evaluate((node: HTMLElement) => ({
    w: node.clientWidth,
    h: node.clientHeight,
  }));

// Every coordinate sits inside the marker padding, and the fit is tight:
// either the focus zoom ceiling, or the extent fills at least half of an axis
// (one more integer zoom level could not have fitted it).
async function assertTightFit(page: any, coords: [number, number][]) {
  const { w, h } = await mapSize(page);
  const pad = { x: Math.min(48, w / 4), y: Math.min(48, h / 4) };
  const shown = await points(page, coords);
  for (const p of shown) {
    assert.ok(p.x >= pad.x - 1 && p.x <= w - pad.x + 1, `x ${p.x} inside ${w}`);
    assert.ok(p.y >= pad.y - 1 && p.y <= h - pad.y + 1, `y ${p.y} inside ${h}`);
  }
  const { zoom } = await view(page);
  assert.ok(zoom <= FOCUS_ZOOM, `zoom ${zoom} capped`);
  const xs = shown.map((p: any) => p.x),
    ys = shown.map((p: any) => p.y);
  const spanX = Math.max(...xs) - Math.min(...xs),
    spanY = Math.max(...ys) - Math.min(...ys);
  assert.ok(
    zoom === FOCUS_ZOOM ||
      spanX >= (w - 2 * pad.x) / 2 - 1 ||
      spanY >= (h - 2 * pad.y) / 2 - 1,
    `tight: zoom ${zoom}, span ${spanX}x${spanY} of ${w}x${h}`,
  );
}
async function assertCentred(page: any, coord: [number, number]) {
  const { w, h } = await mapSize(page);
  const [p] = await points(page, [coord]);
  assert.ok(Math.abs(p.x - w / 2) <= 1, `x ${p.x} centred in ${w}`);
  assert.ok(Math.abs(p.y - h / 2) <= 1, `y ${p.y} centred in ${h}`);
  assert.equal((await view(page)).zoom, FOCUS_ZOOM);
}
async function offscreen(page: any, coord: [number, number]) {
  const { w, h } = await mapSize(page);
  const [p] = await points(page, [coord]);
  return p.x < 0 || p.y < 0 || p.x > w || p.y > h;
}
// The rendered dot sits exactly on its recorded coordinate.
async function dotExact(page: any, eventId: string, coord: [number, number]) {
  const [p] = await points(page, [coord]);
  const dot = await page
    .locator(`.dashboard-event-dot[data-event-id="${eventId}"]`)
    .evaluate((node: HTMLElement) => ({
      x: parseFloat(node.style.left),
      y: parseFloat(node.style.top),
      hidden: node.hidden,
    }));
  assert.equal(dot.hidden, false);
  assert.ok(Math.abs(dot.x - p.x) < 1 && Math.abs(dot.y - p.y) < 1);
}
const status = (page: any) => page.locator("#dashboardMapStatus").innerText();
const portrait = (page: any, member: string) =>
  page.locator(`.dashboard-member-portrait[data-member-id="${member}"]`);
const pressed = (page: any, member: string) =>
  page
    .locator(".dashboard-member-card", {
      has: page.locator(`[data-member-id="${member}"]`),
    })
    .getAttribute("aria-pressed");
async function centre(locator: any) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
// Real CDP mouse input: pressed/released with clickCount 1 then 2, with a
// human gap so the first click's effects (re-render, camera) have started.
async function mouseDouble(page: any, locator: any) {
  const { x, y } = await centre(locator);
  await page.mouse.move(x, y);
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.up({ clickCount: 1 });
  await page.waitForTimeout(150);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await settle(page);
}
// Real Chromium touch input through the renderer's gesture pipeline.
async function touchTap(page: any, cdp: any, locator: any, count = 1) {
  const { x, y } = await centre(locator);
  for (let i = 0; i < count; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    if (i + 1 < count) await page.waitForTimeout(90);
  }
  await settle(page);
}
async function shot(page: any, name: string) {
  if (!evidence) return;
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, name) });
}
// Neighbourhood zoom where adjacent dots are separately pointable.
const nearby = (page: any) =>
  page.evaluate(() =>
    (window as any).fixtureMap.setView([40.7015, -73.9005], 15, {
      animate: false,
    }),
  );
const options = {
  events,
  users,
  override: byDay,
  marks: 11,
};

test("a member picture double-click fits only that member's shown locations; one click keeps ordinary selection", async () =>
  fixture(async (page) => {
    await settle(page);
    const initial = await view(page);
    assert.ok(initial.zoom <= 16, "the ordinary day fit is unchanged");
    // One click: ordinary selection only, the camera stays on the day fit.
    await portrait(page, ada).click();
    await settle(page);
    assert.equal(await pressed(page, ada), "true");
    assert.deepEqual(await view(page), initial);
    // Real mouse double-click on the picture.
    await mouseDouble(page, portrait(page, ada));
    assert.equal(await pressed(page, ada), "true", "selection is kept");
    await assertTightFit(page, [A1, A2, A3, BOSTON]);
    assert.ok(await offscreen(page, TOKYO), "distant member excluded");
    // Cy's dot at exactly A1 is another member's: filtered, not fitted around.
    assert.match(
      await status(page),
      /zoomed to Synthetic Ada's 4 shown event locations/,
    );
    for (const [n, coord] of [
      [1, A1],
      [2, A2],
      [3, A3],
      [4, BOSTON],
    ] as const)
      await dotExact(page, ev(n), coord);
    await shot(page, "desktop-member-double-click.png");
    // The deliberate camera survives a resize.
    const focused = await view(page);
    await page.setViewportSize({ width: 1180, height: 900 });
    await page.waitForFunction(() => {
      const map = (window as any).fixtureMap,
        node = document.querySelector<HTMLElement>("#dashboardMap")!;
      return map.getSize().x === node.clientWidth;
    });
    await settle(page);
    assert.equal((await view(page)).zoom, focused.zoom);
    const { w, h } = await mapSize(page);
    const [kept] = await points(page, [[focused.lat, focused.lng]]);
    assert.ok(Math.abs(kept.x - w / 2) <= 1 && Math.abs(kept.y - h / 2) <= 1);
    // A member with one location focuses that exact point; a later animated
    // ordinary restore can never overwrite it.
    await mouseDouble(page, portrait(page, bob));
    assert.equal(await pressed(page, bob), "true");
    await assertCentred(page, TOKYO);
    await dotExact(page, ev(6), TOKYO);
  }, options));

for (const afterPan of [false, true]) {
  test(`single member selection preserves focused camera ${afterPan ? "after manual pan" : "without manual pan"}`, async () =>
    fixture(async (page) => {
      await settle(page);
      await mouseDouble(page, portrait(page, bob));
      await assertCentred(page, TOKYO);
      if (afterPan) {
        const box = await page.locator("#dashboardMap").boundingBox();
        await page.mouse.move(
          box!.x + box!.width / 2,
          box!.y + box!.height / 2,
        );
        await page.mouse.down();
        await page.mouse.move(
          box!.x + box!.width / 2 + 100,
          box!.y + box!.height / 2 + 60,
          { steps: 10 },
        );
        await page.mouse.up();
        await settle(page);
      }
      const before = await view(page);
      await portrait(page, ada).click();
      await settle(page);
      assert.equal(await pressed(page, ada), "true");
      assert.deepEqual(
        await view(page),
        before,
        "member selection must never restore the day frame",
      );
    }, options));
}

test("single offscreen timeline selection and hover preserve the camera", async () =>
  fixture(async (page) => {
    await settle(page);
    await mouseDouble(page, portrait(page, bob));
    // Explicit All resets filters; then choose a deliberate local view.
    await page.locator(".dashboard-member-all").click();
    await nearby(page);
    await settle(page);
    assert.ok(await offscreen(page, TOKYO));
    const before = await view(page);
    const mark = page.locator(
      `.dashboard-timeline-mark[data-event-id="${ev(6)}"]`,
    );
    await mark.hover();
    await settle(page);
    assert.deepEqual(
      await view(page),
      before,
      "hover must not pan to an offscreen point",
    );
    await mark.click();
    await page.waitForFunction(() =>
      document
        .querySelector("#dashboardMapSelection")
        ?.textContent?.includes("Event access rechecked"),
    );
    await settle(page);
    assert.deepEqual(
      await view(page),
      before,
      "single datapoint selection must not pan",
    );
    assert.equal(await mark.getAttribute("aria-pressed"), "true");
  }, options));

// Exercise every surface of the one native selection button, not a synthetic
// click handler. The border point is blank card space outside its descendants.
for (const touch of [false, true]) {
  for (const surface of ["portrait", "name", "stats", "space"] as const) {
    test(`whole member card ${surface} ${touch ? "double tap" : "double-click"} focuses like the portrait`, async () =>
      fixture(
        async (page) => {
          await settle(page);
          const initial = await view(page);
          const card = portrait(page, ada).locator("..");
          const target =
            surface === "portrait"
              ? portrait(page, ada)
              : surface === "name"
                ? card.locator("strong")
                : surface === "stats"
                  ? card.locator(":scope > span").nth(1)
                  : card;
          await target.scrollIntoViewIfNeeded();
          const point = async () => {
            const box = await target.boundingBox();
            return surface === "space"
              ? { x: box.x + box.width - 8, y: box.y + 1 }
              : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          };
          if (surface === "space") {
            assert.equal(
              await page.evaluate(
                ({ x, y }: { x: number; y: number }) =>
                  document
                    .elementFromPoint(x, y)
                    ?.classList.contains("dashboard-member-card"),
                await point(),
              ),
              true,
              "blank space really hits the selection button",
            );
          }
          const cdp = touch ? await page.context().newCDPSession(page) : null;
          const activate = async (count = 1) => {
            const { x, y } = await point();
            if (cdp) {
              await cdp.send("Input.dispatchTouchEvent", {
                type: "touchStart",
                touchPoints: [
                  { x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 },
                ],
              });
              await cdp.send("Input.dispatchTouchEvent", {
                type: "touchEnd",
                touchPoints: [],
              });
            } else {
              await page.mouse.click(x, y, { clickCount: count });
            }
          };
          await activate();
          await settle(page);
          assert.equal(await pressed(page, ada), "true");
          assert.deepEqual(
            await view(page),
            initial,
            "single activation only selects",
          );
          await page.waitForTimeout(600);
          await activate();
          await page.waitForTimeout(90);
          await activate(2);
          await settle(page);
          await shot(
            page,
            `synthetic-card-${surface}-${touch ? "touch" : "desktop"}.png`,
          );
          if (evidence) {
            await page.screenshot({
              path: join(
                evidence,
                `synthetic-card-${surface}-${touch ? "touch" : "desktop"}-full.png`,
              ),
              fullPage: true,
            });
            await card.screenshot({
              path: join(
                evidence,
                `synthetic-card-${surface}-${touch ? "touch" : "desktop"}-card.png`,
              ),
            });
          }
          assert.equal(await pressed(page, ada), "true");
          await assertTightFit(page, [A1, A2, A3, BOSTON]);
          assert.ok(await offscreen(page, TOKYO));
          if (touch) {
            assert.equal(
              await page.evaluate(() => visualViewport!.scale),
              1,
              "no page zoom",
            );
            assert.equal(
              await card.evaluate(
                (node: HTMLElement) => getComputedStyle(node).touchAction,
              ),
              "manipulation",
            );
          }
          await page.locator(".dashboard-member-all").click();
          await settle(page);
          assert.deepEqual(await view(page), initial, "All resets the day fit");
        },
        {
          ...options,
          touch,
          ...(touch ? { viewport: { width: 390, height: 844 } } : {}),
        },
      ));
  }
  test(`body-fat sibling ${touch ? "double tap" : "double-click"} never selects or focuses the member`, async () =>
    fixture(
      async (page) => {
        await settle(page);
        const initial = await view(page);
        const info = page.getByRole("button", {
          name: "About body fat estimate for Synthetic Ada",
        });
        assert.equal(
          await info.evaluate((node: HTMLElement) =>
            node
              .parentElement!.querySelector(".dashboard-member-card")!
              .contains(node),
          ),
          false,
        );
        const cdp = touch ? await page.context().newCDPSession(page) : null;
        if (cdp) await touchTap(page, cdp, info, 2);
        else await mouseDouble(page, info);
        assert.equal(await pressed(page, ada), "false");
        assert.deepEqual(
          await view(page),
          initial,
          "tooltip is not a camera target",
        );
        // A normal activation still exposes provenance on either input path.
        await page.keyboard.press("Escape");
        if (cdp) await touchTap(page, cdp, info);
        else await info.click();
        assert.equal(
          await page.locator(".dashboard-member-tooltip:popover-open").count(),
          1,
        );
        assert.equal(await pressed(page, ada), "false");
        assert.deepEqual(await view(page), initial);
      },
      {
        ...options,
        touch,
        ...(touch ? { viewport: { width: 390, height: 844 } } : {}),
        override: (url, rows) =>
          url.pathname === "/api/dashboard/members"
            ? {
                body: {
                  members: users.map((user) => ({
                    ...user,
                    stats: {
                      body_fat_percent: 18,
                      body_fat_estimate: {
                        source: "ai",
                        estimated: true,
                        value: 18,
                      },
                    },
                  })),
                },
              }
            : byDay(url, rows),
      },
    ));
  for (const pair of [
    "name-stats",
    "stats-name",
    "portrait-stats",
    "stats-portrait",
  ] as const) {
    test(`mixed ${pair} native ${touch ? "taps" : "clicks"} share the member gesture`, async () =>
      fixture(
        async (page) => {
          await settle(page);
          const card = portrait(page, ada).locator("..");
          await card.scrollIntoViewIfNeeded();
          const cdp = touch ? await page.context().newCDPSession(page) : null;
          const initial = await view(page);
          for (const surface of pair.split("-")) {
            const nameBox = await card.locator("strong").boundingBox();
            const statsBox = await card
              .locator(":scope > span")
              .nth(1)
              .boundingBox();
            const photoBox = await portrait(page, ada).boundingBox();
            // Adjacent points straddle the actual child boundary (<24px apart),
            // so Chromium may emit detail 1 for both; the card identity must win.
            const photoPair = pair.includes("portrait");
            const x = photoPair
              ? surface === "portrait"
                ? photoBox.x + photoBox.width - 3
                : statsBox.x + 3
              : nameBox.x + nameBox.width / 2;
            const y = photoPair
              ? statsBox.y + statsBox.height / 2
              : surface === "name"
                ? nameBox.y + nameBox.height - 3
                : statsBox.y + 3;
            assert.equal(
              await page.evaluate(
                ({ x, y }: { x: number; y: number }) => {
                  const node = document.elementFromPoint(x, y)!;
                  return node.classList.contains("dashboard-member-portrait")
                    ? "portrait"
                    : node.tagName === "STRONG"
                      ? "name"
                      : "stats";
                },
                { x, y },
              ),
              surface,
            );
            if (cdp) {
              await cdp.send("Input.dispatchTouchEvent", {
                type: "touchStart",
                touchPoints: [{ x, y, id: 1 }],
              });
              await cdp.send("Input.dispatchTouchEvent", {
                type: "touchEnd",
                touchPoints: [],
              });
            } else await page.mouse.click(x, y);
            if (surface === pair.split("-")[0]) {
              assert.equal(await pressed(page, ada), "true");
              assert.deepEqual(
                await view(page),
                initial,
                "first subtarget only selects",
              );
              await page.waitForTimeout(90);
            }
          }
          await settle(page);
          await assertTightFit(page, [A1, A2, A3, BOSTON]);
          if (touch)
            assert.equal(await page.evaluate(() => visualViewport!.scale), 1);
        },
        {
          ...options,
          touch,
          ...(touch ? { viewport: { width: 390, height: 844 } } : {}),
        },
      ));
  }
}

test("category filter, privacy fence, no-GPS member and other dates scope the focus truthfully", async () =>
  fixture(async (page) => {
    await settle(page);
    // The timeline category filter scopes the member focus.
    await page
      .locator('.dashboard-timeline-legend button[data-category="meal"]')
      .click();
    await mouseDouble(page, portrait(page, ada));
    await assertTightFit(page, [A2, A3]);
    assert.ok(await offscreen(page, BOSTON), "other categories excluded");
    assert.match(await status(page), /Synthetic Ada's 2 shown event locations/);
    await page
      .locator('.dashboard-timeline-legend button[data-category=""]')
      .click();
    // Withheld (private) and absent GPS are non-destructive no-ops: the
    // focus adds nothing to the ordinary selection its first click makes.
    for (const [member, name] of [
      [dee, "Synthetic Dee"],
      [eve, "Synthetic Eve"],
    ]) {
      await portrait(page, member).click();
      await settle(page);
      const before = await view(page);
      await page.waitForTimeout(600); // A fresh gesture, not a third click.
      await mouseDouble(page, portrait(page, member));
      assert.equal(await pressed(page, member), "true");
      assert.deepEqual(await view(page), before, `${name} keeps the camera`);
      assert.match(
        await status(page),
        new RegExp(`${name} has no shared event location.*not changed`),
      );
    }
    assert.equal(
      await page
        .locator(`.dashboard-event-dot[data-member-id="${dee}"]`)
        .count(),
      0,
    );
    // Another date: only that day's loaded events are focused.
    await page.evaluate(() => {
      const input =
        document.querySelector<HTMLInputElement>("#dashboardMapDate")!;
      input.value = "2026-09-27";
      input.dispatchEvent(new Event("change"));
    });
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".dashboard-timeline-mark").length === 1 &&
        document.querySelectorAll(".dashboard-event-dot").length === 1,
    );
    await settle(page);
    assert.equal((await view(page)).zoom, 16, "single-point day fit stays 16");
    await mouseDouble(page, portrait(page, ada));
    await assertCentred(page, PARIS);
    assert.match(
      await status(page),
      /Synthetic Ada's 1 shown event location\b/,
    );
  }, options));

test("a map dot or timeline slice double-click centres the exact recorded point and keeps event selection", async () =>
  fixture(async (page) => {
    await settle(page);
    await nearby(page);
    const dot = page.locator(`.dashboard-event-dot[data-event-id="${ev(3)}"]`);
    await mouseDouble(page, dot);
    await page.waitForFunction(
      () =>
        document
          .querySelector("#dashboardMapSelection")
          ?.textContent?.includes("Event access rechecked"),
      undefined,
      { timeout: 5000 },
    );
    await settle(page);
    await assertCentred(page, A3);
    await dotExact(page, ev(3), A3);
    assert.equal(await dot.getAttribute("aria-pressed"), "true");
    assert.match(await status(page), /zoomed to the recorded location/);
    await shot(page, "desktop-dot-double-click.png");
    // A co-located event is reachable through its timeline slice.
    await mouseDouble(
      page,
      page.locator(`.dashboard-timeline-mark[data-event-id="${ev(1)}"]`),
    );
    await assertCentred(page, A1);
    // Cy's coincident event stays truthfully at the same point.
    const badge = page.locator(".dashboard-map-group");
    assert.equal(await badge.getAttribute("data-count"), "2");
    // A slice without a shared location never moves the camera.
    const before = await view(page);
    await mouseDouble(
      page,
      page.locator(`.dashboard-timeline-mark[data-event-id="${ev(5)}"]`),
    );
    assert.deepEqual(await view(page), before);
    assert.match(await status(page), /no shared location.*not changed/);
    // Keyboard equivalent: Shift+Enter on a member card and on a dot.
    await page
      .locator(".dashboard-member-card", {
        has: page.locator(`[data-member-id="${bob}"]`),
      })
      .focus();
    await page.keyboard.press("Shift+Enter");
    await settle(page);
    assert.equal(await pressed(page, bob), "true");
    await assertCentred(page, TOKYO);
    await page.locator(".dashboard-member-all").click();
    await settle(page);
    await nearby(page);
    await page
      .locator(`.dashboard-event-dot[data-event-id="${ev(2)}"]`)
      .focus();
    await page.keyboard.press("Shift+Enter");
    await settle(page);
    await assertCentred(page, A2);
  }, options));

test("dateline focus keeps fractional longitudes on the shortest arc", async () => {
  const east: [number, number] = [10.0000412, 179.9999123],
    west: [number, number] = [10.0000077, -179.9999371];
  await fixture(
    async (page) => {
      await settle(page);
      await mouseDouble(page, portrait(page, ada));
      await assertTightFit(page, [east, west]);
      assert.equal((await view(page)).zoom, FOCUS_ZOOM);
      assert.ok(await offscreen(page, TOKYO));
      await dotExact(page, ev(1), east);
      await dotExact(page, ev(2), west);
      await mouseDouble(
        page,
        page.locator(`.dashboard-event-dot[data-event-id="${ev(2)}"]`),
      );
      await assertCentred(page, west);
      await dotExact(page, ev(2), west);
    },
    {
      events: [
        row(1, ada, at(1), "workout.set_completed", east),
        row(2, ada, at(2), "meal.food_added", west),
        row(3, bob, at(3), "workout.set_completed", TOKYO),
      ],
      users,
      marks: 3,
    },
  );
});

test("native touch double tap focuses without page zoom or Leaflet's double-tap zoom", async () =>
  fixture(
    async (page) => {
      const cdp = await page.context().newCDPSession(page);
      try {
        await settle(page);
        const scale = () => page.evaluate(() => visualViewport!.scale);
        assert.equal(await scale(), 1);
        // Record how the page receives the input: touch-sourced clicks only.
        await page.evaluate(() => {
          (window as any).inputLog = [];
          for (const type of ["click", "dblclick", "mousedown"])
            document.addEventListener(
              type,
              (event: any) =>
                (window as any).inputLog.push(
                  `${type}:${event.pointerType ?? ""}:${event.sourceCapabilities?.firesTouchEvents ?? ""}`,
                ),
              true,
            );
        });
        const initial = await view(page);
        // One tap is ordinary selection.
        await touchTap(page, cdp, portrait(page, ada));
        assert.equal(await pressed(page, ada), "true");
        assert.deepEqual(await view(page), initial);
        await touchTap(page, cdp, portrait(page, ada), 2);
        assert.equal(await scale(), 1, "no browser double-tap zoom");
        assert.equal(await pressed(page, ada), "true");
        await assertTightFit(page, [A1, A2, A3, BOSTON]);
        assert.ok(await offscreen(page, TOKYO));
        await page.locator("#dashboardMap").scrollIntoViewIfNeeded();
        await shot(page, "mobile-member-double-tap.png");
        // Double tap a dot: exactly the focus zoom, not Leaflet's +1.
        await nearby(page);
        await touchTap(
          page,
          cdp,
          page.locator(`.dashboard-event-dot[data-event-id="${ev(2)}"]`),
          2,
        );
        assert.equal(await scale(), 1);
        await assertCentred(page, A2);
        assert.equal(
          await page
            .locator(`.dashboard-event-dot[data-event-id="${ev(2)}"]`)
            .getAttribute("aria-pressed"),
          "true",
        );
        await page.locator("#dashboardMap").scrollIntoViewIfNeeded();
        await shot(page, "mobile-dot-double-tap.png");
        const log: string[] = await page.evaluate(
          () => (window as any).inputLog,
        );
        const clicks = log.filter((entry) => entry.startsWith("click:"));
        assert.equal(clicks.length, 5, log.join(" "));
        assert.ok(
          clicks.every((entry) => entry === "click:touch:true"),
          log.join(" "),
        );
      } finally {
        await cdp.detach().catch(() => {});
      }
    },
    { ...options, touch: true, viewport: { width: 390, height: 844 } },
  ));

test("on a local day, another member's double-click is never overwritten by the restore animation", async () => {
  const near: [number, number][] = [
    [40.70001, -73.90002],
    [40.70093, -73.90071],
    [40.70412, -73.89688],
  ];
  await fixture(
    async (page) => {
      await settle(page);
      const initial = await view(page);
      await mouseDouble(page, portrait(page, ada));
      const focused = await view(page);
      // Within Leaflet's zoom animation threshold, so a restore would animate.
      assert.ok(
        focused.zoom > initial.zoom && focused.zoom - initial.zoom <= 4,
      );
      await mouseDouble(page, portrait(page, bob));
      await assertCentred(page, near[2]);
    },
    {
      events: [
        row(1, ada, at(1), "workout.set_completed", near[0]),
        row(2, ada, at(2), "meal.food_added", near[1]),
        row(3, bob, at(3), "workout.set_completed", near[2]),
      ],
      users,
      marks: 3,
    },
  );
});
