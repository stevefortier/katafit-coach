import { test } from "node:test";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

test("activity expansion is lazy, authenticated, bounded to its view, and retryable", async () => {
  const evidence =
    process.env.COACH_EVIDENCE_DIR || `${tmpdir()}/katafit-studio-evidence`;
  await mkdir(evidence, { recursive: true });
  const server = createServer(async (req, res) => {
    const file = req.url === "/" ? "index.html" : req.url?.slice(1);
    if (!["index.html", "app.js", "style.css"].includes(file || ""))
      return void res.writeHead(404).end();
    res.setHeader(
      "Content-Type",
      file!.endsWith("js")
        ? "text/javascript"
        : file!.endsWith("css")
          ? "text/css"
          : "text/html",
    );
    res.end(await readFile(new URL("../ui/" + file, import.meta.url)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 1000 },
    });
    const imageFixture = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 240;
      canvas.height = 160;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#2c3d2e";
      ctx.fillRect(0, 0, 240, 160);
      ctx.fillStyle = "#d4f4a3";
      ctx.font = "18px sans-serif";
      ctx.fillText("SYNTHETIC PHOTO", 20, 70);
      ctx.fillText("Transport fixture", 20, 100);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    let reads = 0,
      media = 0,
      failMeal = true,
      hugeMeal = true,
      hold = false,
      held: any;
    const activities = [
      { activity_ref: "workout", type: "workout", name: "Strength session" },
      { activity_ref: "meal", type: "meal", name: "Recovery lunch" },
      { activity_ref: "photo", type: "media", name: "Progress photo" },
    ];
    await page.addInitScript(() => {
      (window as any).revoked = [];
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = (url: string) => {
        (window as any).revoked.push(url);
        revoke(url);
      };
    });
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url()),
        p = url.pathname;
      assert.equal(
        route.request().headers().authorization,
        "Bearer synthetic-admin",
      );
      let body: any = {};
      if (p === "/api/config")
        body = {
          revision: 1,
          origin: "https://synthetic.invalid",
          provider: {
            model: "synthetic",
            baseUrl: "https://synthetic.invalid",
          },
          persona: Object.fromEntries(
            [
              "name",
              "voice",
              "principles",
              "examples",
              "boundaries",
              "initiative",
              "verbosity",
              "markdown",
            ].map((n) => [n, n === "verbosity" ? "Balanced" : ""]),
          ),
        };
      if (p === "/api/status") body = { state: "stopped" };
      if (p === "/api/operator/chat") body = { messages: [] };
      if (p === "/api/members")
        body = {
          members: [
            {
              member_ref: "alex",
              display_name: "Synthetic Alex",
              access: "granted",
            },
            {
              member_ref: "blair",
              display_name: "Synthetic Blair",
              access: "granted",
            },
          ],
          has_more: false,
        };
      if (p === "/api/members/feed")
        body = {
          member_ref: url.searchParams.get("member_ref"),
          items: [
            {
              id: "private",
              type: "message",
              role: "coach",
              text: "Private activity conversation without raw-data authority",
              created_at: "2026-09-22T12:00:00Z",
            },
          ],
          has_more: false,
        };
      if (p === "/api/members/activities") {
        reads++;
        body = {
          member_ref: url.searchParams.get("member_ref"),
          items: activities,
          has_more: false,
        };
      }
      if (p === "/api/members/activity") {
        reads++;
        if (hold) {
          held = route;
          return;
        }
        const ref = url.searchParams.get("activity_ref"),
          section = url.searchParams.get("section");
        if (ref === "meal" && failMeal) {
          failMeal = false;
          return route.fulfill({
            status: 403,
            json: { error: "PRIVATE_DENIAL" },
          });
        }
        const items =
          section === "workout_exercises"
            ? [{ _id: "squat", name: "Back squat" }]
            : section === "workout_sets"
              ? [{ weight: 60, weight_unit: "kg", reps: 8, complete: true }]
              : section === "meal_foods"
                ? [
                    {
                      name: "Oats",
                      quantity: 80,
                      unit: "g",
                      calories: 300,
                      protein: 10,
                      carbs: 50,
                      fat: 6,
                      nutrition_source: "logged_snapshot",
                    },
                  ]
                : section === "media_files"
                  ? [{ type: "image", media_ref: "photo-bytes" }]
                  : [];
        body = {
          schema_version: 1,
          member_ref: url.searchParams.get("member_ref"),
          activity: activities.find((a) => a.activity_ref === ref),
          section,
          items,
          has_more: false,
          next_cursor: null,
        };
        if (ref === "meal" && hugeMeal) {
          hugeMeal = false;
          body.padding = "x".repeat(300000);
        }
      }
      if (p === "/api/members/media") {
        media++;
        return route.fulfill({
          contentType: "image/png",
          body: Buffer.from(imageFixture, "base64"),
        });
      }
      await route.fulfill({ json: body });
    });
    await page.goto(`http://127.0.0.1:${(server.address() as any).port}/`);
    await page.locator("#adminKey").fill("synthetic-admin");
    await page.locator("#unlock").click();
    await page
      .getByRole("button", { name: "Synthetic Alex", exact: true })
      .click();
    await page.locator(".member-item").waitFor();
    assert.equal(reads, 0, "visible message never hydrates private activity");
    assert.equal(
      await page.locator("#memberActivities").count(),
      1,
      "lazy activity browser exists",
    );
    await page.locator("#memberActivities > summary").click();
    await page.getByText("Strength session", { exact: true }).click();
    await page.getByText("Back squat", { exact: true }).click();
    await page.waitForFunction(() =>
      document
        .querySelector("#memberActivities")
        ?.textContent?.includes("60 kg"),
    );
    assert.match(await page.locator("#memberActivities").innerText(), /8 reps/);
    await page.getByText("Recovery lunch", { exact: true }).click();
    const meal = page
      .locator("details.activity-card")
      .filter({ has: page.getByText("Recovery lunch", { exact: true }) });
    await meal.getByRole("button", { name: "Retry", exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(
      await meal.getByRole("button", { name: "Retry", exact: true }).count(),
      1,
      "oversized JSON fails closed",
    );
    await meal.getByRole("button", { name: "Retry", exact: true }).click();
    await page.waitForFunction(() =>
      document
        .querySelector("#memberActivities")
        ?.textContent?.includes("Oats"),
    );
    assert.match(await meal.innerText(), /80 g/);
    assert.match(await meal.innerText(), /300/);
    assert.equal(media, 0);
    await page.getByText("Progress photo", { exact: true }).click();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll("#memberActivities img")).some(
        (i) => (i as HTMLImageElement).naturalWidth > 0,
      ),
    );
    assert.equal(media, 1);
    for (const [name, width, height] of [
      ["desktop", 1280, 1000],
      ["mobile", 390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.locator("#memberActivities").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: evidence + "/activities-" + name + ".png",
        fullPage: true,
      });
    }
    await page.getByText("Progress photo", { exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll("#memberActivities img").length === 0,
    );
    assert.equal(await page.locator("#memberActivities img").count(), 0);
    assert.ok(
      (await page.evaluate(() => (window as any).revoked.length)) > 0,
      "collapse revokes image URLs",
    );
    await page.getByText("Recovery lunch", { exact: true }).click();
    hold = true;
    await page.getByText("Recovery lunch", { exact: true }).click();
    await page.waitForFunction(() =>
      document
        .querySelector("#memberActivities")
        ?.textContent?.includes("Loading"),
    );
    await page.waitForTimeout(50);
    assert.ok(held);
    await page
      .getByRole("button", { name: "Synthetic Blair", exact: true })
      .click();
    await held
      .fulfill({
        json: {
          schema_version: 1,
          member_ref: "alex",
          activity: activities[1],
          section: "meal_foods",
          items: [{ name: "STALE PRIVATE DETAIL" }],
          has_more: false,
        },
      })
      .catch(() => {});
    await page.waitForTimeout(50);
    assert.doesNotMatch(
      await page.locator("body").innerText(),
      /STALE PRIVATE DETAIL|PRIVATE_DENIAL/,
    );
    await page.locator("#lockStudio").click();
    assert.equal(await page.locator("#memberActivities img").count(), 0);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
