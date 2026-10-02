import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { chromium, type Page } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

const dateEventId = (date: string) =>
  date.slice(0, 10).replaceAll("-", "").padStart(24, "0");

async function fixture(
  run: (page: Page, calls: string[], key: string) => Promise<void>,
) {
  const home = await mkdtemp(tmpdir() + "/coach-date-nav-");
  const calls: string[] = [];
  const backend = createServer((req, res) => {
    calls.push(req.url!);
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url!, "http://synthetic");
    const member = {
      _id: "aaaaaaaaaaaaaaaaaaaaaaaa",
      display_name: "Synthetic Ada",
    };
    const start = url.searchParams.get("start");
    const events =
      url.pathname === "/api/friends/dojo/day-events" && start
        ? [
            {
              id: dateEventId(start),
              user_id: member._id,
              occurred_at: new Date(Date.parse(start) + 3600000).toISOString(),
              event_type: "app.opened",
              subject: { type: "app", id: "cccccccccccccccccccccccc" },
              details: { platform: "web", start_reason: "launch" },
              actor_type: "member",
              source: "interactive",
            },
          ]
        : [];
    res.end(
      JSON.stringify({
        members: [member],
        users: [member],
        activities: [],
        events,
        hasMore: false,
      }),
    );
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(backend.address() as any).port}`,
    token: "synthetic-date-fixture",
  });
  const app = await admin(store, 0);
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage({
      timezoneId: "America/New_York",
      viewport: { width: 1280, height: 1000 },
    });
    page.setDefaultTimeout(5000);
    await page.route("https://tile.openstreetmap.org/**", (route) =>
      route.abort(),
    );
    await page.goto(app.origin + "/dashboard");
    await page.evaluate(async (key) => {
      document.getElementById("studio")!.hidden = false;
      document.getElementById("login")!.hidden = true;
      await (window as any).CoachDashboard.load(null, key);
    }, store.secrets.admin);
    await run(page, calls, store.secrets.admin);
  } finally {
    await browser.close();
    await app.close();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}
async function setDay(page: Page, day: string) {
  await page.locator("#dashboardMapDate").fill(day);
  await page.locator("#dashboardMapDate").dispatchEvent("change");
}

test("native date fallback keeps map geometry and pointer pin selection stable on focus loss", async () => {
  await fixture(async (page) => {
    // Only transport data is synthetic; serve the real document, CSS and map renderer.
    const owner = {
      _id: "aaaaaaaaaaaaaaaaaaaaaaaa",
      display_name: "Synthetic Ada",
    };
    const activity = {
      _id: "bbbbbbbbbbbbbbbbbbbbbbbb",
      user_id: owner._id,
      name: "Synthetic focus regression workout",
      type: "workout",
      status: "complete",
      created_at: "2026-03-10T12:00:00Z",
      position: { latitude: 40.72, longitude: -74.04 },
      data: {},
    };
    const event = {
      id: dateEventId("2026-03-10"),
      user_id: owner._id,
      occurred_at: activity.created_at,
      event_type: "workout.completed",
      subject: { type: "workout", id: activity._id },
      details: {},
      position: {
        availability: "available",
        ...activity.position,
        accuracy: 8,
        source: "gps",
        captured_at: activity.created_at,
      },
    };
    await page.route(/\/api\/dashboard\/(timeline|event)\?/, (route) =>
      route.fulfill({
        json: { users: [owner], events: [event], hasMore: false },
      }),
    );
    let detailReads = 0;
    await page.route(/\/api\/dashboard\/activity\?/, (route) => {
      assert.equal(
        new URL(route.request().url()).searchParams.get("id"),
        activity._id,
      );
      detailReads++;
      return route.fulfill({ json: { activity, owner } });
    });
    await setDay(page, "2026-03-10");
    const input = page.locator("#dashboardMapDate");
    const pin = page.locator(
      `.dashboard-event-dot[data-event-id="${event.id}"]`,
    );
    await pin.waitFor();
    const geometry = () =>
      page.evaluate(() => {
        return Object.fromEntries(
          [
            ["map", "#dashboardMap"],
            ["pin", ".dashboard-event-dot"],
            ["timeline", "#dashboardTimeline"],
            ["strip", ".dashboard-map-date"],
          ].map(([name, selector]) => {
            const rect = document
              .querySelector(selector)!
              .getBoundingClientRect();
            return [
              name,
              { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            ];
          }),
        );
      });
    const failures: string[] = [];
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.getByRole("button", { name: "Next day", exact: true }).focus();
      await pin.scrollIntoViewIfNeeded();
      // Both date entry and the smaller exact event dot fit the viewport;
      // avoid measuring native focus auto-scroll as a layout displacement.
      await page.evaluate(() => window.scrollTo(0, 0));
      const unfocused = await geometry();
      await page.keyboard.press("Tab");
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      assert.equal(
        await input.evaluate((node) => node === document.activeElement),
        true,
      );
      const focused = await geometry();
      const overlay = await page
        .locator(".dashboard-date-fallback")
        .boundingBox();
      assert.ok(
        overlay && overlay.width > 1 && overlay.height > 1,
        "keyboard fallback is visible",
      );
      assert.ok(
        overlay.x >= 0 && overlay.x + overlay.width <= width,
        "fallback stays in viewport",
      );
      const inputBox = (await input.boundingBox())!;
      assert.ok(
        inputBox.x >= overlay.x &&
          inputBox.x + inputBox.width <= overlay.x + overlay.width,
        "native entry is not horizontally clipped",
      );
      assert.ok(
        overlay.y >= focused.strip.y &&
          overlay.y + overlay.height <= focused.strip.y + focused.strip.height,
        "fallback floats within the existing date strip",
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      const beforeReads = detailReads;
      // Use native pointer coordinates, never DOM click or an artificial pre-click blur.
      await page.mouse.move(
        focused.pin.x + focused.pin.width / 2,
        focused.pin.y + focused.pin.height / 2,
      );
      await page.mouse.down();
      const afterDown = await geometry();
      assert.equal(
        await input.evaluate((node) => node === document.activeElement),
        false,
      );
      await page.mouse.up();
      const selected = await page
        .waitForFunction(
          (name) =>
            document
              .getElementById("dashboardMapSelection")!
              .textContent!.includes(name),
          activity.name,
          { timeout: 1000 },
        )
        .then(
          () => true,
          () => false,
        );
      const receipt = {
        width,
        unfocused,
        focused,
        afterDown,
        selected,
        detailReads: detailReads - beforeReads,
      };
      console.log("native-fallback-geometry", JSON.stringify(receipt));
      for (const region of ["map", "pin", "timeline", "strip"] as const) {
        for (const dimension of ["x", "y", "width", "height"] as const) {
          if (
            Math.abs(
              unfocused[region][dimension] - focused[region][dimension],
            ) > 0.5
          )
            failures.push(
              `${width}: ${region}.${dimension} moved on keyboard focus`,
            );
          if (
            Math.abs(
              focused[region][dimension] - afterDown[region][dimension],
            ) > 0.5
          )
            failures.push(
              `${width}: ${region}.${dimension} moved on native blur`,
            );
        }
      }
      if (!selected || detailReads - beforeReads !== 1)
        failures.push(
          `${width}: physical pin click did not read and display selected activity`,
        );
      // Reset only the already-selected detail, retaining the same rendered map.
      await page
        .locator("#dashboardMapSelection")
        .evaluate((node) => node.replaceChildren());
    }
    assert.deepEqual(failures, [], failures.join("\n"));
  });
});

test("served Dojo centered month/year retain and clamp civil day with every daily tick", async () => {
  await fixture(async (page) => {
    await setDay(page, "2024-01-31");
    await page.getByLabel("Month", { exact: true }).selectOption("2");
    assert.equal(
      await page.locator("#dashboardMapDate").inputValue(),
      "2024-02-29",
    );
    await page.getByLabel("Year", { exact: true }).selectOption("2023");
    assert.equal(
      await page.locator("#dashboardMapDate").inputValue(),
      "2023-02-28",
    );
    await setDay(page, "1899-12-31");
    assert.equal(
      await page.getByLabel("Year", { exact: true }).inputValue(),
      "1899",
    );
    for (const [month, length] of [
      [1, 31],
      [2, 28],
      [3, 31],
      [4, 30],
      [5, 31],
      [6, 30],
      [7, 31],
      [8, 31],
      [9, 30],
      [10, 31],
      [11, 30],
      [12, 31],
    ]) {
      await page
        .getByLabel("Month", { exact: true })
        .selectOption(String(month));
      assert.equal(
        await page
          .getByLabel("Day of month", { exact: true })
          .getAttribute("max"),
        String(length),
      );
      assert.equal(await page.locator(".dashboard-day-tick").count(), length);
    }
    await setDay(page, "2026-10-01");
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      const bounds = await page.evaluate(() => {
        const strip = document
          .querySelector(".dashboard-map-date")!
          .getBoundingClientRect();
        const controls = document
          .querySelector(".dashboard-date-selects")!
          .getBoundingClientRect();
        return {
          stripCenter: (strip.left + strip.right) / 2,
          center: (controls.left + controls.right) / 2,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      const paint = await page
        .locator(".dashboard-day-tick")
        .first()
        .evaluate((node) => getComputedStyle(node).backgroundColor);
      assert.notEqual(paint, "rgba(0, 0, 0, 0)", "daily tick paint is visible");
      // Chromium does not expose native slider pseudo-element computed paint;
      // verify real raster pixels instead of treating the host's transparent background as thumb paint.
      const slider = page.getByLabel("Day of month", { exact: true });
      const rgb = (
        await slider.evaluate((node) => getComputedStyle(node).color)
      )
        .match(/\d+/g)!
        .slice(0, 3)
        .map(Number);
      const raster = await sharp(await slider.screenshot())
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const painted = (y: number) =>
        Array.from({ length: raster.info.width }, (_, x) => x).filter((x) =>
          rgb.every(
            (value, channel) =>
              Math.abs(
                raster.data[(y * raster.info.width + x) * 3 + channel] - value,
              ) < 10,
          ),
        ).length;
      assert.ok(
        painted(15) > raster.info.width * 0.8,
        "slider track has contrasting raster paint",
      );
      assert.ok(
        painted(10) >= 12,
        "square slider thumb has contrasting raster paint",
      );
      const labelGeometry = await page
        .locator(".dashboard-day-tick span")
        .evaluateAll((nodes) =>
          nodes
            .filter((node) => getComputedStyle(node).display !== "none")
            .map((node) => {
              const box = node.getBoundingClientRect();
              const style = getComputedStyle(node);
              return {
                text: node.textContent,
                height: box.height,
                lineHeight: parseFloat(style.lineHeight),
                top: box.top,
                bottom: box.bottom,
                left: box.left,
                right: box.right,
              };
            }),
        );
      assert.ok(
        labelGeometry.every((label) => label.height <= label.lineHeight + 1),
        JSON.stringify(labelGeometry),
      );
      assert.ok(
        labelGeometry.every(
          (label, i) => i === 0 || label.left >= labelGeometry[i - 1].right,
        ),
        "visible day labels do not collide",
      );
      const mapTop = await page
        .locator("#dashboardMap")
        .evaluate((node) => node.getBoundingClientRect().top);
      assert.ok(
        labelGeometry.every((label) => label.bottom < mapTop),
        "labels stay above map",
      );
      assert.ok(Math.abs(bounds.center - bounds.stripCenter) < 2);
      assert.equal(bounds.overflow, false);
      if (process.env.DATE_NAV_SCREENSHOT_DIR) {
        await mkdir(process.env.DATE_NAV_SCREENSHOT_DIR, { recursive: true });
        await page.locator(".dashboard-map-date").screenshot({
          path: `${process.env.DATE_NAV_SCREENSHOT_DIR}/synthetic-date-strip-${width}.png`,
        });
      }
    }
  });
});

test("native arrows, range preview/release and Today share civil-date reads without storms", async () => {
  await fixture(async (page) => {
    const reads: string[] = [];
    page.on("request", (request) => {
      if (/\/api\/dashboard\/(map|timeline)\?/.test(request.url()))
        reads.push(request.url());
    });
    await setDay(page, "2026-01-01");
    await page
      .getByRole("button", { name: "Previous day", exact: true })
      .click();
    assert.equal(
      await page.locator("#dashboardMapDate").inputValue(),
      "2025-12-31",
    );
    await page.getByRole("button", { name: "Next day", exact: true }).click();
    assert.equal(
      await page.locator("#dashboardMapDate").inputValue(),
      "2026-01-01",
    );
    await setDay(page, "2026-03-08");
    await page.getByRole("button", { name: "Next day", exact: true }).click();
    assert.equal(
      await page.locator("#dashboardMapDate").inputValue(),
      "2026-03-09",
    );
    await page
      .getByRole("button", { name: "Previous day", exact: true })
      .click();
    assert.equal(
      await page.locator("#dashboardMapDate").inputValue(),
      "2026-03-08",
    );
    const range = page.getByLabel("Day of month", { exact: true });
    await range.focus();
    await range.press("End");
    assert.equal(
      await page.locator("#dashboardMapDate").inputValue(),
      "2026-03-31",
    );
    await range.press("Home");
    assert.equal(
      await page.locator("#dashboardMapDate").inputValue(),
      "2026-03-01",
    );
    await range.press("ArrowRight");
    assert.equal(
      await page.locator("#dashboardMapDate").inputValue(),
      "2026-03-02",
    );
    await page.waitForTimeout(100);
    const before = reads.length;
    await range.evaluate((node) => {
      for (const day of [7, 11, 19]) {
        (node as HTMLInputElement).value = String(day);
        node.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    assert.equal(
      await page.locator("#dashboardMapDate").inputValue(),
      "2026-03-19",
    );
    assert.match(
      await page.getByLabel("Selected date", { exact: true }).innerText(),
      /19/,
    );
    assert.equal(await page.locator(".dashboard-timeline-mark").count(), 0);
    assert.equal(await page.locator("#dashboardMapSelection").innerText(), "");
    await page.waitForTimeout(100);
    assert.equal(reads.length, before);
    await range.dispatchEvent("change");
    await page.waitForTimeout(100);
    assert.equal(reads.length - before, 1);
    await page.clock.install({ time: new Date("2026-03-10T03:59:00Z") });
    await page.clock.setFixedTime(new Date("2026-03-10T04:01:00Z"));
    await page.getByRole("button", { name: "Today", exact: true }).click();
    assert.equal(
      await page.locator("#dashboardMapDate").inputValue(),
      "2026-03-10",
    );
    await page.waitForTimeout(100);
    const todayReads = reads.length;
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(reads.length, todayReads);
  });
});

test("native pointer preview fences held dates, retains member and removes old-key handlers on clear/reload", async () => {
  await fixture(async (page, _calls, key) => {
    await setDay(page, "2026-03-10");
    await page
      .locator(`[data-event-id="${dateEventId("2026-03-10")}"]`)
      .waitFor();
    await page.locator(".dashboard-member-card").click();
    await page
      .locator(`[data-event-id="${dateEventId("2026-03-10")}"]`)
      .click();
    assert.match(
      await page.locator("#dashboardMapSelection").innerText(),
      /Synthetic Ada/,
    );
    const reads: string[] = [];
    page.on("request", (request) => {
      if (/\/api\/dashboard\/(map|timeline)\?/.test(request.url()))
        reads.push(request.url());
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = 0;
    await page.route(/\/api\/dashboard\/(map|timeline)\?/, async (route) => {
      if (
        new URL(route.request().url()).searchParams.get("date") !== "2026-03-11"
      )
        return route.continue();
      const response = await route.fetch();
      held++;
      await gate;
      await route.fulfill({ response });
    });
    try {
      await page.getByRole("button", { name: "Next day", exact: true }).click();
      for (let n = 0; n < 100 && held < 1; n++) await page.waitForTimeout(10);
      assert.equal(
        held,
        1,
        "the shared map/timeline old-date stream is really held",
      );
      const range = page.getByLabel("Day of month", { exact: true });
      const box = (await range.boundingBox())!;
      await page.mouse.move(
        box.x + 8 + ((box.width - 16) * 10) / 30,
        box.y + box.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        box.x + 8 + ((box.width - 16) * 21) / 30,
        box.y + box.height / 2,
        { steps: 8 },
      );
      const preview = await page.locator("#dashboardMapDate").inputValue();
      assert.equal(preview, "2026-03-22");
      assert.equal(await page.locator(".dashboard-timeline-mark").count(), 0);
      assert.equal(
        await page.locator("#dashboardMapSelection").innerText(),
        "",
      );
      const beforeRelease = reads.length;
      assert.equal(beforeRelease, 1, "pointer movements dispatch no reads");
      await page.mouse.up();
      await page
        .locator(`[data-event-id="${dateEventId("2026-03-22")}"]`)
        .waitFor();
      release();
      await page.waitForTimeout(100);
      assert.equal(
        await page
          .locator(`[data-event-id="${dateEventId("2026-03-11")}"]`)
          .count(),
        0,
      );
      assert.equal(
        reads.length - beforeRelease,
        1,
        "native release commits each date-scoped path once",
      );
      assert.equal(
        await page
          .locator(".dashboard-member-card")
          .getAttribute("aria-pressed"),
        "true",
      );
      await page.evaluate(() => {
        (window as any).retainedDateHandler = (
          document.getElementById("dashboardMapNext") as HTMLButtonElement
        ).onclick;
        document.getElementById("lockStudio")!.click();
      });
      const beforeClear = reads.length;
      await page.evaluate(() => {
        (window as any).retainedDateHandler();
        document.getElementById("dashboardMapToday")!.click();
        const range = document.getElementById("dashboardMapDay")!;
        range.dispatchEvent(new Event("input"));
        range.dispatchEvent(new Event("change"));
      });
      await page.waitForTimeout(100);
      assert.equal(
        reads.length,
        beforeClear,
        "clear removes listeners and fences detached old-key callbacks",
      );
      await page.evaluate(async (adminKey) => {
        document.getElementById("studio")!.hidden = false;
        document.getElementById("login")!.hidden = true;
        await (window as any).CoachDashboard.load(null, adminKey);
      }, key);
      const reloadedDate = await page.locator("#dashboardMapDate").inputValue();
      await page.evaluate(() => (window as any).retainedDateHandler());
      assert.equal(
        await page.locator("#dashboardMapDate").inputValue(),
        reloadedDate,
      );
      await page.getByRole("button", { name: "Next day", exact: true }).click();
      assert.notEqual(
        await page.locator("#dashboardMapDate").inputValue(),
        reloadedDate,
      );
    } finally {
      release();
    }
  });
});

test("civil navigation preserves leap-century and DST day boundaries in actual map/timeline requests", async () => {
  await fixture(async (page) => {
    for (const [date, length] of [
      ["2000-02-29", "29"],
      ["2100-02-28", "28"],
      ["2024-02-29", "29"],
    ]) {
      await setDay(page, date);
      assert.equal(
        await page
          .getByLabel("Day of month", { exact: true })
          .getAttribute("max"),
        length,
      );
    }
    for (const [day, expectedHours] of [
      ["2026-03-08", 23],
      ["2026-11-01", 25],
    ] as const) {
      const responses = ["timeline"].map((path) =>
        page.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            url.pathname === `/api/dashboard/${path}` &&
            url.searchParams.get("date") === day
          );
        }),
      );
      await setDay(page, day);
      for (const response of await Promise.all(responses)) {
        const url = new URL(response.url());
        assert.equal(
          (Date.parse(url.searchParams.get("end")!) -
            Date.parse(url.searchParams.get("start")!)) /
            3600000,
          expectedHours,
        );
      }
      await page.getByRole("button", { name: "Next day", exact: true }).click();
      assert.equal(
        await page.locator("#dashboardMapDate").inputValue(),
        day === "2026-03-08" ? "2026-03-09" : "2026-11-02",
      );
    }
  });
});

test("late activity privacy denial survives new date navigation and cannot resurrect member inventory", async () => {
  await fixture(async (page) => {
    // Synthetic transport boundaries; retain the real served renderer and auth/date lifecycle.
    await page.route(/\/api\/dashboard\/(timeline|event)\?/, async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      for (const event of data.events) {
        event.event_type = "workout.completed";
        event.subject = { type: "workout", id: "bbbbbbbbbbbbbbbbbbbbbbbb" };
      }
      await route.fulfill({ response, json: data });
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/api\/dashboard\/activity\?/, async (route) => {
      await gate;
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: "{}",
      });
    });
    try {
      await setDay(page, "2026-03-10");
      const detailRequest = page.waitForRequest(/\/api\/dashboard\/activity\?/);
      await page
        .locator(`[data-event-id="${dateEventId("2026-03-10")}"]`)
        .click();
      await detailRequest;
      await page.getByRole("button", { name: "Next day", exact: true }).click();
      await page
        .locator(`[data-event-id="${dateEventId("2026-03-11")}"]`)
        .waitFor();
      release();
      await page.waitForFunction(
        () => !document.querySelector(".dashboard-timeline-mark"),
      );
      assert.equal(
        await page.locator("#dashboardMapSelection").innerText(),
        "",
      );
      await page.getByRole("button", { name: "Next day", exact: true }).click();
      await page.waitForTimeout(100);
      assert.equal(
        await page.locator(".dashboard-timeline-mark").count(),
        0,
        "date refresh cannot undo confirmed member denial",
      );
    } finally {
      release();
    }
  });
});
