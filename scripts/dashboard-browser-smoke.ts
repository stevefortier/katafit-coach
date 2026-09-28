import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

const home = await mkdtemp(tmpdir() + "/dashboard-browser-");
const photoBytes = await sharp({
  create: { width: 120, height: 90, channels: 3, background: "#4789a8" },
})
  .png()
  .toBuffer();
const imageMeta = {
  schema_version: 1,
  representation: "original",
  mime_type: "image/png",
  byte_count: photoBytes.length,
  sha256: createHash("sha256").update(photoBytes).digest("hex"),
  width: 120,
  height: 90,
};
const backend = createServer(async (req, res) => {
  let raw = "";
  for await (const part of req) raw += part;
  const call = JSON.parse(raw);
  res.setHeader("Content-Type", "application/json");
  if (!call.id) {
    res.writeHead(202);
    res.end();
    return;
  }
  const result =
    call.method === "initialize"
      ? { protocolVersion: "2025-03-26" }
      : call.params?.name === "studio_dashboard_read_photo"
        ? {
            structuredContent: imageMeta,
            content: [
              { type: "text", text: JSON.stringify(imageMeta) },
              {
                type: "image",
                mimeType: "image/png",
                data: photoBytes.toString("base64"),
              },
            ],
          }
        : {
            structuredContent: {
              schema_version: 1,
              owner_type: "dojo",
              period_days: 30,
              has_more: false,
              next_cursor: null,
              members: [
                {
                  member_ref: "one",
                  display_name: "Synthetic Ada",
                  category_access: {
                    training: "shared",
                    nutrition: "shared",
                    body: "shared",
                  },
                  photo_access: "shared",
                  photos: [
                    {
                      media_ref: "synthetic-photo",
                      checkin_at: "2026-09-20T12:00:00Z",
                    },
                    {
                      media_ref: "synthetic-photo-two",
                      checkin_at: "2026-09-20T12:00:00Z",
                    },
                  ],
                  charts: {
                    training: [
                      {
                        date: "2026-09-20",
                        completed_workouts: 2,
                        completed_sets: 6,
                      },
                      {
                        date: "2026-09-21",
                        completed_workouts: 1,
                        completed_sets: 2,
                      },
                      {
                        date: "2026-09-27",
                        completed_workouts: 1,
                        completed_sets: 3,
                      },
                    ],
                    nutrition: [
                      {
                        date: "2026-09-20",
                        logged_meals: 3,
                        recorded_calories: 0,
                        recorded_protein_g: 48,
                      },
                    ],
                    body: [
                      {
                        date: "2026-09-20",
                        type_id: "weight",
                        value: 80,
                        unit: "kg",
                      },
                    ],
                    limitations: "Synthetic activity counts, not adherence.",
                  },
                },
                {
                  member_ref: "two",
                  display_name: "Synthetic Bea",
                  category_access: {
                    training: "not_shared",
                    nutrition: "not_shared",
                    body: "not_shared",
                  },
                  charts: {
                    training: null,
                    nutrition: null,
                    body: null,
                    limitations: null,
                  },
                  photo_access: "not_shared",
                  photos: [],
                },
                {
                  member_ref: "three",
                  display_name: "Synthetic Cy",
                  category_access: {
                    training: "not_shared",
                    nutrition: "shared",
                    body: "shared",
                  },
                  photo_access: "shared",
                  photos: [],
                  charts: {
                    training: null,
                    nutrition: [],
                    body: [
                      {
                        date: "2026-09-20",
                        type_id: "weight",
                        value: 180,
                        unit: "lb",
                      },
                    ],
                    limitations: "Synthetic activity counts, not adherence.",
                  },
                },
              ],
            },
          };
  res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
});
let app: Awaited<ReturnType<typeof admin>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
try {
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(backend.address() as any).port}`,
    token: "synthetic-dashboard-browser",
  });
  app = await admin(store, 0);
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  for (const [width, label] of [
    [1440, "desktop"],
    [390, "mobile"],
    [320, "narrow"],
  ] as const) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
    });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(() => {
        const revoke = URL.revokeObjectURL.bind(URL);
        (window as any).dashboardRevoked = [];
        URL.revokeObjectURL = (url) => {
          (window as any).dashboardRevoked.push(url);
          revoke(url);
        };
      });
      await page.goto(app.origin + "/dashboard");
      if (await page.locator("#studio").isVisible())
        throw Error("Dashboard visible before unlock");
      await page.locator("#adminKey").fill(store.secrets.admin);
      await page.locator("#unlock").click();
      await page
        .getByText("Shared dashboard loaded.")
        .waitFor({ timeout: 5000 })
        .catch(async (error) => {
          const apiStatus = await page.evaluate(
            async (key) =>
              (
                await fetch("/api/dashboard", {
                  headers: { Authorization: "Bearer " + key },
                })
              ).status,
            store.secrets.admin,
          );
          throw Error(
            `${error.message}; api=${apiStatus}; status=${await page.locator("#dashboardStatus").innerText()}; pageErrors=${errors.join(";")}`,
          );
        });
      if (
        !(await page.getByText("1 training-shared among shown").isVisible()) ||
        !(await page.getByText("2 body-shared among shown").isVisible()) ||
        !(await page
          .getByText("Training not shared", { exact: true })
          .first()
          .isVisible()) ||
        (await page.getByText("Statistics shared").count())
      )
        throw Error("Category authorization not reflected in dashboard");
      if (
        (await page.locator("#dashboardRoster .dashboard-tile").count()) !== 3
      )
        throw Error("Expected synthetic roster");
      if ((await page.locator("#dashboardCharts svg").count()) !== 7)
        throw Error("Expected charts split by unit and domain");
      if (
        !(await page
          .getByText("Synthetic Ada — Completed workouts (workouts)")
          .isVisible())
      )
        throw Error("Member-specific curve heading missing");
      const workoutGraph = page.locator("#dashboardCharts svg").first();
      if (
        !(await workoutGraph.getByText("Date (UTC)").count()) ||
        !(await workoutGraph.getByText("Workouts").count())
      )
        throw Error("Chart axes need visible date and metric labels");
      const firstPoint = workoutGraph.locator("circle[tabindex='0']").first();
      const x = await workoutGraph
        .locator("circle[tabindex='0']")
        .evaluateAll((dots) =>
          dots.map((dot) => Number(dot.getAttribute("cx"))),
        );
      if (x.length !== 3 || !(x[1] - x[0] < (x[2] - x[1]) / 3))
        throw Error("Uneven dates must have proportional spacing");
      await firstPoint.hover();
      if (
        !(await page
          .getByRole("tooltip")
          .getByText("Synthetic Ada · 2026-09-20 · 2 workouts")
          .isVisible())
      )
        throw Error("Hovered point did not expose member, date and value");
      await firstPoint.focus();
      await page.mouse.move(0, 0);
      if (!(await page.getByRole("tooltip").isVisible()))
        throw Error(
          "Keyboard focus did not preserve point tooltip after pointer exit",
        );
      if (width < 650) {
        const card = page.locator("#dashboardCharts .dashboard-chart").first();
        await card.evaluate((el) => {
          el.scrollLeft = el.scrollWidth;
        });
        const lastPoint = workoutGraph.locator("circle[tabindex='0']").last();
        await lastPoint.hover();
        const [tooltipBox, cardBox] = await Promise.all([
          page.getByRole("tooltip").boundingBox(),
          card.boundingBox(),
        ]);
        if (
          !tooltipBox ||
          !cardBox ||
          tooltipBox.x < cardBox.x ||
          tooltipBox.x + tooltipBox.width > cardBox.x + cardBox.width
        )
          throw Error("Tooltip escaped horizontally scrolled chart viewport");
      }
      await page.waitForFunction(
        () =>
          [
            ...document.querySelectorAll(
              "#dashboardRoster .dashboard-tile:first-child img",
            ),
          ].filter((img) => (img as HTMLImageElement).naturalWidth === 120)
            .length === 2,
      );
      if (
        (await page
          .locator("#dashboardRoster .dashboard-tile:first-child img")
          .count()) !== 2
      )
        throw Error("Latest check-in gallery dropped a photo");
      await page.waitForFunction(() =>
        [...document.querySelectorAll("#dashboardRoster img")].some(
          (img) => (img as HTMLImageElement).naturalWidth === 120,
        ),
      );
      if (
        !(await page.getByText("Photo not shared").isVisible()) ||
        !(await page
          .getByText("No progress photo available")
          .first()
          .isVisible())
      )
        throw Error("Missing photo states");
      if (
        await page
          .locator("#studio")
          .evaluate((element) => element.scrollWidth > window.innerWidth + 1)
      )
        throw Error("Horizontal overflow");
      if (errors.length) throw Error(`Browser errors: ${errors.join(";")}`);
      const snapshot = (await (
        await fetch(app.origin + "/api/dashboard", {
          headers: { Authorization: `Bearer ${store.secrets.admin}` },
        })
      ).json()) as any;
      const empty = structuredClone(snapshot);
      empty.series.nutrition = [];
      await page.route("**/api/dashboard", (route) =>
        route.fulfill({ json: empty }),
      );
      await page.locator("#dashboardRefresh").click();
      await page
        .getByText("No shared data in this category for this period.")
        .waitFor();
      const unavailable = structuredClone(empty);
      unavailable.coverage.category_shared.training = 0;
      unavailable.series.training = [];
      for (const member of unavailable.members)
        member.category_access.training = "not_shared";
      await page.unroute("**/api/dashboard");
      await page.route("**/api/dashboard", (route) =>
        route.fulfill({ json: unavailable }),
      );
      await page.locator("#dashboardRefresh").click();
      await page.getByText("No shown members share this category.").waitFor();
      if ((await page.locator("#dashboardCharts svg").count()) !== 2)
        throw Error("Unavailable training category leaked graphs");
      await page.unroute("**/api/dashboard");
      await page.locator("#dashboardRefresh").click();
      await page.getByText("2026-09-20 · 6 sets").waitFor();
      await page.waitForFunction(
        () =>
          [
            ...document.querySelectorAll(
              "#dashboardRoster .dashboard-tile:first-child img",
            ),
          ].filter((img) => (img as HTMLImageElement).naturalWidth === 120)
            .length === 2,
      );
      await page.evaluate(() => {
        const label = document.createElement("p");
        label.textContent =
          "SYNTHETIC FIXTURE — local served Studio preview, not member data";
        label.setAttribute(
          "style",
          "color:#fcd34d; font-size:12px; text-align:center; border:1px solid #fcd34d; padding:5px",
        );
        document.querySelector("#dashboardPanel")?.prepend(label);
      });
      await page.screenshot({
        path: `${process.env.COACH_EVIDENCE_DIR ?? "/tmp"}/coach-dashboard-synthetic-${label}.png`,
        fullPage: true,
      });
      await page.locator("#diagnosticsTab").click();
      if (
        (await page.evaluate(() => (window as any).dashboardRevoked.length)) < 2
      )
        throw Error("Photo blob URLs not revoked on navigation");
      if (!page.url().includes("/diagnostics"))
        throw Error("Activity route broken");
      await page.locator("#settingsTab").click();
      if (!page.url().includes("/settings"))
        throw Error("Settings route broken");
      await page.locator("#coachTab").click();
      if (!page.url().includes("/chat/operator"))
        throw Error("Operator route broken");
      if (await page.locator("[id*=memberTab]").count())
        throw Error("Member tab resurrected");
      await page.locator("#dashboardTab").click();
      await page.getByText("Shared dashboard loaded.").waitFor();
      await page.locator("#lockStudio").click();
      if (
        (await page.locator("#studio").isVisible()) ||
        (await page.locator("#dashboardRoster").innerText())
      )
        throw Error("Lock did not clear dashboard");
      console.log(
        `synthetic ${label}: roster, charts, nav, lock, screenshot OK`,
      );
    } finally {
      await context.close();
    }
  }
} finally {
  await browser?.close();
  await app?.close();
  await new Promise<void>((resolve) => backend.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
}
