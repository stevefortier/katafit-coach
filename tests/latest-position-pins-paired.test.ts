import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import sharp from "sharp";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import {
  startBackend,
  memoryBackendEnabled,
} from "./helpers/memory-backend.js";

// Real persistence -> legacy Coach REST credential -> BFF -> served UI for the
// latest known recorded position layer. Disposable synthetic records only.
test(
  "latest known positions survive the real backend, BFF and served dashboard",
  { skip: !memoryBackendEnabled, timeout: 150000 },
  async () => {
    const oldSecret = process.env.JWT_SECRET;
    const oldClerkSecret = process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_SECRET_KEY;
    process.env.JWT_SECRET = "synthetic-latest-position-pair";
    const home = await mkdtemp(tmpdir() + "/latest-pins-pair-");
    let b: Awaited<ReturnType<typeof startBackend>> | undefined;
    let app: Awaited<ReturnType<typeof admin>> | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      b = await startBackend();
      await b
        .require("./core/userActivityTimelineStore")
        .ensureUserActivityIndexes(b.db);
      const viewer = new b.ObjectId(),
        peer = new b.ObjectId(),
        quiet = new b.ObjectId(),
        dojo = new b.ObjectId();
      const shared = {
        workout: ["dojo"],
        meal: ["dojo"],
        position: ["dojo"],
      };
      await b.db.collection("users").insertMany([
        {
          _id: viewer,
          username: "synthetic-chief",
          display_name: "Synthetic Chief",
          privacy_settings: shared,
        },
        {
          _id: peer,
          username: "synthetic-peer",
          display_name: "Synthetic Peer Zoë",
          privacy_settings: shared,
        },
        {
          _id: quiet,
          username: "synthetic-quiet",
          display_name: "Synthetic Quiet",
          privacy_settings: { ...shared, position: [] },
        },
      ]);
      await b.db
        .collection("dojos")
        .insertOne({ _id: dojo, chief_id: viewer, name: "Synthetic latest" });
      await b.db.collection("dojo_members").insertMany(
        [viewer, peer, quiet].map((user_id) => ({
          user_id,
          dojo_id: dojo,
          role: user_id === viewer ? "chief" : "member",
        })),
      );
      const now = Date.now();
      const iso = (t: number) => new Date(t).toISOString();
      const fixAt = (lat: number, lng: number, t: number) => ({
        availability: "available",
        latitude: lat,
        longitude: lng,
        accuracy: 5,
        captured_at: iso(t),
        source: "gps",
      });
      let n = 0;
      const located = async (
        owner: any,
        t: number,
        position: any,
        type = "workout",
        status = "complete",
      ) => {
        const subject = new b!.ObjectId();
        await b!.db.collection("activities").insertOne({
          _id: subject,
          user_id: owner,
          type,
          status,
          created_at: new Date(t),
        });
        const row = {
          owner_user_id: owner,
          subject_id: subject,
          subject_type: type,
          event_type: `${type}.sets_changed`,
          occurred_at: new Date(t),
          request_received_at: new Date(t),
          actor_type: "member",
          actor_user_id: owner,
          source: "interactive",
          details: { exercise_count: 1, set_count: 1 },
          event_key: `synthetic-latest-${n++}`,
          position,
        };
        return (await b!.db.collection("user_activity_events").insertOne(row))
          .insertedId;
      };
      // Peer: authorized fix two days ago; newer deleted-source and invalid rows.
      const peerAt = now - 2 * 86400000;
      const peerEvent = await located(
        peer,
        peerAt,
        fixAt(45.5012345, -73.5712345, peerAt),
      );
      await located(
        peer,
        now - 86400000,
        fixAt(10, 10, now - 86400000),
        "meal",
        "deleted",
      );
      await located(peer, now - 3600000, fixAt(91, 10, now - 3600000));
      // Chief (self): fresh fix two minutes ago.
      const selfAt = now - 120000;
      await located(viewer, selfAt, fixAt(45.6101234, -73.4601234, selfAt));
      // Quiet: has a fix but Position is not shared.
      await located(quiet, now - 60000, fixAt(45.52, -73.58, now - 60000));

      b.app.use("/api/friends", b.require("./routes/friends"));
      // Avatar bytes: the backend's S3 variant store is replaced by a decoded
      // PNG at the same path; the BFF proxy, CSP and browser decode are real.
      const png = await sharp({
        create: {
          width: 64,
          height: 64,
          channels: 3,
          background: { r: 30, g: 140, b: 90 },
        },
      })
        .png()
        .toBuffer();
      b.app.get("/api/users/:userId/avatar/:size", (req: any, res: any) =>
        req.params.userId === String(peer)
          ? res.type("png").send(png)
          : res.status(404).send("Avatar unavailable"),
      );
      const human = b
        .require("jsonwebtoken")
        .sign(
          { user_id: String(viewer), username: "synthetic-chief" },
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
            name: "Synthetic latest pairing",
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
      const bff = (path: string) =>
        fetch(`${app!.origin}${path}`, {
          headers: { Authorization: `Bearer ${store.secrets.admin}` },
        });
      assert.equal(
        (await bff("/api/dashboard/latest-positions?member=x")).status,
        400,
      );
      const response = await bff("/api/dashboard/latest-positions");
      assert.equal(response.status, 200);
      const data = (await response.json()) as any;
      const byId = Object.fromEntries(
        data.members.map((m: any) => [m.user_id, m]),
      );
      assert.deepEqual(byId[String(peer)].latest, {
        event_id: String(peerEvent),
        event_type: "workout.sets_changed",
        occurred_at: iso(peerAt),
        latitude: 45.5012345,
        longitude: -73.5712345,
        accuracy: 5,
        captured_at: iso(peerAt),
        source: "gps",
      });
      assert.equal(byId[String(viewer)].status, "located");
      assert.equal(byId[String(peer)].display_name, "Synthetic Peer Zoë");
      assert.deepEqual(byId[String(quiet)], {
        user_id: String(quiet),
        display_name: "Synthetic Quiet",
        status: "private",
        latest: null,
      });
      assert.ok(!JSON.stringify(data).includes("45.52"));
      // Existing roster DTO is unchanged by this feature.
      const roster = (await (
        await bff("/api/dashboard/members")
      ).json()) as any;
      assert.ok(roster.members.every((m: any) => "last_position" in m));

      browser = await chromium.launch({
        executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
        args: ["--no-sandbox"],
      });
      const evidence =
        process.env.LATEST_PINS_EVIDENCE_DIR ||
        tmpdir() + "/coach-latest-pins-pair";
      await mkdir(evidence, { recursive: true });
      const cases: any[] = [];
      for (const width of [1440, 390]) {
        const context = await browser.newContext({
          viewport: { width, height: 1000 },
          timezoneId: "UTC",
        });
        try {
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("console", (m) => {
            // Leaflet's own empty-tile placeholder after the aborted tile
            // fetch is not part of this feature.
            if (
              /Content Security Policy/i.test(m.text()) &&
              !m
                .text()
                .includes(
                  "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=",
                )
            )
              errors.push(m.text());
          });
          await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (route) =>
            route.abort(),
          );
          const served = await page.goto(app.origin + "/dashboard");
          // The production admin CSP is in force for the served dashboard.
          assert.match(
            served!.headers()["content-security-policy"],
            /img-src 'self' blob:.*script-src 'self'/,
          );
          await page.locator("#adminKey").fill(store.secrets.admin);
          await page.locator("#unlock").click();
          await page.locator("#dashboardMapDate").fill(iso(now).slice(0, 10));
          await page.locator("#dashboardMapDate").dispatchEvent("change");
          await page.waitForFunction(
            () =>
              document.querySelectorAll(".dashboard-latest-pin").length >= 1,
            null,
            { timeout: 25000 },
          );
          await page.evaluate(() => {
            const map = document.querySelector("#dashboardMap") as any;
            map.scrollIntoView({ block: "center", behavior: "instant" });
          });
          await page.waitForFunction(
            () =>
              [
                ...document.querySelectorAll<HTMLImageElement>(
                  ".dashboard-latest-pin img",
                ),
              ].some((i) => i.complete && i.naturalWidth > 0),
            null,
            { timeout: 15000 },
          );
          const labels = await page.$$eval(".dashboard-latest-pin", (nodes) =>
            nodes.map((n) => {
              const photo = n.querySelector(".dashboard-latest-photo")!;
              const img = n.querySelector("img");
              return {
                ids: (n as HTMLElement).dataset.memberIds,
                label: n.getAttribute("aria-label"),
                stale: n.classList.contains("dashboard-latest-stale"),
                radius: getComputedStyle(photo).borderTopLeftRadius,
                opacity: getComputedStyle(photo).opacity,
                photo: img ? img.naturalWidth : null,
                text: photo.textContent,
              };
            }),
          );
          const ids = labels.flatMap((l) => l.ids!.split(" "));
          assert.ok(ids.includes(String(peer)) && ids.includes(String(viewer)));
          assert.ok(!ids.includes(String(quiet)));
          const peerPin = labels.find((l) =>
            l.ids!.split(" ").includes(String(peer)),
          )!;
          assert.match(
            peerPin.label!,
            /Synthetic Peer Zoë, latest known position recorded 2 days ago/,
          );
          // Separate round pins: the peer's own decoded photo, faded as
          // older; the chief's fresh pin at full opacity.
          const selfPin = labels.find((l) => l.ids === String(viewer))!;
          assert.deepEqual(
            [peerPin.ids, peerPin.photo, peerPin.stale, peerPin.opacity],
            [String(peer), 64, true, "0.5"],
          );
          assert.deepEqual(
            [selfPin.stale, selfPin.opacity, selfPin.radius, peerPin.radius],
            [false, "1", "50%", "50%"],
          );
          // UTF-8 end to end: no mojibake in the served UI.
          const body = await page.evaluate(() => document.body.innerText);
          assert.ok(body.includes("Synthetic Peer Zoë"));
          assert.ok(!/Ã|Â/.test(body));
          await page.screenshot({
            path: `${evidence}/paired-${width}-latest-pins.png`,
          });
          assert.deepEqual(errors, []);
          cases.push({ width, pins: labels });
        } finally {
          await context.close();
        }
      }
      // Open-UI revocation: with the dashboard open, revoke Position; the next
      // supported reload path (another day) withdraws the pin.
      {
        const context = await browser.newContext({
          viewport: { width: 1440, height: 1000 },
          timezoneId: "UTC",
        });
        try {
          const page = await context.newPage();
          await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (route) =>
            route.abort(),
          );
          await page.goto(app.origin + "/dashboard");
          await page.locator("#adminKey").fill(store.secrets.admin);
          await page.locator("#unlock").click();
          const peerPin = `.dashboard-latest-pin[data-member-ids~="${peer}"]`;
          await page.waitForSelector(peerPin, { timeout: 25000 });
          await b.db
            .collection("users")
            .updateOne(
              { _id: peer },
              { $set: { "privacy_settings.position": [] } },
            );
          await page
            .locator("#dashboardMapDate")
            .fill(iso(now - 86400000).slice(0, 10));
          await page.locator("#dashboardMapDate").dispatchEvent("change");
          await page.waitForSelector(peerPin, {
            state: "detached",
            timeout: 25000,
          });
          assert.ok(
            await page.$(`.dashboard-latest-pin[data-member-ids~="${viewer}"]`),
          );
          await page.screenshot({
            path: `${evidence}/paired-1440-after-revocation.png`,
          });
        } finally {
          await context.close();
        }
      }
      // Revocation: a fresh read withholds the peer's geometry entirely.
      const revoked = (await (
        await bff("/api/dashboard/latest-positions")
      ).json()) as any;
      const revokedPeer = revoked.members.find(
        (m: any) => m.user_id === String(peer),
      );
      assert.deepEqual(
        [revokedPeer.status, revokedPeer.latest],
        ["private", null],
      );
      assert.ok(!JSON.stringify(revoked).includes("45.5012345"));
      await writeFile(
        `${evidence}/paired-latest-pins.json`,
        JSON.stringify(
          {
            synthetic: true,
            real_persistence: true,
            real_auth: true,
            bff: true,
            production_csp: true,
            avatar_bytes:
              "sharp PNG via BFF /api/dashboard/avatar (backend S3 variant store stubbed)",
            open_ui_revocation: true,
            cases,
            revoked: revokedPeer,
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
