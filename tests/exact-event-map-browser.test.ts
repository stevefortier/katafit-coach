import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fixture,
  ledger,
  ada,
  bob,
  id,
  ev,
  gps,
  type Event,
  type Override,
} from "./helpers/exact-map-fixture.js";

// Offset between an element's centre and a coordinate projected into the
// world copy the map currently displays (Leaflet container = padding box).
async function offset(node: any, latitude: number, longitude: number) {
  return node.evaluate(
    (element: Element, [lat, lng]: [number, number]) => {
      const map = (window as any).fixtureMap,
        el = document.querySelector("#dashboardMap")!;
      const wrapped = lng + 360 * Math.round((map.getCenter().lng - lng) / 360);
      const point = map.latLngToContainerPoint([lat, wrapped]);
      const r = element.getBoundingClientRect(),
        b = el.getBoundingClientRect();
      return {
        dx: r.left + r.width / 2 - b.left - el.clientLeft - point.x,
        dy: r.top + r.height / 2 - b.top - el.clientTop - point.y,
      };
    },
    [latitude, longitude],
  );
}
const exact = (o: { dx: number; dy: number }) =>
  Math.abs(o.dx) < 1 && Math.abs(o.dy) < 1;

test("exact co-located coordinates have one chronological keyboard chooser, not displaced anchors", async () =>
  fixture(async (page) => {
    assert.equal(
      await page
        .locator(
          ".dashboard-map-anchor,.dashboard-map-pin-link,.dashboard-member-pin",
        )
        .count(),
      0,
    );
    const group = page.locator('.dashboard-map-group[data-count="3"]');
    assert.equal(await group.count(), 1);
    const geometry = await offset(group, 40.7, -73.9);
    assert.ok(exact(geometry), JSON.stringify(geometry));
    await group.focus();
    await page.keyboard.press("Enter");
    // Chronological, deterministic event-ID tie order (events 2 and 4 share 02:00).
    assert.deepEqual(
      await page
        .locator(".dashboard-map-choice")
        .evaluateAll((nodes: any[]) => nodes.map((n) => n.dataset.eventId)),
      [ev(1), ev(2), ev(4)],
    );
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() =>
      document
        .querySelector("#dashboardMapSelection")
        ?.textContent?.includes("meal food added"),
    );
    assert.deepEqual(
      await page
        .locator('.dashboard-timeline-mark[aria-pressed="true"]')
        .evaluateAll((nodes: any[]) => nodes.map((n) => n.dataset.eventId)),
      [ev(2)],
    );
    const selected = page.locator('.dashboard-event-dot[aria-pressed="true"]');
    assert.equal(await selected.getAttribute("data-event-id"), ev(2));
    assert.ok(exact(await offset(selected, 40.7, -73.9)));
    assert.equal(
      await selected.evaluate((n: any) => getComputedStyle(n).backgroundColor),
      "rgb(34, 197, 94)",
    );
  }));

test("repeated same-subject ledger events keep separate recorded coordinates and identities", async () =>
  fixture(async (page, { requests }) => {
    assert.ok(
      !requests.some((r) => r.startsWith("/api/dashboard/map")),
      "the activity-coordinate reader no longer drives the map",
    );
    // Seven events carry available GPS; the private survey has none on the map.
    assert.equal(await page.locator(".dashboard-event-dot").count(), 7);
    assert.equal(
      await page
        .locator(`.dashboard-event-dot[data-event-id="${ev(8)}"]`)
        .count(),
      0,
    );
    const later = page.locator(
      `.dashboard-event-dot[data-event-id="${ev(7)}"]`,
    );
    assert.ok(exact(await offset(later, 40.75, -73.95)));
    assert.equal(
      await later.evaluate((n: any) => getComputedStyle(n).backgroundColor),
      "rgb(239, 68, 68)",
    );
    await later.click();
    await page.waitForFunction(() =>
      document
        .querySelector("#dashboardMapSelection")
        ?.textContent?.includes("Current subject"),
    );
    assert.deepEqual(
      await page
        .locator('.dashboard-timeline-mark[aria-pressed="true"]')
        .evaluateAll((nodes: any[]) => nodes.map((n) => n.dataset.eventId)),
      [ev(7)],
      "the same subject's earlier event is not co-selected",
    );
    const detail = await page.locator("#dashboardMapSelection").innerText();
    assert.match(detail, /Event location: 40\.75, -73\.95/);
    assert.match(detail, /2026-09-28T06:00:00\.000Z/);
    assert.ok(
      !/10, 10/.test(detail),
      "current subject GPS never replaces the event location",
    );
    // The detail's moved current coordinates never remap or remove the ledger event.
    assert.ok(exact(await offset(later, 40.75, -73.95)));
    assert.ok(
      requests.some((r) =>
        r.startsWith(`/api/dashboard/event?event_id=${ev(7)}&`),
      ),
      "selection freshly reauthorizes the exact ledger event",
    );
  }));

// Every rendered connection, with its endpoints compared to the exact dots.
async function connections(page: any) {
  return page.locator(".dashboard-map-connection").evaluateAll((lines: any[]) =>
    lines.map((line) => {
      const map = (window as any).fixtureMap;
      // Inline lookups: tsx would inject a __name helper into named closures.
      const [from, to] = [line.dataset.from, line.dataset.to].map((id) => {
        const node = document.querySelector(
          `.dashboard-event-dot[data-event-id="${id}"]`,
        ) as HTMLElement;
        return {
          x: parseFloat(node.style.left),
          y: parseFloat(node.style.top),
        };
      });
      const style = getComputedStyle(line);
      return {
        from: line.dataset.from,
        to: line.dataset.to,
        member: line.dataset.memberId,
        stroke: style.stroke,
        dash: style.strokeDasharray,
        hidden: style.display === "none",
        exact:
          Math.abs(+line.getAttribute("x1") - from.x) < 1 &&
          Math.abs(+line.getAttribute("y1") - from.y) < 1 &&
          Math.abs(+line.getAttribute("x2") - to.x) < 1 &&
          Math.abs(+line.getAttribute("y2") - to.y) < 1,
        zoom: map.getZoom(),
      };
    }),
  );
}

test("per-member dashed event connections follow occurrence order and break at unknown locations and long gaps", async () => {
  const events = ledger();
  // Five hours after Ada's 06:00 event: beyond the documented 4-hour gap.
  events.push({
    ...events[6],
    id: ev(9),
    occurred_at: "2026-09-28T11:00:00.000Z",
    event_type: "meal.food_added",
    subject: { type: "meal", id: id(9) },
    position: gps(40.76, -73.96, "2026-09-28T11:00:00.000Z"),
  });
  await fixture(
    async (page) => {
      const lines = await connections(page);
      assert.deepEqual(
        lines.map((l: any) => `${l.from}>${l.to}`).sort(),
        [
          `${ev(1)}>${ev(2)}`,
          `${ev(2)}>${ev(3)}`,
          `${ev(4)}>${ev(5)}`,
          `${ev(6)}>${ev(7)}`,
        ].sort(),
        "Ada's private 04:00 survey and the 5-hour gap break the chain; no cross-member joins",
      );
      const byPair = Object.fromEntries(
        lines.map((l: any) => [`${l.from}>${l.to}`, l]),
      );
      // Colored by the destination event's category, matching the timeline palette.
      assert.equal(byPair[`${ev(1)}>${ev(2)}`].stroke, "rgb(34, 197, 94)");
      assert.equal(byPair[`${ev(2)}>${ev(3)}`].stroke, "rgb(59, 130, 246)");
      assert.equal(byPair[`${ev(4)}>${ev(5)}`].stroke, "rgb(139, 92, 246)");
      assert.equal(byPair[`${ev(4)}>${ev(5)}`].member, bob);
      for (const line of lines) {
        assert.equal(line.dash, "6px, 5px");
        assert.ok(line.exact, JSON.stringify(line));
      }
      assert.equal(await page.locator(".dashboard-map-note").count(), 0);
    },
    { events },
  );
});

test("an incomplete day shows exact events but no connections and never claims completeness", async () => {
  await fixture(
    async (browserPage, { events, requests }) => {
      // The documented safety bound: 50 serial pages, then visibly partial with resume.
      assert.equal(
        requests.filter((r) =>
          r.startsWith("/api/dashboard/timeline?date=2026-09-28"),
        ).length,
        50,
      );
      assert.equal(
        await browserPage
          .getByRole("button", { name: "Load more events" })
          .count(),
        1,
      );
      assert.equal(
        await browserPage.locator(".dashboard-event-dot").count(),
        7,
      );
      assert.equal(
        await browserPage.locator(".dashboard-map-connection").count(),
        0,
      );
      const status = await browserPage
        .locator("#dashboardMapStatus")
        .innerText();
      assert.match(status, /partial day/);
      assert.ok(!status.includes("complete day"), status);
      assert.equal(events.length, 8);
    },
    {
      ready: "authorized events have a shared location",
      // One event per page with a cursor that keeps advancing past the 50-page
      // safety bound, leaving the day explicitly incomplete.
      override: (url, events) => {
        if (url.pathname !== "/api/dashboard/timeline") return undefined;
        const page = Number(url.searchParams.get("cursor")?.slice(5) || 0);
        return url.searchParams.get("date") !== "2026-09-28"
          ? { body: { users: [], events: [], hasMore: false } }
          : {
              body: {
                users: [
                  { _id: ada, display_name: "Synthetic Ada" },
                  { _id: bob, display_name: "Synthetic Bob" },
                ],
                events: events.slice(page, page + 1),
                hasMore: true,
                nextCursor: `page-${page + 1}`,
              },
            };
      },
    },
  );
});

test("a fresh non-private unavailable position removes only that event's dot and connections and keeps its timeline snapshot", async () =>
  fixture(
    async (page) => {
      assert.equal(
        await page
          .locator(`line[data-from="${ev(3)}"], line[data-to="${ev(3)}"]`)
          .count(),
        1,
      );
      await page
        .locator(`.dashboard-event-dot[data-event-id="${ev(3)}"]`)
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardMapSelection")
          ?.textContent?.includes("No available location for this event."),
      );
      assert.equal(
        await page
          .locator(`.dashboard-event-dot[data-event-id="${ev(3)}"]`)
          .count(),
        0,
      );
      assert.equal(
        await page
          .locator(`line[data-from="${ev(3)}"], line[data-to="${ev(3)}"]`)
          .count(),
        0,
      );
      // Other connections are untouched.
      assert.equal(await page.locator(".dashboard-map-connection").count(), 3);
      const mark = page.locator(
        `.dashboard-timeline-mark[data-event-id="${ev(3)}"]`,
      );
      assert.equal(await mark.count(), 1);
      assert.equal(await mark.getAttribute("aria-pressed"), "true");
      assert.ok(
        !/never recorded|no location was recorded/i.test(
          await page.locator("#dashboardMapSelection").innerText(),
        ),
      );
    },
    {
      override: (url, events) =>
        url.pathname === "/api/dashboard/event" &&
        url.searchParams.get("event_id") === ev(3)
          ? {
              body: {
                users: [],
                events: [
                  {
                    ...events[2],
                    position: {
                      availability: "unavailable",
                      reason: "missing",
                    },
                  },
                ],
                hasMore: false,
              },
            }
          : undefined,
    },
  ));

test("an empty exact-event read removes that event everywhere, but a missing current subject never does", async () =>
  fixture(
    async (page) => {
      await page
        .locator(`.dashboard-event-dot[data-event-id="${ev(5)}"]`)
        .click();
      await page.waitForFunction(
        () =>
          !document
            .querySelector("#dashboardMapSelection")
            ?.textContent?.includes("Checking current event access"),
      );
      for (const selector of [
        `.dashboard-event-dot[data-event-id="${ev(5)}"]`,
        `.dashboard-timeline-mark[data-event-id="${ev(5)}"]`,
        `line[data-to="${ev(5)}"]`,
      ])
        assert.equal(await page.locator(selector).count(), 0, selector);
      assert.equal(await page.locator(".dashboard-timeline-mark").count(), 7);
      assert.match(
        await page.locator("#dashboardMapSelection").innerText(),
        /Event unavailable/,
      );
      // Event 6's subject is gone (404): the historical event and its dot remain.
      await page
        .locator(`.dashboard-event-dot[data-event-id="${ev(6)}"]`)
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardMapSelection")
          ?.textContent?.includes("Current subject activity unavailable (404)"),
      );
      assert.equal(
        await page
          .locator(`.dashboard-event-dot[data-event-id="${ev(6)}"]`)
          .count(),
        1,
      );
      assert.equal(
        await page
          .locator(`.dashboard-timeline-mark[data-event-id="${ev(6)}"]`)
          .count(),
        1,
      );
      assert.match(
        await page.locator("#dashboardMapSelection").innerText(),
        /Event location: 40\.74, -73\.94/,
      );
    },
    {
      override: (url) =>
        url.pathname === "/api/dashboard/event" &&
        url.searchParams.get("event_id") === ev(5)
          ? { body: { users: [], events: [], hasMore: false } }
          : url.pathname === "/api/dashboard/activity" &&
              url.searchParams.get("id") === id(6)
            ? { status: 404, body: { error: "REST_READ_DENIED", status: 404 } }
            : undefined,
    },
  ));

test("a late exact-event denial purges that member's dots, connections, chooser entries and timeline despite a newer selection", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  await fixture(
    async (page, { requests }) => {
      await page
        .locator(`.dashboard-event-dot[data-event-id="${ev(5)}"]`)
        .click();
      while (!requests.some((r) => r.includes(`event_id=${ev(5)}`)))
        await new Promise((r) => setTimeout(r, 20));
      // A newer selection completes while Bob's denial is still in flight.
      await page
        .locator(`.dashboard-event-dot[data-event-id="${ev(6)}"]`)
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardMapSelection")
          ?.textContent?.includes("Current subject"),
      );
      await page.locator('.dashboard-map-group[data-count="3"]').click();
      assert.equal(
        await page
          .locator(`.dashboard-map-choice[data-event-id="${ev(4)}"]`)
          .count(),
        1,
      );
      const denial = page.waitForResponse((r: any) =>
        r.url().includes(`event_id=${ev(5)}`),
      );
      release();
      await denial;
      await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
      assert.equal(
        await page
          .locator(`.dashboard-event-dot[data-member-id="${bob}"]`)
          .count(),
        0,
      );
      for (const selector of [
        `line[data-member-id="${bob}"]`,
        `.dashboard-timeline-mark[data-member-id="${bob}"]`,
        `.dashboard-map-choice[data-event-id="${ev(4)}"]`,
        `.dashboard-member-portrait[data-member-id="${bob}"]`,
      ])
        assert.equal(await page.locator(selector).count(), 0, selector);
      assert.equal(
        await page.locator('.dashboard-map-group[data-count="2"]').count(),
        1,
      );
      // The newer selection is not replaced by the late denial.
      assert.match(
        await page.locator("#dashboardMapSelection").innerText(),
        /Event location: 40\.74, -73\.94/,
      );
      assert.equal(
        await page.locator(`line[data-member-id="${ada}"]`).count(),
        3,
      );
    },
    {
      override: (url) =>
        url.pathname === "/api/dashboard/event" &&
        url.searchParams.get("event_id") === ev(5)
          ? {
              hold,
              status: 403,
              body: { error: "REST_READ_DENIED", status: 403 },
            }
          : undefined,
    },
  );
});

const pageOne = (requests: string[]) =>
  requests.filter(
    (r) =>
      r.startsWith("/api/dashboard/timeline?date=2026-09-28") &&
      !r.includes("cursor="),
  ).length;
// Settled: either every mark rendered or the timeline offers a retry.
const settled = (page: any, marks: number) =>
  page.waitForFunction(
    (count: number) =>
      document.querySelectorAll(".dashboard-timeline-mark").length === count ||
      [...document.querySelectorAll("#dashboardTimeline button")].some((b) =>
        b.textContent?.includes("Retry timeline"),
      ),
    marks,
  );
const users = [
  { _id: ada, display_name: "Synthetic Ada" },
  { _id: bob, display_name: "Synthetic Bob" },
];

test("a 409 authority change mid-pagination discards old pages and restarts from page one", async () => {
  let conflicts = 0;
  await fixture(
    async (page, { requests }) => {
      await settled(page, 8);
      assert.equal(await page.locator(".dashboard-timeline-mark").count(), 8);
      assert.equal(pageOne(requests), 2);
      assert.equal(await page.locator(".dashboard-event-dot").count(), 7);
      assert.equal(await page.locator(".dashboard-map-connection").count(), 4);
      assert.match(
        await page.locator("#dashboardMapStatus").innerText(),
        /complete day/,
      );
    },
    {
      ready: "authorized event",
      marks: null,
      override: (url, events) => {
        if (
          url.pathname !== "/api/dashboard/timeline" ||
          url.searchParams.get("date") !== "2026-09-28"
        )
          return undefined;
        if (!url.searchParams.get("cursor"))
          return {
            body: {
              users,
              events: events.slice(0, 4),
              hasMore: true,
              nextCursor: "second",
            },
          };
        if (!conflicts++)
          return {
            status: 409,
            body: { error: "REST_READ_DENIED", status: 409 },
          };
        return { body: { users, events: events.slice(4), hasMore: false } };
      },
    },
  );
});

test("a persistent 409 is bounded, shows no geometry and never claims a complete day", async () =>
  fixture(
    async (page, { requests }) => {
      await page.waitForFunction(() =>
        [...document.querySelectorAll("#dashboardTimeline button")].some((b) =>
          b.textContent?.includes("Retry timeline"),
        ),
      );
      await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
      assert.equal(pageOne(requests), 3);
      assert.equal(await page.locator(".dashboard-event-dot").count(), 0);
      const status = await page.locator("#dashboardMapStatus").innerText();
      assert.match(status, /unavailable/);
      assert.ok(!status.includes("complete day"), status);
      assert.match(
        await page.locator("#dashboardTimeline").innerText(),
        /authority changed/i,
      );
    },
    {
      ready: "authorized event",
      marks: null,
      override: (url) =>
        url.pathname === "/api/dashboard/timeline" &&
        url.searchParams.get("date") === "2026-09-28"
          ? { status: 409, body: { error: "REST_READ_DENIED", status: 409 } }
          : undefined,
    },
  ));

test("an exact-event 409 invalidates the inventory and reloads the day from page one", async () =>
  fixture(
    async (page, { requests }) => {
      assert.equal(pageOne(requests), 1);
      await page
        .locator(`.dashboard-event-dot[data-event-id="${ev(6)}"]`)
        .click();
      for (let i = 0; i < 100 && pageOne(requests) < 2; i++)
        await new Promise((r) => setTimeout(r, 30));
      assert.equal(pageOne(requests), 2);
      await page.waitForFunction(
        () =>
          document
            .querySelector("#dashboardMapStatus")
            ?.textContent?.includes("complete day") &&
          document.querySelectorAll(".dashboard-timeline-mark").length === 8,
      );
      assert.match(
        await page.locator("#dashboardMapSelection").innerText(),
        /authority changed/,
      );
      assert.equal(
        await page.locator('[aria-pressed="true"][data-event-id]').count(),
        0,
        "no selection survives the authority change",
      );
    },
    {
      override: (url) =>
        url.pathname === "/api/dashboard/event"
          ? { status: 409, body: { error: "REST_READ_DENIED", status: 409 } }
          : undefined,
    },
  ));

// Select from the timeline: the single mark, or its cluster's chooser entry.
async function selectFromTimeline(page: any, eventId: string) {
  const mark = page.locator(
    `.dashboard-timeline-mark[data-event-id="${eventId}"]`,
  );
  if (await mark.isVisible()) await mark.click();
  else {
    await page
      .locator(".dashboard-timeline-cluster")
      .evaluateAll((nodes: any[], target: string) => {
        nodes
          .find((node) => JSON.parse(node.dataset.eventIds).includes(target))
          .click();
      }, eventId);
    await page
      .locator(`.dashboard-timeline-choice[data-event-id="${eventId}"]`)
      .click();
  }
  await page.waitForFunction(() =>
    document
      .querySelector("#dashboardMapSelection")
      ?.textContent?.includes("Event access rechecked"),
  );
}
const onscreen = (page: any, eventId: string) =>
  page
    .locator(`.dashboard-event-dot[data-event-id="${eventId}"]`)
    .evaluate((node: HTMLElement) => {
      const map = document.querySelector("#dashboardMap")!;
      const x = parseFloat(node.style.left),
        y = parseFloat(node.style.top);
      return (
        !node.hidden &&
        x >= 0 &&
        y >= 0 &&
        x <= map.clientWidth &&
        y <= map.clientHeight
      );
    });

test("timeline selection pans only to an offscreen event, keeps zoom, and map selection scrolls its timeline occurrence", async () =>
  fixture(async (page) => {
    const view = () =>
      page.evaluate(() => {
        const map = (window as any).fixtureMap;
        return { ...map.getCenter(), zoom: map.getZoom() };
      });
    const fitted = await view();
    await page.evaluate(
      (zoom: number) =>
        (window as any).fixtureMap.setView([0, 0], zoom, { animate: false }),
      fitted.zoom,
    );
    assert.equal(await onscreen(page, ev(7)), false);
    await selectFromTimeline(page, ev(7));
    assert.equal(await onscreen(page, ev(7)), true);
    const panned = await view();
    assert.equal(panned.zoom, fitted.zoom, "selection never changes zoom");
    // Already visible: the view stays exactly where the user left it.
    assert.equal(await onscreen(page, ev(6)), true);
    await selectFromTimeline(page, ev(6));
    assert.deepEqual(await view(), panned);
    // Zoom the timeline far in, scroll to midnight, then pick on the map.
    for (let i = 0; i < 7; i++)
      await page.locator('[data-action="Zoom in"]').click();
    await page
      .locator(".dashboard-timeline-scroll")
      .evaluate((node: HTMLElement) => (node.scrollLeft = 0));
    await page
      .locator(`.dashboard-event-dot[data-event-id="${ev(7)}"]`)
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector("#dashboardMapSelection")
        ?.textContent?.includes("Event access rechecked"),
    );
    const visible = await page
      .locator(`.dashboard-timeline-mark[data-event-id="${ev(7)}"]`)
      .evaluate((mark: HTMLElement) => {
        const scroll = mark.closest(".dashboard-timeline-scroll")!;
        const a = mark.getBoundingClientRect(),
          b = scroll.getBoundingClientRect();
        // "nearest" may align an edge with sub-pixel overhang; require the centre.
        const centre = (a.left + a.right) / 2;
        return !mark.hidden && centre >= b.left && centre <= b.right;
      });
    assert.equal(visible, true);
  }));

test("event selection dims other members' dots and connections without hiding them; the member filter still hides", async () =>
  fixture(async (page) => {
    const look = (selector: string) =>
      page.locator(selector).evaluateAll((nodes: Element[]) =>
        nodes.map((node) => {
          const style = getComputedStyle(node);
          return {
            opacity: Number(style.opacity),
            shown: style.display !== "none",
          };
        }),
      );
    await page
      .locator(`.dashboard-event-dot[data-event-id="${ev(6)}"]`)
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector("#dashboardMapSelection")
        ?.textContent?.includes("Event access rechecked"),
    );
    // Bob's 02:00 dot sits inside the exact-coordinate group badge, so use his 03:00 dot.
    for (const selector of [
      `.dashboard-event-dot[data-event-id="${ev(5)}"]`,
      `line[data-member-id="${bob}"]`,
    ]) {
      const nodes = await look(selector);
      assert.ok(nodes.length > 0, selector);
      for (const node of nodes) {
        assert.ok(node.shown, selector);
        assert.ok(node.opacity < 0.5, `${selector} ${node.opacity}`);
      }
    }
    for (const selector of [
      `.dashboard-event-dot[data-member-id="${ada}"]`,
      `line[data-member-id="${ada}"]`,
      ".dashboard-map-group",
    ])
      for (const node of await look(selector))
        assert.equal(node.opacity, 1, selector);
    // The explicit member filter keeps its existing hide behavior.
    await page
      .locator(".dashboard-member-card", { hasText: "Synthetic Ada" })
      .click();
    for (const selector of [
      `.dashboard-event-dot[data-member-id="${bob}"]`,
      `line[data-member-id="${bob}"]`,
    ])
      for (const node of await look(selector))
        assert.equal(node.shown, false, selector);
  }));

test("a dateline-crossing connection stays a short shortest-arc segment in one world copy", async () => {
  const stamp = (hour: number) => `2026-09-28T0${hour}:00:00.000Z`;
  const events: Event[] = [
    [1, 179.9],
    [2, -179.9],
  ].map(([n, longitude]) => ({
    id: ev(n),
    user_id: ada,
    occurred_at: stamp(n),
    event_type: "workout.set_completed",
    subject: { type: "workout", id: id(n) },
    details: {},
    position: gps(10, longitude, stamp(n)),
  }));
  await fixture(
    async (page) => {
      const span = () =>
        page
          .locator(".dashboard-map-connection")
          .evaluate((line: SVGLineElement) =>
            Math.hypot(
              +line.getAttribute("x2")! - +line.getAttribute("x1")!,
              +line.getAttribute("y2")! - +line.getAttribute("y1")!,
            ),
          );
      // Fitted to the shortest arc: the segment fits inside the map.
      const mapWidth = await page
        .locator("#dashboardMap")
        .evaluate((node: HTMLElement) => node.clientWidth);
      assert.ok((await span()) < mapWidth, `fitted: ${await span()}`);
      // Centred on the opposite side of the world, the segment must not wrap.
      await page.evaluate(() =>
        (window as any).fixtureMap.setView([10, 0], 3, { animate: false }),
      );
      const width = 256 * 2 ** 3;
      assert.ok((await span()) < width * 0.01, `recentred: ${await span()}`);
    },
    { events },
  );
});

test("a 401/403 on the optional current-subject read still purges that member", async () =>
  fixture(
    async (page) => {
      const subject = page.waitForResponse((r: any) =>
        r.url().includes(`/api/dashboard/activity?id=${id(5)}`),
      );
      await page
        .locator(`.dashboard-event-dot[data-event-id="${ev(5)}"]`)
        .click();
      await subject;
      await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
      for (const selector of [
        `.dashboard-event-dot[data-member-id="${bob}"]`,
        `line[data-member-id="${bob}"]`,
        `.dashboard-timeline-mark[data-member-id="${bob}"]`,
      ])
        assert.equal(await page.locator(selector).count(), 0, selector);
      assert.match(
        await page.locator("#dashboardMapSelection").innerText(),
        /access denied \(403\)/,
      );
    },
    {
      override: (url) =>
        url.pathname === "/api/dashboard/activity" &&
        url.searchParams.get("id") === id(5)
          ? { status: 403, body: { error: "REST_READ_DENIED", status: 403 } }
          : undefined,
    },
  ));

// Serve an event list in backend-sized pages of 100 with opaque advancing cursors.
const paged =
  (size = 100): Override =>
  (url, events) => {
    if (url.pathname !== "/api/dashboard/timeline") return undefined;
    if (url.searchParams.get("date") !== "2026-09-28")
      return { body: { users: [], events: [], hasMore: false } };
    const page = Number(url.searchParams.get("cursor")?.slice(2) || 0);
    const more = (page + 1) * size < events.length;
    return {
      body: {
        users,
        events: events.slice(page * size, (page + 1) * size),
        hasMore: more,
        ...(more ? { nextCursor: `p-${page + 1}` } : {}),
      },
    };
  };
const finished = (page: any) =>
  page.waitForFunction(
    () =>
      /complete day|partial day/.test(
        document.querySelector("#dashboardMapStatus")?.textContent || "",
      ) &&
      !document
        .querySelector("#dashboardTimeline [role=status]:not([hidden])")
        ?.textContent?.includes("Loading"),
  );

test("a day beyond ten pages loads every canonical GPS event automatically and completes only at the terminal cursor", async () => {
  const start = Date.parse("2026-09-28T00:00:00.000Z");
  const events: Event[] = Array.from({ length: 1005 }, (_, i) => {
    const at = new Date(start + i * 80000).toISOString();
    return {
      id: ev(1000 + i),
      user_id: i % 2 ? bob : ada,
      occurred_at: at,
      event_type: "meal.food_added",
      subject: { type: "meal", id: id(1000 + i) },
      details: {},
      position: gps(40 + i * 0.0001, -73 - i * 0.0001, at),
    };
  });
  await fixture(
    async (page, { requests }) => {
      await finished(page);
      assert.equal(
        requests.filter((r) =>
          r.startsWith("/api/dashboard/timeline?date=2026-09-28"),
        ).length,
        11,
      );
      assert.equal(await page.locator(".dashboard-event-dot").count(), 1005);
      for (const n of [2000, 2004])
        assert.equal(
          await page
            .locator(`.dashboard-event-dot[data-event-id="${ev(n)}"]`)
            .count(),
          1,
          `newest event ${n} beyond page ten is on the map`,
        );
      assert.match(
        await page.locator("#dashboardMapStatus").innerText(),
        /complete day/,
      );
      assert.equal(
        await page.getByRole("button", { name: "Load more events" }).count(),
        0,
      );
    },
    {
      events,
      ready: "authorized events have a shared location",
      marks: null,
      override: paged(),
    },
  );
});

test("a 429 mid-pagination keeps loaded events as a partial day without connections, and retry resumes at the failed cursor", async () => {
  let limited = false;
  const pages = paged(3);
  await fixture(
    async (page, { requests }) => {
      await settled(page, 3);
      assert.equal(await page.locator(".dashboard-event-dot").count(), 3);
      assert.equal(await page.locator(".dashboard-map-connection").count(), 0);
      const status = await page.locator("#dashboardMapStatus").innerText();
      assert.match(status, /partial day/);
      assert.ok(!status.includes("complete day"), status);
      const before = requests.length;
      await page.getByRole("button", { name: "Retry timeline" }).click();
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardMapStatus")
          ?.textContent?.includes("complete day"),
      );
      const resumed = requests
        .slice(before)
        .filter((r) => r.startsWith("/api/dashboard/timeline"));
      assert.ok(resumed[0].includes("cursor=p-1"), resumed.join());
      assert.equal(await page.locator(".dashboard-event-dot").count(), 7);
      assert.equal(await page.locator(".dashboard-map-connection").count(), 4);
    },
    {
      ready: "authorized event",
      marks: null,
      override: (url, events) => {
        if (
          url.pathname === "/api/dashboard/timeline" &&
          url.searchParams.get("cursor") === "p-1" &&
          !limited
        ) {
          limited = true;
          return {
            status: 429,
            body: { error: "REST_READ_DENIED", status: 429 },
          };
        }
        return pages(url, events);
      },
    },
  );
});

const withheld = { availability: "unavailable", reason: "private" };
const adaMarks = (page: any) =>
  page.locator(`.dashboard-timeline-mark[data-member-id="${ada}"]`).count();

test("a late private exact-event 200 behind a newer other-member selection withholds all of that member's loaded GPS", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  await fixture(
    async (page, { requests }) => {
      await page.locator('.dashboard-map-group[data-count="3"]').click();
      assert.equal(await page.locator(".dashboard-map-choice").count(), 3);
      await page.keyboard.press("Escape");
      await page
        .locator(`.dashboard-event-dot[data-event-id="${ev(3)}"]`)
        .click();
      while (!requests.some((r) => r.includes(`event_id=${ev(3)}`)))
        await new Promise((r) => setTimeout(r, 20));
      await page
        .locator(`.dashboard-event-dot[data-event-id="${ev(5)}"]`)
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardMapSelection")
          ?.textContent?.includes("Current subject"),
      );
      await page.locator('.dashboard-map-group[data-count="3"]').click();
      const late = page.waitForResponse((r: any) =>
        r.url().includes(`event_id=${ev(3)}`),
      );
      release();
      await late;
      await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
      for (const selector of [
        `.dashboard-event-dot[data-member-id="${ada}"]`,
        `line[data-member-id="${ada}"]`,
        ".dashboard-map-choice",
        ".dashboard-map-group:not([hidden])",
      ])
        assert.equal(await page.locator(selector).count(), 0, selector);
      assert.equal(
        await page.locator(".dashboard-map-chooser:not([hidden])").count(),
        0,
      );
      // Position withheld is not history denial: every Ada occurrence remains.
      assert.equal(await adaMarks(page), 6);
      // The unrelated member keeps its authorized GPS and connection.
      assert.equal(
        await page
          .locator(`.dashboard-event-dot[data-member-id="${bob}"]`)
          .count(),
        2,
      );
      assert.equal(
        await page.locator(`line[data-member-id="${bob}"]`).count(),
        1,
      );
      assert.match(
        await page.locator("#dashboardMapSelection").innerText(),
        /Event location: 40\.73, -73\.91/,
      );
    },
    {
      override: (url, events) =>
        url.pathname === "/api/dashboard/event" &&
        url.searchParams.get("event_id") === ev(3)
          ? {
              hold,
              body: {
                users,
                events: [{ ...events[2], position: withheld }],
                hasMore: false,
              },
            }
          : undefined,
    },
  );
});

test("a late private read behind a newer same-member selection also withdraws the shown location", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  await fixture(
    async (page, { requests }) => {
      await page
        .locator(`.dashboard-event-dot[data-event-id="${ev(3)}"]`)
        .click();
      while (!requests.some((r) => r.includes(`event_id=${ev(3)}`)))
        await new Promise((r) => setTimeout(r, 20));
      await page
        .locator(`.dashboard-event-dot[data-event-id="${ev(6)}"]`)
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardMapSelection")
          ?.textContent?.includes("Event location: 40.74"),
      );
      const late = page.waitForResponse((r: any) =>
        r.url().includes(`event_id=${ev(3)}`),
      );
      release();
      await late;
      await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
      assert.equal(
        await page
          .locator(`.dashboard-event-dot[data-member-id="${ada}"]`)
          .count(),
        0,
      );
      const detail = await page.locator("#dashboardMapSelection").innerText();
      assert.ok(!detail.includes("40.74"), detail);
      assert.match(detail, /No shared location for this event\./);
      assert.equal(await adaMarks(page), 6);
    },
    {
      override: (url, events) =>
        url.pathname === "/api/dashboard/event" &&
        url.searchParams.get("event_id") === ev(3)
          ? {
              hold,
              body: {
                users,
                events: [{ ...events[2], position: withheld }],
                hasMore: false,
              },
            }
          : undefined,
    },
  );
});

test("a private read from an earlier date never redacts the new day, and a fresh reload restores authorized GPS", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  // The next day carries the same members at shifted times with fresh event IDs.
  const nextDay = ledger().map((event, i) => ({
    ...event,
    id: ev(100 + i),
    occurred_at: event.occurred_at.replace("2026-09-28", "2026-09-29"),
  }));
  let privateDay = true;
  const change = (page: any, date: string) =>
    page.evaluate((value: string) => {
      const input =
        document.querySelector<HTMLInputElement>("#dashboardMapDate")!;
      input.value = value;
      input.dispatchEvent(new Event("change"));
    }, date);
  await fixture(
    async (page, { requests }) => {
      await page
        .locator(`.dashboard-event-dot[data-event-id="${ev(3)}"]`)
        .click();
      while (!requests.some((r) => r.includes(`event_id=${ev(3)}`)))
        await new Promise((r) => setTimeout(r, 20));
      await change(page, "2026-09-29");
      await page.waitForFunction(
        (id: string) =>
          !!document.querySelector(
            `.dashboard-event-dot[data-event-id="${id}"]`,
          ) &&
          document
            .querySelector("#dashboardMapStatus")
            ?.textContent?.includes("complete day"),
        ev(100),
      );
      const late = page.waitForResponse((r: any) =>
        r.url().includes(`event_id=${ev(3)}`),
      );
      release();
      await late;
      await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
      assert.equal(
        await page
          .locator(`.dashboard-event-dot[data-member-id="${ada}"]`)
          .count(),
        5,
        "the stale-date private read cannot redact the new day",
      );
      // Withhold on the original day, then reload it with authority regranted.
      await change(page, "2026-09-28");
      await page.waitForFunction(
        () =>
          document
            .querySelector("#dashboardMapStatus")
            ?.textContent?.includes("complete day") &&
          document.querySelectorAll(".dashboard-timeline-mark").length === 8,
      );
      await page
        .locator(`.dashboard-event-dot[data-event-id="${ev(3)}"]`)
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardMapSelection")
          ?.textContent?.includes("No shared location for this event."),
      );
      assert.equal(
        await page
          .locator(`.dashboard-event-dot[data-member-id="${ada}"]`)
          .count(),
        0,
      );
      privateDay = false;
      await change(page, "2026-09-29");
      await page.waitForFunction(
        () =>
          document
            .querySelector("#dashboardMapStatus")
            ?.textContent?.includes("complete day") &&
          document.querySelectorAll(".dashboard-timeline-mark").length === 8,
      );
      await change(page, "2026-09-28");
      await page.waitForFunction(
        (id: string) =>
          !!document.querySelector(
            `.dashboard-event-dot[data-event-id="${id}"]`,
          ),
        ev(3),
      );
      assert.equal(
        await page
          .locator(`.dashboard-event-dot[data-member-id="${ada}"]`)
          .count(),
        5,
        "a fresh authorized reload restores Ada's recorded GPS",
      );
    },
    {
      override: (url, events) => {
        if (
          url.pathname === "/api/dashboard/timeline" &&
          url.searchParams.get("date") === "2026-09-29"
        )
          return { body: { users, events: nextDay, hasMore: false } };
        if (
          url.pathname === "/api/dashboard/event" &&
          url.searchParams.get("event_id") === ev(3) &&
          privateDay
        )
          return {
            hold: hold,
            body: {
              users,
              events: [{ ...events[2], position: withheld }],
              hasMore: false,
            },
          };
        return undefined;
      },
    },
  );
});

const unavailable = { users: [], events: [], hasMore: false };

test("a late empty exact-event read behind a newer other-member selection removes that event and its segments only", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  await fixture(
    async (page, { requests }) => {
      await page
        .locator(`.dashboard-event-dot[data-event-id="${ev(3)}"]`)
        .click();
      while (!requests.some((r) => r.includes(`event_id=${ev(3)}`)))
        await new Promise((r) => setTimeout(r, 20));
      await page
        .locator(`.dashboard-event-dot[data-event-id="${ev(5)}"]`)
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardMapSelection")
          ?.textContent?.includes("Current subject"),
      );
      const late = page.waitForResponse((r: any) =>
        r.url().includes(`event_id=${ev(3)}`),
      );
      release();
      await late;
      await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
      for (const selector of [
        `.dashboard-event-dot[data-event-id="${ev(3)}"]`,
        `.dashboard-timeline-mark[data-event-id="${ev(3)}"]`,
        `line[data-from="${ev(3)}"]`,
        `line[data-to="${ev(3)}"]`,
      ])
        assert.equal(await page.locator(selector).count(), 0, selector);
      assert.equal(await page.locator(".dashboard-timeline-mark").count(), 7);
      // Ada keeps 1→2 and 6→7; the private event 8 still breaks the order.
      assert.equal(
        await page.locator(`line[data-member-id="${ada}"]`).count(),
        2,
      );
      assert.equal(
        await page.locator(`line[data-member-id="${bob}"]`).count(),
        1,
      );
      // The newer selection is untouched.
      const detail = await page.locator("#dashboardMapSelection").innerText();
      assert.match(detail, /Event location: 40\.73, -73\.91/);
      assert.ok(!detail.includes("Event unavailable"), detail);
      assert.equal(
        await page
          .locator(`.dashboard-event-dot[data-event-id="${ev(5)}"]`)
          .getAttribute("aria-pressed"),
        "true",
      );
    },
    {
      override: (url) =>
        url.pathname === "/api/dashboard/event" &&
        url.searchParams.get("event_id") === ev(3)
          ? { hold, body: unavailable }
          : undefined,
    },
  );
});

test("a late exact-event 404 from an earlier ledger generation never removes the reloaded event", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  await fixture(
    async (page, { requests }) => {
      await page
        .locator(`.dashboard-event-dot[data-event-id="${ev(3)}"]`)
        .click();
      while (!requests.some((r) => r.includes(`event_id=${ev(3)}`)))
        await new Promise((r) => setTimeout(r, 20));
      const before = pageOne(requests);
      // Reload the same date: a new ledger generation with fresh authority.
      await page.evaluate(() =>
        document
          .querySelector("#dashboardMapDate")!
          .dispatchEvent(new Event("change")),
      );
      await page.waitForFunction(
        () =>
          document
            .querySelector("#dashboardMapStatus")
            ?.textContent?.includes("complete day") &&
          document.querySelectorAll(".dashboard-timeline-mark").length === 8,
      );
      assert.ok(pageOne(requests) > before);
      const late = page.waitForResponse((r: any) =>
        r.url().includes(`event_id=${ev(3)}`),
      );
      release();
      await late;
      await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
      for (const selector of [
        `.dashboard-event-dot[data-event-id="${ev(3)}"]`,
        `.dashboard-timeline-mark[data-event-id="${ev(3)}"]`,
      ])
        assert.equal(await page.locator(selector).count(), 1, selector);
      assert.equal(
        await page.locator(`line[data-member-id="${ada}"]`).count(),
        3,
      );
    },
    {
      override: (url) =>
        url.pathname === "/api/dashboard/event" &&
        url.searchParams.get("event_id") === ev(3)
          ? {
              hold,
              status: 404,
              body: { error: "REST_READ_DENIED", status: 404 },
            }
          : undefined,
    },
  );
});

// Partial day: page one (events 1–3) loads, page two is rate-limited once.
const partial = (resume: Override): Override => {
  let limited = false;
  const pages = paged(3);
  return (url, events) => {
    if (url.pathname !== "/api/dashboard/timeline") return undefined;
    if (
      url.pathname === "/api/dashboard/timeline" &&
      url.searchParams.get("cursor") === "p-1"
    ) {
      if (!limited) {
        limited = true;
        return {
          status: 429,
          body: { error: "REST_READ_DENIED", status: 429 },
        };
      }
      return resume(url, events) || pages(url, events);
    }
    return pages(url, events) || resume(url, events);
  };
};
const retry = async (page: any, requests: string[]) => {
  await settled(page, 3);
  const before = requests.length;
  await page.getByRole("button", { name: "Retry timeline" }).click();
  const deadline = Date.now() + 5000;
  while (!requests.slice(before).some((r) => r.includes("cursor=p-1"))) {
    assert.ok(Date.now() < deadline, JSON.stringify(requests));
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("a 403 on a resumed page clears the shared ledger's GPS and kills stale map handlers", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  await fixture(
    async (page, { requests }) => {
      await settled(page, 3);
      assert.equal(await page.locator(".dashboard-event-dot").count(), 3);
      await page.evaluate(() => {
        (window as any).staleDot = document.querySelector(
          ".dashboard-event-dot",
        );
        (window as any).staleGroup = document.querySelector(
          ".dashboard-map-group",
        );
      });
      await retry(page, requests);
      const denial = page.waitForResponse((r: any) =>
        r.url().includes("cursor=p-1"),
      );
      release();
      await denial;
      await page.getByText("Timeline unavailable (403); try again.").waitFor();
      for (const selector of [
        ".dashboard-event-dot",
        ".dashboard-map-connection",
        ".dashboard-map-group",
        ".dashboard-map-choice",
        ".dashboard-timeline-mark",
      ])
        assert.equal(await page.locator(selector).count(), 0, selector);
      assert.equal(
        await page.locator("#dashboardMapSelection").innerText(),
        "",
      );
      const before = requests.length;
      await page.evaluate(() => {
        (window as any).staleDot.click();
        (window as any).staleGroup?.click();
      });
      await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
      assert.deepEqual(
        requests
          .slice(before)
          .filter((r) => r.includes("/api/dashboard/event")),
        [],
      );
      assert.equal(await page.locator(".dashboard-map-choice").count(), 0);
      assert.equal(
        await page.locator("#dashboardMapSelection").innerText(),
        "",
      );
      assert.doesNotMatch(
        await page.locator("#dashboardMapStatus").innerText(),
        /[1-9]\d* of \d+ authorized events have a shared location/,
      );
    },
    {
      ready: "partial day",
      marks: null,
      override: partial(() => ({
        hold,
        status: 403,
        body: { error: "REST_READ_DENIED", status: 403 },
      })),
    },
  );
});

test("a failed same-date reload keeps a Position withdrawal: retained rows never show old coordinates", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  let unavailable503 = false;
  await fixture(
    async (page, { requests }) => {
      await page
        .locator(`.dashboard-event-dot[data-event-id="${ev(3)}"]`)
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardMapSelection")
          ?.textContent?.includes("No shared location for this event."),
      );
      assert.equal(
        await page
          .locator(`.dashboard-event-dot[data-member-id="${ada}"]`)
          .count(),
        0,
      );
      // Same-date reload; page one is transiently unavailable.
      unavailable503 = true;
      await page.evaluate(() =>
        document
          .querySelector("#dashboardMapDate")!
          .dispatchEvent(new Event("change")),
      );
      await page.getByText("Timeline unavailable (503); try again.").waitFor();
      // Select another retained Ada occurrence while its exact read is held.
      const before = requests.length;
      await page.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          ),
      );
      const cluster = await page
        .locator(".dashboard-timeline-cluster")
        .evaluateAll(
          (nodes: any[], target: string) =>
            nodes.findIndex((n) =>
              JSON.parse(n.dataset.eventIds).includes(target),
            ),
          ev(6),
        );
      if (cluster >= 0) {
        await page.locator(".dashboard-timeline-cluster").nth(cluster).focus();
        await page.keyboard.press("Enter");
        await page
          .locator(`.dashboard-timeline-choice[data-event-id="${ev(6)}"]`)
          .focus();
      } else
        await page
          .locator(`.dashboard-timeline-mark[data-event-id="${ev(6)}"]`)
          .focus();
      await page.keyboard.press("Enter");
      while (
        !requests.slice(before).some((r) => r.includes(`event_id=${ev(6)}`))
      )
        await new Promise((r) => setTimeout(r, 20));
      const held = await page.locator("#dashboardMapSelection").innerText();
      assert.ok(!held.includes("40.74"), held);
      assert.match(held, /No shared location for this event\./);
      assert.equal(
        await page
          .locator(`.dashboard-event-dot[data-member-id="${ada}"]`)
          .count(),
        0,
      );
      release();
      await page.waitForFunction(
        () =>
          !document
            .querySelector("#dashboardMapSelection")
            ?.textContent?.includes("Checking current event access"),
      );
      const after = await page.locator("#dashboardMapSelection").innerText();
      assert.ok(!after.includes("40.74"), after);
      assert.equal(
        await page
          .locator(`.dashboard-event-dot[data-member-id="${ada}"]`)
          .count(),
        0,
      );
    },
    {
      override: (url, events) => {
        if (url.pathname === "/api/dashboard/timeline" && unavailable503)
          return {
            status: 503,
            body: { error: "REST_READ_UNAVAILABLE", status: 503 },
          };
        if (url.pathname !== "/api/dashboard/event") return undefined;
        const n = url.searchParams.get("event_id");
        if (n === ev(3))
          return {
            body: {
              users,
              events: [{ ...events[2], position: withheld }],
              hasMore: false,
            },
          };
        if (n === ev(6))
          return {
            hold,
            body: { users, events: [events[5]], hasMore: false },
          };
        return undefined;
      },
    },
  );
});

for (const [name, correction] of [
  ["an empty exact read removes the event", "empty"],
  ["a non-private unavailable exact read redacts its GPS", "missing"],
] as const)
  test(`a held resumed page cannot overwrite a concurrent correction: ${name}`, async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const flow = partial((u, e) =>
      u.pathname === "/api/dashboard/timeline"
        ? { hold, ...paged(3)(u, e)! }
        : undefined,
    );
    await fixture(
      async (page, { requests }) => {
        await retry(page, requests);
        await page.locator(".dashboard-map-group").focus();
        await page.keyboard.press("Enter");
        await page
          .locator(`.dashboard-map-choice[data-event-id="${ev(2)}"]`)
          .focus();
        await page.keyboard.press("Enter");
        await page.waitForFunction(
          () =>
            !document
              .querySelector("#dashboardMapSelection")
              ?.textContent?.includes("Checking current event access"),
        );
        assert.equal(
          await page
            .locator(`.dashboard-event-dot[data-event-id="${ev(2)}"]`)
            .count(),
          0,
        );
        release();
        await page.waitForFunction(() =>
          document
            .querySelector("#dashboardMapStatus")
            ?.textContent?.includes("complete day"),
        );
        await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
        assert.equal(
          await page
            .locator(`.dashboard-event-dot[data-event-id="${ev(2)}"]`)
            .count(),
          0,
          "the resumed page does not resurrect the corrected event's GPS",
        );
        assert.equal(
          (await page.locator(`line[data-to="${ev(2)}"]`).count()) +
            (await page.locator(`line[data-from="${ev(2)}"]`).count()),
          0,
        );
        assert.equal(
          await page
            .locator(`.dashboard-timeline-mark[data-event-id="${ev(2)}"]`)
            .count(),
          correction === "empty" ? 0 : 1,
        );
        assert.equal(
          await page.locator(".dashboard-timeline-mark").count(),
          correction === "empty" ? 7 : 8,
        );
      },
      {
        ready: "partial day",
        marks: null,
        override: (url, events) => {
          if (
            url.pathname === "/api/dashboard/event" &&
            url.searchParams.get("event_id") === ev(2)
          )
            return {
              body:
                correction === "empty"
                  ? { users: [], events: [], hasMore: false }
                  : {
                      users,
                      events: [
                        {
                          ...events[1],
                          position: {
                            availability: "unavailable",
                            reason: "missing",
                          },
                        },
                      ],
                      hasMore: false,
                    },
            };
          return flow(url, events);
        },
      },
    );
  });

test("a private Position in the day stream suppresses all member GPS and a fresh authorized reload regrants", async () => {
  let privateRead = true;
  await fixture(
    async (page) => {
      assert.equal(
        await page
          .locator(`.dashboard-event-dot[data-member-id="${ada}"]`)
          .count(),
        0,
      );
      assert.equal(
        await page.locator(`line[data-member-id="${ada}"]`).count(),
        0,
      );
      assert.equal(
        await page
          .locator(`.dashboard-timeline-mark[data-member-id="${ada}"]`)
          .count(),
        6,
      );
      await selectFromTimeline(page, ev(3));
      assert.match(
        await page.locator("#dashboardMapSelection").innerText(),
        /No shared location/,
      );
      privateRead = false;
      await page.evaluate(() =>
        document
          .querySelector("#dashboardMapDate")!
          .dispatchEvent(new Event("change")),
      );
      await page.waitForFunction(
        () =>
          document.querySelectorAll(
            '.dashboard-event-dot[data-member-id="aaaaaaaaaaaaaaaaaaaaaaaa"]',
          ).length === 5,
      );
    },
    {
      override: (url, events) =>
        url.pathname === "/api/dashboard/timeline"
          ? {
              body: {
                users,
                events: events.map((e) =>
                  e.id === ev(8) && privateRead
                    ? { ...e, position: withheld }
                    : e,
                ),
                hasMore: false,
              },
            }
          : undefined,
    },
  );
});

test("ordinary pointer selection can reopen the exact co-location chooser after selecting a point", async () =>
  fixture(async (page) => {
    const group = page.locator('.dashboard-map-group[data-count="3"]');
    await group.click();
    await page
      .locator(`.dashboard-map-choice[data-event-id="${ev(2)}"]`)
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector("#dashboardMapSelection")
        ?.textContent?.includes("Event access rechecked"),
    );
    await group.click({ timeout: 3000 });
    await page
      .locator(`.dashboard-map-choice[data-event-id="${ev(1)}"]`)
      .click();
    assert.equal(
      await page
        .locator('.dashboard-event-dot[aria-pressed="true"]')
        .getAttribute("data-event-id"),
      ev(1),
    );
    assert.ok(exact(await offset(group, 40.7, -73.9)));
  }));

test("map selection reconciles a category filter while preserving timeline and map zoom", async () =>
  fixture(async (page) => {
    await page
      .locator('.dashboard-timeline-legend button[data-category="metric"]')
      .click();
    await page
      .locator("#dashboardTimeline")
      .getByRole("button", { name: "Zoom in", exact: true })
      .click();
    await page
      .locator("#dashboardTimeline")
      .getByRole("button", { name: "Zoom in", exact: true })
      .click();
    const before = await page.evaluate(() => ({
      width: document.querySelector<HTMLElement>(".dashboard-timeline-track")!
        .style.width,
      zoom: (window as any).fixtureMap.getZoom(),
      center: (window as any).fixtureMap.getCenter(),
    }));
    await page
      .locator(".dashboard-timeline-scroll")
      .evaluate((n: HTMLElement) => (n.scrollLeft = n.scrollWidth));
    await page
      .locator(`.dashboard-event-dot[data-event-id="${ev(7)}"]`)
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector("#dashboardMapSelection")
        ?.textContent?.includes("Event access rechecked"),
    );
    const mark = page.locator(
      `.dashboard-timeline-mark[data-event-id="${ev(7)}"]`,
    );
    assert.equal(await mark.isVisible(), true);
    assert.equal(await mark.getAttribute("aria-pressed"), "true");
    assert.equal(
      await page
        .locator('.dashboard-timeline-legend button[data-category=""]')
        .getAttribute("aria-pressed"),
      "true",
    );
    const after = await page.evaluate(() => ({
      width: document.querySelector<HTMLElement>(".dashboard-timeline-track")!
        .style.width,
      zoom: (window as any).fixtureMap.getZoom(),
      center: (window as any).fixtureMap.getCenter(),
    }));
    assert.deepEqual(after, before);
    const visible = await mark.evaluate((n: HTMLElement) => {
      const a = n.getBoundingClientRect(),
        b = n.closest(".dashboard-timeline-scroll")!.getBoundingClientRect();
      return a.left >= b.left && a.right <= b.right;
    });
    assert.ok(visible);
  }));

test("a private resumed page scrubs an open selected location before a late positive exact read", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let publishPage!: () => void;
  const pageHold = new Promise<void>((r) => (publishPage = r));
  const pages = partial((u, e) => ({
    hold: pageHold,
    body: {
      users,
      events: e
        .slice(3)
        .map((x) => (x.id === ev(8) ? { ...x, position: withheld } : x)),
      hasMore: false,
    },
  }));
  await fixture(
    async (page, { requests }) => {
      await retry(page, requests);
      await page
        .locator(`.dashboard-event-dot[data-event-id="${ev(3)}"]`)
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardMapSelection")
          ?.textContent?.includes("Checking current event access"),
      );
      assert.match(
        await page.locator("#dashboardMapSelection").innerText(),
        /40.72/,
      );
      publishPage();
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardMapStatus")
          ?.textContent?.includes("complete day"),
      );
      assert.equal(
        await page
          .locator(`.dashboard-event-dot[data-member-id="${ada}"]`)
          .count(),
        0,
      );
      assert.equal(
        await page
          .locator(`.dashboard-timeline-mark[data-member-id="${ada}"]`)
          .count(),
        6,
      );
      const text = await page.locator("#dashboardMapSelection").innerText();
      assert.match(text, /No shared location/);
      assert.doesNotMatch(text, /40\.72|73\.92|8 m/);
      release();
      await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
      assert.doesNotMatch(
        await page.locator("#dashboardMapSelection").innerText(),
        /40\.72|73\.92|8 m/,
      );
    },
    {
      ready: "partial day",
      marks: null,
      override: (u, e) =>
        u.pathname === "/api/dashboard/event"
          ? { hold, body: { users, events: [e[2]], hasMore: false } }
          : pages(u, e),
    },
  );
});

for (const deniedStatus of [401, 403])
  test(`resumed ${deniedStatus} fences a held positive exact read`, async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const flow = partial(() => ({
      status: deniedStatus,
      body: { error: "denied" },
    }));
    await fixture(
      async (page, { requests }) => {
        await page
          .locator(`.dashboard-event-dot[data-event-id="${ev(3)}"]`)
          .click();
        await page.waitForFunction(() =>
          document
            .querySelector("#dashboardMapSelection")
            ?.textContent?.includes("Checking current event access"),
        );
        await retry(page, requests);
        await page
          .getByText(`Timeline unavailable (${deniedStatus}); try again.`)
          .waitFor();
        release();
        await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
        for (const selector of [
          ".dashboard-event-dot",
          ".dashboard-map-choice",
          ".dashboard-map-connection",
          ".dashboard-timeline-mark",
        ])
          assert.equal(await page.locator(selector).count(), 0);
        assert.equal(
          await page.locator("#dashboardMapSelection").innerText(),
          "",
        );
      },
      {
        ready: "partial day",
        marks: null,
        override: (u, e) =>
          u.pathname === "/api/dashboard/event"
            ? { hold, body: { users, events: [e[2]], hasMore: false } }
            : partialDenial(u, e),
      },
    );
    function partialDenial(u: URL, e: Event[]) {
      return flow(u, e);
    }
  });
