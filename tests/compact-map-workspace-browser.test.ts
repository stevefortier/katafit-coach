import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fixture, ledger } from "./helpers/exact-map-fixture.js";

test("served timeline omits the visible/loaded count row", async () => {
  await fixture(
    async (page) => {
      assert.equal(await page.locator(".dashboard-timeline-mark").count(), 8);
      assert.equal(await page.locator(".dashboard-timeline-count").count(), 0);
      assert.doesNotMatch(
        await page.locator("#dashboardTimeline").innerText(),
        /visible · .*loaded events/,
      );
    },
    { document: true },
  );
});

for (const width of [320, 390, 760, 1440]) {
  test(`compact track keeps ruler, hit targets and Now in separate bands at ${width}px`, async () => {
    await fixture(
      async (page) => {
        const geometry = await page.evaluate(() => {
          const track = document
            .querySelector(".dashboard-timeline-track")!
            .getBoundingClientRect();
          const boxes = (selector: string) =>
            [...document.querySelectorAll<HTMLElement>(selector)]
              .filter((n) => !n.hidden)
              .map((n) => n.getBoundingClientRect().toJSON());
          return {
            track: track.toJSON(),
            marks: boxes(".dashboard-timeline-mark, .dashboard-timeline-mark"),
            ticks: boxes(".dashboard-timeline-tick"),
            now: boxes(".dashboard-timeline-now > span"),
            future: boxes(".dashboard-timeline-future"),
          };
        });
        assert.equal(geometry.track.height, 51);
        for (const mark of geometry.marks) {
          assert.ok(mark.height >= 28);
          assert.ok(
            mark.y >= geometry.track.y && mark.bottom <= geometry.track.bottom,
          );
          for (const tick of geometry.ticks)
            assert.ok(tick.y >= mark.bottom, "ruler below hit targets");
          for (const label of geometry.now)
            assert.ok(label.bottom <= mark.y, "Now above hit targets");
        }
        for (const tick of geometry.ticks)
          assert.ok(tick.bottom <= geometry.track.bottom);
        assert.equal(geometry.now.length, 1);
        assert.ok(
          geometry.now[0].width > 15,
          "Now stays on one line despite its zero-width anchor",
        );
        assert.ok(geometry.now[0].height <= 13);
        assert.ok(
          geometry.now[0].x >= geometry.track.x &&
            geometry.now[0].right <= geometry.track.right,
        );
        assert.ok(
          geometry.future[0].y >= geometry.track.y &&
            geometry.future[0].bottom <= geometry.track.bottom,
        );
      },
      {
        document: true,
        viewport: { width, height: 900 },
        date: "2026-09-28",
        now: "2026-09-28T12:00:00Z",
      },
    );
  });
}

for (const width of [320, 390, 760, 1440]) {
  const height = width === 320 ? 568 : width === 390 ? 844 : 900;
  test(`compact map workspace sizes the timeline to bounded content at ${width}px`, async () => {
    await fixture(
      async (page) => {
        await page.waitForTimeout(150);
        const boxes = await page.evaluate(() => {
          const rect = (selector: string) =>
            document.querySelector(selector)!.getBoundingClientRect().toJSON();
          return {
            timeline: rect("#dashboardTimeline"),
            track: rect(".dashboard-timeline-track"),
            map: rect(".dashboard-map-layout"),
            rail: rect(".dashboard-member-rail"),
            all: rect(".dashboard-member-all"),
            tabs: rect("#dashboardSubtabs"),
            date: rect(".dashboard-map-date"),
            overflow: document.documentElement.scrollHeight > innerHeight,
          };
        });
        assert.ok(
          boxes.map.height > boxes.timeline.height + 10,
          JSON.stringify(boxes),
        );
        const fit = await page
          .locator("#dashboardTimeline")
          .evaluate((n: HTMLElement) => ({
            client: n.clientHeight,
            scroll: n.scrollHeight,
          }));
        if (width !== 320)
          assert.equal(
            fit.client,
            fit.scroll,
            "ordinary content needs no vertical scroll or empty equal-half zone",
          );
        assert.ok(boxes.timeline.height <= 230, JSON.stringify(boxes));
        assert.ok(
          boxes.timeline.bottom <= boxes.map.y + 1,
          JSON.stringify(boxes),
        );
        assert.ok(boxes.map.bottom <= height, JSON.stringify(boxes));
        assert.equal(
          boxes.overflow,
          false,
          JSON.stringify(
            await page.evaluate(() =>
              [...document.querySelectorAll("body *")]
                .filter(
                  (n) =>
                    n.getBoundingClientRect().bottom > innerHeight &&
                    n.getClientRects().length &&
                    !n.closest("#dashboardTimeline"),
                )
                .map((n) => [
                  n.tagName,
                  n.id,
                  n.className,
                  n.getBoundingClientRect().bottom,
                ])
                .slice(0, 30),
            ),
          ),
        );
        assert.equal(boxes.all.y, boxes.rail.y);
        assert.ok(boxes.all.width < 80);
        assert.ok(
          await page
            .locator("#dashboardCalendarButton")
            .evaluate((n: HTMLElement) => n.clientWidth >= n.scrollWidth),
          "calendar label is not clipped",
        );
        assert.equal(await page.locator(".dashboard-map-note").count(), 0);
        assert.equal(
          await page
            .locator("#dashboardTimeline details, #dashboardTimeline h3")
            .count(),
          0,
          "timeline has no explanatory sections or duplicate date heading",
        );
        assert.doesNotMatch(
          await page.locator("#dashboardTimeline").innerText(),
          /About this timeline|Backend event coverage|Day timeline/,
        );
        assert.ok(
          await page.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>(".dashboard-event-dot")]
              .filter((n) => !n.classList.contains("dashboard-filtered"))
              .every((n) => {
                const map = document.getElementById("dashboardMap")!;
                const x = parseFloat(n.style.left),
                  y = parseFloat(n.style.top);
                return (
                  x >= 16 &&
                  x <= map.clientWidth - 16 &&
                  y >= 16 &&
                  y <= map.clientHeight - 16
                );
              }),
          ),
          "every eligible exact anchor fits, including hidden dots represented by a location count",
        );
        const represented = await page.evaluate(() => {
          const map = document.getElementById("dashboardMap")!;
          const inside = (node: HTMLElement) => {
            const x = parseFloat(node.style.left),
              y = parseFloat(node.style.top);
            return (
              x >= 0 && x <= map.clientWidth && y >= 0 && y <= map.clientHeight
            );
          };
          const key = (node: HTMLElement) =>
            node.style.left + ":" + node.style.top;
          const groups = [
            ...map.querySelectorAll<HTMLElement>(
              ".dashboard-map-group:not([hidden])",
            ),
          ].filter(inside);
          const grouped = new Set(groups.map(key));
          const dots = [
            ...map.querySelectorAll<HTMLElement>(
              ".dashboard-event-dot:not(.dashboard-filtered)",
            ),
          ];
          return {
            expected: dots.length,
            visible:
              groups.reduce((n, group) => n + Number(group.dataset.count), 0) +
              dots.filter(
                (dot) => !dot.hidden && inside(dot) && !grouped.has(key(dot)),
              ).length,
          };
        });
        assert.equal(
          represented.visible,
          represented.expected,
          "visible group counts plus ungrouped dots cover every located event without double-counting selected dots",
        );
        await page.locator("#dashboardMapDate").focus();
        await page.locator("#dashboard-gallery-tab").click();
        assert.equal(await page.locator("#dashboardGallery").isVisible(), true);
        await page.locator("#dashboard-map-tab").click();
        await page.waitForFunction(() =>
          document.documentElement.classList.contains("compact-map"),
        );
        await page.locator("#dashboardCalendarButton").click();
        assert.equal(
          await page.locator("#dashboardCalendar").isVisible(),
          true,
        );
        await page.keyboard.press("Escape");
        assert.equal(
          await page
            .locator("#dashboardCalendarButton")
            .evaluate((n: HTMLElement) => n === document.activeElement),
          true,
        );
        const calendarBox = await page
          .locator("#dashboardCalendarButton")
          .boundingBox();
        assert.ok(calendarBox!.width > 150);
        const timelineBox = await page
          .locator("#dashboardTimeline")
          .boundingBox();
        await page.mouse.move(
          timelineBox!.x + 8,
          timelineBox!.y + timelineBox!.height / 2,
        );
        await page.mouse.wheel(0, 600);
        await page.waitForTimeout(100);
        assert.equal(
          await page.evaluate(
            () =>
              window.scrollY +
              document.getElementById("workspaceScroll")!.scrollTop,
          ),
          0,
        );
        const timelineScroll = await page
          .locator("#dashboardTimeline")
          .evaluate((n: HTMLElement) => ({
            top: n.scrollTop,
            overflows: n.scrollHeight > n.clientHeight,
          }));
        if (timelineScroll.overflows) assert.ok(timelineScroll.top > 0);
        else assert.equal(timelineScroll.top, 0);
        const map = await page.locator("#dashboardMap").boundingBox();
        await page.locator(".dashboard-map-group").first().click();
        await page.locator(".dashboard-map-choice").first().click();
        await page.waitForFunction(() =>
          document
            .getElementById("dashboardMapSelection")!
            .textContent!.includes("Event access rechecked"),
        );
        assert.deepEqual(
          await page.locator("#dashboardMap").boundingBox(),
          map,
        );
        await page.locator("#dashboardInspectorClose").click();
        assert.equal(
          await page.locator("#dashboardMapSelection").textContent(),
          "",
        );
        assert.deepEqual(
          await page.locator("#dashboardMap").boundingBox(),
          map,
        );
        await page.locator("#dashboard-trends-tab").click();
        assert.equal(
          await page.locator("#dashboardMapPane").isVisible(),
          false,
        );
        await page.locator("#dashboard-map-tab").click();
        await page.waitForFunction(() =>
          document.documentElement.classList.contains("compact-map"),
        );
        await page.evaluate(
          () =>
            new Promise<void>((r) =>
              requestAnimationFrame(() => requestAnimationFrame(() => r())),
            ),
        );
        const restored = await page.locator("#dashboardMap").boundingBox();
        assert.deepEqual(restored, map);
        const dir = process.env.DASHBOARD_EVIDENCE_DIR;
        if (dir) {
          await mkdir(dir, { recursive: true });
          await page.screenshot({
            path: `${dir}/synthetic-compact-${width}.png`,
          });
        }
      },
      {
        document: true,
        viewport: { width, height },
        override: (url, events) =>
          url.pathname === "/api/dashboard/timeline"
            ? {
                body: {
                  users: [...new Set(events.map((event) => event.user_id))].map(
                    (_id) => ({ _id, name: "Fixture member" }),
                  ),
                  events,
                  hasMore: false,
                  coverage: {
                    atomic_operations: ["metric.measurements_and_definitions"],
                  },
                },
              }
            : undefined,
        now: "2026-10-03T12:00:00Z",
      },
    );
  });
}

test("focused timeline slice does not paint its outline over ruler text", async () => {
  await fixture(
    async (page) => {
      await page.locator(".dashboard-timeline-mark").first().focus();
      const paint = await page
        .locator(".dashboard-timeline-mark:focus")
        .evaluate((node: HTMLElement) => {
          const style = getComputedStyle(node);
          const extension = Math.max(
            0,
            parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset),
          );
          return {
            bottom: node.getBoundingClientRect().bottom + extension,
            rulerTop: document
              .querySelector(".dashboard-timeline-tick")!
              .getBoundingClientRect().top,
          };
        });
      assert.ok(paint.bottom <= paint.rulerTop, JSON.stringify(paint));
    },
    { document: true },
  );
});

for (const width of [320, 390]) {
  test(`dense individual timeline remains compact while retaining a usable map at ${width}px`, async () => {
    const events = Array.from({ length: 80 }, (_, i) => ({
      ...ledger()[i % 8],
      id: `e${i.toString(16).padStart(23, "0")}`,
      occurred_at: ledger()[0].occurred_at,
    }));
    await fixture(
      async (page) => {
        await page.locator(".dashboard-timeline-mark").first().focus();
        assert.equal(
          await page.locator(".dashboard-timeline-mark").count(),
          80,
        );
        const geometry = await page.evaluate(() => {
          const timeline = document.getElementById("dashboardTimeline")!;
          const map = document
            .getElementById("dashboardMap")!
            .getBoundingClientRect();
          return {
            map: map.toJSON(),
            timeline: timeline.getBoundingClientRect().toJSON(),
            overflows: timeline.scrollHeight > timeline.clientHeight,
            pageOverflow: document.documentElement.scrollHeight > innerHeight,
          };
        });
        assert.ok(geometry.map.height >= 110, JSON.stringify(geometry));
        assert.ok(geometry.map.height > geometry.timeline.height);
        if (geometry.overflows) {
          assert.equal(
            await page
              .locator("#dashboardTimeline")
              .evaluate(
                (node: HTMLElement) => getComputedStyle(node).overflowY,
              ),
            "auto",
          );
          await page
            .locator("#dashboardTimeline")
            .evaluate((node: HTMLElement) => {
              node.scrollTop = node.scrollHeight;
            });
          assert.ok(
            await page
              .locator("#dashboardTimeline")
              .evaluate((node: HTMLElement) => node.scrollTop > 0),
          );
        }
        assert.equal(
          await page
            .locator(".dashboard-timeline-track")
            .evaluate(
              (node: HTMLElement) => node.getBoundingClientRect().height,
            ),
          51,
        );
        assert.equal(geometry.pageOverflow, false);
        await page.locator(".dashboard-timeline-mark").last().focus();
        assert.equal(
          await page.locator(".dashboard-timeline-mark:focus").count(),
          1,
        );
        await page.keyboard.press("Escape");
        assert.equal(
          await page.locator(".dashboard-timeline-tooltip").isVisible(),
          false,
        );
        assert.equal(
          await page.locator(".dashboard-timeline-mark:focus").count(),
          1,
        );
        assert.ok(
          (await page.locator("#dashboardMap").boundingBox())!.height >=
            geometry.map.height,
        );
      },
      {
        document: true,
        viewport: { width, height: width === 320 ? 568 : 844 },
        events,
      },
    );
  });
}

test("calendar admits only device-local days through Today on every path", async () => {
  await fixture(
    async (page, { requests }) => {
      await page.locator("#dashboardCalendarButton").click();
      await page.locator("#dashboardMapToday").click();
      assert.equal(
        await page.locator("#dashboardMapDate").inputValue(),
        "2026-10-03",
      );
      assert.equal(await page.locator("#dashboardMapNext").isDisabled(), true);
      const before = requests.length;
      await page
        .locator("#dashboardMapDate")
        .evaluate((n: HTMLInputElement) => {
          n.value = "2026-10-04";
          n.dispatchEvent(new Event("change"));
        });
      assert.equal(
        await page.locator("#dashboardMapDate").inputValue(),
        "2026-10-03",
      );
      assert.equal(requests.length, before);
      await page.locator("#dashboardCalendarButton").click();
      assert.equal(
        await page.locator('[data-calendar-date="2026-10-04"]').isDisabled(),
        true,
      );
      assert.equal(
        await page
          .locator('[data-calendar-date="2026-10-03"]')
          .getAttribute("aria-current"),
        "date",
      );
      await page.locator('[data-calendar-date="2026-10-02"]').focus();
      await page.keyboard.press("Enter");
      assert.equal(
        await page.locator("#dashboardMapDate").inputValue(),
        "2026-10-02",
      );
      assert.match(
        await page.locator("#dashboardCalendarButton").innerText(),
        /Friday.*Oct 2.*2026/,
      );
    },
    { document: true, now: "2026-10-03T12:00:00Z", timezone: "UTC" },
  );
});

test("ordinary longitude fit uses one projected copy, not a duplicated world", async () => {
  await fixture(
    async (page) => {
      const center = await page.evaluate(
        () => (window as any).fixtureMap.getCenter().lng,
      );
      const span = await page.evaluate(() => {
        const b = (window as any).fixtureMap.getBounds();
        return b.getEast() - b.getWest();
      });
      assert.ok(span < 1, `longitude span ${span}, center ${center}`);
    },
    {
      events: ledger()
        .slice(0, 2)
        .map((e, i) => ({
          ...e,
          position: {
            ...e.position,
            longitude: i ? -73.12338200000005 : -73.12348200000002,
          },
        })),
    },
  );
});

for (const status of [200, 403])
  test(`dismiss fences held exact-event ${status} without suppressing late denial`, async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let started = false;
    try {
      await fixture(
        async (page) => {
          await page.locator(".dashboard-map-group").first().click();
          await page.locator(".dashboard-map-choice").first().click();
          await page.waitForFunction(
            () =>
              document.getElementById("dashboardMapSelection")!.childNodes
                .length > 0,
          );
          assert.ok(started);
          await page.locator("#dashboardInspectorClose").focus();
          await page.keyboard.press("Escape");
          assert.equal(
            await page.locator("#dashboardMapSelection").textContent(),
            "",
          );
          release();
          await page.waitForTimeout(150);
          assert.equal(
            await page.locator("#dashboardMapSelection").textContent(),
            "",
          );
          if (status === 403)
            assert.equal(
              await page
                .locator(
                  '.dashboard-event-dot[data-member-id="aaaaaaaaaaaaaaaaaaaaaaaa"]',
                )
                .count(),
              0,
            );
        },
        {
          document: true,
          viewport: { width: 390, height: 844 },
          override: (url, events) => {
            if (url.pathname !== "/api/dashboard/event") return;
            started = true;
            return {
              status,
              hold: held,
              body: {
                users: [],
                events: events.filter(
                  (e) => e.id === url.searchParams.get("event_id"),
                ),
                hasMore: false,
              },
            };
          },
        },
      );
    } finally {
      release();
    }
  });

test("entirely co-located events retain keyboard zoom across panes", async () => {
  const events = ledger()
    .slice(0, 3)
    .map((event) => ({ ...event, position: { ...ledger()[0].position } }));
  await fixture(
    async (page) => {
      await page.waitForTimeout(150);
      assert.equal(
        await page.locator(".dashboard-map-group:not([hidden])").count(),
        1,
      );
      const coverage = await page.evaluate(() => {
        const map = document.getElementById("dashboardMap")!;
        return [
          ...map.querySelectorAll<HTMLElement>(
            ".dashboard-map-group:not([hidden])",
          ),
        ].reduce((total, node) => {
          const x = parseFloat(node.style.left),
            y = parseFloat(node.style.top);
          return (
            total +
            (x >= 0 && x <= map.clientWidth && y >= 0 && y <= map.clientHeight
              ? Number(node.dataset.count)
              : 0)
          );
        }, 0);
      });
      assert.equal(coverage, events.length);
      await page.locator("#dashboardMap").focus();
      await page.keyboard.press("+");
      await page.waitForTimeout(300);
      const zoom = await page.evaluate(() =>
        (window as any).fixtureMap.getZoom(),
      );
      await page.locator("#dashboard-trends-tab").click();
      await page.locator("#dashboard-map-tab").click();
      await page.waitForTimeout(150);
      assert.equal(
        await page.evaluate(() => (window as any).fixtureMap.getZoom()),
        zoom,
      );
    },
    { document: true, events, viewport: { width: 390, height: 844 } },
  );
});

test("keyboard map zoom survives retained pane resizes", async () => {
  await fixture(
    async (page) => {
      await page.locator("#dashboardMap").focus();
      await page.keyboard.press("+");
      await page.waitForTimeout(300);
      const zoom = await page.evaluate(() =>
        (window as any).fixtureMap.getZoom(),
      );
      await page.locator("#dashboard-trends-tab").click();
      await page.locator("#dashboard-map-tab").click();
      await page.waitForTimeout(100);
      assert.equal(
        await page.evaluate(() => (window as any).fixtureMap.getZoom()),
        zoom,
      );
    },
    { document: true },
  );
});
