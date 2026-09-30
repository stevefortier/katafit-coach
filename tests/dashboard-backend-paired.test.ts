import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import {
  startBackend,
  memoryBackendEnabled,
} from "./helpers/memory-backend.js";

// REAL Mongo replica set → ordinary Express routes → real admin BFF → served
// Studio HTML/CSP. Only object storage bytes are synthetic: generated 32px JPEGs.
// No live users, production DB, model inference, or fake HTTP response envelopes.
test(
  "paired synthetic dashboard decodes four JPEGs and completed body charts through real routes",
  { skip: !memoryBackendEnabled, timeout: 120000 },
  async () => {
    process.env.JWT_SECRET = "synthetic-dashboard-jwt";
    delete process.env.CLERK_SECRET_KEY;
    const b = await startBackend();
    const home = await mkdtemp(tmpdir() + "/dashboard-backend-paired-");
    let app: Awaited<ReturnType<typeof admin>> | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    const evidence =
      process.env.DASHBOARD_EVIDENCE_DIR ||
      "/tmp/coach-rest-dashboard-fix-logs";
    await mkdir(evidence, { recursive: true });
    try {
      const jpegs = await Promise.all(
        ["#4789a8", "#a87847", "#78a847", "#8947a8"].map((background) =>
          sharp({ create: { width: 32, height: 32, channels: 3, background } })
            .jpeg()
            .toBuffer(),
        ),
      );
      const storage = new Map<string, Buffer>();
      const storageCalls: string[] = [];
      const media = b.require("./core/activities/media");
      media.getMediaFile = async (id: string) => {
        storageCalls.push(id);
        assert.ok(storage.has(id), "only seeded synthetic storage files exist");
        return {
          fileStream: Readable.from([storage.get(id)!]),
          contentType: "image/jpeg",
        };
      };
      b.app.use("/api", b.require("./routes/media"));
      b.app.use("/api/friends", b.require("./routes/friends"));
      const viewer = new b.ObjectId(),
        owner = new b.ObjectId(),
        dojo = new b.ObjectId();
      const now = new Date(Date.now() - 1000);
      const day = now.toISOString().slice(0, 10);
      const files = Array.from({ length: 4 }, () => ({
        _id: String(new b.ObjectId()),
        type: "image/jpeg",
        name: "SYNTHETIC-32px.jpg",
      }));
      files.forEach((file, i) => storage.set(file._id, jpegs[i]));
      const row = (type: string, data: any, extra: any = {}) => ({
        _id: new b.ObjectId(),
        user_id: owner,
        type,
        status: "complete",
        created_at: now,
        completed_at: now,
        name: "Synthetic QA check-in",
        data,
        ...extra,
      });
      const photo = row("media", { files });
      const weight = (value: any, unit?: string, extra = {}) => ({
        type_id: "weight",
        value,
        ...(unit ? { unit } : {}),
        ...extra,
      });
      const metric = row("metric", {
        measurements: [
          weight("80.5", "kg"),
          weight("176", "lb"),
          { type_id: "fat_percentage", value: "20", unit: "%" },
          weight("80kg", "kg"),
          weight("1e2", "kg"),
          weight(1001, "kg"),
          weight(0, "lb"),
          weight(900),
          weight(111, "stones"),
          { type_id: "fat_percentage", value: 101, unit: "%" },
        ],
      });
      // Filed position is synthetic; the backend must independently authorize
      // the Position audience as well as the metric activity audience.
      metric.position = {
        latitude: 42.3601,
        longitude: -71.0589,
        accuracy: 12,
        source: "gps",
        captured_at: now,
      };
      const hc = row(
        "metric",
        {
          measurements: [
            weight("178", undefined, {
              health_connect: { date: day, value: "178" },
            }),
            weight(888, undefined, {
              health_connect: { date: "2026-02-30", value: 888 },
            }),
          ],
        },
        { source: { provider: "health_connect" } },
      );
      const wrong = row(
        "metric",
        {
          measurements: [
            weight(999, undefined, {
              health_connect: { date: day, value: 999 },
            }),
          ],
        },
        { source: { provider: "wrong" } },
      );
      const pending = row(
        "metric",
        { measurements: [weight(999, "kg")] },
        { status: "pending" },
      );
      const missed = row(
        "metric",
        { measurements: [weight(998, "kg")] },
        { status: "missed", missed_at: now },
      );
      const oldDate = new Date(+now - 86400000);
      const oldPhoto = row(
        "media",
        { files },
        { created_at: oldDate, completed_at: oldDate },
      );
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
            media: ["dojo"],
            metric: ["dojo"],
            workout: ["dojo"],
            position: ["dojo"],
          },
        },
      ]);
      await b.db
        .collection("dojos")
        .insertOne({ _id: dojo, chief_id: viewer, name: "Synthetic QA only" });
      await b.db.collection("dojo_members").insertMany([
        { user_id: viewer, dojo_id: dojo, role: "chief" },
        { user_id: owner, dojo_id: dojo, role: "member" },
      ]);
      await b.db
        .collection("activities")
        .insertMany([photo, oldPhoto, metric, hc, wrong, pending, missed]);
      assert.equal(
        await b.db.collection("activities").countDocuments({ user_id: owner }),
        7,
      );
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
            name: "Synthetic dashboard pairing",
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
      const mapHeaders = { Authorization: `Bearer ${store.secrets.admin}` };
      const mapQuery = new URLSearchParams({
        date: day,
        start: `${day}T00:00:00.000Z`,
        end: new Date(
          Date.parse(`${day}T00:00:00.000Z`) + 86400000,
        ).toISOString(),
      });
      const mapUrl = `${app.origin}/api/dashboard/map?${mapQuery}`;
      const rosterVisible = await fetch(`${app.origin}/api/dashboard/members`, {
        headers: mapHeaders,
      });
      assert.equal(rosterVisible.status, 200);
      const memberCards = (await rosterVisible.json()) as any;
      assert.deepEqual(
        memberCards.members.map((m: any) => m._id).sort(),
        [String(viewer), String(owner)].sort(),
      );
      const authorizedCard = memberCards.members.find(
        (m: any) => m._id === String(owner),
      );
      assert.equal(
        authorizedCard.last_position?.activity_id,
        String(metric._id),
      );
      assert.equal(authorizedCard.last_position?.position?.latitude, 42.3601);
      const mapVisible = await fetch(mapUrl, { headers: mapHeaders });
      assert.equal(mapVisible.status, 200);
      const visibleFeed = (await mapVisible.json()) as any;
      assert.deepEqual(
        visibleFeed.activities.find((a: any) => a._id === String(metric._id))
          ?.position?.latitude,
        42.3601,
      );
      await b.db
        .collection("users")
        .updateOne(
          { _id: owner },
          { $set: { "privacy_settings.position": [] } },
        );
      assert.deepEqual(
        (await b.db.collection("users").findOne({ _id: owner }))
          ?.privacy_settings.position,
        [],
      );
      const mapHidden = await fetch(mapUrl, { headers: mapHeaders });
      assert.equal(mapHidden.status, 200);
      const rosterHidden = await fetch(`${app.origin}/api/dashboard/members`, {
        headers: mapHeaders,
      });
      assert.equal(rosterHidden.status, 200);
      assert.equal(
        (await rosterHidden.json()).members.find(
          (m: any) => m._id === String(owner),
        ).last_position,
        null,
      );
      const hiddenFeed = (await mapHidden.json()) as any;
      assert.ok(
        !hiddenFeed.activities.some((a: any) => a._id === String(metric._id)),
        "Position revocation removes the activity from the map-specific read",
      );
      const hiddenDetail = await fetch(
        `${app.origin}/api/dashboard/activity?id=${metric._id}`,
        { headers: mapHeaders },
      );
      assert.equal(hiddenDetail.status, 200);
      assert.equal(
        ((await hiddenDetail.json()) as any).activity.position,
        undefined,
      );
      await b.db
        .collection("users")
        .updateOne(
          { _id: owner },
          { $set: { "privacy_settings.position": ["dojo"] } },
        );
      const dstStart = "2026-03-08T05:00:00.000Z";
      const dstEnd = "2026-03-09T04:00:00.000Z";
      const justBeforeEnd = row(
        "metric",
        { measurements: [] },
        {
          position: { latitude: 42.3601, longitude: -71.0589 },
          created_at: new Date(Date.parse(dstEnd) - 1),
          completed_at: new Date(Date.parse(dstEnd) - 1),
        },
      );
      const atEnd = row(
        "metric",
        { measurements: [] },
        {
          position: { latitude: 42.3601, longitude: -71.0589 },
          created_at: new Date(dstEnd),
          completed_at: new Date(dstEnd),
        },
      );
      await b.db.collection("activities").insertMany([justBeforeEnd, atEnd]);
      try {
        const boundaryQuery = new URLSearchParams({
          date: "2026-03-08",
          start: dstStart,
          end: dstEnd,
        });
        const boundary = await fetch(
          `${app.origin}/api/dashboard/map?${boundaryQuery}`,
          { headers: mapHeaders },
        );
        assert.equal(boundary.status, 200);
        const ids = ((await boundary.json()) as any).activities.map(
          (a: any) => a._id,
        );
        assert.ok(
          ids.includes(String(justBeforeEnd._id)),
          "DST local day includes last millisecond",
        );
        assert.ok(
          !ids.includes(String(atEnd._id)),
          "DST local day excludes exact next midnight",
        );
      } finally {
        await b.db
          .collection("activities")
          .deleteMany({ _id: { $in: [justBeforeEnd._id, atEnd._id] } });
      }
      const calls: string[] = [];
      b.server.prependListener("request", (req: any) => calls.push(req.url));
      browser = await chromium.launch({
        executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
        headless: true,
        args: ["--no-sandbox"],
      });
      for (const width of [1440, 390, 320]) {
        const callStart = calls.length;
        await b.db.collection("users").updateOne(
          { _id: owner },
          {
            $set: {
              "privacy_settings.media": ["dojo"],
              "privacy_settings.position": ["dojo"],
            },
          },
        );
        assert.deepEqual(
          (await b.db.collection("users").findOne({ _id: owner }))
            .privacy_settings.media,
          ["dojo"],
        );
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          timezoneId: "UTC",
        });
        try {
          const page = await context.newPage();
          const requestedTiles: string[] = [];
          const blankTile = await sharp({
            create: {
              width: 256,
              height: 256,
              channels: 4,
              background: "#ddd",
            },
          })
            .png()
            .toBuffer();
          await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (route) => {
            requestedTiles.push(route.request().url());
            return route.fulfill({
              contentType: "image/png",
              body: blankTile,
            });
          });
          const errors: string[] = [];
          page.on("pageerror", (e) => errors.push(e.message));
          const mediaResponses: number[] = [];
          page.on("response", (response) => {
            if (
              response.url().includes("/api/dashboard/photo?") &&
              response.ok()
            )
              mediaResponses.push(response.status());
          });
          await page.goto(app.origin + "/dashboard");
          assert.match(
            (await page.locator("#dashboardMap").getAttribute("aria-label")) ||
              "",
            /OpenStreetMap/,
          );
          await page.locator("#adminKey").fill(store.secrets.admin);
          await page.locator("#unlock").click();
          await page.waitForFunction(
            () =>
              document
                .querySelector("#dashboardStatus")
                ?.textContent?.toLowerCase()
                .includes("loaded"),
            {},
            { timeout: 15000 },
          );
          await page.waitForFunction(
            () =>
              document.querySelectorAll("#dashboardMap .dashboard-map-marker")
                .length === 1,
            {},
            { timeout: 15000 },
          );
          assert.match(
            await page.locator("#dashboardMapStatus").innerText(),
            /1 members with authorized position/,
          );
          await page
            .locator("#dashboardMemberCards .dashboard-member-card")
            .first()
            .waitFor();
          assert.equal(
            await page
              .locator("#dashboardMemberCards .dashboard-member-card")
              .count(),
            3,
          );
          assert.equal(
            await page.locator("#dashboardMap .dashboard-member-pin").count(),
            1,
          );
          assert.ok(
            requestedTiles.length > 0,
            "served Studio uses OSM raster tiles",
          );
          await page.locator("#dashboardMap .dashboard-map-marker").click();
          await page.waitForFunction(
            () =>
              document
                .querySelector("#dashboardMapSelection")
                ?.textContent?.includes("Synthetic QA check-in"),
            {},
            { timeout: 10000 },
          );
          assert.match(
            await page.locator("#dashboardMapSelection").innerText(),
            /metric/i,
          );
          const previousDay = new Date(
            Date.parse(day + "T00:00:00.000Z") - 86400000,
          )
            .toISOString()
            .slice(0, 10);
          await page.locator("#dashboardMapDate").fill(previousDay);
          await page.locator("#dashboardMapDate").dispatchEvent("change");
          await page.waitForFunction(
            (selected) =>
              document
                .querySelector("#dashboardMapStatus")
                ?.textContent?.startsWith(selected + " activity creation date"),
            previousDay,
            { timeout: 10000 },
          );
          assert.equal(
            await page.locator("#dashboardMap .dashboard-map-marker").count(),
            0,
          );
          await page.locator("#dashboardMapDate").fill(day);
          await page.locator("#dashboardMapDate").dispatchEvent("change");
          await page.waitForFunction(
            () =>
              document.querySelectorAll("#dashboardMap .dashboard-map-marker")
                .length === 1,
            {},
            { timeout: 10000 },
          );
          await page.waitForFunction(
            () =>
              document.querySelectorAll("#dashboardRoster img").length === 4 &&
              [
                ...document.querySelectorAll<HTMLImageElement>(
                  "#dashboardRoster img",
                ),
              ].every((i) => i.complete && i.naturalWidth === 32),
            {},
            { timeout: 10000 },
          );
          await page
            .locator("#dashboardRoster img")
            .evaluateAll(async (imgs) => {
              await Promise.all(
                imgs.map((img) => (img as HTMLImageElement).decode()),
              );
            });
          assert.equal(
            await page.locator("#dashboardRoster article").count(),
            1,
          );
          assert.equal(await page.locator("#dashboardCharts svg").count(), 3);
          const points = await page
            .locator("#dashboardCharts circle")
            .evaluateAll((dots) =>
              dots.map((d) => d.getAttribute("aria-label")),
            );
          assert.deepEqual(points, [
            `Synthetic Ada: ${day}, 80.5 kg`,
            `Synthetic Ada: ${day}, 177 lb`,
            `Synthetic Ada: ${day}, 20 %`,
          ]);
          assert.deepEqual(mediaResponses, [200, 200, 200, 200]);
          const pixels = await page
            .locator("#dashboardRoster img")
            .evaluateAll((imgs) =>
              imgs.map((img) => {
                const canvas = document.createElement("canvas");
                canvas.width = canvas.height = 32;
                const ctx = canvas.getContext("2d")!;
                ctx.drawImage(img as HTMLImageElement, 0, 0);
                return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
              }),
            );
          const expectedPixels = await Promise.all(
            jpegs.map(async (jpeg) => [
              ...(await sharp(jpeg).raw().toBuffer()).subarray(0, 3),
            ]),
          );
          assert.deepEqual(pixels, expectedPixels);
          assert.deepEqual(
            calls
              .slice(callStart)
              .filter((path) => path.startsWith("/api/media/")),
            files.map((file) => `/api/media/${photo._id}/files/${file._id}`),
          );
          assert.ok(calls.includes(`/api/friends/activity/${photo._id}`));
          assert.ok(!calls.includes(`/api/friends/activity/${oldPhoto._id}`));
          assert.ok(!calls.includes(`/api/friends/activity/${pending._id}`));
          assert.ok(!calls.includes(`/api/friends/activity/${missed._id}`));
          assert.match(
            await page.locator("#dashboardCoverage").innerText(),
            /Not a complete roster/,
          );
          assert.ok(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth + 1,
            ),
          );
          await page.locator("#dashboardMap .dashboard-map-marker").click();
          await page.waitForFunction(() =>
            document
              .querySelector("#dashboardMapSelection")
              ?.textContent?.includes("Synthetic QA check-in"),
          );
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.screenshot({
            path: `${evidence}/paired-dashboard-${width}.png`,
            fullPage: true,
          });
          const acquired = await page
            .locator("#dashboardRoster img")
            .evaluateAll((imgs) =>
              imgs.map((i) => (i as HTMLImageElement).src),
            );
          await b.db.collection("users").updateOne(
            { _id: owner },
            {
              $set: {
                "privacy_settings.media": [],
                "privacy_settings.position": [],
              },
            },
          );
          assert.deepEqual(
            (await b.db.collection("users").findOne({ _id: owner }))
              .privacy_settings.media,
            [],
          );
          assert.deepEqual(
            (await b.db.collection("users").findOne({ _id: owner }))
              .privacy_settings.position,
            [],
          );
          const before = calls.length;
          await page.waitForTimeout(100);
          assert.equal(calls.length, before, "no permission polling/replay");
          const denied = await page.evaluate(
            async ({ key, activity, file }) =>
              (
                await fetch(
                  `/api/dashboard/photo?activity_id=${activity}&file_id=${file}`,
                  { headers: { Authorization: `Bearer ${key}` } },
                )
              ).status,
            {
              key: store.secrets.admin,
              activity: String(photo._id),
              file: files[0]._id,
            },
          );
          assert.ok([403, 404].includes(denied));
          assert.deepEqual(
            await page
              .locator("#dashboardRoster img")
              .evaluateAll((imgs) =>
                imgs.map((i) => (i as HTMLImageElement).src),
              ),
            acquired,
          );
          assert.equal(
            await page
              .locator("#dashboardRoster img")
              .evaluateAll(
                (imgs) =>
                  imgs.filter(
                    (i) => (i as HTMLImageElement).naturalWidth === 32,
                  ).length,
              ),
            4,
          );
          await page.locator("#settingsTab").click();
          await page.locator("#dashboardTab").click();
          await page.waitForFunction(() =>
            document
              .querySelector("#dashboardStatus")
              ?.textContent?.toLowerCase()
              .includes("loaded"),
          );
          assert.equal(await page.locator("#dashboardRoster img").count(), 0);
          await page.waitForFunction(
            () =>
              document
                .querySelector("#dashboardMapStatus")
                ?.textContent?.includes("0 members with authorized position"),
            {},
            { timeout: 10000 },
          );
          assert.equal(
            await page.locator("#dashboardMap .dashboard-map-marker").count(),
            0,
          );
          assert.deepEqual(errors, []);
          console.log(
            JSON.stringify({
              synthetic: true,
              width,
              decodedJPEGs: 4,
              bodyCharts: 3,
              bodyPoints: points,
              deniedNewRead: denied,
              acquiredPixelsRetained: true,
            }),
          );
        } finally {
          await context.close();
        }
      }
      assert.equal(
        storageCalls.length,
        12,
        "revoked reads never reach synthetic storage",
      );
    } finally {
      await browser?.close();
      await app?.close();
      await b.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
