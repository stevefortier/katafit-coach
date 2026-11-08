import assert from "node:assert/strict";
import { test } from "node:test";
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
import {
  gesture,
  install,
  marks,
  saveReport,
  settled,
  verdict,
  type Expect,
  type Log,
  type Spec,
} from "./helpers/map-motion-sampler.js";

// Data and authority changes that land while Leaflet's native zoom animation
// is painting: latest pins, event dots, badges and connections stay on their
// fixes in every frame (tiles and native Leaflet markers as the oracle), new
// marks join the running animation, and removed members leave at once.
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
type Fix = [number, number];
const LATEST: Record<string, Fix> = {
  [ada]: [40.7012345, -73.9221987],
  [bob]: [40.7301234, -73.9512345],
  [cy]: [40.7303534, -73.9510045],
  [eve]: [40.6851234, -73.9701234],
};
const AGE: Record<string, number> = {
  [ada]: 2 * 60000,
  [bob]: 3 * 86400000,
  [cy]: 4 * 60000,
  [eve]: 2 * 3600000,
};
const member = (
  user_id: string,
  status: string,
  fix: Fix | null = LATEST[user_id],
) => ({
  user_id,
  display_name: users.find((u) => u._id === user_id)!.display_name,
  status,
  latest:
    status === "located" && fix
      ? {
          event_id: ev(500),
          event_type: "workout.sets_changed",
          occurred_at: iso(NOW - AGE[user_id]),
          latitude: fix[0],
          longitude: fix[1],
          accuracy: 5,
          captured_at: iso(NOW - AGE[user_id]),
          source: "gps",
        }
      : null,
});
const latestBody = (statuses: Record<string, string>, fixes = LATEST) => ({
  as_of: iso(NOW),
  members: users.map((u) => member(u._id, statuses[u._id], fixes[u._id])),
});
const ALL_LOCATED = {
  [ada]: "located",
  [bob]: "located",
  [cy]: "located",
  [eve]: "located",
};
// Two members, 30 located events each, consecutive events connected; both
// first events share one fix (a co-location badge while both are shown).
const events = [ada, bob].flatMap((user, m) =>
  Array.from({ length: 30 }, (_, i) => {
    const n = m * 30 + i + 1;
    const at = iso(
      Date.parse("2026-09-28T06:00:00.000Z") + (i * 5 + m) * 60000,
    );
    const lat = i === 0 ? 40.7 : m ? 40.725 - 0.0012 * i : 40.69 + 0.0014 * i;
    const lng =
      i === 0
        ? -73.95
        : m
          ? -73.99 + 0.0022 * i
          : -73.96 + 0.0018 * i + 0.002 * Math.sin(i / 3);
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
const FIXES = Object.fromEntries(
  events.map((e) => [e.id, [e.position.latitude, e.position.longitude]]),
) as Record<string, Fix>;
const of = (user: string) => events.filter((e) => e.user_id === user);
// The day's expected marks for the members the activity filter shows.
const day = (shown: string[]) => {
  const mine = shown.map(of);
  const both = shown.length === 2;
  return {
    events: mine
      .flat()
      .filter(
        (e) => !both || (e.id !== mine[0][0].id && e.id !== mine[1][0].id),
      )
      .map((e) => e.id),
    groups: (both ? [[40.7, -73.95]] : []) as Fix[],
    lines: mine.flatMap((list) =>
      list.slice(1).map((e, i) => [list[i].id, e.id] as [string, string]),
    ),
  };
};
const pick = (fixes: Record<string, Fix>, ids: string[]) =>
  Object.fromEntries(ids.map((k) => [k, fixes[k]]));
const ALL: Spec = { latest: LATEST, ...day([ada, bob]) };
const evidence = process.env.MAP_PIN_MOTION_EVIDENCE_DIR;

const opaque = (r: number, g: number, b: number, size = 256) =>
  sharp({
    create: { width: size, height: size, channels: 3, background: { r, g, b } },
  })
    .png()
    .toBuffer();
type Hooks = {
  avatar?: Promise<unknown>;
  override?: (url: URL) => any;
};
const run = (
  body: (page: any) => Promise<void>,
  hooks: Hooks = {},
  options: Record<string, unknown> = {},
) =>
  fixture(
    async (page) => {
      // Motion is judged on Chrome's own rendering clock (frames, timers and
      // CSS transitions alike); wall time started at NOW, so age notes hold.
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
      beforeLoad: async (page: any) => {
        const avatar = await opaque(220, 60, 40, 64),
          tile = await opaque(214, 222, 205);
        await page.route("**/api/dashboard/avatar?**", async (route: any) => {
          if (new URL(route.request().url()).searchParams.get("id") !== ada)
            return route.fulfill({ status: 404, body: "{}" });
          await hooks.avatar;
          await route.fulfill({ contentType: "image/png", body: avatar });
        });
        await page.route("https://tile.openstreetmap.org/**", (route: any) =>
          route.fulfill({ contentType: "image/png", body: tile }),
        );
      },
      override: (url: URL) =>
        hooks.override?.(url) ??
        (url.pathname === "/api/dashboard/latest-positions"
          ? { body: latestBody(ALL_LOCATED) }
          : undefined),
      ...options,
    },
  );
const held = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
};
const view = (page: any, zoom = 13, center: Fix = [40.708, -73.95]) =>
  page
    .evaluate(
      ({ zoom, center }: any) =>
        (window as any).fixtureMap.setView(center, zoom, { animate: false }),
      { zoom, center },
    )
    .then(() => page.waitForTimeout(600));
const pinsReady = (page: any, n: number) =>
  page.waitForFunction(
    (n: number) =>
      document.querySelectorAll(".dashboard-latest-pin").length === n,
    n,
  );
const dotsReady = (page: any, n: number) =>
  page.waitForFunction(
    (n: number) =>
      document.querySelectorAll(".dashboard-event-dot").length === n,
    n,
  );
const pinned = (member: string) =>
  `.dashboard-latest-pin[data-member-ids~="${member}"]`;
const inPage = (page: any, fn: string, arg?: any) =>
  page.evaluate(({ fn, arg }: any) => new Function("arg", fn)(arg), {
    fn,
    arg,
  });

type Mutation = {
  // Observed effect: the watch fires on the first frame where the selector
  // matches (or, with gone, stops matching); `next` applies from that frame.
  watch: string;
  gone?: boolean;
  next: Spec;
  act: () => Promise<unknown>;
};
// Native zoom-control zoom; the mutation lands while Leaflet's CSS zoom
// transition is painting. Every frame through settle is checked.
const midZoom = async (
  page: any,
  log: Log,
  name: string,
  before: Spec,
  mutation: Mutation | null,
  o: Expect = {},
  control = ".leaflet-control-zoom-in",
) => {
  await install(page, FIXES, before);
  if (mutation)
    await page.evaluate(
      (n: any) => (window as any).__motion.prepare(n),
      mutation.next,
    );
  const total = await marks(page);
  const ended = settled(page);
  await page.evaluate(() => (window as any).__motion.start());
  await page.click(control);
  await page.waitForFunction(() => (window as any).fixtureMap._animatingZoom);
  await page.waitForTimeout(40);
  if (mutation) {
    await page.evaluate(
      ({ watch, next, gone }: any) =>
        (window as any).__motion.mutate(watch, next, gone),
      { watch: mutation.watch, next: mutation.next, gone: !!mutation.gone },
    );
    await mutation.act();
  }
  await ended;
  const s = await page.evaluate(() => (window as any).__motion.stop());
  log.entries.push({ name, marks: total, ...s });
  const problems = verdict(s, total, { zoom: true, ...o });
  if (mutation) {
    // The effect really landed mid-animation, with frames left to paint.
    if (!s.mutation?.anim) problems.push("mutation started outside the zoom");
    if (!s.watch) problems.push(`effect never observed (${s.pendingWatch})`);
    else {
      if (!s.watch.anim) problems.push("effect observed after the zoom");
      if (s.watch.animFramesAfter < 2)
        problems.push(
          `only ${s.watch.animFramesAfter} zoom frames after effect`,
        );
    }
  }
  if (problems.length)
    log.failures.push(
      `${name}: ${problems.join("; ")} :: ${JSON.stringify({ ...s, frameWrites: undefined, writeKinds: undefined })}`,
    );
  return s;
};
// A settled view, sampled for several frames (no gesture).
const still = async (
  page: any,
  log: Log,
  name: string,
  spec: Spec,
  o: Expect,
) => {
  await install(page, FIXES, spec);
  await page.evaluate(() => (window as any).__motion.start());
  await page.waitForTimeout(250);
  const s = await page.evaluate(() => (window as any).__motion.stop());
  log.entries.push({ name, ...s });
  const problems = verdict(s, 0, o);
  if (problems.length)
    log.failures.push(
      `${name}: ${problems.join("; ")} :: ${JSON.stringify(s)}`,
    );
};
const finish = async (file: string, log: Log) => {
  await saveReport(evidence, file, log);
  assert.deepEqual(log.failures, []);
};

test("mid-zoom: uninterrupted, member selection and held avatar keep every mark on the painted map", async () => {
  const log: Log = { entries: [], failures: [] };
  const avatar = held();
  await run(
    async (page) => {
      await dotsReady(page, events.length);
      await pinsReady(page, 3);
      await view(page);
      await midZoom(page, log, "uninterrupted zoom", ALL, null);
      await view(page);
      // Selecting Ada grays others and filters Bob's activity; Ada's covered
      // first dot is revealed mid-zoom.
      await midZoom(page, log, "member selection", ALL, {
        watch: ".dashboard-latest-pin.dashboard-latest-unselected",
        next: { latest: LATEST, ...day([ada]) },
        act: () =>
          inPage(
            page,
            `document.querySelector('.dashboard-member-card:has(.dashboard-member-portrait[data-member-id="' + arg + '"])').click()`,
            ada,
          ),
      });
      await page.click(".dashboard-member-all");
      await view(page);
      // Ada's held avatar arrives: her pin is replaced by a photo pin.
      await midZoom(page, log, "held avatar arrival", ALL, {
        watch: `${pinned(ada)} img`,
        next: ALL,
        act: async () => avatar.release(),
      });
      if (evidence)
        await page.screenshot({ path: join(evidence, "mid-zoom-settled.png") });
    },
    { avatar: avatar.promise },
  );
  await finish("mid-zoom-selection.json", log);
});

test("mid-zoom: a full member denial removes that member at once and survivors stay on their fixes", async () => {
  const log: Log = { entries: [], failures: [] };
  let deny = false;
  await run(
    async (page) => {
      await dotsReady(page, events.length);
      await pinsReady(page, 3);
      await view(page);
      deny = true;
      await midZoom(page, log, "member denial (exact read 403)", ALL, {
        watch: pinned(ada),
        gone: true,
        next: {
          latest: pick(LATEST, [bob, cy, eve]),
          ...day([bob]),
          absent: [ada],
        },
        act: () =>
          inPage(
            page,
            `document.querySelector('.dashboard-event-dot[data-event-id="' + arg + '"]').click()`,
            of(ada)[3].id,
          ),
      });
    },
    {
      override: (url) =>
        deny && url.pathname === "/api/dashboard/event"
          ? { status: 403, body: {} }
          : undefined,
    },
  );
  await finish("mid-zoom-member-denial.json", log);
});

test("mid-zoom: Position denial and whole-dojo denial remove geometry at once; a held positive never restores it", async () => {
  const log: Log = { entries: [], failures: [] };
  // Eve's first read is incomplete, so Retry can start a held second read.
  let armed = false,
    exact: "private" | null = null;
  const second = held(),
    third = held();
  await run(
    async (page) => {
      await dotsReady(page, events.length);
      await pinsReady(page, 2);
      await view(page);
      const before: Spec = {
        latest: pick(LATEST, [ada, bob, cy]),
        ...day([ada, bob]),
      };
      // A positive for every member is in flight when Ada's position is denied.
      armed = true;
      await page.click("text=Retry latest positions");
      exact = "private";
      await midZoom(page, log, "Position denial (private exact DTO)", before, {
        watch: pinned(ada),
        gone: true,
        next: { latest: pick(LATEST, [bob, cy]), ...day([bob]), absent: [ada] },
        act: () =>
          inPage(
            page,
            `document.querySelector('.dashboard-event-dot[data-event-id="' + arg + '"]').click()`,
            of(ada)[3].id,
          ),
      });
      // The held positive (Ada located, Cy incomplete) lands afterwards.
      second.release();
      await page.waitForSelector(pinned(eve), { state: "attached" });
      await page.waitForTimeout(300);
      await view(page);
      await still(
        page,
        log,
        "held positive after Position denial",
        { latest: pick(LATEST, [bob, eve]), ...day([bob]), absent: [ada] },
        {},
      );
    },
    {
      override: (url) => {
        if (url.pathname === "/api/dashboard/latest-positions") {
          if (!armed)
            return {
              body: latestBody({ ...ALL_LOCATED, [eve]: "incomplete" }),
            };
          // The held positive also names Ada as located.
          return {
            hold: second.promise,
            body: latestBody({ ...ALL_LOCATED, [cy]: "incomplete" }),
          };
        }
        if (exact && url.pathname === "/api/dashboard/event") {
          const item = events.find(
            (e) => e.id === url.searchParams.get("event_id"),
          )!;
          return {
            body: {
              users,
              events: [
                {
                  ...item,
                  position: { availability: "unavailable", reason: "private" },
                },
              ],
              hasMore: false,
            },
          };
        }
        return undefined;
      },
    },
  );
  // Whole-dojo denial: a held Retry read answers 403 while the zoom paints.
  let armed2 = false;
  await run(
    async (page) => {
      await dotsReady(page, events.length);
      await pinsReady(page, 2);
      await view(page);
      armed2 = true;
      await page.click("text=Retry latest positions");
      await midZoom(
        page,
        log,
        "whole-dojo denial (latest 403)",
        { latest: pick(LATEST, [ada, bob, cy]), ...day([ada, bob]) },
        {
          watch: ".dashboard-latest-pin",
          gone: true,
          next: {
            latest: {},
            events: [],
            groups: [],
            lines: [],
            absent: [ada, bob, cy, eve],
          },
          act: async () => third.release(),
        },
        { pins: true, dots: true, lines: true },
      );
      assert.equal(
        await page
          .locator(
            ".dashboard-latest-pin, .dashboard-event-dot, .dashboard-map-connection",
          )
          .count(),
        0,
      );
    },
    {
      override: (url) => {
        if (url.pathname !== "/api/dashboard/latest-positions")
          return undefined;
        return !armed2
          ? { body: latestBody({ ...ALL_LOCATED, [eve]: "incomplete" }) }
          : { hold: third.promise, status: 403, body: {} };
      },
    },
  );
  await finish("mid-zoom-position-denial.json", log);
});

test("mid-zoom: a held day publication builds dots, badge and connections on the running zoom", async () => {
  const log: Log = { entries: [], failures: [] };
  const page2 = held();
  await run(
    async (page) => {
      await pinsReady(page, 3);
      // A kept view: the next day opens where the operator is looking.
      await view(page);
      await page.evaluate(() => {
        const input =
          document.querySelector<HTMLInputElement>("#dashboardMapDate")!;
        input.value = "2026-09-28";
        input.dispatchEvent(new Event("change"));
      });
      await pinsReady(page, 3);
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardMapStatus")
          ?.textContent?.includes("Loading authorized event locations"),
      );
      await view(page);
      await midZoom(
        page,
        log,
        "held day publication",
        { latest: LATEST, events: [], groups: [], lines: [] },
        {
          watch: ".dashboard-map-connection",
          next: ALL,
          act: async () => page2.release(),
        },
      );
      assert.equal(
        await page.locator(".dashboard-event-dot").count(),
        events.length,
      );
    },
    {
      override: (url) => {
        if (url.pathname !== "/api/dashboard/timeline") return undefined;
        const start = url.searchParams.get("start")!,
          end = url.searchParams.get("end")!;
        const list = events.filter(
          (e) => e.occurred_at >= start && e.occurred_at < end,
        );
        if (!list.length)
          return { body: { users, events: [], hasMore: false } };
        return url.searchParams.get("cursor") === "page-2"
          ? {
              hold: page2.promise,
              body: { users, events: list.slice(5), hasMore: false },
            }
          : {
              body: {
                users,
                events: list.slice(0, 5),
                hasMore: true,
                nextCursor: "page-2",
              },
            };
      },
    },
    { date: "2026-09-27" },
  );
  await finish("mid-zoom-day-publication.json", log);
});

test("mid-zoom: a latest response moves, adds, removes and regroups pins on the running zoom", async () => {
  const log: Log = { entries: [], failures: [] };
  const next = held();
  let armed = false;
  // Ada moves; Bob has no fix any more (his day stays); Eve joins Cy.
  const moved: Record<string, Fix> = {
    ...LATEST,
    [ada]: [40.7151234, -73.9301234],
    [eve]: [40.7304534, -73.9509045],
  };
  await run(
    async (page) => {
      await dotsReady(page, events.length);
      await pinsReady(page, 2);
      await view(page);
      armed = true;
      await page.click("text=Retry latest positions");
      await midZoom(
        page,
        log,
        "latest response replaces pins",
        { latest: pick(LATEST, [ada, bob, cy]), ...day([ada, bob]) },
        {
          watch: `.dashboard-latest-pin[data-member-ids~="${cy}"][data-member-ids~="${eve}"]`,
          next: { latest: pick(moved, [ada, cy, eve]), ...day([ada, bob]) },
          act: async () => next.release(),
        },
      );
      assert.equal(await page.locator(pinned(bob)).count(), 0);
      assert.equal(
        await page
          .locator(`.dashboard-event-dot[data-member-id="${bob}"]`)
          .count(),
        of(bob).length,
      );
    },
    {
      override: (url) => {
        if (url.pathname !== "/api/dashboard/latest-positions")
          return undefined;
        return !armed
          ? { body: latestBody({ ...ALL_LOCATED, [eve]: "incomplete" }) }
          : {
              hold: next.promise,
              body: latestBody({ ...ALL_LOCATED, [bob]: "none" }, moved),
            };
      },
    },
  );
  await finish("mid-zoom-latest-response.json", log);
});

test("mid-zoom: a date change or lock retires the animating map without repainting it", async () => {
  const log: Log = { entries: [], failures: [] };
  await run(async (page) => {
    await dotsReady(page, events.length);
    await pinsReady(page, 3);
    await view(page);
    await page.click(".leaflet-control-zoom-in");
    await page.waitForFunction(() => (window as any).fixtureMap._animatingZoom);
    await page.waitForTimeout(40);
    const retired = await page.evaluate(() => {
      const w = window as any;
      const old = w.fixtureMap;
      const input =
        document.querySelector<HTMLInputElement>("#dashboardMapDate")!;
      input.value = "2026-09-29";
      input.dispatchEvent(new Event("change"));
      return old !== w.fixtureMap;
    });
    assert.equal(retired, true);
    // Leaflet's pending zoom end on the retired map must not throw or paint.
    await page.waitForTimeout(500);
    await pinsReady(page, 3);
    assert.equal(
      await page.locator(".leaflet-container .leaflet-map-pane").count(),
      1,
    );
    assert.equal(await page.locator(".dashboard-latest-overlay").count(), 1);
    await view(page);
    // The new day has no events (they belong to 09-28); its pins align.
    await still(
      page,
      log,
      "new day after mid-zoom date change",
      { latest: LATEST, events: [], groups: [], lines: [] },
      { dots: false, lines: false },
    );
    // Lock (dashboard clear) during a zoom.
    await page.click(".leaflet-control-zoom-in");
    await page.waitForFunction(() => (window as any).fixtureMap._animatingZoom);
    await page.waitForTimeout(40);
    await page.evaluate(() => (window as any).CoachDashboard.clear());
    await page.waitForTimeout(500);
    assert.equal(
      await page
        .locator(
          ".dashboard-latest-pin, .dashboard-event-dot, .leaflet-map-pane",
        )
        .count(),
      0,
    );
  });
  await finish("mid-zoom-retire.json", log);
});

// Members and a day on both sides of the antimeridian: drag through the
// worldCopyJump wrap and zoom there; anchors stay in the right world copy.
const DL_LATEST: Record<string, Fix> = {
  [ada]: [0.0012345, 179.9961234],
  [bob]: [-0.0021234, -179.9971234],
  [cy]: [0.0031234, -179.9931234],
};
const dlEvents = [ada, bob].flatMap((user, m) =>
  Array.from({ length: 12 }, (_, i) => {
    const n = m * 12 + i + 1;
    const at = iso(
      Date.parse("2026-09-28T06:00:00.000Z") + (i * 5 + m) * 60000,
    );
    const side = (i + m) % 2 ? 1 : -1;
    const lat = (m ? -0.004 : 0.004) + 0.0007 * i;
    const lng = side > 0 ? 179.9982 - 0.0003 * i : -179.9982 + 0.0003 * i;
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
const DL_FIXES = Object.fromEntries(
  dlEvents.map((e) => [e.id, [e.position.latitude, e.position.longitude]]),
) as Record<string, Fix>;

test("dateline: worldCopyJump drags and zooms keep latest pins, dots and crossing connections in the nearest world", async () => {
  const log: Log = { entries: [], failures: [] };
  const spec: Spec = {
    latest: DL_LATEST,
    events: dlEvents.map((e) => e.id),
    groups: [],
    lines: [ada, bob].flatMap((u) => {
      const list = dlEvents.filter((e) => e.user_id === u);
      return list
        .slice(1)
        .map((e, i) => [list[i].id, e.id] as [string, string]);
    }),
  };
  await run(
    async (page) => {
      await dotsReady(page, dlEvents.length);
      await pinsReady(page, 3);
      await view(page, 15, [0, 180]);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Performance.enable");
      await install(page, DL_FIXES, spec);
      const box = await page.locator("#dashboardMap").boundingBox();
      const cx = box.x + box.width / 2,
        cyy = box.y + box.height / 2;
      const drag = (dx: number) => async () => {
        await page.mouse.move(cx, cyy);
        await page.mouse.down();
        for (let i = 1; i <= 12; i++) {
          await page.mouse.move(cx + (i * dx) / 12, cyy + i * 2);
          await page.waitForTimeout(16);
        }
        await page.mouse.up();
      };
      const lngs: number[] = [];
      const lng = () =>
        page.evaluate(() => (window as any).fixtureMap.getCenter().lng);
      for (const [name, act, o] of [
        ["drag east across 180", drag(-260), { pan: true }],
        [
          "zoom out at the dateline",
          () => page.click(".leaflet-control-zoom-out"),
          { zoom: true },
        ],
        ["drag west across 180", drag(300), { pan: true }],
        [
          "zoom in at the dateline",
          () => page.click(".leaflet-control-zoom-in"),
          { zoom: true },
        ],
        ["drag east again", drag(-360), { pan: true }],
      ] as [string, () => Promise<void>, Expect][]) {
        await gesture(page, cdp, name, act, log, o, spec);
        lngs.push(await lng());
      }
      log.entries.push({ centers: lngs });
      // The view really crossed the antimeridian both ways.
      assert.ok(
        lngs.some((l) => l < 0) && lngs.some((l) => l > 0),
        JSON.stringify(lngs),
      );
      if (evidence)
        await page.screenshot({ path: join(evidence, "dateline-settled.png") });
    },
    {
      override: (url) =>
        url.pathname === "/api/dashboard/latest-positions"
          ? {
              body: {
                as_of: iso(NOW),
                members: [
                  ...[ada, bob, cy].map((u) =>
                    member(u, "located", DL_LATEST[u]),
                  ),
                  member(eve, "none"),
                ],
              },
            }
          : undefined,
    },
    { events: dlEvents as any },
  );
  await finish("dateline.json", log);
});

test("zoom clock: tile levels started a frame apart still paint one map, with every mark on it", async () => {
  const log: Log = { entries: [], failures: [] };
  await run(async (page) => {
    await dotsReady(page, events.length);
    await pinsReady(page, 3);
    // The target level's tiles are already decoded, so both levels paint
    // during the zoom.
    await view(page, 14);
    await view(page);
    // The browser resolves each CSS transition's start on its own; force the
    // case seen natively: the new top level's transform starts one frame
    // after the level below it.
    await page.evaluate(() => {
      const m = (window as any).fixtureMap,
        w = window as any;
      w.__clock = { perturbed: null, starts: null };
      m.once("zoomanim", () => {
        const levels = [
          ...m.getContainer().querySelectorAll(".leaflet-tile-container"),
        ].sort((a: any, b: any) => +b.style.zIndex - +a.style.zIndex);
        const late = levels[0]
          .getAnimations()
          .find((a: any) => a.transitionProperty === "transform");
        if (!late) return;
        late.startTime = (document.timeline.currentTime as number) + 1000 / 60;
        w.__clock.perturbed = { zIndex: levels[0].style.zIndex };
        let n = 0;
        const after = () => {
          if (++n < 3) return requestAnimationFrame(after);
          w.__clock.starts = m
            .getContainer()
            .getAnimations({ subtree: true })
            .filter((a: any) =>
              ["transform", "translate"].includes(a.transitionProperty),
            )
            .map((a: any) => ({
              node: String(
                a.effect.target.className?.baseVal ?? a.effect.target.className,
              ).split(" ")[0],
              start: a.startTime,
            }));
        };
        requestAnimationFrame(after);
      });
    });
    const s = await midZoom(page, log, "one-frame level offset", ALL, null);
    const clock = await page.evaluate(() => (window as any).__clock);
    log.entries.push({ clock });
    if (!clock.perturbed) log.failures.push("no top-level transition to delay");
    // Both levels were visible and compared at the same fixes.
    if (s.maxLevels < 2)
      log.failures.push(`only ${s.maxLevels} visible level(s) compared`);
    const levels = (clock.starts || []).filter(
      (a: any) => a.node === "leaflet-tile-container",
    );
    if (levels.length < 2)
      log.failures.push(`${levels.length} tile level transitions`);
    const starts = new Set((clock.starts || []).map((a: any) => a.start));
    if (starts.size !== 1)
      log.failures.push(
        `zoom transitions on ${starts.size} clocks: ${JSON.stringify(clock.starts)}`,
      );
  });
  await finish("zoom-clock.json", log);
});

test("sampler: each restart owns the only sampling chain, one sample per frame", async () => {
  const log: Log = { entries: [], failures: [] };
  await run(async (page) => {
    await dotsReady(page, events.length);
    await pinsReady(page, 3);
    await view(page);
    await install(page, FIXES, ALL);
    // Restart while the previous chain still has a frame pending, and count
    // the frames that pass with an independent chain.
    const runs = await page.evaluate(async () => {
      const motion = (window as any).__motion;
      const frames = (n: number) =>
        new Promise<number>((resolve) => {
          let seen = 0;
          const tick = () =>
            ++seen < n ? requestAnimationFrame(tick) : resolve(seen);
          requestAnimationFrame(tick);
        });
      const out: any[] = [];
      motion.start();
      let ticks = await frames(12);
      for (let i = 0; i < 4; i++) {
        const s = motion.stop();
        motion.start();
        out.push({ ticks, frames: s.frames, stamps: s.stamps });
        ticks = await frames(12);
      }
      const s = motion.stop();
      out.push({ ticks, frames: s.frames, stamps: s.stamps });
      return out;
    });
    log.entries.push(...runs);
    for (const [i, r] of runs.entries()) {
      const stamps: number[] = r.stamps ?? [];
      // stop() itself takes one last sample outside any frame.
      if (r.frames > r.ticks + 2)
        log.failures.push(`run ${i}: ${r.frames} samples in ${r.ticks} frames`);
      if (stamps.length !== r.frames - 1)
        log.failures.push(
          `run ${i}: ${stamps.length} frame samples of ${r.frames}`,
        );
      if (new Set(stamps).size !== stamps.length)
        log.failures.push(`run ${i}: a frame sampled twice ${stamps}`);
    }
  });
  await finish("sampler-lifecycle.json", log);
});
