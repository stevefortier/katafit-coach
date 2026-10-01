import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const ada = "aaaaaaaaaaaaaaaaaaaaaaaa",
  bob = "bbbbbbbbbbbbbbbbbbbbbbbb";
const id = (n: number) => n.toString(16).padStart(24, "0");
const ev = (n: number) => "e" + n.toString(16).padStart(23, "0");
const gps = (latitude: number, longitude: number, at: string) => ({
  availability: "available",
  latitude,
  longitude,
  accuracy: 8,
  captured_at: at,
  source: "gps",
});

type Override = (
  url: URL,
  events: Event[],
) => { status?: number; body?: unknown; hold?: Promise<unknown> } | undefined;

type Event = {
  id: string;
  user_id: string;
  occurred_at: string;
  event_type: string;
  subject: { type: string; id: string };
  details: Record<string, unknown>;
  position?: Record<string, unknown>;
};

// Canonical ledger events: the map must use each event's own recorded position,
// never a subject activity's current coordinates or creation time.
function ledger(): Event[] {
  const at = (hour: number, minute = 0) =>
    `2026-09-28T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
  const row = (
    n: number,
    user: string,
    stamp: string,
    type: string,
    subject: number,
    position?: [number, number],
  ): Event => ({
    id: ev(n),
    user_id: user,
    occurred_at: stamp,
    event_type: type,
    subject: { type: type.split(".")[0], id: id(subject) },
    details: {},
    ...(position ? { position: gps(position[0], position[1], stamp) } : {}),
  });
  return [
    row(1, ada, at(1), "workout.set_completed", 1, [40.7, -73.9]),
    row(2, ada, at(2), "meal.food_added", 2, [40.7, -73.9]),
    row(3, ada, at(3), "metric.recorded", 3, [40.72, -73.92]),
    row(4, bob, at(2), "workout.set_completed", 4, [40.7, -73.9]),
    row(5, bob, at(3), "media.uploaded", 5, [40.73, -73.91]),
    row(6, ada, at(5), "meal.food_added", 6, [40.74, -73.94]),
    // Same subject as event 1, later and elsewhere: a separate map event.
    row(7, ada, at(6), "workout.set_completed", 1, [40.75, -73.95]),
    {
      ...row(8, ada, at(4), "survey.completed", 8),
      position: { availability: "unavailable", reason: "private" },
    },
  ];
}

async function fixture(
  run: (
    page: any,
    state: { requests: string[]; events: Event[] },
  ) => Promise<void>,
  options: {
    events?: Event[];
    viewport?: { width: number; height: number };
    // Per-test API responses; undefined falls through to the default ledger.
    override?: Override;
    ready?: string;
    // Wait for this many timeline marks; null skips (failure-path tests).
    marks?: number | null;
  } = {},
) {
  const events = options.events || ledger();
  const users = [
    { _id: ada, display_name: "Synthetic Ada" },
    { _id: bob, display_name: "Synthetic Bob" },
  ];
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    requests.push(url.pathname + url.search);
    res.setHeader("content-type", "application/json");
    const custom = url.pathname.startsWith("/api/")
      ? options.override?.(url, events)
      : undefined;
    if (custom) {
      await custom.hold;
      res.writeHead(custom.status || 200);
      res.end(JSON.stringify(custom.body ?? {}));
    } else if (url.pathname === "/") {
      res.setHeader("content-type", "text/html");
      res.end(
        `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/leaflet.css"><section id="dashboardPanel"><input id="dashboardMapDate" type="date"><p id="dashboardMapStatus" role="status"></p><div class="dashboard-map-layout"><div class="dashboard-map-column"><div id="dashboardMap" class="dashboard-map"></div><section id="dashboardTimeline" class="dashboard-timeline"></section></div><aside id="dashboardMapSelection" class="dashboard-map-selection"></aside></div><h3 id="dashboardMemberHeading"></h3><div id="dashboardMemberCards"></div><p id="dashboardStatus"></p><div id="dashboardCoverage"></div><div id="dashboardRoster"></div><div id="dashboardCharts"></div></section><script src="/leaflet.js"></script><script>const original=L.map;L.map=(...args)=>window.fixtureMap=original(...args)</script><script src="/dashboard.js"></script>`,
      );
    } else if (
      ["/leaflet.js", "/leaflet.css", "/dashboard.js", "/style.css"].includes(
        url.pathname,
      )
    ) {
      res.setHeader(
        "content-type",
        url.pathname.endsWith("css") ? "text/css" : "text/javascript",
      );
      res.end(
        await readFile(
          new URL(
            url.pathname.startsWith("/leaflet")
              ? `../node_modules/leaflet/dist${url.pathname}`
              : `../ui${url.pathname}`,
            import.meta.url,
          ),
        ),
      );
    } else if (url.pathname === "/api/dashboard/timeline")
      res.end(JSON.stringify({ users, events, hasMore: false }));
    else if (url.pathname === "/api/dashboard/event") {
      const event = events.find(
        (e) => e.id === url.searchParams.get("event_id"),
      );
      res.end(
        JSON.stringify({ users, events: event ? [event] : [], hasMore: false }),
      );
    } else if (url.pathname === "/api/dashboard/members")
      res.end(JSON.stringify({ members: users }));
    else if (url.pathname === "/api/dashboard/activity") {
      // Current subject state differs from the ledger: another day, moved GPS.
      const subject = url.searchParams.get("id")!;
      const event = events.find((e) => e.subject.id === subject);
      res.end(
        JSON.stringify({
          owner: { _id: event?.user_id || ada },
          activity: {
            _id: subject,
            user_id: event?.user_id || ada,
            type: event?.subject.type || "workout",
            status: "complete",
            name: `Current subject ${subject.slice(-1)}`,
            created_at: "2026-09-20T09:00:00.000Z",
            position: { latitude: 10, longitude: 10 },
          },
        }),
      );
    } else if (url.pathname === "/api/dashboard/map")
      res.end(
        JSON.stringify({
          users,
          activities: [
            {
              _id: id(1),
              user_id: ada,
              type: "workout",
              status: "complete",
              created_at: "2026-09-28T01:00:00.000Z",
              position: { latitude: 10, longitude: 10 },
            },
          ],
          hasMore: false,
        }),
      );
    else res.end(JSON.stringify({ users: [], activities: [], hasMore: false }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage({
      viewport: options.viewport || { width: 1440, height: 1000 },
      timezoneId: "UTC",
    });
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.route("https://tile.openstreetmap.org/**", (r: any) =>
      r.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
          "base64",
        ),
      }),
    );
    await page.goto(`http://127.0.0.1:${(server.address() as any).port}`);
    await page.evaluate(async () => {
      await (window as any).CoachDashboard.load(null, "synthetic");
      const input =
        document.querySelector<HTMLInputElement>("#dashboardMapDate")!;
      input.value = "2026-09-28";
      input.dispatchEvent(new Event("change"));
    });
    await page.waitForFunction(
      (ready: string) =>
        document
          .querySelector("#dashboardMapStatus")
          ?.textContent?.includes(ready),
      options.ready || "complete day",
    );
    if (options.marks !== null)
      await page.waitForFunction(
        (count: number) =>
          document.querySelectorAll(".dashboard-timeline-mark").length ===
          count,
        options.marks ?? events.length,
      );
    await run(page, { requests, events });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
}

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
      assert.match(
        await page.locator(".dashboard-map-note").innerText(),
        /not live tracking.*not a travelled route.*4 hours/s,
      );
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
