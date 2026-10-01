import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

// Actual dashboard renderer and production CSS; only transport and IIFE visibility
// are synthetic. Native Chromium focus/click/key dispatch is not mocked.
async function fixture(cluster = false) {
  const source = (
    await readFile(new URL("../ui/dashboard.js", import.meta.url), "utf8")
  ).replace(
    "return { clear, load };",
    "return { clear, load, renderEventTimeline, loadTimeline };",
  );
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 800 },
      timezoneId: "UTC",
    });
    await page.setContent(
      '<input id="dashboardMapDate" value="2026-10-01"><button id="outside">Outside</button><div id="dashboardTimeline" class="dashboard-timeline" data-date="2026-10-01"></div><div id="dashboardMapSelection"></div>',
    );
    await page.addStyleTag({
      content: await readFile(
        new URL("../ui/style.css", import.meta.url),
        "utf8",
      ),
    });
    await page.addScriptTag({ content: source });
    await page.evaluate((cluster) => {
      const w = window as any;
      const item = {
        id: "a",
        user_id: "aaaaaaaaaaaaaaaaaaaaaaaa",
        occurred_at: "2026-10-01T12:00:00Z",
        event_type: "workout.set_completed",
        subject: { type: "workout", id: "cccccccccccccccccccccccc" },
        details: { set_index: 0, exercise_index: 0 },
      };
      w.events = [
        item,
        ...(cluster ? [{ ...item, id: "b", details: { set_index: 1 } }] : []),
        { ...item, id: "later", occurred_at: "2026-10-01T18:00:00Z" },
      ];
      w.users = [{ _id: item.user_id, display_name: "Fixture Ada" }];
      w.fetch = async () => new Response("{}", { status: 500 });
      w.CoachDashboard.renderEventTimeline(
        document.getElementById("dashboardTimeline"),
        new Map(w.events.map((e: any) => [e.id, e])),
        new Map(w.users.map((u: any) => [u._id, u])),
        new Date("2026-10-01T00:00:00Z"),
        new Date("2026-10-02T00:00:00Z"),
        "fixture",
      );
    }, cluster);
    // Settle the initial real ResizeObserver redraw before acquiring an owner.
    await page.waitForFunction(
      () => document.querySelectorAll(".dashboard-timeline-tick").length > 0,
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    return { page, browser };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

for (const cluster of [false, true])
  for (const path of ["retry", "more"] as const)
    for (const status of [403, 500]) {
      test(`R3 ${cluster ? "cluster" : "single"} pending ${path} fences retained interaction; ${status} ${status === 403 ? "purges" : "recovers stale inventory"}`, async () => {
        const { page, browser } = await fixture(cluster);
        try {
          await page.evaluate(async (path) => {
            const w = window as any;
            w.liveReads = 0;
            w.timelineReads = 0;
            w.fetch = async (url: string) => {
              if (!url.startsWith("/api/dashboard/timeline?")) {
                w.liveReads++;
                return new Response("{}", { status: 500 });
              }
              const i = w.timelineReads++;
              if (path === "retry") return new Response("{}", { status: 500 });
              return new Response(
                JSON.stringify({
                  users: w.users,
                  events:
                    i === 0
                      ? w.events
                      : [
                          {
                            ...w.events[0],
                            id: `page-${i}`,
                            occurred_at: "2026-10-01T12:00:00Z",
                          },
                        ],
                  hasMore: true,
                  nextCursor: `cursor-${i}`,
                }),
              );
            };
            await w.CoachDashboard.loadTimeline("fixture");
          }, path);
          await page.evaluate(
            () =>
              new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              ),
          );
          const owner = page.locator(
            cluster || path === "more"
              ? ".dashboard-timeline-cluster"
              : '.dashboard-timeline-mark[data-event-id="a"]',
          );
          await owner.focus();
          await page.evaluate(() => {
            const w = window as any;
            w.oldChoice = document.querySelector(".dashboard-timeline-choice");
            w.oldOwner = document.activeElement;
            w.fetch = (url: string) => {
              if (!url.startsWith("/api/dashboard/timeline?")) {
                w.liveReads++;
                return Promise.resolve(new Response("{}", { status: 500 }));
              }
              w.timelineReads++;
              return new Promise((resolve) => {
                w.releaseRead = (status: number) =>
                  resolve(new Response("{}", { status }));
              });
            };
          });
          await page
            .getByRole("button", {
              name: path === "more" ? "Load more events" : "Retry timeline",
              exact: true,
            })
            .click();
          assert.match(
            await page.locator("#dashboardTimeline > p").innerText(),
            /Loading authorized/,
          );
          await page.locator("#outside").focus();
          // Native pointer movement must still be possible over inert retained pixels.
          const box = await owner.boundingBox();
          assert.ok(box);
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await owner.evaluate((el) => {
            (el as HTMLElement).focus();
            el.dispatchEvent(
              new PointerEvent("pointerenter", { pointerType: "mouse" }),
            );
            (el as HTMLElement).click();
          });
          await page.evaluate(() => (window as any).oldChoice.click());
          assert.equal(
            await page.locator(".dashboard-timeline-inspector").isVisible(),
            false,
          );
          assert.equal(
            await page.locator(".dashboard-timeline-inspector").textContent(),
            "",
          );
          assert.equal(
            await page.locator("#dashboardMapSelection").textContent(),
            "",
          );
          assert.equal(await page.evaluate(() => (window as any).liveReads), 0);
          await page.evaluate(
            (status) => (window as any).releaseRead(status),
            status,
          );
          await page.waitForFunction(() =>
            document
              .querySelector("#dashboardTimeline > p")
              ?.textContent?.includes("Timeline unavailable"),
          );
          if (status === 403) {
            assert.equal(
              await page
                .locator(
                  ".dashboard-timeline-mark, .dashboard-timeline-cluster",
                )
                .count(),
              0,
            );
            await page.evaluate(() => {
              const w = window as any;
              w.oldOwner.click();
              w.oldChoice.click();
            });
            assert.equal(
              await page.locator("#dashboardMapSelection").textContent(),
              "",
            );
            assert.equal(
              await page.evaluate(() => (window as any).liveReads),
              0,
            );
          } else {
            assert.match(
              await page.locator("#dashboardTimeline > p").innerText(),
              /stale/i,
            );
            // Recovery reattaches the real ResizeObserver; settle its initial
            // layout notification before deliberate focus opens the inspector.
            await page.evaluate(
              () =>
                new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
            );
            await owner.focus();
            assert.equal(
              await page.locator(".dashboard-timeline-inspector").isVisible(),
              true,
            );
            await page.locator(".dashboard-timeline-choice").first().click();
            assert.match(
              await page.locator("#dashboardMapSelection").innerText(),
              /historical event snapshot/i,
            );
            assert.equal(
              await page.evaluate(() => (window as any).liveReads),
              1,
            );
            // A second failed retry refreshes the retained renderer epoch again.
            await page
              .getByRole("button", { name: "Retry timeline", exact: true })
              .click();
            await owner.evaluate((el) => (el as HTMLElement).click());
            assert.equal(
              await page.locator("#dashboardMapSelection").textContent(),
              "",
            );
            await page.evaluate(() => (window as any).releaseRead(500));
            await page.waitForFunction(() =>
              document
                .querySelector("#dashboardTimeline > p")
                ?.textContent?.includes("Timeline unavailable"),
            );
            // Recovery reattaches the real ResizeObserver; settle its initial
            // layout notification before deliberate focus opens the inspector.
            await page.evaluate(
              () =>
                new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
            );
            await owner.focus();
            assert.equal(
              await page.locator(".dashboard-timeline-inspector").isVisible(),
              true,
            );
          }
        } finally {
          await browser.close();
        }
      });
    }

test("R3 late success cannot resurrect inventory after a superseding denial", async () => {
  const { page, browser } = await fixture(true);
  try {
    await page.locator(".dashboard-timeline-cluster").focus();
    await page.keyboard.press("Enter");
    await page.evaluate(() => {
      const w = window as any;
      w.responses = [];
      w.fetch = () => new Promise((resolve) => w.responses.push(resolve));
      w.firstLoad = w.CoachDashboard.loadTimeline("fixture");
    });
    assert.equal(
      await page.locator(".dashboard-timeline-inspector").isVisible(),
      false,
    );
    await page.evaluate(() => {
      const w = window as any;
      w.nextLoad = w.CoachDashboard.loadTimeline("fixture");
    });
    await page.waitForFunction(() => (window as any).responses.length === 2);
    await page.evaluate(async () => {
      const w = window as any;
      w.responses[1](new Response("{}", { status: 403 }));
      await w.nextLoad;
    });
    await page.evaluate(async () => {
      const w = window as any;
      w.responses[0](
        new Response(
          JSON.stringify({ users: w.users, events: w.events, hasMore: false }),
        ),
      );
      await w.firstLoad;
    });
    assert.equal(
      await page
        .locator(
          ".dashboard-timeline-mark, .dashboard-timeline-cluster, .dashboard-timeline-inspector",
        )
        .count(),
      0,
    );
    assert.match(
      await page.locator("#dashboardTimeline > p").innerText(),
      /403/,
    );
    assert.equal(
      await page.locator("#dashboardMapSelection").textContent(),
      "",
    );
  } finally {
    await browser.close();
  }
});

for (const transition of ["date", "lock"] as const) {
  test(`R3 ${transition} discards inspector ownership and timers while late reload succeeds`, async () => {
    const { page, browser } = await fixture();
    try {
      const owner = page.locator('.dashboard-timeline-mark[data-event-id="a"]');
      await owner.focus();
      await owner.dispatchEvent("pointerleave");
      await page.evaluate(() => {
        const w = window as any;
        w.fetch = () =>
          new Promise((resolve) => {
            w.release = resolve;
          });
        w.pending = w.CoachDashboard.loadTimeline("fixture");
      });
      await page.evaluate((transition) => {
        const w = window as any;
        if (transition === "date") {
          (
            document.getElementById("dashboardMapDate") as HTMLInputElement
          ).value = "2026-10-02";
          w.fetch = async () => new Response("{}", { status: 500 });
          w.next = w.CoachDashboard.loadTimeline("fixture");
        } else {
          for (const id of [
            "dashboardRoster",
            "dashboardCharts",
            "dashboardCoverage",
            "dashboardStatus",
          ]) {
            const el = document.createElement("div");
            el.id = id;
            document.body.append(el);
          }
          w.CoachDashboard.clear();
        }
      }, transition);
      await page.evaluate(async () => {
        const w = window as any;
        w.release(
          new Response(
            JSON.stringify({
              users: w.users,
              events: w.events,
              hasMore: false,
            }),
          ),
        );
        await w.pending;
        await w.next;
      });
      await page.waitForTimeout(220); // Beyond the actual 180ms dismissal timer.
      assert.equal(
        await page
          .locator(
            ".dashboard-timeline-inspector, .dashboard-timeline-mark, .dashboard-timeline-cluster",
          )
          .count(),
        0,
      );
      assert.equal(
        await page.locator("#dashboardMapSelection").textContent(),
        "",
      );
      if (transition === "date")
        assert.match(
          await page.locator("#dashboardTimeline > p").innerText(),
          /Timeline unavailable/,
        );
      else
        assert.equal(
          await page.locator("#dashboardTimeline").textContent(),
          "",
        );
    } finally {
      await browser.close();
    }
  });
}

for (const mode of ["keyboard", "pointer", "single"] as const) {
  test(`R2 ${mode} selection restores owner focus and continued arrow navigation`, async () => {
    const { page, browser } = await fixture(mode !== "single");
    try {
      const owner = page.locator(
        mode === "single"
          ? '.dashboard-timeline-mark[data-event-id="a"]'
          : ".dashboard-timeline-cluster",
      );
      if (mode === "pointer") await owner.hover();
      else await owner.focus();
      if (mode === "keyboard") {
        await page.keyboard.press("Enter");
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("Enter");
      } else await page.locator(".dashboard-timeline-choice").first().click();
      assert.match(
        await page.locator("#dashboardMapSelection").innerText(),
        /historical event snapshot/i,
      );
      if (mode === "keyboard")
        assert.match(
          await page.locator("#dashboardMapSelection").innerText(),
          /set index: 1/,
        );
      assert.equal(
        await owner.evaluate(
          (el) => el === document.activeElement && el.isConnected,
        ),
        true,
      );
      assert.equal(
        await page.locator(".dashboard-timeline-inspector").isVisible(),
        false,
      );
      await page.keyboard.press("ArrowRight");
      assert.equal(
        await page
          .locator('.dashboard-timeline-mark[data-event-id="later"]')
          .evaluate((el) => el === document.activeElement),
        true,
      );
    } finally {
      await browser.close();
    }
  });
}

for (const cluster of [false, true])
  for (const open of ["focus", "pointer", "chooser"] as const)
    for (const close of ["click", "keyboard", "escape"] as const) {
      test(`R1 ${cluster ? "cluster" : "single"} ${open} preview ${close} close restores native focus without reopening`, async () => {
        const { page, browser } = await fixture(cluster);
        try {
          const owner = page.locator(
            cluster
              ? ".dashboard-timeline-cluster"
              : '.dashboard-timeline-mark[data-event-id="a"]',
          );
          if (open === "pointer") await owner.hover();
          else {
            await owner.focus();
            if (open === "chooser") {
              if (cluster) await page.keyboard.press("Enter");
              else
                await owner.evaluate((el) =>
                  el.dispatchEvent(
                    new PointerEvent("click", {
                      pointerType: "touch",
                      bubbles: true,
                    }),
                  ),
                );
            }
          }
          assert.equal(
            await page.locator(".dashboard-timeline-inspector").isVisible(),
            true,
          );
          if (close === "escape") {
            await page.locator(".dashboard-timeline-close").focus();
            await page.keyboard.press("Escape");
          } else if (close === "click")
            await page.locator(".dashboard-timeline-close").click();
          else {
            await page.locator(".dashboard-timeline-close").focus();
            await page.keyboard.press("Enter");
          }
          assert.equal(
            await page.locator(".dashboard-timeline-inspector").isVisible(),
            false,
          );
          assert.equal(
            await page.locator(".dashboard-timeline-inspector").textContent(),
            "",
          );
          assert.equal(
            await owner.evaluate(
              (el) => el === document.activeElement && el.isConnected,
            ),
            true,
          );
          await page.locator("#outside").focus();
          await owner.focus();
          assert.equal(
            await page.locator(".dashboard-timeline-inspector").isVisible(),
            true,
          );
          await page.keyboard.press("Escape");
          await page.locator("#outside").hover();
          await owner.hover();
          assert.equal(
            await page.locator(".dashboard-timeline-inspector").isVisible(),
            true,
          );
        } finally {
          await browser.close();
        }
      });
    }
