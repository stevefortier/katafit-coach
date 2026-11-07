import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { fixture, ada, bob, ev, id, gps } from "./helpers/exact-map-fixture.js";
import {
  gesture,
  install,
  saveReport,
  type Log,
  type Spec,
} from "./helpers/map-motion-sampler.js";

// Latest member photo pins stay shown whatever member is selected (the
// selection only grays the others), and every custom overlay (latest pins,
// the day's event dots and their connections) follows Leaflet's native pan,
// zoom and pinch motion frame by frame, measured against the painted tiles.
const cy = "cccccccccccccccccccccccc",
  eve = "eeeeeeeeeeeeeeeeeeeeeeee";
const users = [
  { _id: ada, display_name: "Synthetic Ada" },
  { _id: bob, display_name: "Synthetic Bob" },
  { _id: cy, display_name: "Synthetic Cy" },
  { _id: eve, display_name: "Synthetic Eve" },
];
const NOW = Date.parse("2026-12-01T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const LATEST: Record<string, [number, number, number]> = {
  [ada]: [40.7012345, -73.9221987, NOW - 2 * 60000],
  [bob]: [40.7301234, -73.9512345, NOW - 3 * 86400000],
  [cy]: [40.7303534, -73.9510045, NOW - 4 * 60000],
  [eve]: [40.6851234, -73.9701234, NOW - 2 * 3600000],
};
const latestBody = {
  as_of: iso(NOW),
  members: Object.entries(LATEST).map(([user_id, [lat, lng, at]], n) => ({
    user_id,
    display_name: users.find((u) => u._id === user_id)!.display_name,
    status: "located",
    latest: {
      event_id: ev(500 + n),
      event_type: "workout.sets_changed",
      occurred_at: iso(at),
      latitude: lat,
      longitude: lng,
      accuracy: 5,
      captured_at: iso(at),
      source: "gps",
    },
  })),
};
// A dense synthetic day: two members, 60 located events each, alternating
// categories, consecutive events connected; both first events share a fix.
const events = [ada, bob].flatMap((user, m) =>
  Array.from({ length: 60 }, (_, i) => {
    const n = m * 60 + i + 1;
    const at = iso(
      Date.parse("2026-09-28T06:00:00.000Z") + (i * 5 + m) * 60000,
    );
    const lat = i === 0 ? 40.7 : m ? 40.725 - 0.0006 * i : 40.69 + 0.0007 * i;
    const lng =
      i === 0
        ? -73.95
        : m
          ? -73.99 + 0.0011 * i
          : -73.96 + 0.0009 * i + 0.002 * Math.sin(i / 3);
    const type = i % 2 ? "meal.food_added" : "workout.set_completed";
    return {
      id: ev(n),
      user_id: user,
      occurred_at: at,
      event_type: type,
      subject: { type: type.split(".")[0], id: id(n) },
      details: {},
      position: gps(lat, lng, at),
    };
  }),
);
const evidence = process.env.MAP_PIN_MOTION_EVIDENCE_DIR;
const TILE_RGB = { r: 214, g: 222, b: 205 };
const tilePng = async () => {
  const raw = Buffer.alloc(256 * 256 * 3);
  for (let y = 0; y < 256; y++)
    for (let x = 0; x < 256; x++) {
      const edge = x < 2 || y < 2;
      const o = (y * 256 + x) * 3;
      raw[o] = edge ? 120 : TILE_RGB.r;
      raw[o + 1] = edge ? 130 : TILE_RGB.g;
      raw[o + 2] = edge ? 110 : TILE_RGB.b;
    }
  return sharp(raw, { raw: { width: 256, height: 256, channels: 3 } })
    .png()
    .toBuffer();
};
const beforeLoad = async (page: any) => {
  const avatar = await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: 220, g: 60, b: 40 },
    },
  })
    .png()
    .toBuffer();
  const tile = await tilePng();
  await page.route("**/api/dashboard/avatar?**", (route: any) =>
    new URL(route.request().url()).searchParams.get("id") === ada
      ? route.fulfill({ contentType: "image/png", body: avatar })
      : route.fulfill({ status: 404, body: "{}" }),
  );
  // Opaque 256px tiles at the canonical URL (registered after the fixture's
  // 1x1 default, so this route wins).
  await page.route("https://tile.openstreetmap.org/**", (route: any) =>
    route.fulfill({ contentType: "image/png", body: tile }),
  );
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
      // Let real time flow from the fixed instant: Leaflet tile fade and drag
      // inertia need a moving clock, and the age notes stay deterministic.
      await page.clock.setSystemTime(new Date(NOW));
      await body(page);
    },
    {
      users,
      events: events as any,
      now: iso(NOW),
      marks: null,
      beforeLoad,
      override: (url: URL) =>
        url.pathname === "/api/dashboard/latest-positions"
          ? { body: latestBody }
          : undefined,
      ...options,
    },
  );
const view = (page: any, zoom = 13, center = [40.708, -73.95]) =>
  page.evaluate(
    ([c, z]: [[number, number], number]) =>
      new Promise<void>((resolve) => {
        const m = (window as any).fixtureMap;
        m.setView(c, z, { animate: false });
        // Tile fade (200ms) must finish before painting is judged.
        setTimeout(resolve, 600);
      }),
    [center, zoom],
  );
const camera = (page: any) =>
  page.evaluate(() => {
    const m = (window as any).fixtureMap,
      c = m.getCenter();
    return [c.lat, c.lng, m.getZoom()];
  });
// The painted latest pins: identities, appearance and their own age note.
const latest = (page: any) =>
  page.$$eval(".dashboard-latest-pin", (nodes: HTMLElement[]) =>
    nodes
      .filter((n) => n.getClientRects().length > 0)
      .map((n) => {
        const photo = n.querySelector<HTMLElement>(".dashboard-latest-photo")!;
        const age = n.querySelector<HTMLElement>(".dashboard-latest-age")!;
        const style = getComputedStyle(photo);
        const ageBox = age.getBoundingClientRect(),
          photoBox = photo.getBoundingClientRect();
        return {
          ids: n.dataset.memberIds,
          gray: Number(style.opacity) < 1 || style.filter !== "none",
          age: age.getClientRects().length ? age.textContent : "",
          ageHeight: ageBox.height,
          ageFont: parseFloat(getComputedStyle(age).fontSize),
          photo: photoBox.height,
        };
      }),
  );
const members = async (page: any) =>
  (await latest(page))
    .flatMap((p: any) => p.ids.split(" "))
    .sort()
    .join(",");
// Members with a latest pin in the overlay, painted or culled off-view.
const present = (page: any) =>
  page.$$eval(".dashboard-latest-pin", (nodes: HTMLElement[]) =>
    nodes
      .flatMap((n) => n.dataset.memberIds!.split(" "))
      .sort()
      .join(","),
  );
const dotState = (page: any) =>
  page.$$eval(".dashboard-event-dot", (nodes: HTMLElement[]) =>
    nodes
      .filter((n) => n.getClientRects().length > 0)
      .map((n) => n.dataset.eventId)
      .sort()
      .join(","),
  );
const lineState = (page: any) =>
  page.$$eval(".dashboard-map-connection", (nodes: Element[]) =>
    nodes
      .filter((n) => getComputedStyle(n).display !== "none")
      .map((n) => (n as SVGElement).dataset.to)
      .sort()
      .join(","),
  );
const card = (member: string) =>
  `.dashboard-member-card:has(.dashboard-member-portrait[data-member-id="${member}"])`;
const ALL = [ada, bob, cy, eve].sort().join(",");

test("map pins: every latest pin stays shown across member, pin, chooser, category and date selection; only selection grays", async () => {
  await run(async (page) => {
    await view(page);
    assert.equal(await members(page), ALL);
    const dotsAll = await dotState(page),
      linesAll = await lineState(page);
    const appearance = async () =>
      Object.fromEntries(
        (await latest(page)).map((p: any) => [p.ids, p.gray]),
      ) as Record<string, boolean>;
    // A member's painted dots under All, plus its first event, which the
    // co-location badge covers only while both members are shown.
    const memberDots = (member: string) =>
      events
        .filter((e) => e.user_id === member)
        .map((e) => e.id)
        .filter((e, i) => i === 0 || dotsAll.split(",").includes(e))
        .sort()
        .join(",");
    // Ada (member card) -> Bob (member card) -> All.
    await page.click(card(ada));
    assert.equal(await members(page), ALL);
    assert.deepEqual(await appearance(), {
      [ada]: false,
      [`${bob} ${cy}`]: true,
      [eve]: true,
    });
    assert.equal(await dotState(page), memberDots(ada));
    await page.click(card(bob));
    assert.equal(await members(page), ALL);
    // A selected member's old fix is full-color; the fresh unselected Ada is gray.
    assert.deepEqual(await appearance(), {
      [ada]: true,
      [`${bob} ${cy}`]: false,
      [eve]: true,
    });
    assert.equal(await dotState(page), memberDots(bob));
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: join(evidence, "selection-wide-bob.png") });
    }
    await page.click(".dashboard-member-all");
    assert.equal(await members(page), ALL);
    assert.deepEqual(await appearance(), {
      [ada]: false,
      [`${bob} ${cy}`]: false,
      [eve]: false,
    });
    assert.equal(await dotState(page), dotsAll);
    assert.equal(await lineState(page), linesAll);
    // All restores the fitted initial view (existing behavior); ordinary
    // selections from here on must not move it.
    const camera0 = await camera(page);
    // Map pin click (ordinary selection): camera-neutral, all pins remain.
    await page.click(`.dashboard-latest-pin[data-member-ids="${eve}"]`);
    await page.waitForTimeout(600);
    assert.equal(await members(page), ALL);
    assert.deepEqual(await appearance(), {
      [ada]: true,
      [`${bob} ${cy}`]: true,
      [eve]: false,
    });
    // Single portraits: the selected Eve (2 h old) is full color, the
    // unselected fresh Ada (2 min) is gray; each keeps its own small age note.
    const singles = Object.fromEntries(
      (await latest(page))
        .filter((p: any) => !p.ids.includes(" "))
        .map((p: any) => [p.ids, p]),
    );
    assert.equal(singles[eve].gray, false);
    assert.equal(singles[eve].age, "2 h ago");
    assert.equal(singles[ada].gray, true);
    assert.equal(singles[ada].age, "2 min ago");
    for (const pin of [singles[eve], singles[ada]])
      assert.ok(pin.ageHeight > 0 && pin.ageHeight < pin.photo / 2);
    assert.deepEqual(await camera(page), camera0);
    // The overlap chooser lists every identity; each choice shows its own
    // selection state and its own age.
    await page.click(`.dashboard-latest-pin[data-member-ids="${bob} ${cy}"]`);
    const choices = () =>
      page.$$eval(".dashboard-latest-choice", (nodes: HTMLElement[]) =>
        nodes.map((c) => {
          const s = getComputedStyle(
            c.querySelector(".dashboard-latest-photo")!,
          );
          return [
            c.dataset.memberId,
            c.querySelector(".dashboard-latest-choice-age")!.textContent,
            Number(s.opacity) < 1 || s.filter !== "none",
          ];
        }),
      );
    assert.deepEqual(await choices(), [
      [bob, "3 days ago", true],
      [cy, "4 min ago", true],
    ]);
    await page.click(`.dashboard-latest-choice[data-member-id="${cy}"]`);
    await page.waitForTimeout(600);
    assert.deepEqual(await camera(page), camera0);
    assert.equal(await members(page), ALL);
    assert.equal(await dotState(page), "");
    await page.click(`.dashboard-latest-pin[data-member-ids="${bob} ${cy}"]`);
    assert.deepEqual(await choices(), [
      [bob, "3 days ago", true],
      [cy, "4 min ago", false],
    ]);
    await page.keyboard.press("Escape");
    // Category filter: latest pins unchanged, event layer exactly as before.
    await page.click(card(ada));
    const dotsAda = await dotState(page),
      linesAda = await lineState(page);
    await page.click('.dashboard-timeline-legend button[data-category="meal"]');
    assert.equal(await members(page), ALL);
    assert.equal(await dotState(page), dotsAda);
    assert.equal(await lineState(page), linesAda);
    // Every individual pin has its own small, readable age note.
    for (const pin of await latest(page))
      if (!pin.ids.includes(" ")) {
        assert.ok(pin.age, `age note for ${pin.ids}`);
        assert.ok(pin.ageFont <= 12 && pin.ageFont >= 10);
        assert.ok(pin.ageHeight > 0 && pin.ageHeight < pin.photo / 2);
      }
    const ages = Object.fromEntries(
      (await latest(page)).map((p: any) => [p.ids, p.age]),
    );
    assert.equal(ages[ada], "2 min ago");
    assert.equal(ages[eve], "2 h ago");
    // Another day: still every latest pin.
    await page.evaluate(() => {
      const input =
        document.querySelector<HTMLInputElement>("#dashboardMapDate")!;
      input.value = "2026-09-27";
      input.dispatchEvent(new Event("change"));
    });
    await page.waitForFunction(() =>
      document
        .querySelector("#dashboardMapStatus")
        ?.textContent?.includes("2026-09-27"),
    );
    await view(page);
    assert.equal(await members(page), ALL);
    // The new map's first ResizeObserver invalidateSize may land after
    // view(); Leaflet then derives getCenter from the rounded pixel origin
    // (up to half a pixel off), so the view is compared at pixel precision.
    assert.deepEqual(
      await page.evaluate(() => {
        const m = (window as any).fixtureMap;
        const off = m
          .project(m.getCenter())
          .distanceTo(m.project([40.708, -73.95]));
        return [m.getZoom(), off < 1];
      }),
      [13, true],
    );
  });
});

// Frozen expectations for the sampler: every latest member at its own fix,
// and the day's dots/badge/connections for the members the activity filter
// shows (the shared first fix is a badge while both members are shown).
const FIXES = Object.fromEntries(
  events.map((e) => [e.id, [e.position.latitude, e.position.longitude]]),
) as Record<string, [number, number]>;
const LATEST_FIXES = Object.fromEntries(
  Object.entries(LATEST).map(([k, [lat, lng]]) => [k, [lat, lng]]),
) as Record<string, [number, number]>;
const spec = (selected: string | null): Spec => {
  const shown = [ada, bob].filter((u) => !selected || u === selected);
  const mine = shown.map((u) => events.filter((e) => e.user_id === u));
  const both = shown.length === 2;
  return {
    latest: LATEST_FIXES,
    events: mine
      .flat()
      .filter((e, i, all) =>
        both ? e.id !== mine[0][0].id && e.id !== mine[1][0].id : true,
      )
      .map((e) => e.id),
    groups: both ? [[40.7, -73.95]] : [],
    lines: mine.flatMap((list) =>
      list.slice(1).map((e, i) => [list[i].id, e.id] as [string, string]),
    ),
  };
};
test("map pins: mouse drag with inertia, wheel and zoom control keep latest pins, dots and lines on the tiles every frame", async () => {
  const report: Log = { entries: [], failures: [] };
  await run(async (page) => {
    await view(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    await install(page, FIXES, spec(null));
    const box = await page.locator("#dashboardMap").boundingBox();
    const cx = box.x + box.width / 2,
      cyy = box.y + box.height / 2;
    await gesture(
      page,
      cdp,
      "mouse drag + inertia",
      async () => {
        await page.mouse.move(cx, cyy);
        await page.mouse.down();
        for (let i = 1; i <= 14; i++) {
          await page.mouse.move(cx - i * 18, cyy - i * 6);
          await page.waitForTimeout(12);
        }
        await page.mouse.up();
      },
      report,
      { pan: true },
      spec(null),
    );
    await gesture(
      page,
      cdp,
      "wheel zoom in",
      async () => {
        await page.mouse.move(cx + 80, cyy - 40);
        await page.mouse.wheel(0, -60);
      },
      report,
      { zoom: true },
      spec(null),
    );
    // A selected member: other members' pins stay shown (gray) while moving.
    await page.click(card(bob));
    await gesture(
      page,
      cdp,
      "zoom control out",
      () => page.click(".leaflet-control-zoom-out"),
      report,
      { zoom: true },
      spec(bob),
    );
    await gesture(
      page,
      cdp,
      "wheel zoom out",
      async () => {
        await page.mouse.move(cx - 120, cyy + 30);
        await page.mouse.wheel(0, 60);
      },
      report,
      { zoom: true },
      spec(bob),
    );
    await gesture(
      page,
      cdp,
      "zoom control in",
      () => page.click(".leaflet-control-zoom-in"),
      report,
      { zoom: true },
      spec(bob),
    );
    await page.click(".dashboard-member-all");
    await gesture(
      page,
      cdp,
      "mouse drag back",
      async () => {
        await page.mouse.move(cx, cyy);
        await page.mouse.down();
        for (let i = 1; i <= 10; i++) {
          await page.mouse.move(cx + i * 20, cyy + i * 4);
          await page.waitForTimeout(30);
        }
        await page.waitForTimeout(120);
        await page.mouse.up();
      },
      report,
      { pan: true },
      spec(null),
    );
    const shown = await present(page);
    if (shown !== ALL) report.failures.push(`latest pins shown: ${shown}`);
    if (evidence)
      await page.screenshot({
        path: join(evidence, "motion-wide-settled.png"),
      });
  });
  await saveReport(evidence, "motion-wide.json", report);
  assert.deepEqual(report.failures, []);
});

test("map pins: phone touch pan and two-finger pinch keep latest pins, dots and lines on the tiles every frame", async () => {
  const report: Log = { entries: [], failures: [] };
  await run(
    async (page) => {
      await page.evaluate(() =>
        document.getElementById("dashboardMap")!.scrollIntoView({
          block: "center",
          behavior: "instant",
        }),
      );
      await view(page, 13, [40.705, -73.945]);
      await page.click(card(ada));
      await page.evaluate(() =>
        document.getElementById("dashboardMap")!.scrollIntoView({
          block: "center",
          behavior: "instant",
        }),
      );
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Performance.enable");
      await install(page, FIXES, spec(ada));
      const box = await page.locator("#dashboardMap").boundingBox();
      const cx = Math.round(box.x + box.width / 2),
        cyy = Math.round(box.y + box.height / 2);
      const touch = (type: string, points: [number, number][]) =>
        cdp.send("Input.dispatchTouchEvent", {
          type,
          touchPoints: points.map(([x, y], i) => ({ x, y, id: i })),
        });
      await gesture(
        page,
        cdp,
        "touch pan + inertia",
        async () => {
          await touch("touchStart", [[cx, cyy]]);
          for (let i = 1; i <= 12; i++) {
            await touch("touchMove", [[cx - i * 10, cyy + i * 4]]);
            await page.waitForTimeout(16);
          }
          await touch("touchEnd", []);
        },
        report,
        { pan: true },
        spec(ada),
      );
      await gesture(
        page,
        cdp,
        "two-finger pinch out",
        async () => {
          await touch("touchStart", [
            [cx - 30, cyy],
            [cx + 30, cyy],
          ]);
          for (let i = 1; i <= 14; i++) {
            await touch("touchMove", [
              [cx - 30 - i * 3, cyy - i],
              [cx + 30 + i * 3, cyy + i],
            ]);
            await page.waitForTimeout(20);
          }
          // Fingers held mid-pinch: a static fractional-zoom frame.
          await page.waitForTimeout(100);
          await page.evaluate(() => (window as any).__motion.sample());
          if (evidence)
            await page.screenshot({
              path: join(evidence, "motion-narrow-mid-pinch.png"),
            });
          await touch("touchEnd", []);
        },
        report,
        { pinch: true, zoom: true },
        spec(ada),
      );
      await gesture(
        page,
        cdp,
        "two-finger pinch in",
        async () => {
          await touch("touchStart", [
            [cx - 90, cyy - 20],
            [cx + 90, cyy + 20],
          ]);
          for (let i = 1; i <= 14; i++) {
            await touch("touchMove", [
              [cx - 90 + i * 4, cyy - 20 + i],
              [cx + 90 - i * 4, cyy + 20 - i],
            ]);
            await page.waitForTimeout(20);
          }
          await touch("touchEnd", []);
        },
        report,
        { pinch: true, zoom: true },
        spec(ada),
      );
      const shown = await present(page);
      if (shown !== ALL) report.failures.push(`latest pins shown: ${shown}`);
      if (evidence)
        await page.screenshot({
          path: join(evidence, "motion-narrow-settled.png"),
        });
    },
    { viewport: { width: 390, height: 844 }, touch: true },
  );
  await saveReport(evidence, "motion-narrow.json", report);
  assert.deepEqual(report.failures, []);
});
