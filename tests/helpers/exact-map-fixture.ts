import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

export const ada = "aaaaaaaaaaaaaaaaaaaaaaaa",
  bob = "bbbbbbbbbbbbbbbbbbbbbbbb";
export const id = (n: number) => n.toString(16).padStart(24, "0");
export const ev = (n: number) => "e" + n.toString(16).padStart(23, "0");
export const gps = (latitude: number, longitude: number, at: string) => ({
  availability: "available",
  latitude,
  longitude,
  accuracy: 8,
  captured_at: at,
  source: "gps",
});

export type Override = (
  url: URL,
  events: Event[],
) => { status?: number; body?: unknown; hold?: Promise<unknown> } | undefined;

export type Event = {
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
export function ledger(): Event[] {
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
      position: { availability: "unavailable", reason: "missing" },
    },
  ];
}

export async function fixture(
  run: (
    page: any,
    state: { requests: string[]; events: Event[] },
  ) => Promise<void>,
  options: {
    events?: Event[];
    date?: string;
    now?: string;
    document?: boolean;
    timezone?: string;
    leaflet?: boolean;
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
      if (options.document) {
        const html = await readFile(
          new URL("../../ui/index.html", import.meta.url),
          "utf8",
        );
        res.end(
          html.replace(/<script[\s\S]*?<\/script>/g, "") +
            '<script src="/leaflet.js"></script><script>const original=L.map;L.map=(...args)=>window.fixtureMap=original(...args)</script><script src="/dashboard.js"></script>',
        );
        return;
      }
      res.end(
        `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/leaflet.css"><section id="dashboardPanel"><input id="dashboardMapDate" type="date"><p id="dashboardMapStatus" role="status"></p><div class="dashboard-map-layout"><div class="dashboard-map-column"><div id="dashboardMap" class="dashboard-map"></div><section id="dashboardTimeline" class="dashboard-timeline"></section></div><aside id="dashboardMapSelection" class="dashboard-map-selection"></aside></div><h3 id="dashboardMemberHeading"></h3><div id="dashboardMemberCards"></div><p id="dashboardStatus"></p><div id="dashboardCoverage"></div><div id="dashboardRoster"></div><div id="dashboardCharts"></div></section>${options.leaflet === false ? "" : '<script src="/leaflet.js"></script><script>const original=L.map;L.map=(...args)=>window.fixtureMap=original(...args)</script>'}<script src="/dashboard.js"></script>`,
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
              ? `../../node_modules/leaflet/dist${url.pathname}`
              : `../../ui${url.pathname}`,
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
      timezoneId: options.timezone || "UTC",
    });
    await page.addInitScript("window.__name = (value) => value");
    await page.clock.setFixedTime(
      new Date(options.now || "2026-12-01T12:00:00Z"),
    );
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
    await page.evaluate(async (date: string) => {
      if (document.getElementById("studio")) {
        document.getElementById("studio")!.hidden = false;
        document.getElementById("login")!.hidden = true;
      }
      await (window as any).CoachDashboard.load(null, "synthetic");
      const input =
        document.querySelector<HTMLInputElement>("#dashboardMapDate")!;
      input.value = date;
      input.dispatchEvent(new Event("change"));
    }, options.date || "2026-09-28");
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
    // A deliberately held response must never keep the server open.
    server.closeAllConnections();
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
}
