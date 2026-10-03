import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

test("served dashboard preserves workout, meal and body trends while Gallery stays media-only", async () => {
  const home = await mkdtemp(tmpdir() + "/chart-preservation-");
  const calls: string[] = [];
  const base = {
    user_id: "ada",
    status: "complete",
    created_at: "2026-09-28T12:00:00Z",
  };
  const rows = [
    {
      ...base,
      _id: "workout",
      type: "workout",
      workout_progress: { completed_sets: 6 },
    },
    {
      ...base,
      _id: "meal",
      type: "meal",
      nutrition_summary: { calories: 650, protein: 42 },
    },
    {
      ...base,
      _id: "metric",
      type: "metric",
      data: { measurements: [{ type_id: "weight", value: 75, unit: "kg" }] },
    },
    {
      ...base,
      _id: "media",
      type: "media",
      data: {
        files: [
          {
            _id: "photo",
            type: "image/png",
            inferences: [
              {
                result: {
                  estimated_body_fat_range: {
                    lower_bound: 18,
                    upper_bound: 20,
                  },
                },
              },
            ],
          },
        ],
      },
    },
    { ...base, _id: "survey", type: "survey" },
    { ...base, _id: "status", type: "status_change" },
    {
      ...base,
      _id: "pending-workout",
      type: "workout",
      status: "pending",
      workout_progress: { completed_sets: 99 },
    },
    {
      ...base,
      _id: "pending-meal",
      type: "meal",
      status: "pending",
      nutrition_summary: { calories: 9999, protein: 999 },
    },
  ];
  const backend = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture");
    calls.push(req.url!);
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/friends/feed/dojo") {
      // Always return success and honor selection: two-type acquisition loses real chart inputs.
      const types = (
        url.searchParams.get("types") ||
        url.searchParams.get("type") ||
        ""
      ).split(",");
      const older = url.searchParams.has("beforeDate");
      res.end(
        JSON.stringify({
          users: [{ _id: "ada", display_name: "Synthetic Ada" }],
          activities: older
            ? []
            : rows.filter((row) => types.includes(row.type)),
          hasMore: !older && url.searchParams.has("types"),
          oldestDate: base.created_at,
          nextCursor: null,
        }),
      );
    } else if (url.pathname.startsWith("/api/friends/activity/")) {
      res.end(
        JSON.stringify({
          activity: rows.find(
            (row) => row._id === url.pathname.split("/").at(-1),
          ),
          owner: { _id: "ada" },
        }),
      );
    } else {
      res.end(
        JSON.stringify({
          members: [],
          users: [],
          activities: [],
          events: [],
          hasMore: false,
        }),
      );
    }
  });
  let server: Awaited<ReturnType<typeof admin>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    const store = new Store(home);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin: `http://127.0.0.1:${(backend.address() as any).port}`,
      token: "synthetic",
    });
    server = await admin(store, 0);
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    await page.goto(server.origin);
    await page.evaluate(() => {
      document.getElementById("studio")!.hidden = false;
      document.getElementById("login")!.hidden = true;
      document.getElementById("dashboardPanel")!.hidden = false;
    });
    await page.evaluate(
      (key) => (window as any).CoachDashboard.load(null, key),
      store.secrets.admin,
    );
    await page.getByRole("tab", { name: "Activity trends" }).click();
    const labels = await page
      .locator("#dashboardCharts svg")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("aria-label")).join("\n"),
      );
    assert.match(
      labels,
      /weight in kg: 2026-09-28 75/,
      "body weight remains charted",
    );
    assert.match(
      labels,
      /Body fat \(photo estimate\) in %: 2026-09-28 19/,
      "media body-fat remains charted",
    );
    assert.match(
      labels,
      /Completed workouts in workouts: 2026-09-28 1/,
      "completed workout trend must survive acquisition filtering",
    );
    assert.match(labels, /Completed sets in sets: 2026-09-28 6/);
    assert.match(labels, /Logged meals in meals: 2026-09-28 1/);
    assert.match(labels, /Recorded calories in kcal: 2026-09-28 650/);
    assert.match(labels, /Recorded protein in g: 2026-09-28 42/);
    assert.doesNotMatch(labels, /9999|999|99 sets/);
    await page
      .getByRole("button", { name: "Load older activities", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.getElementById("dashboardStatus")!.textContent ===
        "Loaded bounded feed history; not a complete history.",
    );
    const chartCalls = calls.filter(
      (path) =>
        path.startsWith("/api/friends/feed/dojo?") && path.includes("types="),
    );
    assert.deepEqual(chartCalls, [
      "/api/friends/feed/dojo?limit=20&types=meal,media,metric,workout",
      "/api/friends/feed/dojo?limit=20&types=meal,media,metric,workout&beforeDate=2026-09-28T12%3A00%3A00Z",
    ]);
    assert.ok(
      calls.includes(
        "/api/friends/feed/dojo?limit=20&type=media&pagination=cursor",
      ),
    );
    assert.ok(
      !calls.some((path) =>
        /\/api\/friends\/activity\/(workout|meal|survey|status)$/.test(path),
      ),
    );
    assert.match(
      await page.locator("#dashboardCoverage").innerText(),
      /200 activity limit/,
    );
    assert.doesNotMatch(
      await page.locator("#dashboardGallery").innerText(),
      /Completed workouts|Logged meals|650|42 g/,
    );
  } finally {
    await browser?.close();
    await server?.close();
    if (backend.listening)
      await new Promise<void>((resolve) => backend.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
