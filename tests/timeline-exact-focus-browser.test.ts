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
} from "./helpers/exact-map-fixture.js";

// Exact timeline event activation in a dense, real-layout synthetic day: the
// rendered mark actually hit (not the chronologically nearest event) is
// selected, freshly reauthorized and, on a repeat activation, focused only
// once that exact read authorizes it. All members, events and coordinates are
// synthetic fixtures.

const FOCUS_ZOOM = 18;
const evidence = process.env.TIMELINE_FOCUS_EVIDENCE_DIR;
const users = [
  { _id: ada, display_name: "Synthetic Ada" },
  { _id: bob, display_name: "Synthetic Bob" },
];
const DAY = Date.UTC(2026, 8, 28);
const stamp = (seconds: number) => new Date(DAY + seconds * 1000).toISOString();
const hms = (h: number, m = 0, s = 0) => h * 3600 + m * 60 + s;
const row = (
  n: number,
  user: string,
  seconds: number,
  type: string,
  position?: [number, number],
): Event => ({
  id: ev(n),
  user_id: user,
  occurred_at: stamp(seconds),
  event_type: type,
  subject: { type: type.split(".")[0], id: id(n) },
  details: {},
  position: position
    ? gps(position[0], position[1], stamp(seconds))
    : { availability: "unavailable", reason: "missing" },
});

// Dense app-lifecycle cluster 06:50–07:35, roughly one event a minute, so the
// 2px marks overlap; each carries its own exact fractional coordinate.
const events: Event[] = [];
for (let k = 0; k < 40; k++)
  events.push(
    row(
      k + 1,
      k % 3 ? ada : bob,
      hms(6, 50) + k * 67 + (k % 5),
      k % 2 ? "app.backgrounded" : "app.foregrounded",
      [40.7012345 + k * 0.0011, -73.9912345 + k * 0.0009],
    ),
  );
// An isolated coincident pair: the same instant, different members/places.
const TIE_ADA = ev(41),
  TIE_BOB = ev(42);
const TIE_A: [number, number] = [40.7612345, -73.9712345],
  TIE_B: [number, number] = [40.7123987, -74.0123987];
events.push(
  row(41, ada, hms(10, 15), "app.backgrounded", TIE_A),
  row(42, bob, hms(10, 15), "app.backgrounded", TIE_B),
);
// Isolated marks for fence checks, a no-GPS event and broad NYC context.
const SOLO: Record<string, [number, number]> = {
  [ev(43)]: [40.7301234, -73.9351234],
  [ev(44)]: [40.6801234, -73.9651234],
  [ev(45)]: [40.7451234, -73.9051234],
  [ev(46)]: [40.6651234, -73.9851234],
};
events.push(
  row(43, ada, hms(13), "app.backgrounded", SOLO[ev(43)]),
  row(44, ada, hms(14), "app.foregrounded", SOLO[ev(44)]),
  row(45, bob, hms(15), "app.backgrounded", SOLO[ev(45)]),
  row(46, bob, hms(16), "app.foregrounded", SOLO[ev(46)]),
  row(47, ada, hms(17), "app.backgrounded"),
  row(48, ada, hms(1), "workout.set_completed", [40.85, -73.85]),
  row(49, bob, hms(20), "meal.food_added", [40.6, -74.1]),
);
const byId = new Map(events.map((e) => [e.id, e]));
const coord = (eventId: string): [number, number] => {
  const p = byId.get(eventId)!.position as any;
  return [p.latitude, p.longitude];
};

type Held = { id: string; release: () => void };
// Every exact detail read is held until the test releases it; `reply` may
// substitute the fresh authoritative answer for an event.
function detailReads(
  reply: Map<string, { status?: number; body?: unknown }> = new Map(),
) {
  const held: Held[] = [];
  const reads: string[] = [];
  const override = (url: URL, all: Event[]) => {
    // The day stream returns only the requested civil day's events.
    if (url.pathname === "/api/dashboard/timeline")
      return {
        body: {
          users,
          events: all.filter(
            (e) =>
              e.occurred_at >= url.searchParams.get("start")! &&
              e.occurred_at < url.searchParams.get("end")!,
          ),
          hasMore: false,
        },
      };
    if (url.pathname !== "/api/dashboard/event") return undefined;
    const eventId = url.searchParams.get("event_id")!;
    reads.push(eventId);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    held.push({ id: eventId, release });
    const event = all.find((e) => e.id === eventId);
    return {
      hold,
      ...(reply.get(eventId) ?? {
        body: { users, events: event ? [event] : [], hasMore: false },
      }),
    };
  };
  const releaseAll = () => held.splice(0).forEach((h) => h.release());
  const releaseFor = (eventId: string) => {
    for (const h of held.filter((h) => h.id === eventId)) {
      h.release();
      held.splice(held.indexOf(h), 1);
    }
  };
  return { override, reads, held, releaseAll, releaseFor };
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
async function centredOffset(page: any, [lat, lng]: [number, number]) {
  return page.evaluate(
    ([lat, lng]: [number, number]) => {
      const map = (window as any).fixtureMap,
        node = document.getElementById("dashboardMap")!;
      const centre = map.getCenter().lng;
      const p = map.latLngToContainerPoint([
        lat,
        lng + 360 * Math.round((centre - lng) / 360),
      ]);
      return {
        dx: p.x - node.clientWidth / 2,
        dy: p.y - node.clientHeight / 2,
        zoom: map.getZoom(),
      };
    },
    [lat, lng],
  );
}
async function assertCentred(page: any, at: [number, number], why: string) {
  const { dx, dy, zoom } = await centredOffset(page, at);
  assert.ok(
    Math.abs(dx) <= 1 && Math.abs(dy) <= 1,
    `${why}: off centre by ${dx},${dy}`,
  );
  assert.equal(zoom, FOCUS_ZOOM, `${why}: zoom`);
}
// The inspector's authorized snapshot: occurrence instant and subject id.
const inspector = (page: any) =>
  page.locator("#dashboardMapSelection").evaluate((node: HTMLElement) => {
    const text = node.innerText;
    return {
      occurred: /Occurred: [^\n]*· (\S+Z)/.exec(text)?.[1] ?? null,
      subject: /Subject: \S+ · ([0-9a-f]{24})/.exec(text)?.[1] ?? null,
      rechecked: text.includes("Event access rechecked for this read."),
      checking: text.includes("Checking current event access"),
      text,
    };
  });
const pressedMarks = (page: any) =>
  page
    .locator('.dashboard-timeline-mark[aria-pressed="true"]')
    .evaluateAll((nodes: HTMLElement[]) => nodes.map((n) => n.dataset.eventId));
const status = (page: any) => page.locator("#dashboardMapStatus").innerText();

// Pointer-input log: which rendered mark each press really hit.
async function logInput(page: any) {
  await page.evaluate(() => {
    (window as any).inputLog = [];
    for (const type of ["pointerdown", "click"])
      document.addEventListener(
        type,
        (event: any) =>
          (window as any).inputLog.push({
            type,
            pointer: event.pointerType ?? "",
            detail: event.detail,
            mark:
              (event.target as HTMLElement)?.closest?.(
                ".dashboard-timeline-mark",
              )?.dataset.eventId ?? null,
          }),
        true,
      );
  });
}
const inputLog = (page: any) => page.evaluate(() => (window as any).inputLog);

// Points inside the dense cluster where the rendered mark actually hit differs
// from the chronologically nearest event at that x (the old scrub mapping).
async function denseTargets(page: any) {
  const stamps = Object.fromEntries(
    events.map((e) => [e.id, Date.parse(e.occurred_at)]),
  );
  return page.evaluate(
    ({
      stamps,
      start,
      end,
    }: {
      stamps: Record<string, number>;
      start: number;
      end: number;
    }) => {
      const track = document.querySelector<HTMLElement>(
        ".dashboard-timeline-track",
      )!;
      const t = track.getBoundingClientRect();
      const marks = [
        ...track.querySelectorAll<HTMLElement>(".dashboard-timeline-mark"),
      ].filter((m) => !m.hidden);
      const visible = marks
        .map((m) => m.dataset.eventId!)
        .sort((a, b) => stamps[a] - stamps[b] || a.localeCompare(b));
      const nearest = (x: number) => {
        const at =
          start +
          Math.max(0, Math.min(1, (x - t.left) / t.width)) * (end - start);
        let best: string | null = null;
        for (const id of visible)
          if (
            best === null ||
            Math.abs(stamps[id] - at) < Math.abs(stamps[best] - at)
          )
            best = id;
        return best;
      };
      const found: {
        x: number;
        y: number;
        hit: string;
        nearest: string | null;
      }[] = [];
      for (const mark of marks) {
        const r = mark.getBoundingClientRect();
        const y = Math.round(r.top + r.height / 2);
        for (let x = Math.floor(r.left) - 1; x <= Math.ceil(r.right) + 1; x++) {
          const hit = (
            document.elementFromPoint(x, y) as HTMLElement | null
          )?.closest<HTMLElement>(".dashboard-timeline-mark");
          if (hit && hit.dataset.eventId !== nearest(x))
            found.push({
              x,
              y,
              hit: hit.dataset.eventId!,
              nearest: nearest(x),
            });
        }
      }
      return found;
    },
    { stamps, start: DAY, end: DAY + 86400000 },
  );
}
async function pickDense(page: any) {
  const dense = new Set(events.slice(0, 40).map((e) => e.id));
  const found = (await denseTargets(page)).filter(
    (f: any) => dense.has(f.hit) && f.hit !== f.nearest && f.nearest,
  );
  assert.ok(found.length, "the dense fixture renders overlapping marks");
  // Prefer a hit whose chronological neighbour is a different member/time.
  return (
    found.find(
      (f: any) =>
        byId.get(f.hit)!.occurred_at !== byId.get(f.nearest)!.occurred_at,
    ) ?? found[0]
  );
}
async function markCentre(page: any, eventId: string) {
  const box = await page
    .locator(`.dashboard-timeline-mark[data-event-id="${eventId}"]`)
    .boundingBox();
  return {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
  };
}
const hitAt = (page: any, { x, y }: { x: number; y: number }) =>
  page.evaluate(
    ([x, y]: number[]) =>
      (
        document.elementFromPoint(x, y) as HTMLElement | null
      )?.closest<HTMLElement>(".dashboard-timeline-mark")?.dataset.eventId ??
      null,
    [x, y],
  );
// Real CDP mouse: hover, then a press pair with click counts 1 and 2.
async function mouseDouble(page: any, { x, y }: { x: number; y: number }) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(60);
  const hovered = await page
    .locator("#dashboardTimelineTooltip")
    .getAttribute("data-event-id");
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.up({ clickCount: 1 });
  await page.waitForTimeout(150);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await page.waitForTimeout(250);
  return hovered;
}
async function mouseClick(page: any, { x, y }: { x: number; y: number }) {
  await page.mouse.move(x, y);
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.up({ clickCount: 1 });
}
// Real Chromium touch input through the renderer's gesture pipeline.
async function touchDouble(
  page: any,
  cdp: any,
  { x, y }: { x: number; y: number },
) {
  for (let i = 0; i < 2; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, id: 1, radiusX: 1, radiusY: 1, force: 1 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    if (!i) await page.waitForTimeout(90);
  }
  await page.waitForTimeout(250);
}
async function released(page: any) {
  await page.waitForFunction(() =>
    document
      .querySelector("#dashboardMapSelection")
      ?.textContent?.includes("Event access rechecked"),
  );
  await settle(page);
}
async function shot(page: any, name: string) {
  if (!evidence) return;
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, name) });
}
async function record(name: string, data: unknown) {
  if (!evidence) return;
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, name), JSON.stringify(data, null, 2));
}
async function assertExactFocus(page: any, eventId: string, why: string) {
  const shown = await inspector(page);
  const expected = byId.get(eventId)!;
  assert.equal(shown.occurred, expected.occurred_at, `${why}: inspector time`);
  assert.equal(shown.subject, expected.subject.id, `${why}: inspector event`);
  assert.ok(shown.rechecked, `${why}: fresh exact read authorized it`);
  assert.deepEqual(
    await pressedMarks(page),
    [eventId],
    `${why}: selected mark`,
  );
  await assertCentred(page, coord(eventId), why);
  assert.match(await status(page), /zoomed to the recorded location/);
}
const base = { events, users, document: true, marks: events.length };

test("a real mouse double-click on a dense rendered mark selects, reauthorizes and only then focuses that exact event", async () => {
  const detail = detailReads();
  await fixture(
    async (page) => {
      await settle(page);
      const initial = await view(page);
      assert.ok(initial.zoom <= 12, `broad day fit ${initial.zoom}`);
      await logInput(page);
      const target = await pickDense(page);
      const rendered = await hitAt(page, target);
      assert.equal(
        rendered,
        target.hit,
        "the press point renders the target mark",
      );
      const hovered = await mouseDouble(page, target);
      // Held: the intended exact event is pending; the camera has not moved.
      const pending = await inspector(page);
      const heldView = await view(page);
      const presses = (await inputLog(page)).filter(
        (e: any) => e.type === "pointerdown",
      );
      const observed = {
        target,
        hovered,
        presses,
        reads: [...detail.reads],
        pending: { occurred: pending.occurred, checking: pending.checking },
        initial,
        heldView,
      };
      await record("mouse-dense-observed.json", observed);
      assert.equal(
        hovered,
        target.hit,
        `hover previews the mark under the pointer: ${JSON.stringify(observed)}`,
      );
      assert.deepEqual(
        presses.map((p: any) => p.mark),
        [target.hit, target.hit],
        `both presses hit the same mark: ${JSON.stringify(observed)}`,
      );
      assert.ok(detail.reads.length >= 1, "a fresh exact read was issued");
      assert.ok(
        detail.reads.every((r) => r === target.hit),
        `only the activated event is read: ${JSON.stringify(observed)}`,
      );
      assert.equal(
        pending.occurred,
        byId.get(target.hit)!.occurred_at,
        "pending inspector event",
      );
      assert.ok(pending.checking, "pending fresh read is shown");
      assert.deepEqual(
        heldView,
        initial,
        `no focus before authorization: ${JSON.stringify(observed)}`,
      );
      detail.releaseAll();
      await released(page);
      await assertExactFocus(page, target.hit, "dense mouse");
      await shot(page, "synthetic-desktop-dense-mark-double-click.png");

      // The coincident pair: a pointer on the stacked marks means the stack's
      // first event (as before); its twin is keyboard reachable, with
      // Shift+Enter waiting for its read.
      const tie = await markCentre(page, TIE_BOB);
      assert.ok(
        [TIE_BOB, TIE_ADA].includes((await hitAt(page, tie))!),
        "the pointer is on the coincident stack",
      );
      const before = detail.reads.length;
      const tieHit = await mouseDouble(page, tie);
      assert.ok(tieHit === TIE_BOB || tieHit === TIE_ADA, `tie hit ${tieHit}`);
      const twin = tieHit === TIE_BOB ? TIE_ADA : TIE_BOB;
      assert.ok(
        detail.reads.length > before &&
          detail.reads.slice(before).every((r) => r === tieHit),
        `tied presses read the previewed event: ${detail.reads.slice(before)}`,
      );
      detail.releaseAll();
      await released(page);
      await assertExactFocus(page, tieHit!, "tied mark");
      await page
        .locator(`.dashboard-timeline-mark[data-event-id="${tieHit}"]`)
        .focus();
      await page.keyboard.press(
        tieHit === TIE_BOB ? "ArrowLeft" : "ArrowRight",
      );
      assert.equal(
        await page.evaluate(
          () => (document.activeElement as HTMLElement).dataset.eventId,
        ),
        twin,
        "the coincident twin is keyboard reachable",
      );
      const keyed = await view(page);
      await page.keyboard.press("Shift+Enter");
      await page.waitForTimeout(250);
      assert.deepEqual(
        await view(page),
        keyed,
        "keyboard focus also waits for authorization",
      );
      assert.equal(
        (await inspector(page)).occurred,
        byId.get(twin)!.occurred_at,
      );
      detail.releaseAll();
      await released(page);
      await assertExactFocus(page, twin, "keyboard twin");
    },
    { ...base, override: detail.override },
  );
});

test("a native touch double tap on a dense rendered mark focuses that exact event after its held read", async () => {
  const detail = detailReads();
  await fixture(
    async (page) => {
      const cdp = await page.context().newCDPSession(page);
      try {
        await settle(page);
        const initial = await view(page);
        await logInput(page);
        const target = await pickDense(page);
        assert.equal(await hitAt(page, target), target.hit);
        await touchDouble(page, cdp, target);
        const presses = (await inputLog(page)).filter(
          (e: any) => e.type === "pointerdown",
        );
        const pending = await inspector(page);
        const heldView = await view(page);
        const observed = {
          target,
          presses,
          reads: [...detail.reads],
          pending: { occurred: pending.occurred, checking: pending.checking },
          initial,
          heldView,
        };
        await record("touch-dense-observed.json", observed);
        assert.ok(
          presses.every((p: any) => p.pointer === "touch"),
          JSON.stringify(observed),
        );
        assert.deepEqual(
          presses.map((p: any) => p.mark),
          [target.hit, target.hit],
          `both taps hit the same mark: ${JSON.stringify(observed)}`,
        );
        assert.ok(
          detail.reads.length >= 1 &&
            detail.reads.every((r) => r === target.hit),
          `only the tapped event is read: ${JSON.stringify(observed)}`,
        );
        assert.equal(
          pending.occurred,
          byId.get(target.hit)!.occurred_at,
          JSON.stringify(observed),
        );
        assert.deepEqual(
          heldView,
          initial,
          `no focus before authorization: ${JSON.stringify(observed)}`,
        );
        assert.equal(await page.evaluate(() => visualViewport!.scale), 1);
        detail.releaseAll();
        await released(page);
        await assertExactFocus(page, target.hit, "dense touch");
        assert.equal(
          await page.evaluate(() => visualViewport!.scale),
          1,
          "no page zoom",
        );
        await shot(page, "synthetic-mobile-dense-mark-double-tap.png");
      } finally {
        await cdp.detach().catch(() => {});
      }
    },
    {
      ...base,
      override: detail.override,
      touch: true,
      viewport: { width: 390, height: 844 },
    },
  );
});

test("a pending repeat activation never focuses a withdrawn, superseded or denied selection", async () => {
  const reply = new Map<string, { status?: number; body?: unknown }>([
    // The fresh read withdraws Ada's Position for this event.
    [
      ev(43),
      {
        body: {
          users,
          events: [
            {
              ...byId.get(ev(43))!,
              position: { availability: "unavailable", reason: "private" },
            },
          ],
          hasMore: false,
        },
      },
    ],
    [ev(46), { status: 403, body: {} }],
  ]);
  const detail = detailReads(reply);
  await fixture(
    async (page) => {
      await settle(page);
      const initial = await view(page);
      // Withdrawn Position: truthful no-op, no borrowed coordinate.
      await mouseDouble(page, await markCentre(page, ev(43)));
      assert.deepEqual(await view(page), initial);
      detail.releaseAll();
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardMapSelection")
          ?.textContent?.includes("Event access rechecked"),
      );
      await settle(page);
      assert.deepEqual(
        await view(page),
        initial,
        "withdrawn Position never focuses",
      );
      assert.match(
        (await inspector(page)).text,
        /No shared location for this event/,
      );
      assert.match(await status(page), /no shared location.*not changed/);
      // A newer single selection supersedes a pending repeat activation.
      await mouseDouble(page, await markCentre(page, ev(45)));
      await page.waitForTimeout(600);
      await mouseClick(page, await markCentre(page, ev(44)));
      await page.waitForTimeout(150);
      detail.releaseFor(ev(45));
      await page.waitForTimeout(200);
      detail.releaseAll();
      await released(page);
      assert.deepEqual(
        await view(page),
        initial,
        "superseded repeat never focuses",
      );
      assert.equal(
        (await inspector(page)).occurred,
        byId.get(ev(44))!.occurred_at,
      );
      // A late denial removes the member and never focuses. (The first
      // press's denial already purges the member behind the repeat.)
      await mouseDouble(page, await markCentre(page, ev(46)));
      assert.deepEqual(await view(page), initial);
      detail.releaseAll();
      await page.waitForFunction(
        (member: string) =>
          !document.querySelector(
            `.dashboard-timeline-mark[data-member-id="${member}"], .dashboard-event-dot[data-member-id="${member}"]`,
          ),
        bob,
      );
      await settle(page);
      assert.deepEqual(await view(page), initial, "denied event never focuses");
      assert.equal((await inspector(page)).rechecked, false);
      assert.doesNotMatch(await status(page), /zoomed/);
    },
    { ...base, override: detail.override },
  );
});

test("a pending repeat activation is fenced by a date change", async () => {
  const detail = detailReads();
  await fixture(
    async (page) => {
      await settle(page);
      await mouseDouble(page, await markCentre(page, ev(44)));
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
      await settle(page);
      const otherDay = await view(page);
      detail.releaseAll();
      await page.waitForTimeout(400);
      await settle(page);
      assert.deepEqual(
        await view(page),
        otherDay,
        "other-day reply never focuses",
      );
      assert.equal((await inspector(page)).occurred, null);
      assert.doesNotMatch(await status(page), /zoomed/);
    },
    { ...base, override: detail.override },
  );
});
