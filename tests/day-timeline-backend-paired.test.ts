import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import sharp from "sharp";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import {
  startBackend,
  memoryBackendEnabled,
} from "./helpers/memory-backend.js";

// Disposable real Mongo/Express -> authenticated Coach BFF -> served Studio.
// The only substituted network resource is the synthetic basemap tile.
test(
  "paired day timeline includes unpositioned activities and links fresh detail to map",
  {
    skip: !memoryBackendEnabled,
    timeout: 120000,
  },
  async () => {
    process.env.JWT_SECRET = "synthetic-day-timeline-jwt";
    delete process.env.CLERK_SECRET_KEY;
    const b = await startBackend();
    const home = await mkdtemp(tmpdir() + "/day-timeline-pair-");
    let app: Awaited<ReturnType<typeof admin>> | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      b.app.use("/api/friends", b.require("./routes/friends"));
      const viewer = new b.ObjectId(),
        owner = new b.ObjectId(),
        dojo = new b.ObjectId();
      await b.db.collection("users").insertMany([
        {
          _id: viewer,
          username: "synthetic-viewer",
          display_name: "Synthetic Viewer",
          timezone: "UTC",
        },
        {
          _id: owner,
          username: "synthetic-ada",
          display_name: "Synthetic Ada",
          privacy_settings: {
            workout: ["dojo"],
            meal: ["dojo"],
            metric: ["dojo"],
            media: ["dojo"],
            survey: ["dojo"],
            position: ["dojo"],
          },
        },
      ]);
      await b.db.collection("dojos").insertOne({
        _id: dojo,
        chief_id: viewer,
        name: "Synthetic timeline QA",
      });
      await b.db.collection("dojo_members").insertMany([
        { user_id: viewer, dojo_id: dojo, role: "chief" },
        { user_id: owner, dojo_id: dojo, role: "member" },
      ]);
      const day = "2026-09-28";
      const activity = (type: string, at: string, position?: any) => ({
        _id: new b.ObjectId(),
        user_id: owner,
        type,
        status: "complete",
        name: `Synthetic ${type}`,
        created_at: new Date(`${day}T${at}:00.000Z`),
        completed_at: new Date(`${day}T${at}:00.000Z`),
        data: {},
        ...(position ? { position } : {}),
      });
      const workout = activity("workout", "09:00", {
        latitude: 42.36,
        longitude: -71.05,
      });
      const meal = activity("meal", "12:00");
      const metric = activity("metric", "12:00");
      const media = activity("media", "18:00");
      const pending = { ...activity("workout", "10:00"), status: "pending" };
      await b.db
        .collection("activities")
        .insertMany([workout, meal, metric, media, pending]);
      const human = b
        .require("jsonwebtoken")
        .sign(
          { user_id: String(viewer), username: "synthetic-viewer" },
          process.env.JWT_SECRET,
        );
      const issued = await fetch(
        b.origin + "/api/coach/external-agent/credentials",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${human}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: "Synthetic timeline pairing",
            rest_user_access: true,
          }),
        },
      );
      assert.equal(issued.status, 201);
      const { token } = (await issued.json()) as any;
      const store = new Store(home);
      await store.init();
      await store.save({ ...store.publicConfig(), origin: b.origin, token });
      app = await admin(store, 0);
      const headers = { Authorization: `Bearer ${store.secrets.admin}` };
      const query = new URLSearchParams({
        date: day,
        start: `${day}T00:00:00.000Z`,
        end: "2026-09-29T00:00:00.000Z",
      });
      const read = async () => {
        const response = await fetch(
          `${app!.origin}/api/dashboard/timeline?${query}`,
          { headers },
        );
        assert.equal(response.status, 200);
        return (await response.json()) as any;
      };
      const snapshot = await read();
      assert.equal(snapshot.hasMore, false);
      assert.deepEqual(
        snapshot.activities.map((a: any) => a._id).sort(),
        [workout, meal, metric, media].map((a) => String(a._id)).sort(),
      );
      assert.equal(
        snapshot.activities.filter((a: any) => a.position).length,
        1,
      );
      browser = await chromium.launch({
        executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
        args: ["--no-sandbox"],
      });
      const tile = await sharp({
        create: { width: 256, height: 256, channels: 3, background: "#ddd" },
      })
        .png()
        .toBuffer();
      const evidence =
        process.env.DASHBOARD_EVIDENCE_DIR ||
        "/tmp/coach-day-timeline/evidence";
      await mkdir(evidence, { recursive: true });
      for (const width of [1440, 390, 320]) {
        const context = await browser.newContext({
          viewport: { width, height: 1000 },
          timezoneId: "UTC",
        });
        try {
          const page = await context.newPage();
          const errors: string[] = [];
          const deniedReads: { path: string; status: number }[] = [];
          page.on("response", (response) => {
            if (
              response.url().includes("/api/dashboard") &&
              response.status() >= 400
            )
              deniedReads.push({
                path: new URL(response.url()).pathname,
                status: response.status(),
              });
          });
          page.on("pageerror", (e) => errors.push(e.message));
          await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (route) =>
            route.fulfill({ contentType: "image/png", body: tile }),
          );
          await page.goto(app.origin + "/dashboard");
          await page.locator("#adminKey").fill(store.secrets.admin);
          await page.locator("#unlock").click();
          await page.waitForFunction(() => {
            const timeline =
              document.querySelector("#dashboardTimeline")?.textContent || "";
            const map =
              document.querySelector("#dashboardMapStatus")?.textContent || "";
            return (
              !!timeline &&
              !timeline.includes("Loading") &&
              !!map &&
              !map.includes("Loading")
            );
          });
          await page.locator("#dashboardMapDate").fill(day);
          await page.locator("#dashboardMapDate").dispatchEvent("change");
          const marks = page.locator(".dashboard-timeline-mark");
          await page.waitForFunction(
            () =>
              document.querySelectorAll(".dashboard-timeline-mark").length ===
              4,
            {},
            { timeout: 20000 },
          );
          const mark = (id: any) =>
            page.locator(`.dashboard-timeline-mark[data-activity-id="${id}"]`);
          const pin = page.locator(
            `.dashboard-activity-pin[data-activity-id="${workout._id}"]`,
          );
          await pin.waitFor({ timeout: 10000 }).catch(async (error) => {
            const state = await page.evaluate(() => ({
              map: document.getElementById("dashboardMapStatus")?.textContent,
              timeline:
                document.getElementById("dashboardTimeline")?.textContent,
              pins: document.querySelectorAll(".dashboard-activity-pin").length,
            }));
            throw new Error(
              `${error.message}; denied reads: ${JSON.stringify(deniedReads)}; UI state: ${JSON.stringify(state)}`,
            );
          });
          const colors = await marks.evaluateAll((nodes) =>
            nodes.map((n) => getComputedStyle(n).backgroundColor),
          );
          assert.equal(new Set(colors).size, 4);
          await b.db
            .collection("activities")
            .updateOne(
              { _id: meal._id },
              { $set: { name: "Synthetic fresh meal detail" } },
            );
          await mark(meal._id).click();
          await page.waitForFunction(() =>
            document
              .querySelector("#dashboardMapSelection")
              ?.textContent?.includes("Synthetic fresh meal detail"),
          );
          assert.match(
            await page.locator("#dashboardMapSelection").innerText(),
            /position.*(unavailable|not shared|not available)|no.*position/i,
          );
          await mark(workout._id).click();
          await page.waitForFunction(() =>
            document
              .querySelector("#dashboardMapSelection")
              ?.textContent?.includes("Synthetic workout"),
          );
          assert.equal(await pin.getAttribute("aria-pressed"), "true");
          await pin.click();
          assert.equal(
            await mark(workout._id).getAttribute("aria-pressed"),
            "true",
          );
          const geometry = await page.evaluate(() => ({
            body: document.documentElement.scrollWidth,
            viewport: innerWidth,
            map: document
              .getElementById("dashboardMap")!
              .getBoundingClientRect()
              .toJSON(),
            timeline: document
              .getElementById("dashboardTimeline")!
              .getBoundingClientRect()
              .toJSON(),
            detail: document
              .getElementById("dashboardMapSelection")!
              .getBoundingClientRect()
              .toJSON(),
            scroll: (() => {
              const n = document.querySelector(".dashboard-timeline-scroll")!;
              return { client: n.clientWidth, full: n.scrollWidth };
            })(),
          }));
          assert.ok(
            geometry.timeline.top >= geometry.map.bottom - 1,
            JSON.stringify(geometry),
          );
          if (width >= 1000) {
            assert.ok(
              geometry.detail.left >= geometry.map.right - 1,
              JSON.stringify(geometry),
            );
            assert.ok(
              geometry.scroll.full <= geometry.scroll.client + 1,
              "Whole day fits desktop timeline: " + JSON.stringify(geometry),
            );
          }
          assert.ok(
            geometry.body <= geometry.viewport + 1,
            JSON.stringify(geometry),
          );
          const tickBoxes = await page
            .locator(".dashboard-timeline-tick")
            .evaluateAll((nodes) =>
              nodes.map((node) => {
                const r = node.getBoundingClientRect();
                return { text: node.textContent, left: r.left, right: r.right };
              }),
            );
          for (let i = 1; i < tickBoxes.length; i++) {
            assert.ok(
              tickBoxes[i].left >= tickBoxes[i - 1].right + 2,
              "Timeline tick labels have readable gaps: " +
                JSON.stringify(tickBoxes),
            );
          }
          await page.screenshot({
            path: `${evidence}/synthetic-paired-timeline-${width}.png`,
            fullPage: true,
          });
          assert.deepEqual(errors, []);
          assert.deepEqual(
            deniedReads.filter((read) => read.status === 429),
            [],
            "normal day/map/timeline/avatar load must not self-throttle",
          );
        } finally {
          await context.close();
        }
      }
      // Read back actual privacy withdrawal: activity remains, coordinates vanish.
      await b.db
        .collection("users")
        .updateOne(
          { _id: owner },
          { $set: { "privacy_settings.position": [] } },
        );
      assert.deepEqual(
        (await b.db.collection("users").findOne({ _id: owner }))
          .privacy_settings.position,
        [],
      );
      const redacted = await read();
      assert.equal(redacted.activities.length, 4);
      assert.ok(redacted.activities.every((a: any) => !a.position));
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        timezoneId: "UTC",
      });
      try {
        const page = await context.newPage();
        await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (route) =>
          route.fulfill({ contentType: "image/png", body: tile }),
        );
        await page.goto(app.origin + "/dashboard");
        await page.locator("#adminKey").fill(store.secrets.admin);
        await page.locator("#unlock").click();
        await page.waitForFunction(() => {
          const timeline =
            document.querySelector("#dashboardTimeline")?.textContent || "";
          const map =
            document.querySelector("#dashboardMapStatus")?.textContent || "";
          return (
            !!timeline &&
            !timeline.includes("Loading") &&
            !!map &&
            !map.includes("Loading")
          );
        });
        await page.locator("#dashboardMapDate").fill(day);
        await page.locator("#dashboardMapDate").dispatchEvent("change");
        await page
          .waitForFunction(
            () =>
              document.querySelectorAll(".dashboard-timeline-mark").length ===
              4,
          )
          .catch(async (error) => {
            const state = await page.evaluate(() => ({
              timeline:
                document.getElementById("dashboardTimeline")?.textContent,
              map: document.getElementById("dashboardMapStatus")?.textContent,
              marks: document.querySelectorAll(".dashboard-timeline-mark")
                .length,
              day: (
                document.getElementById("dashboardMapDate") as HTMLInputElement
              )?.value,
            }));
            throw new Error(
              `${error.message}; UI state: ${JSON.stringify(state)}`,
            );
          });
        const workoutMark = page.locator(
          `.dashboard-timeline-mark[data-activity-id="${workout._id}"]`,
        );
        await workoutMark.click();
        await page.waitForFunction(() =>
          document
            .querySelector("#dashboardMapSelection")
            ?.textContent?.includes("Synthetic workout"),
        );
        assert.match(
          await page.locator("#dashboardMapSelection").innerText(),
          /position.*(unavailable|not shared|not available)|no.*position/i,
        );
        assert.equal(await page.locator(".dashboard-activity-pin").count(), 0);
        // Revoke category after visible authorized snapshot, then click its mark.
        await b.db
          .collection("users")
          .updateOne({ _id: owner }, { $set: { "privacy_settings.meal": [] } });
        assert.deepEqual(
          (await b.db.collection("users").findOne({ _id: owner }))
            .privacy_settings.meal,
          [],
        );
        const mealMark = page.locator(
          `.dashboard-timeline-mark[data-activity-id="${meal._id}"]`,
        );
        await mealMark.click();
        await page.waitForFunction(
          (id) =>
            !document.querySelector(
              `.dashboard-timeline-mark[data-activity-id="${id}"]`,
            ),
          String(meal._id),
        );
        assert.equal(await page.locator(".dashboard-timeline-mark").count(), 3);
        assert.doesNotMatch(
          await page.locator("#dashboardMapSelection").innerText(),
          /Synthetic fresh meal detail/,
        );
      } finally {
        await context.close();
      }
      const denied = await fetch(
        `${app.origin}/api/dashboard/activity?id=${meal._id}`,
        { headers },
      );
      assert.equal(denied.status, 404);
      assert.equal((await read()).activities.length, 3);
    } finally {
      await browser?.close();
      await app?.close();
      await b.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
