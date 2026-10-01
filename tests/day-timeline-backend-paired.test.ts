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
  "paired event snapshots include unpositioned subjects while map retains live creation-time detail",
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
      // Canonical ledger fixtures test ordinary authorization + event DTOs.
      // Actual persistence->ledger coverage is independently paired in all-event-timeline-paired.
      const build = b.require(
        "./core/userActivityTimeline",
      ).buildUserActivityEvent;
      await b
        .require("./core/userActivityTimelineStore")
        .ensureUserActivityIndexes(b.db);
      const events = [workout, meal, metric, media].map((a, i) => ({
        _id: new b.ObjectId(),
        ...build({
          ownerUserId: owner,
          actorUserId: owner,
          actorType: "member",
          source: "interactive",
          requestId: `fixture-${i}`,
          eventKey: `fixture-${i}`,
          subjectType: a.type,
          subjectId: a._id,
          occurredAt: a.created_at,
          requestReceivedAt: a.created_at,
          eventType: `${a.type}.created`,
          details: {},
        }),
      }));
      await b.db.collection("user_activity_events").insertMany(events);
      const snapshot = await read();
      assert.equal(snapshot.hasMore, false);
      assert.deepEqual(
        snapshot.events.map((e: any) => e.id).sort(),
        events.map((e) => String(e._id)).sort(),
      );
      assert.ok(snapshot.events.every((e: any) => !e.position));
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
          page.on("pageerror", (e) => errors.push(e.message));
          await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (route) =>
            route.fulfill({ contentType: "image/png", body: tile }),
          );
          await page.goto(app.origin + "/dashboard");
          await page.locator("#adminKey").fill(store.secrets.admin);
          await page.locator("#unlock").click();
          await page.waitForFunction(
            () =>
              document.querySelector("#dashboardTimeline > p")?.textContent &&
              !document
                .querySelector("#dashboardTimeline > p")
                ?.textContent?.includes("Loading"),
          );
          await page.locator("#dashboardMapDate").fill(day);
          await page.locator("#dashboardMapDate").dispatchEvent("change");
          await page.waitForFunction(
            () =>
              document.querySelectorAll(".dashboard-timeline-mark").length ===
              4,
          );
          const mark = page.locator(`[data-event-id="${events[1]._id}"]`);
          await mark.click();
          assert.match(
            await page.locator("#dashboardMapSelection").innerText(),
            /meal created/,
          );
          assert.match(
            await page.locator("#dashboardMapSelection").innerText(),
            /historical event snapshot/,
          );
          const pin = page.locator(
            `.dashboard-activity-pin[data-activity-id="${workout._id}"]`,
          );
          await pin.waitFor();
          await pin.click();
          await page.getByText("Synthetic workout", { exact: true }).waitFor();
          assert.equal(await pin.getAttribute("aria-pressed"), "true");
          await mark.click();
          assert.equal(await mark.getAttribute("aria-pressed"), "true");
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
            true,
          );
          await page.locator("#dashboardTimeline").scrollIntoViewIfNeeded();
          await page.screenshot({
            path: `${evidence}/synthetic-paired-events-${width}.png`,
            fullPage: true,
          });
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      }
      await b.db.collection("users").updateOne(
        { _id: owner },
        {
          $set: {
            "privacy_settings.position": [],
            "privacy_settings.meal": [],
          },
        },
      );
      const ownerAfter = await b.db.collection("users").findOne({ _id: owner });
      assert.deepEqual(ownerAfter.privacy_settings.position, []);
      assert.deepEqual(ownerAfter.privacy_settings.meal, []);
      const redacted = await read();
      assert.equal(redacted.events.length, 3);
      assert.ok(
        redacted.events.every(
          (e: any) => !e.position && e.subject.id !== String(meal._id),
        ),
      );
      const denied = await fetch(
        `${app.origin}/api/dashboard/activity?id=${meal._id}`,
        { headers },
      );
      assert.equal(denied.status, 404);
    } finally {
      await browser?.close();
      await app?.close();
      await b.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
