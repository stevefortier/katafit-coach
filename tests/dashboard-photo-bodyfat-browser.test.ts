import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

// Synthetic ordinary REST envelopes; exercise the shipped browser renderer.
test("photo midpoint renders as an estimate and manual fat never charts", async () => {
  const photo = (id: string, day: string, files: any[]) => ({
    _id: id,
    user_id: "ada",
    type: "media",
    status: "complete",
    created_at: `2026-09-${day}T12:00:00Z`,
    data: { files },
  });
  const file = (range: any, extra = {}) => ({
    _id: "f",
    type: "image/jpeg",
    inferenceStatus: "completed",
    inferences: [{ result: { estimated_body_fat_range: range } }],
    ...extra,
  });
  const rows = [
    photo("latest", "28", [
      file({ lower_bound: 0.16, upper_bound: 0.2, best_estimate: 0.19 }),
    ]),
    photo("older", "27", [file({ lower_bound: 20, upper_bound: 24 })]),
    {
      _id: "manual",
      user_id: "ada",
      type: "metric",
      status: "complete",
      created_at: "2026-09-29T12:00:00Z",
      data: {
        measurements: [{ type_id: "fat_percentage", value: 45, unit: "%" }],
      },
    },
  ];
  let currentRows = rows;
  let detailOverrides: Record<string, any> = {};
  let currentStats: any = {
    body_fat_percent: 18,
    body_fat_estimate: { source: "ai", estimated: true, value: 18 },
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture");
    if (url.pathname === "/dashboard.js") {
      res.setHeader("content-type", "text/javascript");
      res.end(await readFile(new URL("../ui/dashboard.js", import.meta.url)));
    } else if (url.pathname === "/") {
      res.setHeader("content-type", "text/html");
      res.end(
        '<input id="dashboardMapDate" type="date"><div id="dashboardMapStatus"></div><div id="dashboardMap"></div><div id="dashboardMapSelection"></div><div id="dashboardMemberHeading"></div><div id="dashboardMemberCards"></div><div id="dashboardStatus"></div><div id="dashboardCoverage"></div><div id="dashboardRoster"></div><div id="dashboardCharts"></div><script src="/dashboard.js"></script>',
      );
    } else {
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/api/dashboard/members")
        res.end(
          JSON.stringify({
            members: [
              {
                _id: "ada",
                display_name: "Synthetic Ada",
                stats: currentStats,
              },
            ],
          }),
        );
      else if (url.pathname === "/api/dashboard/activity") {
        const activity = currentRows.find(
          (row) => row._id === url.searchParams.get("id"),
        );
        res.end(
          JSON.stringify({
            activity: activity && {
              ...activity,
              ...detailOverrides[activity._id],
            },
            owner: { _id: "ada" },
          }),
        );
      } else if (url.pathname === "/api/dashboard")
        res.end(
          JSON.stringify({
            users: [{ _id: "ada", display_name: "Synthetic Ada" }],
            activities: currentRows,
            hasMore: false,
          }),
        );
      else {
        res.statusCode = 404;
        res.end("{}");
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as any).port}/`);
    const load = () =>
      page.evaluate(() =>
        (window as any).CoachDashboard.load(null, "synthetic"),
      );
    await load();
    assert.match(
      await page.locator("#dashboardMemberCards").innerText(),
      /Body fat \(photo estimate\): 18 %/,
    );
    assert.match(
      await page.locator("#dashboardCharts").innerText(),
      /Body fat \(photo estimate\)/,
    );
    const labels = () =>
      page
        .locator("#dashboardCharts svg")
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("aria-label")),
        );
    assert.deepEqual(await labels(), [
      "Synthetic Ada, Body fat (photo estimate) in %: 2026-09-27 22; 2026-09-28 18",
    ]);
    currentStats = { body_fat_percent: 45 };
    await load();
    assert.match(
      await page.locator("#dashboardMemberCards").innerText(),
      /Body fat \(photo estimate\): Unavailable/,
    );
    // Canonical Stats accepts strict decimal strings, and presentation rounds
    // percent values to one decimal rather than leaking float artifacts.
    currentRows = [
      photo("decimal", "28", [
        file({ lower_bound: ".10", upper_bound: ".13" }),
      ]),
      rows[2],
    ];
    currentStats = {
      body_fat_percent: 11.500000000000002,
      body_fat_estimate: {
        min: 10,
        max: 13,
        value: 11.500000000000002,
        source: "ai",
        estimated: true,
        date: "2026-09-28T12:00:00Z",
      },
    };
    await load();
    assert.match(
      await page.locator("#dashboardMemberCards").innerText(),
      /Body fat \(photo estimate\): 11\.5 %/,
    );
    assert.doesNotMatch(
      await page.locator("#dashboardMemberCards").innerText(),
      /000000000/,
    );
    assert.deepEqual(await labels(), [
      "Synthetic Ada, Body fat (photo estimate) in %: 2026-09-28 11.5",
    ]);
    // A completed list entry cannot authorize a now-pending/template detail.
    for (const changed of [{ status: "pending" }, { is_template: true }]) {
      detailOverrides = { decimal: changed };
      await load();
      assert.deepEqual(await labels(), []);
    }
    detailOverrides = {};
    // Invalid latest inference must not fall back to an older inference/manual reading.
    for (const invalid of [
      [],
      [file({ lower_bound: 0.3, upper_bound: 0.2 })],
      [file({ lower_bound: "16%", upper_bound: 20 })],
      [file({ lower_bound: 0.16, upper_bound: 20 })],
      [file({ lower_bound: "1e1", upper_bound: 13 })],
      [file({ lower_bound: 0.16, upper_bound: 0.2 }, { isPlaceholder: true })],
      [
        file(
          { lower_bound: 0.16, upper_bound: 0.2 },
          {
            inferences: [
              {
                result: {
                  estimated_body_fat_range: {
                    lower_bound: 0.16,
                    upper_bound: 0.2,
                  },
                  _session: { file_ids: ["other"] },
                },
              },
            ],
          },
        ),
      ],
      [
        file(
          { lower_bound: 0.16, upper_bound: 0.2 },
          { inferenceStatus: "failed" },
        ),
      ],
      [
        file(
          { lower_bound: 0.16, upper_bound: 0.2 },
          {
            inferences: [
              {
                result: {
                  estimated_body_fat_range: {
                    lower_bound: 0.16,
                    upper_bound: 0.2,
                  },
                },
              },
              { result: {} },
            ],
          },
        ),
      ],
      [
        file(
          { lower_bound: 0.16, upper_bound: 0.2 },
          {
            inferences: [
              {
                result: {
                  estimated_body_fat_range: {
                    lower_bound: 0.16,
                    upper_bound: 0.2,
                  },
                  photo_validation: { file_id: "other" },
                },
              },
            ],
          },
        ),
      ],
    ]) {
      currentRows = [photo("invalid", "28", invalid), rows[2]];
      currentStats = {};
      await load();
      assert.match(
        await page.locator("#dashboardMemberCards").innerText(),
        /Body fat \(photo estimate\): Unavailable/,
      );
      assert.deepEqual(await labels(), []);
      assert.match(
        await page.locator("#dashboardCharts").innerText(),
        /Trend measurements unavailable/,
      );
    }
    for (const value of ["18", 0, -1, 101]) {
      currentStats = {
        body_fat_percent: value,
        body_fat_estimate: { source: "ai", estimated: true, value },
      };
      await load();
      assert.match(
        await page.locator("#dashboardMemberCards").innerText(),
        /Body fat \(photo estimate\): Unavailable/,
      );
    }
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
