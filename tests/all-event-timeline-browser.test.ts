import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

test("served timeline retains every occurrence and renders deleted/nonactivity event snapshots without live detail", async () => {
  const home = await mkdtemp("/tmp/coach-events-");
  const member = "aaaaaaaaaaaaaaaaaaaaaaaa";
  // Snapshot of the backend EVENT_DETAILS catalog, plus an unknown future kind.
  const kinds = [
    "metric.created",
    "metric.deleted",
    "metric.completed",
    "metric.reopened",
    "metric.status_changed",
    "metric.completion_time_corrected",
    "survey.created",
    "survey.deleted",
    "survey.completed",
    "survey.reopened",
    "survey.status_changed",
    "survey.completion_time_corrected",
    "status_change.created",
    "status_change.deleted",
    "status_change.completed",
    "status_change.reopened",
    "status_change.status_changed",
    "status_change.completion_time_corrected",
    "media.created",
    "media.deleted",
    "media.completed",
    "media.reopened",
    "media.status_changed",
    "media.completion_time_corrected",
    "metric.metadata_changed",
    "survey.metadata_changed",
    "status_change.metadata_changed",
    "media.metadata_changed",
    "survey.questions_changed",
    "status_change.readiness_changed",
    "survey.answers_changed",
    "media.files_changed",
    "media.processing_changed",
    "metric.measurements_changed",
    "member_settings.changed",
    "metric_definition.created",
    "metric_definition.changed",
    "metric_definition.deleted",
    "member_nutrition.created",
    "member_nutrition.changed",
    "member_nutrition.deleted",
    "app.opened",
    "app.backgrounded",
    "app.foregrounded",
    "workout.metadata_changed",
    "meal.metadata_changed",
    "workout.created",
    "workout.reopened",
    "workout.status_changed",
    "meal.status_changed",
    "workout.travel_replacement_changed",
    "workout.exercises_changed",
    "workout.sets_changed",
    "workout.set_added",
    "workout.set_updated",
    "workout.set_completed",
    "workout.set_reopened",
    "workout.set_removed",
    "workout.completion_time_corrected",
    "meal.foods_changed",
    "meal.food_occurrence_changed",
    "meal.recipe_converted",
    "meal.upgraded",
    "meal.recipe_added",
    "meal.recipe_scaled",
    "meal.recipe_removed",
    "meal.foods_reordered",
    "meal.foods_moved",
    "meal.completed",
    "workout.deleted",
    "meal.deleted",
    "meal.created",
    "meal.reopened",
    "meal.completion_time_corrected",
    "workout.started",
    "workout.stopped",
    "workout.resumed",
    "workout.completed",
    "meal.food_added",
    "meal.food_updated",
    "meal.food_removed",
    "future_event",
  ];
  const calls: string[] = [];
  let status = 200;
  let paged = false;
  const backend = createServer((req, res) => {
    calls.push(req.url!);
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/api/friends/dojo/day-events?")) {
      res.statusCode = status;
      const start = new URL(req.url!, "http://fixture").searchParams.get(
        "start",
      )!;
      const cursor = new URL(req.url!, "http://fixture").searchParams.get(
        "cursor",
      );
      const offset = cursor ? Number(cursor.split(".")[0]) : 0;
      res.end(
        JSON.stringify({
          users: [{ _id: member, display_name: "Fixture Ada" }],
          events: (paged ? kinds.slice(0, 1) : kinds).map((event_type, i) => ({
            id: `event-${paged ? offset : i}`,
            user_id: member,
            occurred_at: new Date(Date.parse(start) + 9000000).toISOString(),
            event_type,
            subject: {
              type: event_type.split(".")[0],
              id: "dddddddddddddddddddddddd",
            },
            details: {
              ...(event_type.includes("status_changed") ||
              /\.(started|stopped|resumed|completed|reopened)$/.test(event_type)
                ? { from_status: "ongoing", to_status: "complete" }
                : {}),
              ...(event_type.startsWith("meal.food_") &&
              event_type !== "meal.food_occurrence_changed"
                ? {
                    food_id: "rice",
                    instance_id: "two",
                    quantity: 2,
                    unit: "g",
                    ...(event_type === "meal.food_updated"
                      ? { previous_quantity: 1, previous_unit: "g" }
                      : {}),
                  }
                : {}),
              ...(event_type.startsWith("workout.set_")
                ? {
                    exercise_id: "bbbbbbbbbbbbbbbbbbbbbbbb",
                    set_id: "cccccccccccccccccccccccc",
                    exercise_index: 0,
                    set_index: i,
                    changed_fields: ["complete"],
                  }
                : {}),
              ...(event_type === "meal.food_occurrence_changed"
                ? {
                    food_index: 3,
                    change: "updated",
                    changed_fields: ["quantity"],
                    instance_id: "two",
                  }
                : {}),
              ...(event_type.endsWith("metadata_changed")
                ? { changed_fields: ["name"] }
                : {}),
              ...(event_type === "member_settings.changed"
                ? { changed_fields: ["location_capture_enabled"] }
                : {}),
              ...(event_type.startsWith("app.")
                ? {
                    event_id: "fixture-observation",
                    session_id: "fixture-session",
                    sequence: i,
                    platform: "web",
                    observed_at: new Date(
                      Date.parse(start) + 9000000,
                    ).toISOString(),
                    ...(event_type === "app.opened"
                      ? { start_reason: "launch" }
                      : {}),
                  }
                : {}),
              ...(event_type.includes("foods_") ||
              event_type.includes("recipe_") ||
              event_type === "meal.upgraded"
                ? { food_count: 2 }
                : {}),
              ...(event_type === "metric.measurements_changed"
                ? { measurement_count: 2 }
                : {}),
              ...(event_type.startsWith("survey.") &&
              event_type.endsWith("changed") &&
              !event_type.includes("metadata") &&
              !event_type.includes("status")
                ? {
                    question_count: 2,
                    ...(event_type === "survey.answers_changed"
                      ? { answered_count: 1 }
                      : {}),
                  }
                : {}),
              ...(event_type === "media.files_changed" ||
              event_type === "media.processing_changed"
                ? {
                    file_count: 2,
                    ...(event_type === "media.processing_changed"
                      ? { accepted_count: 1, rejected_count: 1 }
                      : {}),
                  }
                : {}),
              ...(event_type === "workout.exercises_changed" ||
              event_type === "workout.sets_changed"
                ? { exercise_count: 1, set_count: 2 }
                : {}),
              name: "<img src=x onerror=alert(1)>",
            },
            actor_type: "member",
            source: "interactive",
          })),
          hasMore: paged && offset < 11,
          nextCursor: paged && offset < 11 ? `${offset + 1}.signature` : null,
          coverage: { historical_aggregates: true },
        }),
      );
    } else if (req.url === "/api/friends/dojo/dashboard-members")
      res.end(
        JSON.stringify({
          members: [{ _id: member, display_name: "Fixture Ada" }],
        }),
      );
    else if (req.url?.startsWith("/api/friends/activity/")) {
      res.statusCode = 404;
      res.end("{}");
    } else
      res.end(JSON.stringify({ users: [], activities: [], hasMore: false }));
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(backend.address() as any).port}`,
    token: "fixture-token",
  });
  const app = await admin(store, 0);
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage({ timezoneId: "America/New_York" });
    await page.goto(app.origin + "/dashboard");
    assert.match(
      await page.locator('label[for="dashboardMapDate"]').innerText(),
      /event occurrence/,
    );
    await page.evaluate(async (key) => {
      document.getElementById("studio")!.hidden = false;
      document.getElementById("login")!.hidden = true;
      (window as any).L = undefined;
      await (window as any).CoachDashboard.load(null, key);
    }, store.secrets.admin);
    await page.locator("#dashboardMapDate").fill("2026-11-01");
    await page.locator("#dashboardMapDate").dispatchEvent("change");
    await page.waitForFunction(
      () =>
        !document
          .querySelector("#dashboardTimeline > p")
          ?.textContent?.includes("Loading"),
    );
    assert.equal(
      await page.locator(".dashboard-timeline-mark").count(),
      kinds.length,
    );
    const geometry = await page
      .locator(".dashboard-timeline-mark")
      .evaluateAll((nodes) =>
        nodes.map((n) => ({
          x: (n as HTMLElement).style.left,
          y: (n as HTMLElement).style.top,
        })),
      );
    assert.equal(new Set(geometry.map((g) => g.x)).size, 1);
    assert.equal(new Set(geometry.map((g) => g.y)).size, kinds.length);
    for (const kind of [
      "workout.set_completed",
      "meal.food_updated",
      "workout.status_changed",
      "app.opened",
      "member_settings.changed",
      "meal.food_occurrence_changed",
      "future_event",
    ]) {
      const i = kinds.indexOf(kind);
      await page.locator(`[data-event-id="event-${i}"]`).click();
      const detail = await page.locator("#dashboardMapSelection").innerText();
      assert.match(detail, /Fixture Ada/);
      assert.ok(detail.includes(kind.replace(/[._]/g, " ")));
      assert.doesNotMatch(detail, /<img|onerror/);
      if (kind === "workout.set_completed") {
        assert.match(detail, /set index:/);
        assert.ok(detail.includes(`Exercise 1 · Set ${i + 1}`));
        assert.match(detail, /changed fields: complete/);
      }
      if (kind === "meal.food_updated") {
        assert.match(detail, /previous quantity: 1/);
        assert.match(detail, /1 g → 2 g/);
        assert.match(detail, /quantity: 2/);
        assert.match(detail, /unit: g/);
      }
      if (kind === "workout.status_changed") {
        assert.match(detail, /from status: ongoing/);
        assert.match(detail, /to status: complete/);
      }
      if (kind === "app.opened") assert.match(detail, /observed at:/);
      if (kind === "member_settings.changed")
        assert.match(detail, /location_capture_enabled/);
      if (kind === "meal.food_occurrence_changed") {
        assert.match(detail, /food index: 3/);
        assert.match(detail, /change: updated/);
      }
    }
    assert.deepEqual(
      await page
        .locator(".dashboard-timeline-mark")
        .evaluateAll((nodes) =>
          nodes.map((n) => (n as HTMLElement).dataset.eventType).sort(),
        ),
      [...kinds].sort(),
    );
    assert.equal(
      calls.filter((c) => c.startsWith("/api/friends/activity/")).length,
      0,
    );
    assert.equal(await page.locator("#dashboardMapSelection img").count(), 0);
    assert.match(
      await page.locator("#dashboardTimeline").innerText(),
      /82.*events/,
    );
    const evidence =
      process.env.EVENT_TIMELINE_EVIDENCE ||
      "/home/kai/task-evidence/coach-all-event-timeline";
    await mkdir(evidence, { recursive: true });
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.locator("#dashboardTimeline").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `${evidence}/fixture-events-${width}.png`,
        fullPage: true,
      });
      await page
        .locator("#dashboardTimeline")
        .screenshot({ path: `${evidence}/fixture-timeline-${width}.png` });
      for (const kind of [
        "workout.set_completed",
        "meal.food_updated",
        "workout.completed",
      ]) {
        await page
          .locator(`[data-event-id="event-${kinds.indexOf(kind)}"]`)
          .click();
        await page.locator("#dashboardMapSelection").screenshot({
          path: `${evidence}/fixture-detail-${kind}-${width}.png`,
        });
      }
    }
    status = 429;
    await page.locator("#dashboardMapDate").dispatchEvent("change");
    await page.getByText("Timeline unavailable (429); try again.").waitFor();
    assert.equal(
      await page.locator(".dashboard-timeline-mark").count(),
      kinds.length,
    );
    await page.locator(`[data-event-id="event-0"]`).click();
    status = 200;
    await page.getByRole("button", { name: "Retry timeline" }).click();
    assert.equal(await page.locator("#dashboardMapSelection").innerText(), "");
    await page.waitForFunction(() =>
      document
        .querySelector(".dashboard-timeline-count")
        ?.textContent?.includes("82 loaded events"),
    );
    paged = true;
    await page.locator("#dashboardMapDate").dispatchEvent("change");
    await page
      .getByRole("button", { name: "Load more events" })
      .waitFor({ timeout: 3000 });
    assert.equal(await page.locator(".dashboard-timeline-mark").count(), 10);
    assert.match(
      await page.locator("#dashboardTimeline").innerText(),
      /More events available/,
    );
    await page.getByRole("button", { name: "Load more events" }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".dashboard-timeline-mark").length === 12,
    );
    assert.equal(
      await page.getByRole("button", { name: "Load more events" }).count(),
      0,
    );
    assert.match(
      await page.locator("#dashboardTimeline").innerText(),
      /Complete loaded pages/,
    );
    status = 403;
    await page.locator("#dashboardMapDate").dispatchEvent("change");
    await page.getByText("Timeline unavailable (403); try again.").waitFor();
    assert.equal(await page.locator(".dashboard-timeline-mark").count(), 0);
    assert.equal(await page.locator("#dashboardMapSelection").innerText(), "");
  } finally {
    await browser.close();
    await app.close();
    await new Promise<void>((r) => backend.close(() => r()));
    await rm(home, { recursive: true, force: true });
  }
});
