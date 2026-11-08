import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import {
  fixture,
  clockProbe,
  ada,
  bob,
  ev,
  id,
  gps,
} from "./helpers/exact-map-fixture.js";
import { install, verdict, type Spec } from "./helpers/map-motion-sampler.js";

// Deliberate map focus (double activation or Shift+Enter) flies the camera:
// one native Leaflet pan+zoom of about half a second from the painted view to
// the exact existing target. Judged on Chrome's own rendering clock (no
// Playwright clock): every frame's camera is recorded, and the overlay marks
// are measured against the painted tiles throughout the flight.
const cy = "cccccccccccccccccccccccc",
  eve = "eeeeeeeeeeeeeeeeeeeeeeee";
const users = [
  { _id: ada, display_name: "Synthetic Ada" },
  { _id: bob, display_name: "Synthetic Bob" },
  { _id: cy, display_name: "Synthetic Cy" },
  { _id: eve, display_name: "Synthetic Eve" },
];
const FOCUS_ZOOM = 18;
const NOW = Date.parse("2026-12-01T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const at = (hour: number, minute = 0) =>
  `2026-09-28T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
// Ada in New York, Bob in Tokyo, Cy on both sides of the antimeridian.
const A: [number, number][] = [
  [40.7012345, -73.9221987],
  [40.7051234, -73.9151234],
  [40.6981234, -73.9101234],
];
const B: [number, number][] = [
  [35.6812345, 139.7671234],
  [35.6852345, 139.7591234],
];
const C: [number, number][] = [
  [-17.7134123, 178.0651234],
  [-13.8333123, -171.7667123],
];
const row = (
  n: number,
  user: string,
  stamp: string,
  fix: [number, number],
) => ({
  id: ev(n),
  user_id: user,
  occurred_at: stamp,
  event_type: n % 2 ? "workout.set_completed" : "meal.food_added",
  subject: { type: n % 2 ? "workout" : "meal", id: id(n) },
  details: {},
  position: gps(fix[0], fix[1], stamp),
});
const events = [
  ...A.map((fix, i) => row(i + 1, ada, at(6 + i), fix)),
  ...B.map((fix, i) => row(i + 4, bob, at(6 + i, 20), fix)),
  ...C.map((fix, i) => row(i + 6, cy, at(6 + i, 40), fix)),
];
const LATEST: Record<string, [number, number, number]> = {
  [ada]: [40.7031234, -73.9194321, NOW - 2 * 60000],
  [bob]: [51.5072123, -0.1276123, NOW - 3 * 3600000],
  // About 30m from Ada's: one aggregate pin (a chooser) below street level.
  [cy]: [40.7033534, -73.9192021, NOW - 9 * 60000],
  [eve]: [-33.8688123, 151.2093123, NOW - 5 * 60000],
};
const latestBody = {
  as_of: iso(NOW),
  members: users.map((user, n) => {
    const fix = LATEST[user._id];
    return {
      user_id: user._id,
      display_name: user.display_name,
      status: fix ? "located" : "none",
      latest: fix
        ? {
            event_id: ev(500 + n),
            event_type: "workout.sets_changed",
            occurred_at: iso(fix[2]),
            latitude: fix[0],
            longitude: fix[1],
            accuracy: 5,
            captured_at: iso(fix[2]),
            source: "gps",
          }
        : null,
    };
  }),
};
const FIXES = Object.fromEntries(
  events.map((e) => [e.id, [e.position.latitude, e.position.longitude]]),
) as Record<string, [number, number]>;
const LATEST_FIXES = Object.fromEntries(
  Object.entries(LATEST).map(([k, [lat, lng]]) => [k, [lat, lng]]),
) as Record<string, [number, number]>;
// What the sampler expects painted while one member is selected.
const spec = (member: string): Spec => {
  const mine = events.filter((e) => e.user_id === member);
  return {
    latest: LATEST_FIXES,
    events: mine.map((e) => e.id),
    lines: mine.slice(1).map((e, i) => [mine[i].id, e.id] as [string, string]),
  };
};
const evidence = process.env.MAP_FOCUS_FLIGHT_EVIDENCE_DIR;

const TILE_RGB = { r: 214, g: 222, b: 205 };
const beforeLoad = async (page: any) => {
  const raw = Buffer.alloc(256 * 256 * 3);
  for (let y = 0; y < 256; y++)
    for (let x = 0; x < 256; x++) {
      const edge = x < 2 || y < 2;
      const o = (y * 256 + x) * 3;
      raw[o] = edge ? 120 : TILE_RGB.r;
      raw[o + 1] = edge ? 130 : TILE_RGB.g;
      raw[o + 2] = edge ? 110 : TILE_RGB.b;
    }
  const tile = await sharp(raw, {
    raw: { width: 256, height: 256, channels: 3 },
  })
    .png()
    .toBuffer();
  await page.route("https://tile.openstreetmap.org/**", (route: any) =>
    route.fulfill({ contentType: "image/png", body: tile }),
  );
  // A native zoom whose end can be held (Leaflet ends it from a timer).
  await page.addInitScript(() => {
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
    // Leaflet also ends it on its proxy's transform transitionend.
    window.addEventListener(
      "transitionend",
      (e) => {
        const t = e.target as Element | null;
        if (w.holdZoomEnd && t?.classList?.contains("leaflet-proxy"))
          e.stopPropagation();
      },
      true,
    );
  });
};
const run = (
  body: (page: any) => Promise<void>,
  options: Record<string, unknown> = {},
) =>
  fixture(
    async (page) => {
      await page.waitForFunction(
        (n: number) =>
          document.querySelectorAll(".dashboard-event-dot").length === n,
        events.length,
      );
      const clock: any = await clockProbe(page);
      assert.ok(
        !clock.playwrightClock && clock.nativeRequestAnimationFrame,
        JSON.stringify(clock),
      );
      await body(page);
    },
    {
      users,
      events: events as any,
      now: iso(NOW),
      marks: null,
      nativeClock: true,
      beforeLoad,
      override: (url: URL) =>
        url.pathname === "/api/dashboard/latest-positions"
          ? { body: latestBody }
          : undefined,
      ...options,
    },
  );

// A fixed starting view; the tile fade (200ms) ends before anything is judged.
const startAt = (page: any, center: [number, number], zoom: number) =>
  page.evaluate(
    ([c, z]: [[number, number], number]) =>
      new Promise<void>((resolve) => {
        (window as any).fixtureMap.setView(c, z, { animate: false });
        setTimeout(resolve, 600);
      }),
    [center, zoom],
  );
const camera = (page: any) =>
  page.evaluate(() => {
    const m = (window as any).fixtureMap,
      c = m.getCenter();
    return { lat: c.lat, lng: c.lng, zoom: m.getZoom() };
  });
// Every rendered frame's camera (and a reference dot's painted box), plus
// the timestamps of the activations that ask for it, on one clock.
const record = (page: any, dotId?: string) =>
  page.evaluate((dotId?: string) => {
    const w = window as any,
      m = w.fixtureMap;
    w.__cameraRun = (w.__cameraRun || 0) + 1;
    const run = w.__cameraRun;
    w.__camera = { frames: [] as any[], inputs: [] as any[] };
    const input = (event: Event) =>
      w.__camera.inputs.push({
        type: event.type,
        t: event.timeStamp,
        detail: (event as MouseEvent).detail,
      });
    w.__cameraInput?.();
    for (const type of ["click", "keydown", "wheel", "pointerdown"])
      document.addEventListener(type, input, true);
    w.__cameraInput = () => {
      for (const type of ["click", "keydown", "wheel", "pointerdown"])
        document.removeEventListener(type, input, true);
    };
    const tick = (t: number) => {
      // A removed map (lock, another day) has no camera left to record.
      if (w.__cameraRun !== run || !m._mapPane) return;
      const c = m.getCenter();
      const dot = dotId
        ? document.querySelector<HTMLElement>(
            `.dashboard-event-dot[data-event-id="${dotId}"]`,
          )
        : null;
      const r = dot?.getClientRects().length
        ? dot.getBoundingClientRect()
        : null;
      w.__camera.frames.push({
        t,
        lat: c.lat,
        lng: c.lng,
        zoom: m.getZoom(),
        dot: r && {
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          w: r.width,
        },
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, dotId);
const recorded = (page: any) =>
  page.evaluate(() => {
    const w = window as any;
    w.__cameraRun++;
    w.__cameraInput?.();
    return w.__camera;
  });
const same = (a: any, b: any) =>
  Math.abs(a.zoom - b.zoom) < 1e-9 &&
  Math.abs(a.lat - b.lat) < 1e-9 &&
  Math.abs(a.lng - b.lng) < 1e-9;
// The camera's path from its first frame: when it first left the start and
// when it arrived at its final view, and every state in between.
const path = (frames: any[]) => {
  const start = frames[0],
    end = frames[frames.length - 1];
  const first = frames.findIndex((f) => !same(f, start));
  let arrive = frames.length - 1;
  while (arrive > 0 && same(frames[arrive - 1], end)) arrive--;
  const between = first < 0 ? [] : frames.slice(first, arrive);
  return {
    start,
    end,
    moved: first >= 0,
    firstAt: first < 0 ? null : frames[first].t,
    arriveAt: frames[arrive].t,
    duration: first < 0 ? 0 : frames[arrive].t - frames[first].t,
    between,
    fractional: between.filter((f) => f.zoom % 1).length,
    zooms: new Set(between.map((f) => f.zoom.toFixed(4))).size,
    centers: new Set(
      between.map((f) => `${f.lat.toFixed(6)},${f.lng.toFixed(6)}`),
    ).size,
  };
};
// A real flight: several rendered in-between views that change both center
// and zoom, starting promptly and lasting about half a second (generous
// bounds for browser scheduling; no exact 500ms promise).
const assertFlight = (p: any, askedAt: number, label: string) => {
  const info = JSON.stringify({
    ...p,
    between: p.between.length,
    start: p.start,
    end: p.end,
  });
  assert.ok(p.moved, `${label}: the camera moved ${info}`);
  assert.ok(p.between.length >= 5, `${label}: in-between frames ${info}`);
  assert.ok(
    p.fractional >= 3 && p.zooms >= 3,
    `${label}: zoom animates ${info}`,
  );
  assert.ok(p.centers >= 3, `${label}: center animates ${info}`);
  assert.ok(
    p.firstAt - askedAt >= -1 && p.firstAt - askedAt <= 250,
    `${label}: starts promptly (${p.firstAt - askedAt}ms) ${info}`,
  );
  assert.ok(
    p.duration >= 300 && p.duration <= 1100,
    `${label}: about half a second (${p.duration}ms) ${info}`,
  );
};
// Leaflet's own fitBounds target for the existing member focus (padding and
// zoom cap), compared on the world copy nearest the final view.
const assertMemberTarget = (page: any, fixes: [number, number][]) =>
  page.evaluate(
    ([fixes, cap]: [[number, number][], number]) => {
      const m = (window as any).fixtureMap,
        L = (window as any).L;
      const size = m.getSize(),
        pad = [Math.min(48, size.x / 4), Math.min(48, size.y / 4)];
      const lngs = fixes
        .map(([, lng]) => (lng + 360) % 360)
        .sort((a, b) => a - b);
      let start = lngs[0],
        gap = -1;
      for (let i = 0; i < lngs.length; i++) {
        const next = i + 1 < lngs.length ? lngs[i + 1] : lngs[0] + 360;
        if (next - lngs[i] > gap) {
          gap = next - lngs[i];
          start = lngs[(i + 1) % lngs.length];
        }
      }
      const coords = fixes.map(([lat, lng]) => {
        const w = (lng + 360) % 360;
        return [lat, w < start ? w + 360 : w];
      });
      const want =
        coords.length === 1
          ? { center: L.latLng(coords[0]), zoom: cap }
          : m._getBoundsCenterZoom(L.latLngBounds(coords), {
              padding: pad,
              maxZoom: cap,
            });
      const c = m.getCenter(),
        lng =
          want.center.lng + 360 * Math.round((c.lng - want.center.lng) / 360);
      return {
        target: { lat: want.center.lat, lng: want.center.lng, zoom: want.zoom },
        zoom: [m.getZoom(), want.zoom],
        px: m
          .project(c, m.getZoom())
          .distanceTo(m.project([want.center.lat, lng], m.getZoom())),
      };
    },
    [fixes, FOCUS_ZOOM],
  );
async function centre(page: any, selector: string) {
  const node = page.locator(selector);
  await node.scrollIntoViewIfNeeded();
  const box = await node.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
// Real CDP mouse input: click count 1 then 2 with a human gap.
async function mouseDouble(page: any, selector: string) {
  const { x, y } = await centre(page, selector);
  await page.mouse.move(x, y);
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.up({ clickCount: 1 });
  await page.waitForTimeout(120);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
}
const card = (member: string) =>
  `.dashboard-member-card:has(.dashboard-member-portrait[data-member-id="${member}"])`;
// The last activation input (second click or tap, or Shift+Enter).
const asked = (camera: any) => {
  const inputs = camera.inputs.filter((i: any) =>
    ["click", "keydown"].includes(i.type),
  );
  return inputs[inputs.length - 1].t;
};
// The camera path of one activation, from a recorded still start.
async function flight(page: any, act: () => Promise<void>, wait = 1500) {
  await record(page);
  await page.waitForTimeout(100);
  await act();
  await page.waitForTimeout(wait);
  const camera = await recorded(page);
  return { camera, p: path(camera.frames) };
}
// An exact recorded point at street level, on the world copy nearest it.
async function assertPoint(page: any, fix: [number, number], label: string) {
  const r = await page.evaluate(([lat, lng]: [number, number]) => {
    const m = (window as any).fixtureMap,
      c = m.getCenter(),
      z = m.getZoom(),
      near = lng + 360 * Math.round((c.lng - lng) / 360);
    return {
      zoom: z,
      px: m.project(c, z).distanceTo(m.project([lat, near], z)),
    };
  }, fix);
  assert.equal(r.zoom, FOCUS_ZOOM, `${label} ${JSON.stringify(r)}`);
  assert.ok(r.px < 1, `${label} ${JSON.stringify(r)}`);
}
const status = (page: any) => page.locator("#dashboardMapStatus").innerText();
async function save(name: string, data: unknown) {
  if (!evidence) return;
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, name), JSON.stringify(data, null, 2));
}
async function shot(page: any, name: string) {
  if (!evidence) return;
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, name) });
}
const landed = (page: any, ms = 1500) => page.waitForTimeout(ms);

test("member card: one click never moves the camera; a double-click flies pan+zoom about half a second to the exact member fit", async () =>
  run(async (page) => {
    // Somewhere else entirely: Tokyo at zoom 6.
    await startAt(page, B[0], 6);
    const before = await camera(page);
    // One click: ordinary selection only, on every frame.
    await record(page);
    const one = await centre(page, card(ada));
    await page.mouse.click(one.x, one.y);
    await page.waitForTimeout(900);
    const still = await recorded(page);
    assert.ok(still.frames.length > 20);
    assert.ok(
      still.frames.every((f: any) => same(f, before)),
      "a single click keeps the camera on every frame",
    );
    // A double-click: the sampler judges every overlay anchor on the tiles.
    await install(page, FIXES, spec(ada));
    await page.evaluate(() => (window as any).__motion.start());
    await record(page, events[0].id);
    await page.waitForTimeout(400);
    // Isolate an anchor-measurement window strictly inside this same flight;
    // neither the still prelude nor the landed tail can satisfy it.
    await page.evaluate(() => {
      const w = window as any;
      const onMove = (event: any) => {
        if (!event.flyTo) return;
        w.fixtureMap.off("move", onMove);
        w.__flightPrelude = w.__motion.stop();
        w.__motion.start();
        w.__flightSampleStart = performance.now();
      };
      w.fixtureMap.on("move", onMove);
    });
    await mouseDouble(page, card(ada));
    await page.waitForTimeout(220);
    const intermediate = await page.evaluate(() => {
      const w = window as any;
      const result = {
        start: w.__flightSampleStart,
        end: performance.now(),
        zoom: w.fixtureMap.getZoom(),
        sampler: w.__motion.stop(),
        prelude: w.__flightPrelude,
      };
      w.__motion.start();
      return result;
    });
    await shot(page, "member-flight-mid.png");
    await landed(page);
    const s = await page.evaluate(() => (window as any).__motion.stop());
    const flight = await recorded(page);
    const p = path(flight.frames);
    await save("member-flight.json", {
      camera: flight,
      sampler: s,
      intermediate,
      path: { ...p, between: p.between.length },
    });
    await shot(page, "member-flight-landed.png");
    assertFlight(p, asked(flight), "member card");
    assert.ok(
      intermediate.start >= asked(flight) &&
        intermediate.end < p.arriveAt &&
        intermediate.zoom % 1 !== 0,
      "anchor window is inside the moving flight, before landing",
    );
    assert.deepEqual(verdict(intermediate.sampler, 0, {}), []);
    // Unverified anchors remain disclosed in each segment's receipt: opaque
    // image bytes do not eliminate Leaflet's tile-load/fade gaps. Do not
    // count those as measurements or relax the sampler's visible-tile oracle.
    assert.ok(same(p.start, before), "the flight starts at the painted view");
    // Both pan and zoom: Tokyo z6 to New York at street level.
    assert.ok(Math.abs(p.end.lng - before.lng) > 100);
    assert.ok(p.end.zoom > before.zoom + 6);
    const target = await assertMemberTarget(page, A);
    assert.equal(target.zoom[0], target.zoom[1], JSON.stringify(target));
    assert.ok(target.px < 1, JSON.stringify(target));
    assert.match(
      await page.locator("#dashboardMapStatus").innerText(),
      /zoomed to Synthetic Ada's 3 shown event locations/,
    );
    // The reference dot is painted at intermediate positions at its fixed size.
    const dots = p.between.filter((f: any) => f.dot);
    assert.ok(dots.length >= 5, "the dot is painted along the flight");
    for (const f of dots)
      assert.ok(Math.abs(f.dot.w - 14) <= 0.5, JSON.stringify(f));
    const problems = verdict(s, 0, {});
    assert.deepEqual(
      problems,
      [],
      JSON.stringify({ ...s, frameWrites: undefined }),
    );
  }));

test("every deliberate route flies: map dot, timeline mark, card Shift+Enter, latest pin, chooser Shift+Enter", async () =>
  run(async (page) => {
    // Map dot double-click: New York z13 to the exact fix at street level.
    await startAt(page, [40.7, -73.93], 13);
    let { camera: c, p } = await flight(page, () =>
      mouseDouble(page, `.dashboard-event-dot[data-event-id="${ev(2)}"]`),
    );
    await save("route-dot.json", { camera: c });
    assertFlight(p, asked(c), "map dot");
    await assertPoint(page, A[1], "map dot");
    assert.match(
      await status(page),
      /Map zoomed to the recorded location of Synthetic Ada/,
    );
    // Timeline mark double-click: the flight starts once the read authorizes.
    await startAt(page, B[0], 6);
    ({ camera: c, p } = await flight(page, () =>
      mouseDouble(page, `.dashboard-timeline-mark[data-event-id="${ev(3)}"]`),
    ));
    await save("route-timeline.json", { camera: c });
    assertFlight(p, asked(c), "timeline mark");
    await assertPoint(page, A[2], "timeline mark");
    // Shift+Enter on a member card: Bob's two Tokyo fixes.
    await startAt(page, A[0], 9);
    await page.locator(card(bob)).focus();
    ({ camera: c, p } = await flight(page, () =>
      page.keyboard.press("Shift+Enter"),
    ));
    await save("route-shift-enter.json", { camera: c });
    assertFlight(p, asked(c), "Shift+Enter");
    const bobTarget = await assertMemberTarget(page, B);
    assert.equal(
      bobTarget.zoom[0],
      bobTarget.zoom[1],
      JSON.stringify(bobTarget),
    );
    assert.ok(bobTarget.px < 1, JSON.stringify(bobTarget));
    // Latest pin double-click: Eve's latest fix in Sydney from a world view.
    await startAt(page, [0, 40], 2);
    ({ camera: c, p } = await flight(page, () =>
      mouseDouble(page, `.dashboard-latest-pin[data-member-ids="${eve}"]`),
    ));
    await save("route-latest.json", { camera: c });
    assertFlight(p, asked(c), "latest pin");
    await assertPoint(page, LATEST_FIXES[eve], "latest pin");
    assert.match(
      await status(page),
      /Map centered on Synthetic Eve's latest known recorded position/,
    );
    // Chooser: Ada and Cy share one aggregate pin at z12. A choice's first
    // activation closes the chooser, so its deliberate route is Shift+Enter.
    await startAt(page, LATEST_FIXES[ada], 12);
    await page.click(`.dashboard-latest-pin[data-member-ids="${ada} ${cy}"]`);
    await page.waitForSelector(".dashboard-latest-chooser:not([hidden])");
    await page.focus(`.dashboard-latest-choice[data-member-id="${cy}"]`);
    ({ camera: c, p } = await flight(page, () =>
      page.keyboard.press("Shift+Enter"),
    ));
    await save("route-chooser.json", { camera: c });
    assertFlight(p, asked(c), "latest chooser");
    await assertPoint(page, LATEST_FIXES[cy], "latest chooser");
    await shot(page, "route-chooser-landed.png");
  }));

test("touch double tap on a member card flies; one tap only selects", async () =>
  run(
    async (page) => {
      const cdp = await page.context().newCDPSession(page);
      const tap = async () => {
        const { x, y } = await centre(page, card(ada));
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
        });
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
      };
      try {
        await startAt(page, B[0], 6);
        const before = await camera(page);
        let { p } = await flight(page, tap, 900);
        assert.ok(!p.moved, "one tap keeps the camera");
        assert.ok(same(p.end, before));
        let c;
        ({ camera: c, p } = await flight(page, async () => {
          await tap();
          await page.waitForTimeout(90);
          await tap();
        }));
        await save("route-touch.json", { camera: c });
        assertFlight(p, asked(c), "touch double tap");
        const target = await assertMemberTarget(page, A);
        assert.equal(target.zoom[0], target.zoom[1], JSON.stringify(target));
        assert.ok(target.px < 1, JSON.stringify(target));
      } finally {
        await cdp.detach().catch(() => {});
      }
    },
    { touch: true, viewport: { width: 390, height: 844 } },
  ));

// Leaflet's own fit for these fixes at the current size (any world copy).
const memberTarget = async (page: any, fixes: [number, number][]) =>
  (await assertMemberTarget(page, fixes)).target;
// Whether a recorded camera is that target (same zoom, within 1px).
const reached = (page: any, frames: any[], target: any) =>
  page.evaluate(
    ([frames, t]: [any[], any]) => {
      const m = (window as any).fixtureMap;
      return frames.some((f) => {
        if (Math.abs(f.zoom - t.zoom) > 1e-6) return false;
        const lng = t.lng + 360 * Math.round((f.lng - t.lng) / 360);
        return (
          m
            .project([f.lat, f.lng], t.zoom)
            .distanceTo(m.project([t.lat, lng], t.zoom)) < 1
        );
      });
    },
    [frames, target],
  );
const nowMs = (page: any) => page.evaluate(() => performance.now());
const still = (frames: any[], from: number) => {
  const after = frames.filter((f) => f.t >= from);
  return after.length > 3 && after.every((f) => same(f, after[0]));
};

test("same-zoom pan and the antimeridian fly the short way to the exact fit", async () =>
  run(async (page) => {
    // Already at Ada's fit zoom, centred a little away: a pan of the same zoom.
    await startAt(page, A[0], 9);
    const fit = await memberTarget(page, A);
    await startAt(page, [fit.lat + 0.01, fit.lng - 0.02], fit.zoom);
    let { camera: c, p } = await flight(page, () =>
      mouseDouble(page, card(ada)),
    );
    await save("same-zoom.json", { camera: c });
    assert.equal(p.start.zoom, p.end.zoom, "the same zoom");
    assert.ok(
      p.moved && p.centers >= 3 && p.between.length >= 5,
      JSON.stringify({ ...p, between: p.between.length }),
    );
    assert.ok(p.duration >= 300 && p.duration <= 1100, `${p.duration}ms`);
    let t = await assertMemberTarget(page, A);
    assert.ok(t.px < 1 && t.zoom[0] === t.zoom[1], JSON.stringify(t));
    // Cy's day spans Fiji (178E) and Samoa (172W); from the Samoa side the
    // camera never travels the long way round.
    await startAt(page, [-14, -168], 5);
    ({ camera: c, p } = await flight(page, () => mouseDouble(page, card(cy))));
    await save("antimeridian.json", { camera: c });
    assertFlight(p, asked(c), "antimeridian");
    const lngs = c.frames.map((f: any) => f.lng);
    assert.ok(
      Math.max(...lngs) - Math.min(...lngs) < 20,
      `short way ${Math.min(...lngs)}..${Math.max(...lngs)}`,
    );
    t = await assertMemberTarget(page, C);
    assert.ok(t.px < 1 && t.zoom[0] === t.zoom[1], JSON.stringify(t));
  }));

test("a quick new focus supersedes the flight from the painted camera; the old target is never painted", async () =>
  run(async (page) => {
    await startAt(page, A[0], 9);
    const adaTarget = await memberTarget(page, A);
    await startAt(page, [48, 10], 4);
    const { camera: c, p } = await flight(
      page,
      async () => {
        await mouseDouble(page, card(ada));
        await page.waitForTimeout(150);
        await mouseDouble(page, card(bob));
      },
      1700,
    );
    await save("replacement.json", { camera: c });
    assert.equal(
      await reached(page, c.frames, adaTarget),
      false,
      "Ada's target never painted",
    );
    const t = await assertMemberTarget(page, B);
    assert.ok(t.px < 1 && t.zoom[0] === t.zoom[1], JSON.stringify(t));
    // Bob's first click stopped Ada's flight where it was painted (a still,
    // mid-flight camera); Bob's flight then starts from exactly there.
    const clicks = c.inputs.filter((i: any) => i.type === "click");
    const [, , bob1, bob2] = clicks.map((i: any) => i.t);
    const held = c.frames.filter((f: any) => f.t > bob1 + 20 && f.t < bob2);
    assert.ok(
      held.length >= 3 && held.every((f: any) => same(f, held[0])),
      "stopped at the painted camera",
    );
    assert.ok(
      !same(held[0], p.start) && Math.abs(held[0].zoom % 1) > 0,
      "mid-flight",
    );
    const next = c.frames.filter((f: any) => f.t >= bob2);
    const bobPath = path([held[held.length - 1], ...next]);
    assertFlight(bobPath, bob2, "replacement");
    assert.match(
      await status(page),
      /zoomed to Synthetic Bob's 2 shown event locations/,
    );
  }));

for (const [label, interrupt] of [
  [
    "drag",
    async (page: any) => {
      const box = await page.locator("#dashboardMap").boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        box.x + box.width / 2 + 60,
        box.y + box.height / 2 + 30,
        { steps: 6 },
      );
      await page.mouse.up();
    },
  ],
  [
    "wheel",
    async (page: any) => {
      const box = await page.locator("#dashboardMap").boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 200);
    },
  ],
  [
    "keyboard zoom",
    async (page: any) => {
      await page.focus("#dashboardMap");
      await page.keyboard.press("-");
    },
  ],
  ["zoom control", (page: any) => page.click(".leaflet-control-zoom-out")],
  [
    "ordinary selection",
    async (page: any) => {
      const { x, y } = await centre(page, card(bob));
      await page.mouse.click(x, y);
    },
  ],
] as const)
  test(`${label} mid-flight wins: the focus never resumes or lands`, async () =>
    run(async (page) => {
      await startAt(page, A[0], 9);
      const target = await memberTarget(page, A);
      await startAt(page, B[0], 6);
      let at = 0;
      const { camera: c } = await flight(
        page,
        async () => {
          await mouseDouble(page, card(ada));
          await page.waitForTimeout(200);
          at = await nowMs(page);
          await interrupt(page);
        },
        1600,
      );
      await save(`interrupt-${label.replace(/ /g, "-")}.json`, {
        camera: c,
        at,
      });
      const before = c.frames.filter((f: any) => f.t < at);
      const p = path(before);
      assert.ok(
        p.moved && p.between.length >= 3,
        `${label}: flying when interrupted`,
      );
      assert.equal(
        await reached(page, c.frames, target),
        false,
        `${label}: never landed`,
      );
      const last = c.frames[c.frames.length - 1].t;
      assert.ok(still(c.frames, last - 400), `${label}: no resumed flight`);
      assert.doesNotMatch(await status(page), /Map zoomed to Synthetic Ada/);
      if (label === "ordinary selection") {
        // Stopped exactly where painted: no further camera writes at all.
        assert.ok(
          still(c.frames, at + 50),
          "selection stops the camera where painted",
        );
        assert.ok(!same(c.frames[c.frames.length - 1], p.start));
      }
    }));

// One member's exact event reads are held and then denied (403); the day,
// the roster and everyone else stay readable.
const deniable = (member: string) => {
  let deny!: () => void;
  const denial = new Promise<void>((resolve) => (deny = resolve));
  const override = (url: URL, all: any[]) => {
    if (url.pathname === "/api/dashboard/latest-positions")
      return { body: latestBody };
    if (url.pathname !== "/api/dashboard/event") return undefined;
    const event = all.find((e) => e.id === url.searchParams.get("event_id"));
    return event?.user_id === member
      ? { hold: denial, status: 403, body: {} }
      : undefined;
  };
  return { deny, override };
};
for (const [label, member, focus, target, gone] of [
  [
    "member focus",
    ada,
    (page: any) => mouseDouble(page, card(ada)),
    (page: any) => memberTarget(page, A),
    `.dashboard-event-dot[data-member-id="${ada}"]`,
  ],
  [
    "latest-pin focus",
    bob,
    (page: any) =>
      mouseDouble(page, `.dashboard-latest-pin[data-member-ids="${bob}"]`),
    async () => ({
      lat: LATEST[bob][0],
      lng: LATEST[bob][1],
      zoom: FOCUS_ZOOM,
    }),
    `.dashboard-latest-pin[data-member-ids="${bob}"]`,
  ],
] as const) {
  const day = deniable(member);
  test(`a denial mid-flight (${label}) stops it where painted; it never lands`, async () =>
    run(
      async (page) => {
        await startAt(page, A[0], 9);
        const goal = await target(page);
        await startAt(page, [20, 40], 3);
        // A pending exact read of the member's mark: its reply is the denial.
        const mark = events.find((e) => e.user_id === member)!.id;
        const { x, y } = await centre(
          page,
          `.dashboard-timeline-mark[data-event-id="${mark}"]`,
        );
        await page.mouse.click(x, y);
        await page.waitForTimeout(300);
        await record(page);
        await focus(page);
        await page.waitForTimeout(200);
        const at = await nowMs(page);
        day.deny();
        await page.waitForFunction(
          (sel: string) => !document.querySelector(sel),
          gone,
        );
        const goneAt = await nowMs(page);
        await page.waitForTimeout(900);
        const c = await recorded(page);
        await save(`denial-${label.replace(/ /g, "-")}.json`, {
          camera: c,
          at,
          goneAt,
        });
        const p = path(c.frames.filter((f: any) => f.t < at));
        assert.ok(
          p.moved && p.between.length >= 3,
          `${label}: flying when denied`,
        );
        assert.equal(
          await reached(page, c.frames, goal),
          false,
          `${label}: never landed`,
        );
        assert.ok(still(c.frames, goneAt), `${label}: stopped where painted`);
        assert.ok(
          Math.abs(c.frames[c.frames.length - 1].zoom % 1) > 0,
          `${label}: mid-flight`,
        );
        assert.doesNotMatch(
          await status(page),
          /Map zoomed|Map centered on/,
          `${label}: no focus note`,
        );
      },
      { override: day.override },
    ));
}

test("a focus during a native zoom flies from where that zoom ends, to the current target", async () =>
  run(async (page) => {
    await startAt(page, A[0], 9);
    const target = await memberTarget(page, A);
    await startAt(page, B[0], 6);
    await page.evaluate(() => ((window as any).holdZoomEnd = true));
    await page.click(".leaflet-control-zoom-in");
    await page.waitForFunction(() => (window as any).heldZoomEnds.length === 1);
    await record(page);
    await mouseDouble(page, card(ada));
    await page.waitForTimeout(300);
    const held = await recorded(page);
    await save("during-native-zoom-held.json", held);
    // Nothing moved the camera while that zoom was still painting.
    assert.ok(
      held.frames.every((f: any) => same(f, held.frames[0])),
      "waits for the zoom",
    );
    assert.equal(held.frames[0].zoom, 7);
    const { camera: c, p } = await flight(page, () =>
      page.evaluate(() => {
        const w = window as any;
        w.holdZoomEnd = false;
        for (const end of w.heldZoomEnds.splice(0)) end();
      }),
    );
    await save("during-native-zoom.json", { camera: c });
    assert.ok(
      p.between.length >= 5 && p.duration >= 300,
      JSON.stringify({ ...p, between: p.between.length }),
    );
    assert.equal(
      await reached(page, [p.end], target),
      true,
      "lands on Ada's fit",
    );
  }));

test("zoom control cancels a focus queued during a held native zoom", async () =>
  run(async (page) => {
    await startAt(page, B[0], 6);
    const target = await memberTarget(page, A);
    const release = () =>
      page.evaluate(() => {
        const w = window as any;
        w.holdZoomEnd = false;
        for (const end of w.heldZoomEnds.splice(0)) end();
      });
    try {
      await page.evaluate(() => ((window as any).holdZoomEnd = true));
      await page.click(".leaflet-control-zoom-in");
      await page.waitForFunction(
        () => (window as any).heldZoomEnds.length === 1,
      );
      await record(page);
      await page.locator(card(ada)).focus();
      await page.keyboard.press("Shift+Enter");
      await page.waitForTimeout(300);
      const held = await recorded(page);
      assert.equal(held.frames[0].zoom, 7, "normal zoom control works");
      assert.ok(still(held.frames, held.frames[0].t), "focus waits for zoom");
      assert.doesNotMatch(await status(page), /Map zoomed to Synthetic Ada/);
      assert.equal(
        await page.locator(card(ada)).getAttribute("aria-pressed"),
        "true",
      );

      await record(page);
      await page.click(".leaflet-control-zoom-out");
      await release();
      await landed(page);
      const c = await recorded(page);
      const result = {
        camera: c,
        held,
        oldTargetPainted: await reached(page, c.frames, target),
        staleNote: /Map zoomed to Synthetic Ada/.test(await status(page)),
        movedAfterRelease: c.frames.some((f: any) => !same(f, held.frames[0])),
      };
      await save("queued-focus-control.json", result);
      assert.equal(
        await page.locator(card(ada)).getAttribute("aria-pressed"),
        "true",
        "zoom navigation preserves member selection",
      );
      assert.deepEqual(
        {
          oldTargetPainted: result.oldTargetPainted,
          staleNote: result.staleNote,
          movedAfterRelease: result.movedAfterRelease,
        },
        { oldTargetPainted: false, staleNote: false, movedAfterRelease: false },
        "newer control input retires queued focus: no old-target flight or stale note",
      );
    } finally {
      await release();
    }
  }));

test("reduced motion jumps to the same target with no in-between view", async () =>
  run(async (page) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await startAt(page, B[0], 6);
    const { camera: c, p } = await flight(page, () =>
      mouseDouble(page, card(ada)),
    );
    await save("reduced-motion.json", { camera: c });
    assert.ok(p.moved);
    assert.equal(p.between.length, 0, "one jump");
    assert.equal(p.end.zoom % 1, 0);
    const t = await assertMemberTarget(page, A);
    assert.ok(t.px < 1 && t.zoom[0] === t.zoom[1], JSON.stringify(t));
    assert.match(
      await status(page),
      /zoomed to Synthetic Ada's 3 shown event locations/,
    );
  }));

test("a date change mid-flight stops it; the new day keeps the painted view", async () =>
  run(async (page) => {
    await startAt(page, A[0], 9);
    const target = await memberTarget(page, A);
    await startAt(page, B[0], 6);
    await record(page);
    await mouseDouble(page, card(ada));
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const w = window as any,
        m = w.fixtureMap;
      w.oldMap = m;
      // The camera painted when the old day's map is removed.
      const remove = m.remove;
      m.remove = function () {
        const c = m.getCenter();
        w.painted = { lat: c.lat, lng: c.lng, zoom: m.getZoom() };
        return remove.call(this);
      };
      const input =
        document.querySelector<HTMLInputElement>("#dashboardMapDate")!;
      input.value = "2026-09-29";
      input.dispatchEvent(new Event("change"));
    });
    await page.waitForTimeout(1200);
    const c = await recorded(page);
    const { painted, after } = await page.evaluate(() => {
      const w = window as any,
        m = w.fixtureMap,
        c = m.getCenter();
      return {
        painted: w.painted,
        after: {
          fresh: m !== w.oldMap,
          lat: c.lat,
          lng: c.lng,
          zoom: m.getZoom(),
        },
      };
    });
    await save("date-change.json", { camera: c, painted, after });
    assert.ok(after.fresh && painted, "a new day map");
    assert.ok(painted.zoom % 1 !== 0, "removed mid-flight");
    // The kept view is the painted one (Leaflet snaps its zoom).
    assert.equal(after.zoom, Math.round(painted.zoom));
    // Leaflet rounds the new map's pixel origin: sub-pixel at that zoom.
    const shift = await page.evaluate(
      ({ a, b }) => {
        const m = (window as any).fixtureMap;
        return m
          .project([a.lat, a.lng], a.zoom)
          .distanceTo(m.project([b.lat, b.lng], a.zoom));
      },
      { a: after, b: painted },
    );
    assert.ok(shift < 1, JSON.stringify({ after, painted, shift }));
    assert.equal(await reached(page, [after], target), false);
    assert.doesNotMatch(await status(page), /Map zoomed/);
  }));

test("a lock mid-flight stops it: the removed map never moves again", async () =>
  run(async (page) => {
    await startAt(page, B[0], 6);
    await mouseDouble(page, card(ada));
    const moves = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const w = window as any,
            m = w.fixtureMap;
          setTimeout(() => {
            let n = 0;
            m.on("move", () => n++);
            const flying = m.getZoom() % 1 !== 0;
            w.CoachDashboard.clear();
            setTimeout(() => resolve(flying ? n : -1), 700);
          }, 150);
        }),
    );
    assert.equal(moves, 0, "no move after lock");
  }));
