import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fixture,
  ada,
  bob,
  id,
  ev,
  gps,
  type Event,
  type Override,
} from "./helpers/exact-map-fixture.js";

// Member cards are clickable before the paged day ledger finishes loading.
// A member picture double activation in that window is a deliberate focus
// request: once the day publishes, the camera fits that member's shown
// locations instead of being left on the default all-members fit.

const eve = "eeeeeeeeeeeeeeeeeeeeeeee";
const users = [
  { _id: ada, display_name: "Synthetic Ada" },
  { _id: bob, display_name: "Synthetic Bob" },
  { _id: eve, display_name: "Synthetic Eve" },
];
const FOCUS_ZOOM = 18;
const evidence = process.env.MAP_FOCUS_EVIDENCE_DIR;

const at = (hour: number, day = 28) =>
  `2026-09-${day}T${String(hour).padStart(2, "0")}:00:00.000Z`;
const row = (
  n: number,
  user: string,
  stamp: string,
  type: string,
  position: [number, number] | Record<string, unknown>,
): Event => ({
  id: ev(n),
  user_id: user,
  occurred_at: stamp,
  event_type: type,
  subject: { type: type.split(".")[0], id: id(n) },
  details: {},
  position: Array.isArray(position)
    ? gps(position[0], position[1], stamp)
    : position,
});
// Two NYC clusters ~15 km apart; exact fractional coordinates.
const ADA: [number, number][] = [
    [40.7075123, -74.0113456],
    [40.7081234, -74.0102345],
    [40.7069345, -74.0121234],
  ],
  BOB: [number, number][] = [
    [40.8448123, -73.8648456],
    [40.8452234, -73.8661345],
    [40.8441345, -73.8655234],
  ],
  PARIS: [number, number] = [48.8566123, 2.3522456];
const missing = { availability: "unavailable", reason: "missing" };
const events: Event[] = [
  row(1, ada, at(1), "workout.set_completed", ADA[0]),
  row(2, bob, at(2), "workout.set_completed", BOB[0]),
  row(3, eve, at(3), "survey.completed", missing),
  row(4, ada, at(4), "meal.food_added", ADA[1]),
  row(5, bob, at(5), "meal.food_added", BOB[1]),
  row(6, ada, at(6), "meal.food_added", ADA[2]),
  row(7, bob, at(7), "metric.recorded", BOB[2]),
  // Another day: never part of the 28th's focus.
  row(8, ada, at(9, 27), "workout.set_completed", PARIS),
];
const ALL = [...ADA, ...BOB];

// A two-page day whose second page is held until the test releases it.
function pagedDay() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const override: Override = (url, all) => {
    if (url.pathname !== "/api/dashboard/timeline") return undefined;
    const day = all.filter(
      (e) =>
        e.occurred_at >= url.searchParams.get("start")! &&
        e.occurred_at < url.searchParams.get("end")!,
    );
    if (!day.some((e) => e.occurred_at.startsWith("2026-09-28")))
      return { body: { users, events: day, hasMore: false } };
    return url.searchParams.get("cursor") === "page-2"
      ? { hold: held, body: { users, events: day.slice(3), hasMore: false } }
      : {
          body: {
            users,
            events: day.slice(0, 3),
            hasMore: true,
            nextCursor: "page-2",
          },
        };
  };
  return { release, override };
}
const loading = {
  events,
  users,
  ready: "Loading authorized event locations",
  marks: null,
};

// Camera and selection receipts, recorded in the page from the first frame.
async function record(page: any) {
  await page.evaluate(() => {
    const w = window as any;
    w.receipts = [];
    const note = (kind: string, extra = {}) => {
      const map = w.fixtureMap;
      w.receipts.push({
        t: Math.round(performance.now()),
        kind,
        zoom: map.getZoom(),
        lat: +map.getCenter().lat.toFixed(6),
        lng: +map.getCenter().lng.toFixed(6),
        selected:
          document
            .querySelector(
              '.dashboard-member-card[aria-pressed="true"] [data-member-id]',
            )
            ?.getAttribute("data-member-id") || null,
        ...extra,
      });
    };
    w.fixtureMap.on("moveend", () => note("moveend"));
    for (const type of ["click", "mousedown"])
      document.addEventListener(
        type,
        (event: any) =>
          note(type, {
            detail: event.detail,
            member:
              event.target
                ?.closest?.("[data-member-id], .dashboard-member-card")
                ?.querySelector?.("[data-member-id]")
                ?.getAttribute("data-member-id") ||
              event.target?.closest?.("[data-member-id]")?.dataset.memberId ||
              null,
          }),
        true,
      );
    new MutationObserver(() =>
      note("status", {
        text: document.querySelector("#dashboardMapStatus")!.textContent,
      }),
    ).observe(document.querySelector("#dashboardMapStatus")!, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
}
async function receipts(page: any, name: string) {
  if (!evidence) return;
  await mkdir(evidence, { recursive: true });
  await writeFile(
    join(evidence, name),
    JSON.stringify(
      await page.evaluate(() => (window as any).receipts),
      null,
      2,
    ),
  );
}
async function shot(page: any, name: string) {
  if (!evidence) return;
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, name) });
}

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
// Every coordinate inside the marker padding, and no integer zoom closer
// could still have shown them (or the given ceiling was reached).
async function assertFit(
  page: any,
  coords: [number, number][],
  ceiling: number,
  label: string,
) {
  const { w, h } = await mapSize(page);
  const pad = { x: Math.min(48, w / 4), y: Math.min(48, h / 4) };
  const shown = await points(page, coords);
  const { zoom } = await view(page);
  for (const p of shown)
    assert.ok(
      p.x >= pad.x - 1 &&
        p.x <= w - pad.x + 1 &&
        p.y >= pad.y - 1 &&
        p.y <= h - pad.y + 1,
      `${label}: point ${p.x},${p.y} inside ${w}x${h} at zoom ${zoom}`,
    );
  const xs = shown.map((p: any) => p.x),
    ys = shown.map((p: any) => p.y);
  assert.ok(
    zoom === ceiling ||
      (zoom < ceiling &&
        (Math.max(...xs) - Math.min(...xs) >= (w - 2 * pad.x) / 2 - 1 ||
          Math.max(...ys) - Math.min(...ys) >= (h - 2 * pad.y) / 2 - 1)),
    `${label}: tight at zoom ${zoom} (ceiling ${ceiling})`,
  );
}
// The member focus: Ada's three points at street level, Bob's cluster gone.
async function assertAdaFocus(page: any) {
  await assertFit(page, ADA, FOCUS_ZOOM, "Ada focus");
  const bobShown = await points(page, BOB);
  const { w, h } = await mapSize(page);
  assert.ok(
    bobShown.every((p: any) => p.x < 0 || p.y < 0 || p.x > w || p.y > h),
    "Bob's cluster is outside the focused camera",
  );
}
// The ordinary opening day fit of every member's located event.
const assertDefaultFit = (page: any, label: string) =>
  assertFit(page, ALL, 16, label);

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
// Real CDP mouse input: click counts 1 then 2 with a human gap.
async function mouseDouble(page: any, locator: any) {
  const { x, y } = await centre(locator);
  await page.mouse.move(x, y);
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.up({ clickCount: 1 });
  await page.waitForTimeout(150);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
}
async function touchDouble(page: any, cdp: any, locator: any) {
  const { x, y } = await centre(locator);
  for (let i = 0; i < 2; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    if (!i) await page.waitForTimeout(90);
  }
}
async function stillLoading(page: any) {
  assert.match(await status(page), /Loading authorized event locations/);
  assert.equal(await page.locator(".dashboard-event-dot").count(), 0);
}
async function publish(page: any, release: () => void) {
  release();
  await page.waitForFunction(() =>
    document
      .querySelector("#dashboardMapStatus")
      ?.textContent?.includes("complete day"),
  );
  await page.waitForFunction(
    () => document.querySelectorAll(".dashboard-timeline-mark").length === 7,
  );
  await settle(page);
}

test("a member double-click while the paged day loads fits that member once it publishes, not the default all-members view", async () => {
  const day = pagedDay();
  await fixture(
    async (page) => {
      await record(page);
      await portrait(page, ada).waitFor();
      await stillLoading(page);
      const before = await view(page);
      await mouseDouble(page, portrait(page, ada));
      await settle(page);
      assert.equal(await pressed(page, ada), "true");
      // Nothing is loaded yet: the camera waits rather than guessing.
      assert.deepEqual(await view(page), before);
      const pending = await status(page);
      await publish(page, day.release);
      await shot(page, "paged-member-double-click-after-publish.png");
      await receipts(page, "paged-member-double-click-receipts.json");
      await assertAdaFocus(page);
      // While loading, the status never claimed Ada has no location.
      assert.doesNotMatch(pending, /no shared event location/);
      assert.match(pending, /Synthetic Ada.*once this day's events load/);
      assert.equal(await pressed(page, ada), "true", "selection is kept");
      assert.equal(
        await page.locator("#dashboardMapSelection").innerText(),
        "",
      );
      assert.match(
        await status(page),
        /Map zoomed to Synthetic Ada's 3 shown event locations/,
      );
      // The applied focus is a deliberate camera: a resize keeps it.
      const focused = await view(page);
      await page.setViewportSize({ width: 1180, height: 900 });
      await page.waitForFunction(() => {
        const map = (window as any).fixtureMap,
          node = document.querySelector<HTMLElement>("#dashboardMap")!;
        return map.getSize().x === node.clientWidth;
      });
      await settle(page);
      assert.equal((await view(page)).zoom, focused.zoom);
      await assertAdaFocus(page);
      // An explicit All reset returns to the day's default all-members fit.
      await page.setViewportSize({ width: 1440, height: 1000 });
      await settle(page);
      await page.locator(".dashboard-member-all").click();
      await settle(page);
      await assertDefaultFit(page, "All reset");
      assert.doesNotMatch(await status(page), /Map zoomed/);
      await shot(page, "paged-all-reset.png");
    },
    { ...loading, override: day.override },
  );
});

test("a native touch double tap while the paged day loads fits that member once it publishes", async () => {
  const day = pagedDay();
  await fixture(
    async (page) => {
      const cdp = await page.context().newCDPSession(page);
      try {
        await record(page);
        await portrait(page, ada).waitFor();
        await stillLoading(page);
        await touchDouble(page, cdp, portrait(page, ada));
        await settle(page);
        assert.equal(await pressed(page, ada), "true");
        await publish(page, day.release);
        await page.locator("#dashboardMap").scrollIntoViewIfNeeded();
        await shot(page, "paged-member-double-tap-after-publish.png");
        await receipts(page, "paged-member-double-tap-receipts.json");
        assert.equal(
          await page.evaluate(() => visualViewport!.scale),
          1,
          "no page zoom",
        );
        await assertAdaFocus(page);
      } finally {
        await cdp.detach().catch(() => {});
      }
    },
    {
      ...loading,
      override: day.override,
      touch: true,
      viewport: { width: 390, height: 844 },
    },
  );
});

test("without a pending focus, or after All, another member, a map drag or a date change, the day keeps its ordinary fit", async () => {
  // No request: the ordinary opening fit of every member.
  {
    const day = pagedDay();
    await fixture(
      async (page) => {
        await portrait(page, ada).waitFor();
        await publish(page, day.release);
        await assertDefaultFit(page, "no request");
        assert.doesNotMatch(await status(page), /Map zoomed|no shared/);
      },
      { ...loading, override: day.override },
    );
  }
  // A later explicit All, an ordinary click on another member or a deliberate
  // map drag supersedes it.
  for (const [label, supersede] of [
    ["All", (page: any) => page.locator(".dashboard-member-all").click()],
    [
      "another member",
      async (page: any) => {
        await page.waitForTimeout(600); // A fresh gesture, not a third click.
        await portrait(page, bob).click();
      },
    ],
    [
      "a map drag",
      async (page: any) => {
        const box = await page.locator("#dashboardMap").boundingBox();
        const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 120, y + 40, { steps: 6 });
        await page.mouse.up();
      },
    ],
  ] as const) {
    const day = pagedDay();
    await fixture(
      async (page) => {
        await portrait(page, ada).waitFor();
        await mouseDouble(page, portrait(page, ada));
        await supersede(page);
        await settle(page);
        assert.doesNotMatch(await status(page), /will zoom/);
        await publish(page, day.release);
        await assertDefaultFit(page, `superseded by ${label}`);
        assert.doesNotMatch(await status(page), /Map zoomed|no shared/);
      },
      { ...loading, override: day.override },
    );
  }
  // A date change before the day publishes cancels the old date's request.
  {
    const day = pagedDay();
    await fixture(
      async (page) => {
        await portrait(page, ada).waitFor();
        await mouseDouble(page, portrait(page, ada));
        await page.evaluate(() => {
          const input =
            document.querySelector<HTMLInputElement>("#dashboardMapDate")!;
          input.value = "2026-09-27";
          input.dispatchEvent(new Event("change"));
        });
        await page.waitForFunction(
          () =>
            document.querySelectorAll(".dashboard-event-dot").length === 1 &&
            document
              .querySelector("#dashboardMapStatus")
              ?.textContent?.includes("complete day"),
        );
        day.release();
        await settle(page);
        // The single-point day fit stays at 16, never the focus zoom.
        assert.equal((await view(page)).zoom, 16);
        assert.doesNotMatch(await status(page), /Map zoomed|no shared/);
      },
      { ...loading, override: day.override },
    );
  }
});

test("a pending focus for a member without a shared location becomes a truthful no-op after loading", async () => {
  const day = pagedDay();
  await fixture(
    async (page) => {
      await portrait(page, eve).waitFor();
      await mouseDouble(page, portrait(page, eve));
      await settle(page);
      const pending = await status(page);
      await publish(page, day.release);
      await assertDefaultFit(page, "no-GPS member");
      assert.equal(await pressed(page, eve), "true");
      assert.match(
        await status(page),
        /Synthetic Eve has no shared event location on 2026-09-28; the map view was not changed\./,
      );
      // Before loading it could not yet know, and never claimed so.
      assert.doesNotMatch(pending, /no shared event location/);
    },
    { ...loading, override: day.override },
  );
});

// A wheel zoom is still animating when the second click lands: Leaflet drops
// a fit requested mid-animation, and its animation end overwrites a set view.
async function wheelThenDouble(
  page: any,
  locator: any,
  // Runs while the animation is still in flight, after the double activation.
  meanwhile?: () => Promise<void>,
) {
  const { x, y } = await centre(locator);
  const box = await page.locator("#dashboardMap").boundingBox();
  await page.evaluate(() => {
    const w = window as any;
    w.clicksInAnimation = [];
    document.addEventListener(
      "click",
      () =>
        w.clicksInAnimation.push(
          !!document.querySelector("#dashboardMap .leaflet-zoom-anim"),
        ),
      true,
    );
  });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -200);
  await page.waitForFunction(() =>
    document.querySelector("#dashboardMap .leaflet-zoom-anim"),
  );
  await page.mouse.move(x, y);
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.up({ clickCount: 1 });
  await page.waitForTimeout(40);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await meanwhile?.();
  assert.ok(
    (await page.evaluate(() => (window as any).clicksInAnimation))
      .slice(-2)
      .every(Boolean),
    "the activation landed during the wheel zoom animation",
  );
  await settle(page);
}

test("a double activation landing during a wheel zoom animation still focuses once it ends", async () => {
  const day = pagedDay();
  day.release();
  await fixture(
    async (page) => {
      await settle(page);
      await assertDefaultFit(page, "opening day fit");
      await wheelThenDouble(page, portrait(page, ada));
      await shot(page, "wheel-member-double-click.png");
      assert.equal(await pressed(page, ada), "true");
      await assertAdaFocus(page);
      assert.match(
        await status(page),
        /Map zoomed to Synthetic Ada's 3 shown event locations/,
      );
      // The exact-event focus from a timeline slice behaves the same.
      await page.locator(".dashboard-member-all").click();
      await settle(page);
      await assertDefaultFit(page, "All reset");
      await wheelThenDouble(
        page,
        page.locator(`.dashboard-timeline-mark[data-event-id="${ev(5)}"]`),
      );
      const { w, h } = await mapSize(page);
      const [point] = await points(page, [BOB[1]]);
      assert.equal((await view(page)).zoom, FOCUS_ZOOM);
      assert.ok(
        Math.abs(point.x - w / 2) <= 2 && Math.abs(point.y - h / 2) <= 2,
        `event centred: ${point.x},${point.y} in ${w}x${h}`,
      );
      assert.match(await status(page), /zoomed to the recorded location/);
      // An All selection made before the animation ends supersedes the focus.
      await page.locator(".dashboard-member-all").click();
      await settle(page);
      await wheelThenDouble(page, portrait(page, ada), async () => {
        const all = await centre(page.locator(".dashboard-member-all"));
        await page.mouse.click(all.x, all.y);
      });
      assert.notEqual((await view(page)).zoom, FOCUS_ZOOM);
      assert.doesNotMatch(await status(page), /Map zoomed/);
    },
    { events, users, override: day.override, marks: 7 },
  );
});

// Leaflet ends a zoom animation on transitionend or its 250 ms fallback timer.
// With the zoom transition disabled and that one timer captured, the wheel
// zoom stays in flight until the test ends it: the deferred focus boundary.
const holdableZoom = (page: any) =>
  page.addInitScript(() => {
    const w = window as any;
    const timeout = window.setTimeout;
    w.heldZoomEnds = [];
    (window as any).setTimeout = (fn: any, ms?: number, ...rest: any[]) => {
      if (w.holdZoomEnd && fn?.name === "bound _onZoomTransitionEnd") {
        w.heldZoomEnds.push(fn);
        return 0;
      }
      return timeout(fn, ms, ...rest);
    };
  });
const animating = (page: any) =>
  page.evaluate(
    () => !!document.querySelector("#dashboardMap .leaflet-zoom-anim"),
  );
async function holdWheelZoom(page: any) {
  await page.addStyleTag({
    content:
      ".leaflet-zoom-anim .leaflet-zoom-animated { transition: none !important; }",
  });
  await page.evaluate(() => ((window as any).holdZoomEnd = true));
  const box = await page.locator("#dashboardMap").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -200);
  await page.waitForFunction(
    () =>
      document.querySelector("#dashboardMap .leaflet-zoom-anim") &&
      (window as any).heldZoomEnds.length === 1,
  );
}
async function releaseZoom(page: any) {
  assert.equal(await animating(page), true, "the zoom was still held");
  await page.evaluate(() => {
    const w = window as any;
    w.holdZoomEnd = false;
    for (const end of w.heldZoomEnds.splice(0)) end();
  });
  assert.equal(await animating(page), false);
  await settle(page);
}
// The complete day; Ada's exact event reads are held and then denied (403),
// every other exact read stays pending so no reply moves the camera.
function deniableDay() {
  let deny!: () => void;
  const denial = new Promise<void>((resolve) => (deny = resolve));
  const override: Override = (url, all) => {
    if (url.pathname === "/api/dashboard/timeline")
      return {
        body: {
          users,
          events: all.filter((e) => e.occurred_at.startsWith("2026-09-28")),
          hasMore: false,
        },
      };
    if (url.pathname !== "/api/dashboard/event") return undefined;
    const event = all.find((e) => e.id === url.searchParams.get("event_id"));
    return event?.user_id === ada
      ? { hold: denial, status: 403, body: {} }
      : { hold: new Promise(() => {}) };
  };
  return { deny, override };
}
const adaGone = (page: any) =>
  page.waitForFunction(
    (member: string) =>
      !document.querySelector(
        `[data-member-id="${member}"].dashboard-event-dot, .dashboard-member-portrait[data-member-id="${member}"]`,
      ),
    ada,
  );
// After the held zoom ends, nothing was focused on a superseded target.
async function assertNotFocused(page: any, label: string) {
  assert.notEqual((await view(page)).zoom, FOCUS_ZOOM, label);
  assert.doesNotMatch(await status(page), /Map zoomed/, label);
}

for (const [label, run] of [
  [
    "nothing supersedes it: the member focus applies when the zoom ends",
    async (page: any) => {
      await holdWheelZoom(page);
      await mouseDouble(page, portrait(page, ada));
      await releaseZoom(page);
      await assertAdaFocus(page);
      assert.match(
        await status(page),
        /Map zoomed to Synthetic Ada's 3 shown event locations/,
      );
    },
  ],
  [
    "a denial of that member before the zoom ends cancels a member focus",
    async (page: any, day: ReturnType<typeof deniableDay>) => {
      // An earlier read of Ada's event is still pending.
      await page
        .locator(`.dashboard-timeline-mark[data-event-id="${ev(1)}"]`)
        .click();
      await holdWheelZoom(page);
      await mouseDouble(page, portrait(page, ada));
      day.deny();
      await adaGone(page);
      await releaseZoom(page);
      await shot(page, "held-zoom-member-denied.png");
      await assertNotFocused(page, "denied member");
    },
  ],
  [
    "a denial of that member before the zoom ends cancels an event focus",
    async (page: any, day: ReturnType<typeof deniableDay>) => {
      await holdWheelZoom(page);
      await page
        .locator(`.dashboard-event-dot[data-event-id="${ev(4)}"]`)
        .focus();
      await page.keyboard.press("Shift+Enter");
      day.deny();
      await adaGone(page);
      await releaseZoom(page);
      await assertNotFocused(page, "denied event");
    },
  ],
  [
    "a newer event selection before the zoom ends cancels a member focus",
    async (page: any) => {
      await holdWheelZoom(page);
      await mouseDouble(page, portrait(page, ada));
      // One of Ada's events: the member stays selected, the event is newer.
      await page
        .locator(`.dashboard-timeline-mark[data-event-id="${ev(6)}"]`)
        .click();
      await page.waitForFunction(
        (id: string) =>
          document
            .querySelector(`.dashboard-timeline-mark[data-event-id="${id}"]`)
            ?.getAttribute("aria-pressed") === "true",
        ev(6),
      );
      await releaseZoom(page);
      await assertNotFocused(page, "newer selection");
    },
  ],
  [
    "a category filter before the zoom ends cancels a member focus",
    async (page: any) => {
      await holdWheelZoom(page);
      await mouseDouble(page, portrait(page, ada));
      await page.locator('.dashboard-timeline [data-category="meal"]').click();
      await releaseZoom(page);
      await assertNotFocused(page, "category filter");
    },
  ],
] as const)
  test(`a focus deferred by a held zoom animation: ${label}`, async () => {
    const day = deniableDay();
    await fixture((page) => run(page, day), {
      events,
      users,
      override: day.override,
      marks: 7,
      beforeLoad: holdableZoom,
    });
  });

// Chromium dispatches the second click only if the node pressed by its
// mousedown is still connected at mouseup. A roster or feed arrival, or a
// denial of another member, re-renders the member cards; landing inside a held
// second press it must update the retained cards rather than replace them.
const held = () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  return { hold, release };
};
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
// Synthetic avatars for Ada and Bob; Eve keeps her initials.
const avatars = (page: any) =>
  page.route("**/api/dashboard/avatar?*", (route: any) =>
    [ada, bob].includes(new URL(route.request().url()).searchParams.get("id")!)
      ? route.fulfill({ contentType: "image/png", body: PNG })
      : route.fulfill({ status: 404, body: "" }),
  );
const dayOnly: Override = (url, all) =>
  url.pathname === "/api/dashboard/timeline"
    ? {
        body: {
          users,
          events: all.filter((e) => e.occurred_at.startsWith("2026-09-28")),
          hasMore: false,
        },
      }
    : undefined;
// The roster carries stats (Bob's photo body-fat estimate has a tooltip);
// the feed's user rows never do.
const rosterUsers = users.map((user) =>
  user._id === ada
    ? { ...user, stats: { weight: { value: 61, unit: "kg" }, height_cm: 170 } }
    : user._id === bob
      ? {
          ...user,
          stats: {
            body_fat_percent: 21.5,
            body_fat_estimate: { source: "ai", estimated: true, value: 21.5 },
          },
        }
      : user,
);
const card = (page: any, member: string) =>
  page.locator(".dashboard-member-card", {
    has: page.locator(`[data-member-id="${member}"]`),
  });
const avatarUrl = (page: any, member: string) =>
  page.evaluate(
    (m: string) =>
      document
        .querySelector<HTMLImageElement>(
          `.dashboard-member-portrait[data-member-id="${m}"] img.dashboard-roster-image`,
        )
        ?.getAttribute("src") || null,
    member,
  );
const avatarLoaded = (page: any, member: string) =>
  page.waitForFunction((m: string) => {
    const image = document.querySelector<HTMLImageElement>(
      `.dashboard-member-portrait[data-member-id="${m}"] img.dashboard-roster-image`,
    );
    return image?.complete && image.naturalWidth > 0;
  }, member);
const revoked = (page: any, url: string) =>
  page.evaluate((u: string) => {
    // A fresh decoder tests Blob URL lifetime under the served CSP; fetch
    // can reject even an authorized live blob when connect-src excludes it.
    const image = new Image();
    image.src = u;
    return image.decode().then(
      () => false,
      () => true,
    );
  }, url);
// A denial removes the member's card, avatar and every map location at once.
const memberGone = (page: any, member: string) =>
  page.waitForFunction(
    (m: string) =>
      !document.querySelector(
        `[data-member-id="${m}"].dashboard-event-dot, .dashboard-member-portrait[data-member-id="${m}"], .dashboard-member-tooltip[id$="${m}"]`,
      ),
    member,
  );
// Native click 1, then a held native press 2 on the member's picture; `during`
// runs (and settles its update) while the button is down, then it is released.
async function heldSecondPress(
  page: any,
  member: string,
  during: () => Promise<void>,
) {
  const { x, y } = await centre(portrait(page, member));
  await page.evaluate(() => {
    const w = window as any;
    w.pressClicks = [];
    document.addEventListener(
      "click",
      (event: any) =>
        w.pressClicks.push({
          detail: event.detail,
          member:
            event.target
              ?.closest?.(".dashboard-member-card")
              ?.querySelector("[data-member-id]")?.dataset.memberId || null,
        }),
      true,
    );
  });
  await page.mouse.move(x, y);
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.up({ clickCount: 1 });
  await page.waitForTimeout(120);
  await page.evaluate((m: string) => {
    const w = window as any;
    const node = document.querySelector(
      `.dashboard-member-portrait[data-member-id="${m}"]`,
    )!;
    w.pressedNodes = {
      portrait: node,
      button: node.closest("button"),
      entry: node.closest(".dashboard-member-entry"),
      rail: node.closest(".dashboard-member-rail"),
    };
    w.pressClicks.length = 0;
  }, member);
  await page.mouse.down({ clickCount: 2 });
  await during();
  // Recorded while still held; asserted after the native release.
  const retained = await page.evaluate(
    ({ m, x, y }: { m: string; x: number; y: number }) => {
      const nodes = (window as any).pressedNodes;
      const now = document.querySelector(
        `.dashboard-member-portrait[data-member-id="${m}"]`,
      );
      return {
        connected: Object.values(nodes).every((n: any) => n.isConnected),
        same: now === nodes.portrait && now?.closest("button") === nodes.button,
        underPointer: nodes.button.contains(document.elementFromPoint(x, y)),
      };
    },
    { m: member, x, y },
  );
  await page.mouse.up({ clickCount: 2 });
  await settle(page);
  return {
    retained,
    clicks: (await page.evaluate(() => (window as any).pressClicks)) as {
      detail: number;
      member: string | null;
    }[],
  };
}
async function assertHeldDoubleFocused(
  page: any,
  result: Awaited<ReturnType<typeof heldSecondPress>>,
  label: string,
) {
  assert.deepEqual(
    result.clicks,
    [{ detail: 2, member: ada }],
    `${label}: the native second click reached Ada's card`,
  );
  assert.equal(await pressed(page, ada), "true", label);
  await assertAdaFocus(page);
  assert.match(
    await status(page),
    /Map zoomed to Synthetic Ada's 3 shown event locations/,
    label,
  );
  assert.deepEqual(
    result.retained,
    { connected: true, same: true, underPointer: true },
    `${label}: the pressed picture and button stayed the same connected nodes`,
  );
}

test("a roster arrival inside a held second press keeps the pressed card, so the double-click still focuses", async () => {
  const roster = held();
  await fixture(
    async (page) => {
      await record(page);
      await portrait(page, ada).waitFor();
      // Feed-only cards: the separately authorized roster is still held.
      assert.equal(
        await page.locator("#dashboardMemberHeading").innerText(),
        "Members in loaded shared data",
      );
      assert.equal(await page.locator(".dashboard-roster-image").count(), 0);
      await settle(page);
      await assertDefaultFit(page, "opening day fit");
      const result = await heldSecondPress(page, ada, async () => {
        roster.release();
        // The roster render and Ada's avatar settle while the button is down.
        await page.waitForFunction(
          () =>
            document.querySelector("#dashboardMemberHeading")?.textContent ===
            "Dojo members",
        );
        await avatarLoaded(page, ada);
        await avatarLoaded(page, bob);
        assert.match(await card(page, ada).innerText(), /Weight: 61 kg/);
        assert.match(await card(page, ada).innerText(), /Height: 170 cm/);
        await shot(page, "h2-roster-arrival-held.png");
      });
      await receipts(page, "h2-roster-arrival-receipts.json");
      await shot(page, "h2-roster-arrival-after.png");
      await assertHeldDoubleFocused(page, result, "roster arrival");
      // Current roster data, order and avatars; one image per picture.
      assert.deepEqual(
        await page
          .locator(".dashboard-member-portrait")
          .evaluateAll((nodes: HTMLElement[]) =>
            nodes.map((n) => [
              n.dataset.memberId,
              n.querySelectorAll("img").length,
              n.textContent,
            ]),
          ),
        [
          [ada, 1, "SA"],
          [bob, 1, "SB"],
          [eve, 0, "SE"],
        ],
      );
      assert.match(await card(page, bob).innerText(), /Weight: Unavailable/);
      assert.match(await card(page, bob).innerText(), /Body fat: 21.5 %/);
      // Keyboard activation re-renders in place too: focus stays on the button.
      await card(page, bob).focus();
      await page.keyboard.press("Shift+Enter");
      await settle(page);
      assert.equal(await pressed(page, bob), "true");
      assert.equal(await pressed(page, ada), "false");
      assert.equal(
        await card(page, bob).evaluate(
          (node: Element) => node === document.activeElement,
        ),
        true,
      );
      await assertFit(page, BOB, FOCUS_ZOOM, "Bob keyboard focus");
      assert.match(
        await status(page),
        /Map zoomed to Synthetic Bob's 3 shown event locations/,
      );
      await page.locator(".dashboard-member-all").click();
      await settle(page);
      await assertDefaultFit(page, "All reset");
      assert.equal(
        await page
          .locator(".dashboard-member-all")
          .getAttribute("aria-pressed"),
        "true",
      );
      assert.equal(
        await page
          .locator('.dashboard-member-card[aria-pressed="true"]')
          .count(),
        0,
      );
    },
    {
      events,
      users,
      marks: 7,
      beforeLoad: avatars,
      override: (url, all) =>
        url.pathname === "/api/dashboard"
          ? { body: { users, activities: [], hasMore: false } }
          : url.pathname === "/api/dashboard/members"
            ? { hold: roster.hold, body: { members: rosterUsers } }
            : dayOnly(url, all),
    },
  );
});

test("an older feed page arriving inside a held second press keeps the pressed card, so the double-click still focuses", async () => {
  const older = held();
  const fay = "ffffffffffffffffffffffff";
  await fixture(
    async (page, state) => {
      await record(page);
      await portrait(page, ada).waitFor();
      await avatarLoaded(page, ada);
      await settle(page);
      await page.getByRole("button", { name: "Load older activities" }).click();
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardStatus")
          ?.textContent?.includes("Loading shared dashboard"),
      );
      assert.ok(
        state.requests.some((r) => r.startsWith("/api/dashboard?before=")),
      );
      const result = await heldSecondPress(page, ada, async () => {
        older.release();
        // The older page adds a feed-only member while the button is down.
        await page.waitForFunction(() =>
          document
            .querySelector("#dashboardStatus")
            ?.textContent?.includes("Loaded bounded feed history"),
        );
        await portrait(page, fay).waitFor();
        await shot(page, "h2-feed-page-held.png");
      });
      await receipts(page, "h2-feed-page-receipts.json");
      await assertHeldDoubleFocused(page, result, "feed page arrival");
      assert.deepEqual(
        await page
          .locator(".dashboard-member-portrait")
          .evaluateAll((nodes: HTMLElement[]) =>
            nodes.map((n) => n.dataset.memberId),
          ),
        [ada, bob, fay, eve],
      );
      assert.equal(
        await page.locator(".dashboard-member-portrait img").count(),
        2,
      );
    },
    {
      events,
      users,
      marks: 7,
      beforeLoad: avatars,
      override: (url, all) =>
        url.pathname !== "/api/dashboard"
          ? dayOnly(url, all)
          : url.searchParams.has("before")
            ? {
                hold: older.hold,
                body: {
                  users: [
                    users[0],
                    users[1],
                    { _id: fay, display_name: "Synthetic Fay" },
                  ],
                  activities: [],
                  hasMore: false,
                },
              }
            : {
                body: {
                  users: users.slice(0, 2),
                  activities: [],
                  hasMore: true,
                  oldestDate: "2026-09-01T00:00:00.000Z",
                },
              },
    },
  );
});

// One member's exact event reads are held, then denied (403); every other
// exact read stays pending so no reply moves the camera.
function deniable(member: string) {
  const denial = held();
  const override: Override = (url, all) => {
    if (url.pathname === "/api/dashboard/members")
      return { body: { members: rosterUsers } };
    if (url.pathname !== "/api/dashboard/event") return dayOnly(url, all);
    const event = all.find((e) => e.id === url.searchParams.get("event_id"));
    return event?.user_id === member
      ? { hold: denial.hold, status: 403, body: {} }
      : { hold: new Promise(() => {}) };
  };
  return { deny: denial.release, override };
}

test("another member's denial inside a held second press is removed at once and the pressed card still focuses", async () => {
  const day = deniable(bob);
  await fixture(
    async (page) => {
      await record(page);
      await avatarLoaded(page, ada);
      await avatarLoaded(page, bob);
      const bobAvatar = (await avatarUrl(page, bob))!;
      assert.equal(
        await revoked(page, bobAvatar),
        false,
        "live avatar decodes",
      );
      assert.equal(
        await page.locator(`#dashboard-bodyfat-${bob}`).count(),
        1,
        "Bob's body-fat tooltip exists before the denial",
      );
      // An earlier read of Bob's event is still pending.
      await page
        .locator(`.dashboard-timeline-mark[data-event-id="${ev(2)}"]`)
        .click();
      await settle(page);
      const result = await heldSecondPress(page, ada, async () => {
        day.deny();
        // Removed while the button is still down, not after the gesture.
        await memberGone(page, bob);
        assert.equal(await revoked(page, bobAvatar), true, "avatar revoked");
        assert.equal(
          await page
            .locator(`.dashboard-timeline-mark[data-member-id="${bob}"]`)
            .count(),
          0,
        );
        await shot(page, "h2-other-denied-held.png");
      });
      await receipts(page, "h2-other-denied-receipts.json");
      await assertHeldDoubleFocused(page, result, "another member denied");
      assert.equal(await card(page, bob).count(), 0);
      assert.ok(await avatarUrl(page, ada), "Ada keeps her avatar");
      assert.deepEqual(
        await page
          .locator(".dashboard-member-portrait")
          .evaluateAll((nodes: HTMLElement[]) =>
            nodes.map((n) => n.dataset.memberId),
          ),
        [ada, eve],
      );
      assert.match(await card(page, ada).innerText(), /Weight: 61 kg/);
    },
    { events, users, marks: 7, beforeLoad: avatars, override: day.override },
  );
});

test("the pressed member's own denial inside a held second press removes it at once and nothing activates later", async () => {
  const day = deniable(ada);
  await fixture(
    async (page) => {
      await record(page);
      await avatarLoaded(page, ada);
      const adaAvatar = (await avatarUrl(page, ada))!;
      assert.equal(
        await revoked(page, adaAvatar),
        false,
        "live avatar decodes",
      );
      await page
        .locator(`.dashboard-timeline-mark[data-event-id="${ev(1)}"]`)
        .click();
      await settle(page);
      const before = await view(page);
      const result = await heldSecondPress(page, ada, async () => {
        day.deny();
        await memberGone(page, ada);
        assert.equal(await revoked(page, adaAvatar), true, "avatar revoked");
        assert.equal(
          await page
            .locator(`.dashboard-timeline-mark[data-member-id="${ada}"]`)
            .count(),
          0,
        );
        await shot(page, "h2-pressed-denied-held.png");
      });
      await page.waitForTimeout(600);
      await receipts(page, "h2-pressed-denied-receipts.json");
      assert.equal(result.retained.connected, false, "the denied card is gone");
      assert.deepEqual(
        result.clicks.filter((c) => c.member),
        [],
        "no member card was activated by the release",
      );
      assert.equal(await card(page, ada).count(), 0);
      assert.equal(
        await page
          .locator('.dashboard-member-card[aria-pressed="true"]')
          .count(),
        0,
      );
      assert.notEqual((await view(page)).zoom, FOCUS_ZOOM);
      assert.ok((await view(page)).zoom <= before.zoom);
      assert.doesNotMatch(await status(page), /Map zoomed|Synthetic Ada/);
    },
    { events, users, marks: 7, beforeLoad: avatars, override: day.override },
  );
});
