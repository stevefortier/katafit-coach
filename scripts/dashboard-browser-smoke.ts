import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

const home = await mkdtemp(tmpdir() + "/dashboard-rest-browser-");
const bytes = await sharp({
  create: { width: 120, height: 90, channels: 3, background: "#4789a8" },
})
  .png()
  .toBuffer();
const calls: string[] = [];
let shared = true;
const backend = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.method !== "GET") {
    let raw = "";
    for await (const c of req) raw += c;
    const call = JSON.parse(raw);
    if (!call.id) {
      res.writeHead(202);
      res.end();
      return;
    }
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: call.id,
        result:
          call.method === "tools/list"
            ? { tools: [] }
            : call.method === "initialize"
              ? { protocolVersion: "2025-03-26" }
              : { structuredContent: {} },
      }),
    );
    return;
  }
  calls.push(req.url!);
  assert.equal(req.headers.authorization, "Bearer synthetic-browser-token");
  if (!shared) {
    res.writeHead(403);
    res.end('{"error":"private denial"}');
    return;
  }
  if (req.url?.startsWith("/api/friends/feed/dojo"))
    res.end(
      JSON.stringify({
        users: [{ _id: "ada", display_name: "Synthetic Ada" }],
        activities: [
          {
            _id: "photo",
            user_id: "ada",
            type: "media",
            name: "Progress check-in",
            created_at: "2026-09-28T12:00:00Z",
            data: { files: [{ _id: "one", type: "image/png" }] },
          },
          ...(
            [
              {
                _id: "workout",
                type: "workout",
                workout_progress: { completed_sets: 5 },
              },
              {
                _id: "meal",
                type: "meal",
                nutrition_summary: { calories: 420, protein: 30 },
              },
              { _id: "metricKg", type: "metric" },
              { _id: "metricLb", type: "metric" },
            ] as any[]
          ).map((a) => ({
            ...a,
            user_id: "ada",
            status: "complete",
            completed_at: "2026-09-28T12:00:00Z",
          })),
        ],
        hasMore: true,
        oldestDate: "2026-09-28T12:00:00Z",
      }),
    );
  else if (req.url?.startsWith("/api/friends/activity/metric"))
    res.end(
      JSON.stringify({
        data: {
          measurements: [
            {
              type_id: "weight",
              value: req.url.endsWith("Kg") ? 80 : 176,
              unit: req.url.endsWith("Kg") ? "kg" : "lb",
            },
          ],
        },
      }),
    );
  else if (req.url === "/api/friends/activity/photo")
    res.end(
      JSON.stringify({
        _id: "photo",
        type: "media",
        data: {
          files: ["one", "two", "three", "four"].map((_id) => ({
            _id,
            type: "image/png",
          })),
        },
      }),
    );
  else if (req.url?.startsWith("/api/media/photo/files/")) {
    res.setHeader("content-type", "image/png");
    res.end(bytes);
  } else {
    res.writeHead(404);
    res.end("{}");
  }
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
let app: Awaited<ReturnType<typeof admin>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(backend.address() as any).port}`,
    token: "synthetic-browser-token",
  });
  app = await admin(store, 0);
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  for (const width of [1440, 390, 320]) {
    shared = true;
    const context = await browser.newContext({
      viewport: { width, height: 900 },
    });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(app.origin + "/dashboard");
      await page.locator("#adminKey").fill(store.secrets.admin);
      await page.locator("#unlock").click();
      await page
        .getByText("More activities available", { exact: false })
        .waitFor({ timeout: 5000 });
      await page.waitForFunction(
        () =>
          document.querySelectorAll("#dashboardRoster img").length === 4 &&
          [
            ...document.querySelectorAll<HTMLImageElement>(
              "#dashboardRoster img",
            ),
          ].every((i) => i.complete && i.naturalWidth > 0),
        {},
        { timeout: 5000 },
      );
      assert.ok(calls.includes("/api/friends/activity/photo"));
      assert.equal(await page.locator("#dashboardRoster img").count(), 4);
      assert.equal(await page.locator("#dashboardCharts svg").count(), 7);
      assert.ok(
        await page
          .getByText("Synthetic Ada — weight (kg)", { exact: true })
          .count(),
      );
      assert.ok(
        await page
          .getByText("Synthetic Ada — weight (lb)", { exact: true })
          .count(),
      );
      await page.getByRole("button", { name: "Load older activities" }).click();
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardStatus")
          ?.textContent?.includes("More activities available"),
      );
      assert.ok(calls.some((path) => path.includes("beforeDate=")));
      assert.equal(await page.locator("#dashboardCharts svg").count(), 7);
      const before = calls.length;
      shared = false;
      await page.waitForTimeout(100);
      assert.equal(calls.length, before);
      assert.equal(await page.locator("#dashboardRoster img").count(), 4);
      await page.screenshot({
        path: `/tmp/coach-rest-client-logs/dashboard-${width}.png`,
        fullPage: true,
      });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      await page.locator("#dashboardRefresh").click();
      await page
        .getByText(/REST request denied \(403\)/)
        .waitFor({ timeout: 5000 });
      assert.equal(await page.locator("#dashboardRoster img").count(), 0);
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          width,
          decodedPhotos: 4,
          charts: 7,
          unitsSeparated: true,
          retainedWithoutPermissionCalls: true,
          nextFetchDenied: 403,
        }),
      );
    } finally {
      await context.close();
    }
  }
} finally {
  await browser?.close();
  await app?.close();
  backend.closeAllConnections();
  await new Promise<void>((r) => backend.close(() => r()));
  await rm(home, { recursive: true, force: true });
}
