import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { startBackend } from "./helpers/memory-backend.js";

test(
  "real Mongo/ordinary auth → member Stats BFF → served Stats at desktop/390/320",
  { skip: !process.env.KATAFIT_MEMORY_BACKEND },
  async () => {
    const b = await startBackend();
    const home = await mkdtemp(tmpdir() + "/dojo-stats-");
    let server: Awaited<ReturnType<typeof admin>> | undefined, browser;
    try {
      const chief = new b.ObjectId(),
        member = new b.ObjectId(),
        dojo = new b.ObjectId(),
        credential = new b.ObjectId();
      const token = `rgn_coach_${credential}_${randomBytes(32).toString("base64url")}`;
      await b.db.collection("users").insertMany([
        { _id: chief, display_name: "Synthetic Chief" },
        {
          _id: member,
          display_name: "Synthetic Ada",
          timezone: "UTC",
          privacy_settings: {
            metric: ["dojo_chief"],
            media: ["dojo_chief"],
            meal: ["dojo_chief"],
            workout: ["dojo_chief"],
          },
        },
      ]);
      await b.db.collection("dojos").insertOne({ _id: dojo, chief_id: chief });
      await b.db
        .collection("dojo_members")
        .insertMany(
          [chief, member].map((user_id) => ({ user_id, dojo_id: dojo })),
        );
      await b.db.collection("external_coach_credentials").insertOne({
        _id: credential,
        user_id: chief,
        token_hash: createHash("sha256").update(token).digest("hex"),
        rest_user_access: true,
        created_at: new Date(),
        revoked_at: null,
        expires_at: new Date(Date.now() + 600000),
      });
      await b.db.collection("user_metric_types").insertOne({
        user_id: member,
        type_id: "custom",
        name: "<img src=x onerror=alert(1)> Safe custom",
      });
      await b.db.collection("activities").insertMany(
        Array.from({ length: 5 }, (_, i) => ({
          user_id: member,
          type: "metric",
          status: "complete",
          created_at: new Date(`2026-09-${10 + i}T12:00:00Z`),
          data: {
            measurements: [
              { type_id: "weight", value: 180 - i, unit: "lb" },
              { type_id: "sleep_minutes", value: 480 + i * 5 },
              { type_id: "custom", value: 10 + i },
            ],
          },
        })),
      );
      const food = new b.ObjectId();
      await b.db.collection("foods").insertOne({
        _id: food,
        serving_size: 100,
        serving_unit: "g",
        calories: 700,
        protein: 40,
        water_ml: 400,
      });
      await b.db
        .collection("exercises")
        .insertOne({ _id: "synthetic-lift", externalLoadFactor: 1.25 });
      for (let i = 0; i < 5; i++) {
        const day = `2026-09-${10 + i}`,
          date = new Date(day + "T12:00:00Z"),
          file = new b.ObjectId();
        await b.db.collection("activities").insertMany([
          {
            user_id: member,
            type: "workout",
            status: "complete",
            created_at: date,
            data: {
              exercises: [
                {
                  exercise_id: "synthetic-lift",
                  sets: [
                    { complete: true, repetitions: 10 + i, weight: 80 + i * 5 },
                  ],
                },
              ],
            },
          },
          {
            user_id: member,
            type: "meal",
            status: "complete",
            created_at: date,
            data: {
              foods: [{ food_id: food, quantity: 200 + i * 10, unit: "g" }],
            },
          },
          {
            user_id: member,
            type: "media",
            status: "complete",
            created_at: date,
            data: {
              files: [
                {
                  _id: file,
                  type: "image/jpeg",
                  inferences: [
                    {
                      result: {
                        subject_count: 1,
                        _session: { file_ids: [String(file)] },
                        estimated_body_fat_range: {
                          lower_bound: 0.19 - i * 0.005,
                          upper_bound: 0.23 - i * 0.005,
                        },
                        musculature_assessment: { overall_index: 6 + i * 0.2 },
                      },
                    },
                  ],
                },
              ],
            },
          },
        ]);
        await b.db.collection("daily_target_snapshots").insertOne({
          user_id: member,
          day_key: day,
          timezone: "UTC",
          source: "formula",
          calculation_version: 3,
          completion_revision: 0,
          calories: 2200 + i * 20,
          calories_min: 2000 + i * 20,
          calories_max: 2400 + i * 20,
          protein: 130,
          water_ml: 2500,
        });
        await b.db
          .collection("daily_target_revisions")
          .insertOne({ user_id: member, day_key: day, revision: 0 });
      }
      b.app.use((req: any, _res: any, next: any) => {
        req.cookies = {};
        next();
      });
      b.app.use("/api/friends", b.require("./routes/friends"));
      const store = new Store(home);
      await store.init();
      await store.save({ ...store.publicConfig(), origin: b.origin, token });
      server = await admin(store, 0);
      const headers = { Authorization: "Bearer " + store.secrets.admin };
      const response = await fetch(
        server.origin + `/api/dashboard/stats?user_id=${member}`,
        { headers },
      );
      assert.equal(response.status, 200);
      const dto: any = await response.json();
      assert.equal(dto.history.weight.length, 5);
      assert.equal(dto.history.bodyFat.length, 5);
      // Unknown subject-count evidence remains in storage but is ineligible for
      // body estimates. Do not restore the old unsafe implicit-single default.
      const photo = {
        user_id: member,
        type: "media",
        created_at: new Date("2026-09-10T12:00:00Z"),
      };
      const subjectPath = "data.files.0.inferences.0.result.subject_count";
      await b.db
        .collection("activities")
        .updateOne(photo, { $unset: { [subjectPath]: "" } });
      const unverifiedResponse = await fetch(
        server.origin + `/api/dashboard/stats?user_id=${member}`,
        { headers },
      );
      assert.equal(unverifiedResponse.status, 200);
      const unverified: any = await unverifiedResponse.json();
      assert.equal(unverified.history.bodyFat.length, 4);
      assert.equal(unverified.history.musculature.length, 4);
      assert.equal(unverified.history.weight.length, 5);
      await b.db
        .collection("activities")
        .updateOne(photo, { $set: { [subjectPath]: 1 } });
      assert.equal(dto.history.nutritionHistory.calories[0].target, 2200);
      assert.equal(dto.history.weeklyVolume[0].value > 0, true);
      assert.equal(dto.version, 1);
      assert.equal(dto.history.nutritionHistory.dailyTargets.length, 5);
      assert.equal(
        dto.history.nutritionHistory.dailyTargets[0].calories_min,
        2000,
      );
      await b.db.collection("users").updateOne(
        { _id: member },
        {
          $set: {
            privacy_settings: {
              meal: ["dojo_chief"],
              metric: [],
              media: [],
              workout: [],
            },
          },
        },
      );
      assert.deepEqual(
        (await b.db.collection("users").findOne({ _id: member }))
          .privacy_settings.metric,
        [],
      );
      const mealOnlyResponse = await fetch(
        server.origin + `/api/dashboard/stats?user_id=${member}`,
        { headers },
      );
      assert.equal(mealOnlyResponse.status, 200);
      const mealOnly: any = await mealOnlyResponse.json();
      assert.equal(mealOnly.history.weight, null);
      assert.equal(
        mealOnly.history.nutritionHistory.calories[0].targetMin,
        2000,
      );
      await b.db
        .collection("daily_target_snapshots")
        .updateOne(
          { user_id: member, day_key: "2026-09-10" },
          { $unset: { calories: "", calories_min: "", calories_max: "" } },
        );
      const incompleteResponse = await fetch(
        server.origin + `/api/dashboard/stats?user_id=${member}`,
        { headers },
      );
      assert.equal(incompleteResponse.status, 200);
      const incomplete: any = await incompleteResponse.json();
      assert.equal(
        incomplete.history.nutritionHistory.calories[0].targetMin,
        undefined,
      );
      assert.equal(
        incomplete.history.nutritionHistory.dailyTargets.find(
          (row: any) => row.day_key === "2026-09-10",
        ).calories,
        undefined,
      );
      await b.db
        .collection("daily_target_snapshots")
        .updateOne(
          { user_id: member, day_key: "2026-09-10" },
          { $set: { calories: 2200, calories_min: 2000, calories_max: 2400 } },
        );
      await b.db.collection("users").updateOne(
        { _id: member },
        {
          $set: {
            privacy_settings: {
              meal: ["dojo_chief"],
              metric: ["dojo_chief"],
              media: ["dojo_chief"],
              workout: ["dojo_chief"],
            },
          },
        },
      );

      // Real producer output, not a padded response: 1200 authorized older
      // measurements stay below the backend inventory/nested-source bounds.
      await b.db.collection("activities").insertMany(
        Array.from({ length: 1200 }, (_, i) => ({
          user_id: member,
          type: "metric",
          status: "complete",
          created_at: new Date(Date.UTC(2022, 0, 1 + i)),
          data: {
            measurements: [
              { type_id: "weight", value: 185, unit: "lb" },
              ...Array.from({ length: 3 }, () => ({
                type_id: "custom",
                value: 10,
              })),
            ],
          },
        })),
      );
      const largeResponse = await fetch(
        server.origin + `/api/dashboard/stats?user_id=${member}`,
        { headers },
      );
      assert.equal(largeResponse.status, 200);
      const largeText = await largeResponse.text();
      assert.ok(Buffer.byteLength(largeText) > 256 * 1024);
      assert.ok(Buffer.byteLength(largeText) < 2 * 1024 * 1024);
      assert.equal(JSON.parse(largeText).history.weight.length, 1205);
      console.log(
        JSON.stringify({
          syntheticMemberHistoryBytes: Buffer.byteLength(largeText),
          weightReadings: 1205,
          backendBffStatus: largeResponse.status,
        }),
      );

      const malformed = await fetch(
        server.origin +
          `/api/dashboard/stats?user_id=${member}&user_id=${member}`,
        { headers },
      );
      assert.equal(malformed.status, 400);
      browser = await chromium.launch({
        executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
        headless: true,
        args: ["--no-sandbox"],
      });
      const page = await browser.newPage({
        viewport: { width: 1280, height: 800 },
      });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("https://tile.openstreetmap.org/**", (route) =>
        route.abort(),
      );
      await page.goto(server.origin + "/dashboard");
      await page.locator("#adminKey").fill(store.secrets.admin);
      await page.locator("#unlock").click();
      await page.getByRole("tab", { name: "Stats", exact: true }).click();
      assert.equal(
        await page.locator("#dashboardSubtabs [role=tab]").count(),
        4,
      );
      await page
        .locator("#dashboardMemberCards button")
        .filter({ hasText: "Synthetic Ada" })
        .first()
        .click();
      await page
        .getByRole("button", { name: "Load / Retry member Stats" })
        .click();
      await page.locator(".stats-lane svg").first().waitFor();
      assert.equal(await page.locator(".stats-lane").count(), 10);
      const fatSummary = page.locator("[data-lane=bodyFat] details summary");
      await fatSummary.focus();
      await page.keyboard.press("Enter");
      assert.equal(
        await page
          .locator("[data-lane=bodyFat] details li")
          .first()
          .isVisible(),
        true,
      );
      await page.keyboard.press("Enter");
      await page
        .locator(".stats-lane details summary")
        .evaluateAll((els) => els.forEach((el) => (el as HTMLElement).click()));
      assert.match(
        await page.locator("[data-lane=bodyFat]").innerText(),
        /19.*23/,
      );
      assert.match(
        await page.locator("[data-lane=calories]").innerText(),
        /2000.*2400.*under budget/,
      );
      assert.match(
        await page.locator("[data-lane=protein]").innerText(),
        /130.*under target/,
      );
      assert.match(
        await page.locator("[data-lane=water]").innerText(),
        /2500.*under target/,
      );
      assert.match(
        await page.locator("[data-lane=weeklyScore]").innerText(),
        /partial week/,
      );
      assert.doesNotMatch(
        await page.locator("[data-lane=weeklyScore]").innerText(),
        /latest \d+\.\d/,
      );
      assert.ok(
        await page
          .locator("[data-lane=calories] circle[data-status=under]")
          .count(),
      );
      assert.match(
        await page
          .locator("[data-lane=custom]")
          .filter({ hasText: "Sleep" })
          .innerText(),
        /Sleep \(hours\).*7h.*reached/s,
      );
      assert.ok(await page.locator("[data-lane=bodyFat] [data-band]").count());
      assert.ok(await page.locator("[data-lane=calories] [data-band]").count());
      assert.equal(
        await page.locator(".stats-lane details summary").count(),
        10,
      );
      const axes = await page
        .locator(".stats-lane svg")
        .evaluateAll((els) =>
          els.map((el) =>
            [el.getAttribute("data-start"), el.getAttribute("data-end")].join(
              ":",
            ),
          ),
        );
      assert.equal(new Set(axes).size, 1);
      assert.notEqual(axes[0], ":");
      assert.ok(
        await page
          .locator("[data-lane=weeklyScore] rect[data-partial]")
          .count(),
      );
      assert.ok(
        await page.locator("[data-lane=custom] rect[data-status]").count(),
      );
      assert.equal(await page.getByLabel("Stats range").inputValue(), "90");
      await page.getByLabel("Stats weight units").selectOption("kg");
      assert.match(
        (await page.locator("[data-lane=weight]").textContent()) || "",
        /79.83/,
      );
      assert.equal(
        await page.locator("#dashboardStats img").count(),
        0,
        "custom label remains safe text",
      );
      await page.locator("#dashboardStatsPane").evaluate((el) => {
        const badge = document.createElement("p");
        badge.textContent =
          "SYNTHETIC FIXTURE — disposable Mongo + real Backend/BFF/Studio";
        el.prepend(badge);
      });
      const capture =
        process.env.KATAFIT_STATS_CAPTURE_DIR || home + "/synthetic-previews";
      await mkdir(capture, { recursive: true });
      for (const width of [1280, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        for (const key of ["bodyFat", "calories", "protein", "water"]) {
          const details = page.locator(`[data-lane=${key}] details`);
          if (
            !(await details.evaluate((el) => (el as HTMLDetailsElement).open))
          )
            await details.locator("summary").click();
          assert.equal(await details.locator("li").first().isVisible(), true);
        }
        await page.evaluate(() => scrollTo(0, 0));
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
          `overflow at ${width}`,
        );
        await page.screenshot({
          path: `${capture}/synthetic-stats-${width}.png`,
          fullPage: true,
        });
      }
      await page.getByLabel("Stats range").selectOption("all");
      await page.locator("[data-lane=weight] summary").click();
      assert.match(
        await page.locator("[data-lane=weight] li").first().innerText(),
        /2022-01-01/,
      );
      const weightPath = await page
        .locator('[data-lane=weight] path[stroke-width="1.5"]')
        .getAttribute("d");
      assert.ok(
        (weightPath?.match(/M/g) || []).length >= 2,
        "one-year historical gap remains disconnected",
      );
      await page
        .locator("#dashboardMemberCards button")
        .filter({ hasText: "Select\nAll" })
        .first()
        .click();
      await page
        .getByRole("button", { name: "Load next member Stats" })
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardStats")
          ?.textContent?.includes("2/2 member histories loaded"),
      );
      assert.equal(await page.locator(".stats-member").count(), 2);
      assert.equal(
        await page.locator(".stats-lane").count(),
        18,
        "8 lanes for empty chief plus 10 for Ada, never totals",
      );
      await page
        .locator("#dashboardMemberCards button")
        .filter({ hasText: "Synthetic Ada" })
        .first()
        .click();
      await page.getByRole("tab", { name: "Map & events" }).click();
      await page.getByRole("tab", { name: "Stats", exact: true }).click();
      assert.equal(await page.locator(".stats-lane").count(), 10);
      for (const invalid of [false, true]) {
        await page.route(
          "**/api/dashboard/stats?*",
          (route) =>
            route.fulfill(
              invalid
                ? {
                    status: 200,
                    json: {
                      ...dto,
                      history: { ...dto.history, weight: [null] },
                    },
                  }
                : { status: 503, json: { error: "synthetic transient" } },
            ),
          { times: 1 },
        );
        await page
          .getByRole("button", { name: "Refresh member Stats" })
          .click();
        await page.waitForFunction(() =>
          document
            .querySelector("#dashboardStats")
            ?.textContent?.includes("Retained history"),
        );
        assert.equal(await page.locator(".stats-lane").count(), 10);
        assert.equal(
          await page
            .getByRole("button", { name: "Refresh member Stats" })
            .isEnabled(),
          true,
        );
      }
      let releaseHeld!: () => void, heldStarted!: () => void;
      const held = new Promise<void>((r) => {
        heldStarted = r;
      });
      const release = new Promise<void>((r) => {
        releaseHeld = r;
      });
      await page.route(
        "**/api/dashboard/stats?*",
        async (route) => {
          const result = await route.fetch();
          heldStarted();
          await release;
          await route.fulfill({ response: result });
        },
        { times: 1 },
      );
      await page.getByRole("button", { name: "Refresh member Stats" }).click();
      await held;
      await page
        .locator("#dashboardMemberCards button")
        .filter({ hasText: "Select\nAll" })
        .first()
        .click();
      assert.equal(await page.locator(".stats-member").count(), 2);
      await page
        .locator("#dashboardMemberCards button")
        .filter({ hasText: "Synthetic Ada" })
        .first()
        .click();
      assert.equal(await page.locator(".stats-lane").count(), 10);
      try {
        await page.locator("#lockStudio").click();
        await b.db.collection("users").updateOne(
          { _id: member },
          {
            $set: {
              privacy_settings: {
                metric: [],
                media: [],
                meal: [],
                workout: [],
              },
            },
          },
        );
        assert.deepEqual(
          (await b.db.collection("users").findOne({ _id: member }))
            .privacy_settings.metric,
          [],
        );
        await page.locator("#adminKey").fill(store.secrets.admin);
        await page.locator("#unlock").click();
        await page.getByRole("tab", { name: "Stats", exact: true }).click();
        await page
          .locator("#dashboardMemberCards button")
          .filter({ hasText: "Synthetic Ada" })
          .first()
          .click();
        await page
          .getByRole("button", { name: "Load / Retry member Stats" })
          .click();
        await page.waitForFunction(() =>
          document
            .querySelector("#dashboardStats [data-lane=weight]")
            ?.textContent?.includes("Unavailable"),
        );
        const staleResponse = page.waitForResponse((r) =>
          r.url().includes("/api/dashboard/stats?"),
        );
        releaseHeld();
        await staleResponse;
        await page.evaluate(
          () =>
            new Promise((r) =>
              requestAnimationFrame(() => requestAnimationFrame(r)),
            ),
        );
        assert.equal(
          await page.locator(".stats-lane svg").count(),
          0,
          "late pre-lock acquired response cannot resurrect denied current scope",
        );
      } finally {
        releaseHeld();
      }
      await b.db
        .collection("external_coach_credentials")
        .updateOne({ _id: credential }, { $set: { revoked_at: new Date() } });
      assert.equal(
        (
          await fetch(
            server.origin + `/api/dashboard/stats?user_id=${member}`,
            { headers },
          )
        ).status,
        401,
      );
      await page.getByRole("button", { name: "Refresh member Stats" }).click();
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardStats")
          ?.textContent?.includes("Stats read denied (401)"),
      );
      assert.equal(await page.locator(".stats-lane svg").count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await server?.close();
      await b.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
