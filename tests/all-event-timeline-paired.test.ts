import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import {
  startBackend,
  memoryBackendEnabled,
} from "./helpers/memory-backend.js";

// Independent real persistence -> ordinary auth -> BFF -> served UI acceptance.
// Disposable synthetic records, no production database or provider access.
test(
  "every persisted self event survives the real dashboard timeline pipeline",
  {
    skip: !memoryBackendEnabled,
    timeout: 150000,
  },
  async () => {
    const oldSecret = process.env.JWT_SECRET;
    const oldClerkSecret = process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_SECRET_KEY;
    process.env.JWT_SECRET = "synthetic-independent-event-timeline";
    const home = await mkdtemp(tmpdir() + "/all-events-pair-");
    let b: Awaited<ReturnType<typeof startBackend>> | undefined;
    let app: Awaited<ReturnType<typeof admin>> | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      b = await startBackend();
      const rawActivities = b.db.collection("activities");
      const rawEvents = b.db.collection("user_activity_events");
      const viewer = new b.ObjectId(),
        peer = new b.ObjectId(),
        dojo = new b.ObjectId();
      const workout = new b.ObjectId(),
        meal = new b.ObjectId(),
        exercise = new b.ObjectId();
      const setA = new b.ObjectId(),
        setB = new b.ObjectId();
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      const start = new Date(day + "T00:00:00.000Z");
      const end = new Date(+start + 86400000);
      await b.db.collection("users").insertMany([
        {
          _id: viewer,
          username: "synthetic-self",
          display_name: "Synthetic Self",
          timezone: "UTC",
        },
        {
          _id: peer,
          username: "synthetic-private",
          display_name: "Synthetic Private",
          privacy_settings: { workout: [] },
        },
      ]);
      await b.db.collection("dojos").insertOne({
        _id: dojo,
        chief_id: viewer,
        name: "Synthetic event timeline",
      });
      await b.db.collection("dojo_members").insertMany([
        { user_id: viewer, dojo_id: dojo, role: "chief" },
        { user_id: peer, dojo_id: dojo, role: "member" },
      ]);
      await rawActivities.insertMany([
        {
          _id: workout,
          user_id: viewer,
          type: "workout",
          status: "ongoing",
          created_at: now,
          data: {
            exercises: [
              {
                _id: exercise,
                exercise_id: "synthetic-squat",
                sets: [
                  { _id: setA, repetitions: 5, complete: false },
                  { _id: setB, repetitions: 5, complete: false },
                ],
              },
            ],
          },
        },
        {
          _id: meal,
          user_id: viewer,
          type: "meal",
          status: "pending",
          created_at: now,
          data: {
            foods: [
              { food_id: "rice", instance_id: "one", quantity: 1, unit: "g" },
              { food_id: "rice", instance_id: "two", quantity: 2, unit: "g" },
            ],
          },
        },
      ]);
      await rawActivities.insertOne({
        _id: new b.ObjectId(),
        user_id: peer,
        type: "workout",
        status: "complete",
        created_at: now,
        data: { exercises: [] },
      });
      b.require("./core/userActivityPersistence").instrument(
        b.db,
        b.require("./config/db").getClient(),
      );
      await b
        .require("./core/userActivityTimelineStore")
        .ensureUserActivityIndexes(b.db);
      const member = (fn: () => Promise<any>) =>
        b!
          .require("./middleware/userActivityContext")
          .runWithUserActivityContext(
            {
              trusted: true,
              ownerUserId: String(viewer),
              actorUserId: String(viewer),
              actorType: "member",
              source: "interactive",
              requestId: "independent-event-pair",
              requestReceivedAt: now,
            },
            fn,
          );
      const changeSets = {
        $set: {
          "data.exercises.0.sets.0.complete": true,
          "data.exercises.0.sets.1.complete": true,
        },
      };
      await member(() =>
        b!.db
          .collection("activities")
          .updateOne({ _id: workout, user_id: viewer }, changeSets),
      );
      const afterSets = await rawEvents.countDocuments({
        owner_user_id: viewer,
      });
      await member(() =>
        b!.db
          .collection("activities")
          .updateOne({ _id: workout, user_id: viewer }, changeSets),
      );
      assert.equal(
        await rawEvents.countDocuments({ owner_user_id: viewer }),
        afterSets,
        "retry must not add events",
      );
      await member(() =>
        b!.db.collection("activities").updateOne(
          { _id: meal },
          {
            $set: { "data.foods.0.quantity": 3, "data.foods.1.quantity": 4 },
          },
        ),
      );
      await member(() =>
        b!.db
          .collection("activities")
          .updateOne(
            { _id: workout },
            { $set: { status: "complete", completed_at: now } },
          ),
      );
      await member(() =>
        b!.db
          .collection("activities")
          .updateOne({ _id: workout }, { $set: { status: "pending" } }),
      );
      await member(() =>
        b!.db.collection("activities").deleteOne({ _id: meal }),
      );
      await b.db
        .collection("activities")
        .updateOne(
          { user_id: peer, type: "workout" },
          { $set: { name: "PRIVATE_PEER_EVENT" } },
        );
      assert.equal(
        await rawEvents.countDocuments({ owner_user_id: peer }),
        1,
        "private peer must have a real persisted event for the denial control",
      );
      const persisted = await rawEvents
        .find({ owner_user_id: viewer, occurred_at: { $gte: start, $lt: end } })
        .toArray();
      assert.ok(
        persisted.length >= 7,
        "multiple set/food changes must retain granular cardinality",
      );
      const setRows = persisted.filter((r: any) =>
        /^workout\.set_/.test(r.event_type),
      );
      assert.equal(
        setRows.length,
        2,
        "each of two completed sets needs its own ledger event",
      );
      assert.equal(
        persisted.filter((r: any) => r.event_type === "meal.food_updated")
          .length,
        2,
        "duplicate food IDs remain two occurrences",
      );
      b.app.use("/api/friends", b.require("./routes/friends"));
      const human = b
        .require("jsonwebtoken")
        .sign(
          { user_id: String(viewer), username: "synthetic-self" },
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
            name: "Synthetic all-event pairing",
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
      const query = new URLSearchParams({
        date: day,
        start: start.toISOString(),
        end: end.toISOString(),
      });
      const response = await fetch(
        `${app.origin}/api/dashboard/timeline?${query}`,
        { headers: { Authorization: `Bearer ${store.secrets.admin}` } },
      );
      assert.equal(response.status, 200);
      const data = (await response.json()) as any;
      assert.equal(data.hasMore, false);
      assert.deepEqual(
        data.events.map((r: any) => r.id).sort(),
        persisted.map((r: any) => String(r._id)).sort(),
        "BFF must expose every authorized canonical row, including deleted-source history",
      );
      assert.ok(data.events.every((r: any) => r.user_id === String(viewer)));
      assert.ok(!JSON.stringify(data).includes("actor_credential_id"));
      browser = await chromium.launch({
        executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
        args: ["--no-sandbox"],
      });
      const evidence =
        process.env.ALL_EVENT_EVIDENCE_DIR ||
        tmpdir() + "/coach-independent-all-events";
      await mkdir(evidence, { recursive: true });
      const cases: any[] = [];
      for (const width of [1440, 390, 320]) {
        const context = await browser.newContext({
          viewport: { width, height: 1000 },
          timezoneId: "UTC",
        });
        try {
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (route) =>
            route.abort(),
          );
          await page.goto(app.origin + "/dashboard");
          await page.locator("#adminKey").fill(store.secrets.admin);
          await page.locator("#unlock").click();
          await page.locator("#dashboardMapDate").fill(day);
          await page.locator("#dashboardMapDate").dispatchEvent("change");
          await page.waitForFunction(
            (count) =>
              document.querySelectorAll(".dashboard-timeline-mark").length ===
              count,
            persisted.length,
            { timeout: 25000 },
          );
          const ids = await page
            .locator(".dashboard-timeline-mark")
            .evaluateAll((nodes) =>
              nodes.map((node) => (node as HTMLElement).dataset.eventId),
            );
          assert.deepEqual(
            ids.sort(),
            persisted.map((r: any) => String(r._id)).sort(),
          );
          for (const row of [
            ...setRows,
            ...persisted.filter(
              (r: any) =>
                r.event_type === "meal.food_updated" ||
                r.event_type === "workout.reopened" ||
                r.event_type === "meal.deleted",
            ),
          ]) {
            const mark = page.locator(
              `.dashboard-timeline-mark[data-event-id="${row._id}"]`,
            );
            if (await mark.isVisible()) await mark.click();
            else {
              const clusterIndex = await page
                .locator(".dashboard-timeline-cluster")
                .evaluateAll(
                  (nodes, id) =>
                    nodes.findIndex((node) =>
                      JSON.parse(
                        (node as HTMLElement).dataset.eventIds!,
                      ).includes(id),
                    ),
                  String(row._id),
                );
              assert.ok(
                clusterIndex >= 0,
                "every persisted event belongs to an accessible collision cluster",
              );
              await page
                .locator(".dashboard-timeline-cluster")
                .nth(clusterIndex)
                .click();
              await page
                .locator(
                  `.dashboard-timeline-choice[data-event-id="${row._id}"]`,
                )
                .click();
            }
            const detailText = await page
              .locator("#dashboardMapSelection")
              .innerText();
            assert.ok(
              detailText.length > 30,
              "selection must show readable event details without a live source",
            );
            assert.ok(
              detailText.includes(row.event_type.replace(/[._]/g, " ")),
            );
            for (const field of [
              "set_id",
              "instance_id",
              "from_status",
              "to_status",
              "quantity",
              "previous_quantity",
            ]) {
              if (row.details[field] !== undefined)
                assert.ok(
                  detailText.includes(String(row.details[field])),
                  `${field} must be visible`,
                );
            }
            if (row.event_type !== "meal.deleted") {
              await page.locator("#dashboardMapSelection").evaluate((node) => {
                node.scrollIntoView({ block: "start", behavior: "instant" });
                const stickyBottom = Math.max(
                  0,
                  ...Array.from(
                    document.querySelectorAll(
                      "header, .dashboard-member-cards, #studioNotice",
                    ),
                  ).map((element) => {
                    const box = element.getBoundingClientRect();
                    return getComputedStyle(element).position === "sticky" &&
                      box.bottom > 0 &&
                      box.top < innerHeight
                      ? box.bottom
                      : 0;
                  }),
                );
                const shift =
                  node.getBoundingClientRect().top - stickyBottom - 20;
                let parent = node.parentElement;
                while (
                  parent &&
                  !(
                    parent.scrollHeight > parent.clientHeight &&
                    /auto|scroll/.test(getComputedStyle(parent).overflowY)
                  )
                )
                  parent = parent.parentElement;
                if (parent) parent.scrollTop += shift;
                else window.scrollBy(0, shift);
              });
              await page.locator("#dashboardMapSelection").screenshot({
                path: `${evidence}/${width}-${row.event_type}-${row.details.set_index ?? row.details.instance_id ?? "status"}-detail.png`,
              });
            }
          }
          assert.deepEqual(errors, []);
          const geometry = await page.evaluate(() => ({
            width: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            map: document
              .querySelector("#dashboardMap")!
              .getBoundingClientRect()
              .toJSON(),
            detail: document
              .querySelector("#dashboardMapSelection")!
              .getBoundingClientRect()
              .toJSON(),
            timeline: document
              .querySelector("#dashboardTimeline")!
              .getBoundingClientRect()
              .toJSON(),
            timelineScroll: (() => {
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
              geometry.timelineScroll.full <=
                geometry.timelineScroll.client + 1,
              JSON.stringify(geometry),
            );
          } else
            assert.ok(
              geometry.detail.top >= geometry.map.bottom - 1,
              JSON.stringify(geometry),
            );
          assert.ok(
            geometry.scrollWidth <= width + 1,
            JSON.stringify(geometry),
          );
          await page.locator("#dashboardTimeline").scrollIntoViewIfNeeded();
          await page.screenshot({
            path: `${evidence}/${width}-persisted-all-events.png`,
          });
          cases.push({ width, event_count: ids.length, errors, geometry });
        } finally {
          await context.close();
        }
      }
      await writeFile(
        `${evidence}/independent-pair.json`,
        JSON.stringify(
          {
            synthetic: true,
            real_persistence: true,
            real_auth: true,
            event_types: persisted.map((r: any) => r.event_type),
            cases,
          },
          null,
          2,
        ),
      );
    } finally {
      await browser?.close();
      await app?.close();
      await b?.close();
      await rm(home, { recursive: true, force: true });
      if (oldSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = oldSecret;
      if (oldClerkSecret === undefined) delete process.env.CLERK_SECRET_KEY;
      else process.env.CLERK_SECRET_KEY = oldClerkSecret;
    }
  },
);
