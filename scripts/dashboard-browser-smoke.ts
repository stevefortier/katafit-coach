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
                  stats_access: "shared",
                  photo_access: "shared",
                  photos: [
                    {
                      media_ref: "synthetic-photo",
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
                  stats_access: "not_shared",
                  charts: null,
                  photo_access: "not_shared",
                  photos: [],
                },
                {
                  member_ref: "three",
                  display_name: "Synthetic Cy",
                  stats_access: "shared",
                  photo_access: "shared",
                  photos: [],
                  charts: {
                    training: [
                      {
                        date: "2026-09-20",
                        completed_workouts: 1,
                        completed_sets: 1,
                      },
                    ],
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
      await page.goto(app.origin + "/dashboard");
      if (await page.locator("#studio").isVisible())
        throw Error("Dashboard visible before unlock");
      await page.locator("#adminKey").fill(store.secrets.admin);
      await page.locator("#unlock").click();
      await page.getByText("Shared dashboard loaded.").waitFor();
      if (
        (await page.locator("#dashboardRoster .dashboard-tile").count()) !== 3
      )
        throw Error("Expected synthetic roster");
      if ((await page.locator("#dashboardCharts svg").count()) !== 7)
        throw Error("Expected charts split by unit and domain");
      if (
        !(await page
          .getByText("2026-09-20 · 0 kcal · 1 contributor")
          .isVisible()) ||
        !(await page
          .getByText("2026-09-20 · 7 sets · 2 contributors")
          .isVisible())
      )
        throw Error("Readable per-point values and contributor counts missing");
      await page.locator("#dashboardRoster img").waitFor();
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
