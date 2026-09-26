import { test } from "node:test";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

for (const mode of ["refresh", "timed"] as const)
  test(`successful ${mode} revalidation clears raw data and fences delayed detail`, async () => {
    const evidence =
      process.env.COACH_EVIDENCE_DIR || `${tmpdir()}/katafit-studio-evidence`;
    await mkdir(evidence, { recursive: true });
    const server = createServer(async (req, res) => {
      const file = req.url === "/" ? "index.html" : req.url?.slice(1);
      if (
        !["index.html", "app.js", "terminal.js", "style.css"].includes(
          file || "",
        )
      )
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
        held: any,
        feedError = "",
        revokedWorkout = false;
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
        if (p === "/api/members/feed") {
          if (feedError)
            return route.fulfill({
              status: feedError === "UPDATE_IN_PROGRESS" ? 409 : 400,
              json: { error: feedError },
            });
          body = {
            member_ref: url.searchParams.get("member_ref"),
            items: [
              ...activities.map((activity, i) => ({
                id: activity.activity_ref,
                activity_ref: activity.activity_ref,
                type: "message",
                role: "coach",
                text: activity.name,
                created_at: `2026-09-22T12:0${i + 1}:00Z`,
              })),
              {
                id: "private",
                type: "message",
                role: "coach",
                text: "Private activity conversation without raw-data authority",
                created_at: "2026-09-22T12:00:00Z",
              },
            ],
            has_more: !url.searchParams.has("cursor"),
            next_cursor: url.searchParams.has("cursor") ? null : "second-page",
          };
        }
        assert.notEqual(p, "/api/members/activities");
        if (p === "/api/members/activity") {
          reads++;
          if (
            revokedWorkout &&
            url.searchParams.get("activity_ref") === "workout"
          )
            return route.fulfill({
              status: 403,
              json: { error: "PRIVATE_DENIAL" },
            });
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
      await page.locator(".member-item").first().waitFor();
      await page.evaluate("loadMemberFeed(true)");
      if (mode === "refresh") {
        await page.evaluate(() => {
          (window as any).firstMemberRow =
            document.querySelector(".member-item");
        });
        await page.evaluate("loadMemberFeed(false, true)");
        assert.equal(
          await page.evaluate(
            () =>
              document.querySelector(".member-item") ===
              (window as any).firstMemberRow,
          ),
          true,
          "unchanged authorized feed must not rebuild the chat DOM on timed revalidation",
        );
      }
      assert.equal(reads, 0, "visible message never hydrates private activity");
      assert.equal(await page.locator("#memberActivities").count(), 0);
      await page.locator(".member-thread > details > summary").nth(0).click();
      await page.getByText("Back squat", { exact: true }).click();
      await page.waitForFunction(() =>
        document.querySelector("#memberItems")?.textContent?.includes("60 kg"),
      );
      assert.match(await page.locator("#memberItems").innerText(), /8 reps/);

      await page.locator(".member-thread > details > summary").nth(2).click();
      await page.waitForFunction(
        () =>
          !!document.querySelector<HTMLImageElement>("#memberItems img")
            ?.naturalWidth,
      );
      const revalidate = async () => {
        if (mode === "timed")
          await page.evaluate("loadMemberFeed(false, true)");
        else {
          await page.evaluate("loadMemberFeed()");
          await page.evaluate("loadMemberFeed(true)");
        }
      };
      // Feed can succeed after category revocation; cached raw content must clear.
      await revalidate();
      assert.equal(
        (await page.locator("#memberItems").innerText()).includes("60 kg"),
        false,
      );
      assert.equal(await page.locator("#memberItems img").count(), 0);
      assert.ok(await page.evaluate(() => (window as any).revoked.length > 0));
      // A request started before successful revalidation cannot repaint afterward.

      hold = true;
      await page.locator(".member-thread > details > summary").nth(0).click();
      for (let i = 0; i < 50 && !held; i++) await page.waitForTimeout(20);
      assert.ok(held, "detail request is in flight");
      await revalidate();
      await held
        .fulfill({
          json: {
            schema_version: 1,
            member_ref: "alex",
            activity: activities[0],
            section: "workout_exercises",
            items: [{ _id: "late", name: "LATE_PRIVATE_DETAIL" }],
            has_more: false,
            next_cursor: null,
          },
        })
        .catch(() => {});
      await page.waitForTimeout(50);
      assert.equal(
        (await page.locator("#memberItems").innerText()).includes(
          "LATE_PRIVATE_DETAIL",
        ),
        false,
      );
      assert.match(
        await page.locator("#memberItems").innerText(),
        /Private activity conversation/,
      );
      hold = false;
      revokedWorkout = true;
      await page.locator(".member-thread > details > summary").nth(0).click();
      await page
        .locator(".member-thread > details")
        .first()
        .getByRole("button", { name: "Retry", exact: true })
        .waitFor();
      assert.doesNotMatch(
        await page.locator("#memberItems").innerText(),
        /60 kg|Back squat|LATE_PRIVATE_DETAIL|PRIVATE_DENIAL/,
      );
      assert.match(
        await page.locator("#memberItems").innerText(),
        /Private activity conversation/,
      );
      feedError = "BACKEND_TIMEOUT";
      await page.locator("#memberRefresh").click();
      await page.waitForFunction(
        () =>
          document
            .querySelector("#memberStatus")
            ?.textContent?.includes("timed out"),
        null,
        { timeout: 1500 },
      );
      assert.equal(await page.locator(".member-item").count(), 0);
      assert.doesNotMatch(
        await page.locator("#memberStatus").innerText(),
        /sharing may have changed/i,
      );
      feedError = "UPDATE_IN_PROGRESS";
      await page.locator("#memberRefresh").click();
      await page.waitForFunction(() =>
        document
          .querySelector("#memberStatus")
          ?.textContent?.includes("updating"),
      );
    } finally {
      await browser?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
