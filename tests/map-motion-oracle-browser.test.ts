import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";
import { install, verdict, saveReport } from "./helpers/map-motion-sampler.js";

// Oracle controls for the shared map-motion sampler: the real exported
// install() and verdict() run on real Chromium layout, with a synthetic map
// projection and synthetic native markers (no Leaflet behavior is claimed).
// Every tile is an opaque 256px image; a level's tile (x, y) at screen origin
// O paints fix [lat, lng] at O + (128 + lng - 256x, 128 + lat - 256y).
type Level = {
  z?: number;
  zIndex: number;
  opacity: number;
  levelOpacity?: number;
  tiles: { x: number; at: [number, number] }[];
};
type Case = {
  levels: Level[];
  pins: { member: string; fix: [number, number]; at: [number, number] }[];
  dots?: { id: string; fix: [number, number]; at: [number, number] }[];
  native: Record<string, [number, number]>;
};

let browser: any;
before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  });
});
after(async () => browser?.close());
const receipts: any[] = [];
after(() =>
  saveReport(process.env.MAP_PIN_MOTION_EVIDENCE_DIR, "oracle-controls.json", {
    entries: receipts,
    failures: [],
  }),
);

const sampled = async (name: string, c: Case) => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    await page.route("https://oracle.invalid/**", (r: any) =>
      r.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="green"/></svg>',
      }),
    );
    const levels = c.levels
      .map(
        (l) =>
          `<div class="leaflet-tile-container" style="z-index:${l.zIndex};opacity:${l.levelOpacity ?? 1}">${l.tiles
            .map(
              (t) =>
                `<img class="leaflet-tile leaflet-tile-loaded" src="https://oracle.invalid/${l.z ?? 2}/${t.x}/0.png" style="left:${t.at[0]}px;top:${t.at[1]}px;opacity:${l.opacity}">`,
            )
            .join("")}</div>`,
      )
      .join("");
    // A pin's tip (photo bottom + 11px) and a dot's center mark the fix.
    const pins = c.pins
      .map(
        (p) =>
          `<button class="dashboard-latest-pin" data-member-ids="${p.member}" style="left:${p.at[0] - 20}px;top:${p.at[1] - 51}px"><span class="dashboard-latest-photo"></span></button>`,
      )
      .join("");
    const dots = (c.dots || [])
      .map(
        (d) =>
          `<span class="dashboard-map-marker dashboard-event-dot" data-event-id="${d.id}" style="left:${d.at[0] - 7}px;top:${d.at[1] - 7}px"></span>`,
      )
      .join("");
    await page.setContent(
      `<style>body{margin:0}#dashboardMap{position:relative;width:800px;height:600px;overflow:hidden}.leaflet-tile-container{position:absolute;inset:0}img{position:absolute;width:256px;height:256px}.dashboard-latest-pin{position:absolute;border:0;padding:0;background:none}.dashboard-latest-photo{display:block;width:40px;height:40px}.dashboard-event-dot{position:absolute;width:14px;height:14px}</style><div id="dashboardMap">${levels}${pins}${dots}</div>`,
    );
    await page.waitForFunction(() =>
      [...document.images].every((i) => i.complete && i.naturalWidth > 0),
    );
    await page.evaluate("window.__name = (value) => value");
    await page.evaluate((native: Record<string, [number, number]>) => {
      const w = window as any;
      w.fixtureMap = {
        project: ([lat, lng]: [number, number]) => ({
          x: 128 + lng,
          y: 128 + lat,
        }),
        getPane: () => null,
        getZoom: () => 13,
        on() {},
        off() {},
      };
      // Only the canonical world copy of a native marker is on screen.
      w.L = {
        divIcon: (x: any) => x,
        marker: ([lat, lng]: [number, number]) => {
          const at = native[`${lat},${lng}`] || [-1e6, -1e6];
          return {
            addTo() {
              return this;
            },
            getElement: () => ({
              getBoundingClientRect: () => ({ left: at[0], top: at[1] }),
            }),
            remove() {},
          };
        },
      };
    }, c.native);
    const fixes = Object.fromEntries((c.dots || []).map((d) => [d.id, d.fix]));
    await install(page, fixes, {
      latest: Object.fromEntries(c.pins.map((p) => [p.member, p.fix])),
      events: (c.dots || []).map((d) => d.id),
    });
    const s = await page.evaluate(() => {
      const m = (window as any).__motion;
      m.start();
      for (let i = 0; i < 5; i++) m.sample();
      return m.stop();
    });
    const problems = verdict(s, 1, { dots: !!c.dots, lines: false });
    receipts.push({ name, case: c, problems, state: s });
    return { s, problems };
  } finally {
    await page.close();
  }
};

const A: [number, number] = [0, 0];
const B: [number, number] = [0, 256];
// One opaque level with fix A painted at (300, 300).
const sole = (opacity = 1, origin = 172): Level => ({
  zIndex: 1,
  opacity,
  tiles: [
    { x: 0, at: [origin, 172] },
    { x: 1, at: [origin + 256, 172] },
  ],
});
const fails = (problems: string[], pattern: RegExp) =>
  assert.ok(
    problems.some((p) => pattern.test(p)),
    `expected ${pattern} in ${JSON.stringify(problems)}`,
  );
const drift = /^latest pin drift/;
const ambiguous = /^basemap ambiguous\/inconclusive \(Leaflet\/browser split\)/;

test("oracle: coherent basemap, pin and dot on it, passes", async () => {
  const { problems } = await sampled("coherent", {
    levels: [sole()],
    pins: [{ member: "a", fix: A, at: [300, 300] }],
    dots: [{ id: "e", fix: [10, 50], at: [350, 310] }],
    native: { "0,0": [300, 300], "10,50": [350, 310] },
  });
  assert.deepEqual(problems, []);
});

test("oracle: a sole level still fading in is the visible basemap", async () => {
  const { s, problems } = await sampled("startup partial opacity", {
    levels: [sole(0.35)],
    pins: [{ member: "a", fix: A, at: [300, 300] }],
    native: { "0,0": [300, 300] },
  });
  assert.deepEqual(problems, []);
  assert.ok(s.measured.pins > 0);
});

test("oracle: an opacity-0 level is no reference and hides nothing", async () => {
  const levels = [
    sole(),
    {
      zIndex: 2,
      opacity: 0,
      tiles: [{ x: 0, at: [232, 172] as [number, number] }],
    },
  ];
  const on = await sampled("opacity 0 excluded (product on opaque)", {
    levels,
    pins: [{ member: "a", fix: A, at: [300, 300] }],
    native: { "0,0": [300, 300] },
  });
  assert.deepEqual(on.problems, []);
  const off = await sampled("opacity 0 excluded (product on transparent)", {
    levels,
    pins: [{ member: "a", fix: A, at: [360, 300] }],
    native: { "0,0": [300, 300] },
  });
  fails(off.problems, drift);
});

test("oracle: a pin 3px off an agreed basemap and native marker fails", async () => {
  const { problems } = await sampled("+3px", {
    levels: [sole()],
    pins: [{ member: "a", fix: A, at: [303, 300] }],
    native: { "0,0": [300, 300] },
  });
  fails(problems, drift);
});

test("oracle: following a native marker 60px off the sole visible tile fails", async () => {
  const { problems } = await sampled("native-only escape", {
    levels: [sole(1, 232)],
    pins: [{ member: "a", fix: A, at: [300, 300] }],
    native: { "0,0": [300, 300] },
  });
  fails(problems, drift);
});

test("oracle: following a faint lower level under an agreed upper level fails", async () => {
  const { problems } = await sampled("faint lower-level escape", {
    levels: [sole(0.0001), { ...sole(1, 232), zIndex: 2 }],
    pins: [{ member: "a", fix: A, at: [300, 300] }],
    native: { "0,0": [360, 300] },
  });
  fails(problems, drift);
});

test("oracle: following an opaque lower level occluded at the fix fails", async () => {
  const { problems } = await sampled("occluded lower-level escape", {
    levels: [sole(1), { ...sole(1, 232), zIndex: 2 }],
    pins: [{ member: "a", fix: A, at: [300, 300] }],
    native: { "0,0": [360, 300] },
  });
  fails(problems, drift);
});

test("oracle: anchors on disjoint levels that disagree are a split, not a pass", async () => {
  // Level 1 paints A at (228, 300); level 2 paints B 60px east of where
  // level 1's registration puts it. Each pin sits on its own level.
  const { problems } = await sampled("split anchors on disjoint levels", {
    levels: [
      { zIndex: 1, opacity: 1, tiles: [{ x: 0, at: [100, 172] }] },
      { zIndex: 2, opacity: 1, tiles: [{ x: 1, at: [416, 172] }] },
    ],
    pins: [
      { member: "a", fix: A, at: [228, 300] },
      { member: "b", fix: B, at: [544, 300] },
    ],
    native: { "0,0": [228, 300], "0,256": [544, 300] },
  });
  fails(problems, ambiguous);
});

test("oracle: a visible composite of disagreeing levels is inconclusive, not a pass", async () => {
  // An upper level at 0.86 over an opaque lower level 60px apart: both
  // visibly paint the map at the fix.
  const levels = [sole(1), { ...sole(0.86, 232), zIndex: 2 }];
  const one = await sampled("ambiguous composite", {
    levels,
    pins: [{ member: "a", fix: A, at: [360, 300] }],
    native: { "0,0": [360, 300] },
  });
  fails(one.problems, ambiguous);
  const two = await sampled("ambiguous composite, anchors split", {
    levels,
    pins: [
      { member: "a", fix: A, at: [360, 300] },
      { member: "b", fix: [40, 20], at: [320, 340] },
    ],
    native: { "0,0": [360, 300], "40,20": [320, 340] },
  });
  fails(two.problems, ambiguous);
});

test("oracle: a mark over visible tiles is held to their grid when its fix is blank", async () => {
  // Only tile x1 is painted (from x=428): fix A's own spot (300, 300) is
  // blank, and tile x1's grid places A there.
  const { s, problems } = await sampled("blank fix, mark over a visible tile", {
    levels: [{ zIndex: 1, opacity: 1, tiles: [{ x: 1, at: [428, 172] }] }],
    pins: [{ member: "a", fix: A, at: [500, 300] }],
    native: { "0,0": [500, 300] },
  });
  fails(problems, drift);
  assert.equal(s.byMark, s.frames);
});

test("oracle: a mark over blank map is unverified, never a measured pass", async () => {
  const { s, problems } = await sampled("blank fix, mark over blank map", {
    levels: [{ zIndex: 1, opacity: 1, tiles: [{ x: 1, at: [428, 172] }] }],
    pins: [{ member: "a", fix: A, at: [300, 300] }],
    native: { "0,0": [300, 300] },
  });
  assert.equal(s.measured.pins, 0);
  assert.equal(s.unverified, s.frames);
  fails(problems, /^measured pins$/);
});
