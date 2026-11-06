import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { fixture, ada, bob, ev, id, gps } from "./helpers/exact-map-fixture.js";

// Latest known (recorded, not live) member positions: round photo pins at the
// exact canonical GPS, independent of the selected day and category.
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
const NOW = Date.parse("2026-12-01T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const ADA: [number, number] = [40.7012345, -73.9021987];
const BOB: [number, number] = [40.7301234, -73.9512345];
const EVE: [number, number] = [40.6801234, -73.9701234];
const CY: [number, number] = [40.7303534, -73.9510045];
const located = (
  user_id: string,
  [latitude, longitude]: [number, number],
  captured: number,
) => ({
  user_id,
  display_name: users.find((u) => u._id === user_id)!.display_name,
  status: "located",
  latest: {
    event_id: ev(Number.parseInt(user_id.slice(0, 2), 16)),
    event_type: "workout.sets_changed",
    occurred_at: iso(captured),
    latitude,
    longitude,
    accuracy: 5,
    captured_at: iso(captured),
    source: "gps",
  },
});
const latestBody = {
  as_of: iso(NOW),
  members: [
    located(ada, ADA, NOW - 5 * 60000),
    // Stale first, fresh second, a few metres apart: one aggregate marker
    // whose chooser keeps each member's own photo, age and opacity.
    located(bob, BOB, NOW - 3 * 86400000),
    located(cy, CY, NOW - 2 * 60000),
    {
      user_id: dee,
      display_name: "Synthetic Dee",
      status: "private",
      latest: null,
    },
    located(eve, EVE, NOW + 2 * 3600000),
  ],
};
// The selected day has only one old event far from every latest pin.
const events = [
  {
    id: ev(1),
    user_id: bob,
    occurred_at: "2026-09-28T02:00:00.000Z",
    event_type: "workout.set_completed",
    subject: { type: "workout", id: id(1) },
    details: {},
    position: gps(40.75, -73.99, "2026-09-28T02:00:00.000Z"),
  },
  {
    id: ev(2),
    user_id: ada,
    occurred_at: "2026-09-28T03:00:00.000Z",
    event_type: "workout.set_completed",
    subject: { type: "workout", id: id(2) },
    details: {},
    position: gps(41.75, -74.99, "2026-09-28T03:00:00.000Z"),
  },
];
const evidence = process.env.LATEST_PINS_EVIDENCE_DIR;
const avatarPng = () =>
  sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: 220, g: 60, b: 40 },
    },
  })
    .png()
    .toBuffer();
const beforeLoad = async (page: any) => {
  const png = await avatarPng();
  await page.route("**/api/dashboard/avatar?**", (route: any) => {
    const member = new URL(route.request().url()).searchParams.get("id");
    if (member === ada)
      return route.fulfill({ contentType: "image/png", body: png });
    return route.fulfill({ status: 404, body: "{}" });
  });
};
const run = (
  body: (page: any, requests: string[]) => Promise<void>,
  options: Record<string, unknown> = {},
) =>
  fixture(async (page, { requests }) => body(page, requests), {
    users,
    events: events as any,
    now: iso(NOW),
    marks: 2,
    beforeLoad,
    override: (url) =>
      url.pathname === "/api/dashboard/latest-positions"
        ? { body: latestBody }
        : undefined,
    ...options,
  });
const pins = (page: any) =>
  page.$$eval(".dashboard-latest-pin", (nodes: HTMLElement[]) =>
    nodes.map((n) => ({
      ids: n.dataset.memberIds,
      stale: n.classList.contains("dashboard-latest-stale"),
      age: (n.querySelector(".dashboard-latest-age") as HTMLElement).hidden
        ? ""
        : n.querySelector(".dashboard-latest-age")!.textContent,
      label: n.getAttribute("aria-label"),
      left: parseFloat(n.style.left),
      top: parseFloat(n.style.top),
      radius: getComputedStyle(n.querySelector(".dashboard-latest-photo")!)
        .borderTopLeftRadius,
      image: (() => {
        const img = n.querySelector("img") as HTMLImageElement | null;
        return img ? img.complete && img.naturalWidth : null;
      })(),
      text: n.querySelector(".dashboard-latest-photo")!.textContent,
      aggregate: !!n.querySelector(".dashboard-latest-aggregate"),
      mixed: n.classList.contains("dashboard-latest-mixed"),
      opacity: getComputedStyle(n.querySelector(".dashboard-latest-photo")!)
        .opacity,
    })),
  );
// The day fit centres on the day's event; show the latest pins' area.
const showPins = async (page: any) => {
  await page.evaluate(() =>
    (window as any).fixtureMap.setView([40.705, -73.94], 12, {
      animate: false,
    }),
  );
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".dashboard-latest-pin:not([hidden])")
        .length === 3,
  );
};
const camera = (page: any) =>
  page.evaluate(() => {
    const m = (window as any).fixtureMap;
    const c = m.getCenter();
    return { lat: c.lat, lng: c.lng, zoom: m.getZoom() };
  });

const choices = (page: any) =>
  page.$$eval(".dashboard-latest-choice", (nodes: HTMLElement[]) =>
    nodes.map((c) => {
      const box = c.getBoundingClientRect(),
        map = document.querySelector("#dashboardMap")!.getBoundingClientRect();
      const img = c.querySelector("img") as HTMLImageElement | null;
      return {
        id: c.dataset.memberId,
        name: c.querySelector(".dashboard-latest-choice-name")!.textContent,
        age: c.querySelector(".dashboard-latest-choice-age")!.textContent,
        stale: c.classList.contains("dashboard-latest-stale"),
        opacity: getComputedStyle(c.querySelector(".dashboard-latest-photo")!)
          .opacity,
        radius: getComputedStyle(c.querySelector(".dashboard-latest-photo")!)
          .borderTopLeftRadius,
        photo: img ? img.complete && img.naturalWidth : null,
        inside:
          box.left >= map.left - 0.5 &&
          box.right <= map.right + 0.5 &&
          box.top >= map.top - 0.5 &&
          box.bottom <= map.bottom + 0.5,
      };
    }),
  );

test("latest pins: exact anchors, decoded photo, aggregate overlap marker with per-member chooser", async () => {
  await run(async (page) => {
    await page.waitForFunction(
      () => document.querySelectorAll(".dashboard-latest-pin").length > 0,
    );
    await showPins(page);
    await page.waitForFunction(() =>
      [
        ...document.querySelectorAll<HTMLImageElement>(
          ".dashboard-latest-pin img",
        ),
      ].some((i) => i.complete && i.naturalWidth > 0),
    );
    const view = await pins(page);
    const byIds = Object.fromEntries(view.map((p: any) => [p.ids, p]));
    assert.deepEqual(
      Object.keys(byIds).sort(),
      [ada, `${bob} ${cy}`, eve].sort(),
    );
    assert.equal(byIds[ada].image, 64);
    assert.equal(byIds[ada].stale, false);
    assert.equal(byIds[ada].opacity, "1");
    assert.equal(byIds[ada].age, "");
    for (const p of view) assert.equal(p.radius, "50%");
    // The overlap marker is a neutral count: no member's portrait or age.
    const group = byIds[`${bob} ${cy}`];
    assert.equal(group.aggregate, true);
    assert.equal(group.image, null);
    assert.equal(group.text, "2");
    assert.equal(group.mixed, true);
    assert.equal(group.stale, false);
    assert.equal(group.age, "1 older");
    assert.match(group.label, /2 members' .*1 older than ten minutes/);
    assert.match(
      group.label,
      /Synthetic Bob, latest known position recorded 3 days ago/,
    );
    assert.match(
      group.label,
      /Synthetic Cy, latest known position recorded 2 min ago/,
    );
    assert.equal(byIds[eve].stale, true);
    assert.equal(byIds[eve].opacity, "0.5");
    assert.equal(byIds[eve].age, "capture time is ahead of this device");
    assert.ok(!view.some((p: any) => p.ids.includes(dee)));
    // Anchored at the exact recorded coordinate.
    const expected = await page.evaluate(
      ([lat, lng]: [number, number]) =>
        (window as any).fixtureMap.latLngToContainerPoint([lat, lng]),
      ADA,
    );
    assert.ok(Math.abs(byIds[ada].left - expected.x) < 0.01);
    assert.ok(Math.abs(byIds[ada].top - expected.y) < 0.01);
    // Each chooser entry carries its own photo/initials, age and opacity.
    await page.click(`.dashboard-latest-pin[data-member-ids="${bob} ${cy}"]`);
    const listed = await choices(page);
    assert.deepEqual(
      listed.map((c: any) => [c.name, c.age, c.stale, c.opacity, c.radius]),
      [
        ["Synthetic Bob", "3 days ago", true, "0.5", "50%"],
        ["Synthetic Cy", "2 min ago", false, "1", "50%"],
      ],
    );
    assert.ok(listed.every((c: any) => c.inside));
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: join(evidence, "latest-pins-wide.png") });
    }
    // Zooming in regroups: near-but-distinct members get their own pins.
    await page.evaluate(
      ([lat, lng]: [number, number]) =>
        (window as any).fixtureMap.setView([lat, lng], 19, { animate: false }),
      BOB,
    );
    await page.waitForFunction(
      ([b, c]: [string, string]) =>
        document.querySelector(
          `.dashboard-latest-pin[data-member-ids="${b}"]`,
        ) &&
        document.querySelector(`.dashboard-latest-pin[data-member-ids="${c}"]`),
      [bob, cy],
    );
    assert.equal(await page.$(".dashboard-latest-chooser:not([hidden])"), null);
  });
});

test("latest pins: fresh-first and all-stale overlaps, keyboard chooser, exact per-member focus, narrow edge clamp", async () => {
  const body = {
    as_of: iso(NOW),
    members: [
      located(ada, ADA, NOW - 1 * 60000),
      located(bob, [ADA[0] + 0.00001, ADA[1]], NOW - 40 * 60000),
      located(cy, BOB, NOW - 30 * 60000),
      located(eve, [BOB[0], BOB[1] + 0.00002], NOW - 5 * 3600000),
    ],
  };
  await run(
    async (page) => {
      await page.waitForFunction(
        () => document.querySelectorAll(".dashboard-latest-pin").length === 2,
      );
      // Push the fresh-first group to the map's right edge.
      await page.evaluate(([lat, lng]: [number, number]) => {
        const m = (window as any).fixtureMap;
        m.setView([lat, lng], 12, { animate: false });
        const size = m.getSize();
        m.panBy([-(size.x / 2 - 12), 0], { animate: false });
      }, ADA);
      await page.waitForTimeout(100);
      const view = Object.fromEntries(
        (await pins(page)).map((p: any) => [p.ids, p]),
      );
      const fresh = view[`${ada} ${bob}`];
      assert.equal(fresh.aggregate, true);
      assert.equal(fresh.mixed, true);
      assert.equal(fresh.age, "1 older");
      await page.focus(
        `.dashboard-latest-pin[data-member-ids="${ada} ${bob}"]`,
      );
      await page.keyboard.press("Enter");
      let listed = await choices(page);
      assert.deepEqual(
        listed.map((c: any) => [c.name, c.age, c.stale]),
        [
          ["Synthetic Ada", "1 min ago", false],
          ["Synthetic Bob", "40 min ago", true],
        ],
      );
      assert.ok(
        listed.every((c: any) => c.inside),
        JSON.stringify(listed),
      );
      // Keyboard: arrows move, Escape returns to the owner, reopen works.
      await page.keyboard.press("ArrowDown");
      assert.equal(
        await page.evaluate(
          () => (document.activeElement as HTMLElement).dataset.memberId,
        ),
        bob,
      );
      await page.keyboard.press("Escape");
      assert.equal(
        await page.$(".dashboard-latest-chooser:not([hidden])"),
        null,
      );
      assert.equal(
        await page.evaluate(
          () => (document.activeElement as HTMLElement).dataset.memberIds,
        ),
        `${ada} ${bob}`,
      );
      await page.keyboard.press("Enter");
      await page.keyboard.press("ArrowDown");
      // Shift+Enter centers that member's own exact fix at street level.
      await page.keyboard.press("Shift+Enter");
      let cam = await camera(page);
      assert.ok(Math.abs(cam.lat - (ADA[0] + 0.00001)) < 1e-7);
      assert.ok(Math.abs(cam.lng - ADA[1]) < 1e-7);
      assert.equal(cam.zoom, 18);
      // Panning closes an open chooser.
      await page.click(".dashboard-member-all");
      await page.evaluate(
        ([lat, lng]: [number, number]) =>
          (window as any).fixtureMap.setView([lat, lng], 12, {
            animate: false,
          }),
        BOB,
      );
      await page.waitForFunction(
        (k: string) =>
          document.querySelector(
            `.dashboard-latest-pin[data-member-ids="${k}"]`,
          ),
        `${cy} ${eve}`,
      );
      const stale = Object.fromEntries(
        (await pins(page)).map((p: any) => [p.ids, p]),
      )[`${cy} ${eve}`];
      assert.equal(stale.stale, true);
      assert.equal(stale.age, "all older");
      await page.click(`.dashboard-latest-pin[data-member-ids="${cy} ${eve}"]`);
      listed = await choices(page);
      assert.deepEqual(
        listed.map((c: any) => [c.name, c.age, c.stale]),
        [
          ["Synthetic Cy", "30 min ago", true],
          ["Synthetic Eve", "5 h ago", true],
        ],
      );
      await page.evaluate(() =>
        (window as any).fixtureMap.panBy([30, 0], { animate: false }),
      );
      assert.equal(
        await page.$(".dashboard-latest-chooser:not([hidden])"),
        null,
      );
      // A single chooser activation only selects: the camera stays.
      await page.click(`.dashboard-latest-pin[data-member-ids="${cy} ${eve}"]`);
      const still = await camera(page);
      await page.click(`.dashboard-latest-choice[data-member-id="${eve}"]`);
      await page.waitForTimeout(400);
      assert.deepEqual(await camera(page), still);
      assert.deepEqual(
        (await pins(page)).map((p: any) => p.ids),
        [eve],
      );
      if (evidence)
        await page.screenshot({
          path: join(evidence, "latest-pins-narrow-chooser.png"),
        });
    },
    {
      viewport: { width: 390, height: 844 },
      override: (url: URL) =>
        url.pathname === "/api/dashboard/latest-positions"
          ? { body }
          : undefined,
    },
  );
});

test("latest pins: single click only selects; double-click and Shift+Enter focus; day change keeps latest", async () => {
  await run(async (page, requests) => {
    await page.waitForFunction(
      () => document.querySelectorAll(".dashboard-latest-pin").length > 0,
    );
    await showPins(page);
    const before = await camera(page);
    await page.click(`.dashboard-latest-pin[data-member-ids="${ada}"]`);
    await page.waitForTimeout(600);
    assert.deepEqual(await camera(page), before);
    const pressed = await page.$$eval(
      ".dashboard-member-card",
      (n: HTMLElement[]) =>
        n
          .filter((c) => c.getAttribute("aria-pressed") === "true")
          .map((c) => c.textContent),
    );
    assert.equal(pressed.length, 1);
    assert.match(pressed[0], /Synthetic Ada/);
    // Explicit member filter shows only the selected member's latest pin.
    assert.deepEqual(
      (await pins(page)).map((p: any) => p.ids),
      [ada],
    );
    await page.dblclick(`.dashboard-latest-pin[data-member-ids="${ada}"]`);
    const focused = await camera(page);
    assert.ok(
      Math.abs(focused.lat - ADA[0]) < 1e-6 &&
        Math.abs(focused.lng - ADA[1]) < 1e-6,
    );
    assert.equal(focused.zoom, 18);
    // Ada's selected-day event is elsewhere: a resize keeps the explicit focus.
    await page.setViewportSize({ width: 1000, height: 850 });
    await page.waitForTimeout(400);
    const resized = await camera(page);
    assert.ok(
      Math.abs(resized.lat - ADA[0]) < 1e-5 &&
        Math.abs(resized.lng - ADA[1]) < 1e-5 &&
        resized.zoom === 18,
      JSON.stringify(resized),
    );
    // Keyboard focus is explicit too.
    await page.click(".dashboard-member-all");
    await showPins(page);
    await page.focus(`.dashboard-latest-pin[data-member-ids="${eve}"]`);
    await page.keyboard.press("Shift+Enter");
    const keyed = await camera(page);
    assert.ok(
      Math.abs(keyed.lat - EVE[0]) < 1e-6 &&
        Math.abs(keyed.lng - EVE[1]) < 1e-6,
    );
    await page.click(".dashboard-member-all");
    // The day's event mark still selects its exact event alongside the layer.
    await page.click(".dashboard-timeline-mark");
    await page.waitForFunction(() =>
      document.querySelector(".dashboard-timeline-mark[aria-pressed='true']"),
    );
    // Another day never redefines latest or hides the age note.
    const latestReads = () =>
      requests.filter((r) => r.startsWith("/api/dashboard/latest-positions"))
        .length;
    const readsBefore = latestReads();
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
    await showPins(page);
    const after = Object.fromEntries(
      (await pins(page)).map((p: any) => [p.ids, p]),
    );
    assert.equal(after[`${bob} ${cy}`].age, "1 older");
    assert.equal(after[eve].stale, true);
    // Exactly one read per map/day load; selection and focus never read.
    assert.equal(latestReads(), readsBefore + 1);
  });
});

test("latest pins: age crosses ten minutes without requests and re-evaluates on resume", async () => {
  await run(async (page, requests) => {
    await page.waitForFunction(
      () => document.querySelectorAll(".dashboard-latest-pin").length > 0,
    );
    await showPins(page);
    const count = requests.length;
    await page.clock.setFixedTime(new Date(NOW + 6 * 60000));
    // The single shared ticker (15 s) re-evaluates without any request.
    await page.waitForFunction(
      (key: string) =>
        document
          .querySelector(`.dashboard-latest-pin[data-member-ids="${key}"]`)
          ?.classList.contains("dashboard-latest-stale"),
      ada,
      { timeout: 20000 },
    );
    let view = Object.fromEntries(
      (await pins(page)).map((p: any) => [p.ids, p]),
    );
    assert.equal(view[ada].age, "11 min ago");
    await page.clock.setFixedTime(new Date(NOW + 65 * 60000));
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    view = Object.fromEntries((await pins(page)).map((p: any) => [p.ids, p]));
    assert.equal(view[ada].age, "1 h ago");
    assert.equal(requests.length, count);
    assert.equal(
      await page.evaluate(
        () => document.querySelectorAll(".dashboard-latest-pin").length,
      ),
      3,
    );
  });
});

test("latest pins: denial shows no geometry; narrow viewport keeps pins reachable", async () => {
  await run(
    async (page) => {
      await page.waitForFunction(() =>
        document
          .querySelector(".dashboard-latest-caption")
          ?.textContent?.includes("denied (403)"),
      );
      assert.equal(
        await page.$$eval(".dashboard-latest-pin", (n: any[]) => n.length),
        0,
      );
    },
    {
      override: (url: URL) =>
        url.pathname === "/api/dashboard/latest-positions"
          ? { status: 403, body: { error: "DOJO_ACCESS_DENIED" } }
          : undefined,
    },
  );
  await run(
    async (page) => {
      await page.waitForFunction(
        () => document.querySelectorAll(".dashboard-latest-pin").length >= 1,
      );
      await page.evaluate(() =>
        (window as any).fixtureMap.setView([40.705, -73.94], 12, {
          animate: false,
        }),
      );
      await page.waitForTimeout(300);
      if (evidence)
        await page.screenshot({
          path: join(evidence, "latest-pins-narrow.png"),
          fullPage: true,
        });
    },
    { viewport: { width: 390, height: 844 } },
  );
});

const latestIds = async (page: any) =>
  (await pins(page))
    .flatMap((p: any) => p.ids.split(" "))
    .sort()
    .join(",");
const caption = (page: any) =>
  page.$eval(".dashboard-latest-caption", (n: HTMLElement) =>
    n.hidden ? "" : n.textContent,
  );
const privateFor = (member: string) =>
  events.map((e) =>
    e.user_id === member
      ? { ...e, position: { availability: "unavailable", reason: "private" } }
      : e,
  );

test("latest pins: Position invalidation holds in both response orders and latest-private removes day geometry", async () => {
  // Order A: the latest positive lands first; the later private day DTO
  // removes that member's latest pin synchronously.
  let releaseDay!: () => void;
  const dayHeld = new Promise<void>((r) => (releaseDay = r));
  let dayReads = 0;
  await run(
    async (page) => {
      await showPins(page);
      assert.equal(await latestIds(page), [ada, bob, cy, eve].sort().join(","));
      releaseDay();
      await page.waitForFunction(
        (b: string) =>
          !document.querySelector(
            `.dashboard-latest-pin[data-member-ids~="${b}"]`,
          ) && document.querySelector(".dashboard-timeline-mark"),
        bob,
      );
      assert.equal(await latestIds(page), [ada, cy, eve].sort().join(","));
    },
    {
      marks: null,
      ready: "2026-09-28",
      override: (url) =>
        url.pathname === "/api/dashboard/timeline"
          ? // Startup's first (today) read settles; the selected day's is held.
            ++dayReads === 1
            ? { body: { users, events, hasMore: false } }
            : {
                body: { users, events: privateFor(bob), hasMore: false },
                hold: dayHeld,
              }
          : url.pathname === "/api/dashboard/latest-positions"
            ? { body: latestBody }
            : undefined,
    },
  );
  // Order B: the private day DTO lands first; the held positive from a read
  // that began earlier never resurrects the pin.
  let releaseLatest!: () => void;
  const latestHeld = new Promise<void>((r) => (releaseLatest = r));
  await run(
    async (page, requests) => {
      await page.waitForFunction(() =>
        document.querySelector(".dashboard-timeline-mark"),
      );
      assert.ok(
        requests.some((r) => r.startsWith("/api/dashboard/latest-positions")),
      );
      releaseLatest();
      await page.waitForFunction(
        () => document.querySelectorAll(".dashboard-latest-pin").length > 0,
      );
      await showPins(page).catch(() => {});
      assert.equal(await latestIds(page), [ada, cy, eve].sort().join(","));
    },
    {
      marks: null,
      override: (url) =>
        url.pathname === "/api/dashboard/timeline"
          ? { body: { users, events: privateFor(bob), hasMore: false } }
          : url.pathname === "/api/dashboard/latest-positions"
            ? { body: latestBody, hold: latestHeld }
            : undefined,
    },
  );
  // A newer latest-private removes the member's selected-day geometry.
  await run(
    async (page) => {
      await page.waitForFunction(
        (e: string) =>
          !document.querySelector(
            `.dashboard-event-dot[data-event-id="${e}"]`,
          ) && document.querySelector(".dashboard-latest-pin"),
        ev(2),
      );
      assert.ok(await page.$(`.dashboard-event-dot[data-event-id="${ev(1)}"]`));
      assert.ok(!(await latestIds(page)).includes(ada));
    },
    {
      marks: null,
      override: (url) =>
        url.pathname === "/api/dashboard/latest-positions"
          ? {
              body: {
                ...latestBody,
                members: [
                  {
                    user_id: ada,
                    display_name: "Synthetic Ada",
                    status: "private",
                    latest: null,
                  },
                  ...latestBody.members.slice(1),
                ],
              },
            }
          : undefined,
    },
  );
});

test("latest pins: dojo timeline denial clears pins, chooser and held positives", async () => {
  let timelineReads = 0,
    latestReads = 0,
    release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await run(
    async (page) => {
      await showPins(page);
      await page.click(`.dashboard-latest-pin[data-member-ids="${bob} ${cy}"]`);
      assert.equal((await choices(page)).length, 2);
      await page.evaluate(() => {
        const input =
          document.querySelector<HTMLInputElement>("#dashboardMapDate")!;
        input.value = "2026-09-27";
        input.dispatchEvent(new Event("change"));
      });
      await page.waitForFunction(() =>
        document
          .querySelector(".dashboard-latest-caption")
          ?.textContent?.includes("dojo access denied"),
      );
      assert.equal(
        await page.$$eval(".dashboard-latest-pin", (n: any[]) => n.length),
        0,
      );
      assert.equal(
        await page.$(".dashboard-latest-chooser:not([hidden])"),
        null,
      );
      release();
      await page.waitForTimeout(300);
      assert.equal(
        await page.$$eval(".dashboard-latest-pin", (n: any[]) => n.length),
        0,
      );
    },
    {
      override: (url) => {
        if (url.pathname === "/api/dashboard/timeline" && ++timelineReads > 2)
          return { status: 403, body: { error: "Forbidden" } };
        if (url.pathname === "/api/dashboard/latest-positions")
          return ++latestReads > 2
            ? { body: latestBody, hold: held }
            : { body: latestBody };
        return undefined;
      },
    },
  );
});

test("latest pins: 409 restarts once; incomplete and malformed reads stay visible with Retry", async () => {
  let phase = "incomplete",
    conflicts = 0,
    reads = 0;
  const incomplete = {
    ...latestBody,
    members: [
      latestBody.members[0],
      {
        user_id: bob,
        display_name: "Synthetic Bob",
        status: "incomplete",
        latest: null,
      },
    ],
  };
  await run(
    async (page) => {
      await page.waitForFunction(() =>
        document
          .querySelector(".dashboard-latest-caption")
          ?.textContent?.includes("could not be confirmed for Synthetic Bob"),
      );
      assert.equal(await latestIds(page), ada);
      // The warning survives re-rendering (zoom) rather than flashing once.
      await page.evaluate(() =>
        (window as any).fixtureMap.setZoom(8, { animate: false }),
      );
      await page.waitForTimeout(100);
      assert.match(await caption(page), /could not be confirmed/);
      // Retry: one 409 restarts once, then a malformed 200 fails closed.
      phase = "conflict";
      reads = 0;
      await page.click(".dashboard-latest-caption button");
      await page.waitForFunction(() =>
        document
          .querySelector(".dashboard-latest-caption")
          ?.textContent?.includes("unavailable (invalid response)"),
      );
      assert.deepEqual([reads, conflicts], [2, 1]);
      assert.equal(
        await page.$$eval(".dashboard-latest-pin", (n: any[]) => n.length),
        0,
      );
      phase = "ok";
      await page.click(".dashboard-latest-caption button");
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLElement>(".dashboard-latest-caption")!
            .hidden,
      );
      await showPins(page);
    },
    {
      override: (url) => {
        if (url.pathname !== "/api/dashboard/latest-positions")
          return undefined;
        reads++;
        if (phase === "incomplete") return { body: incomplete };
        if (phase === "conflict" && conflicts === 0 && ++conflicts)
          return { status: 409, body: { error: "EVENT_HISTORY_CHANGED" } };
        if (phase === "conflict")
          return {
            body: {
              members: [
                { user_id: ada, status: "located", latest: { latitude: "x" } },
              ],
            },
          };
        return { body: latestBody };
      },
    },
  );
});

test("latest pins: initial framing shows latest fixes with or without selected-day events; All restores it", async () => {
  const contains = (page: any, points: [number, number][]) =>
    page.evaluate(
      (pts: [number, number][]) =>
        pts.every(([lat, lng]) => {
          // Any world copy counts: the camera may sit on a wrapped copy.
          const b = (window as any).fixtureMap.getBounds();
          return [-360, 0, 360].some((k) => b.contains([lat, lng + k]));
        }),
      points,
    );
  // No selected-day events: the latest fixes alone frame the map.
  await run(
    async (page) => {
      await page.waitForFunction(
        () => document.querySelectorAll(".dashboard-latest-pin").length > 0,
      );
      await page.waitForTimeout(200);
      assert.ok(await contains(page, [ADA, BOB, CY, EVE]));
    },
    { events: [] as any, marks: null },
  );
  // A historical day elsewhere: the union of day events and latest fixes.
  await run(async (page) => {
    await page.waitForFunction(
      () => document.querySelectorAll(".dashboard-latest-pin").length > 0,
    );
    await page.waitForTimeout(200);
    const union: [number, number][] = [
      ADA,
      BOB,
      CY,
      EVE,
      [40.75, -73.99],
      [41.75, -74.99],
    ];
    assert.ok(await contains(page, union));
    const framed = await camera(page);
    await page.evaluate(() =>
      (window as any).fixtureMap.setView([10, 10], 5, { animate: false }),
    );
    await page.click(".dashboard-member-all");
    await page.waitForTimeout(400);
    assert.ok(
      await contains(page, union),
      JSON.stringify([framed, await camera(page)]),
    );
  });
});

test("latest pins: explicit focus survives a pending day publication whose events are elsewhere", async () => {
  let dayReads = 0,
    release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await run(
    async (page) => {
      await showPins(page);
      await page.dblclick(`.dashboard-latest-pin[data-member-ids="${ada}"]`);
      await page.waitForTimeout(400);
      release();
      await page.waitForFunction(
        () => document.querySelectorAll(".dashboard-timeline-mark").length > 0,
      );
      await page.waitForTimeout(400);
      const cam = await camera(page);
      assert.ok(
        Math.abs(cam.lat - ADA[0]) < 1e-6 &&
          Math.abs(cam.lng - ADA[1]) < 1e-6 &&
          cam.zoom === 18,
        JSON.stringify(cam),
      );
    },
    {
      marks: null,
      ready: "2026-09-28",
      override: (url) =>
        url.pathname === "/api/dashboard/timeline"
          ? ++dayReads === 1
            ? { body: { users, events, hasMore: false } }
            : { body: { users, events, hasMore: false }, hold: held }
          : url.pathname === "/api/dashboard/latest-positions"
            ? { body: latestBody }
            : undefined,
    },
  );
});
