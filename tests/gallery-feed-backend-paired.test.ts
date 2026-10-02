import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { restRequest } from "../src/katafit/restGet.js";
import {
  startBackend,
  memoryBackendEnabled,
} from "./helpers/memory-backend.js";

test(
  "real filtered gallery BFF pages45/80 same-time peer media including full-page terminal probe without unrelated rows or pixel reads",
  { skip: !memoryBackendEnabled, timeout: 120000 },
  async () => {
    process.env.JWT_SECRET = "synthetic-gallery-paired-secret";
    delete process.env.CLERK_SECRET_KEY;
    const backend = await startBackend();
    const home = await mkdtemp(tmpdir() + "/gallery-feed-paired-");
    let studio: Awaited<ReturnType<typeof admin>> | undefined;
    try {
      const calls: string[] = [];
      backend.app.use((req: any, _res: any, next: any) => {
        calls.push(req.originalUrl);
        next();
      });
      backend.app.use("/api/friends", backend.require("./routes/friends"));
      for (const photoCount of [45, 80]) {
        await backend.db.dropDatabase();
        const viewer = new backend.ObjectId(),
          owner = new backend.ObjectId(),
          dojo = new backend.ObjectId();
        await backend.db.collection("users").insertMany([
          {
            _id: viewer,
            username: "synthetic-gallery-viewer",
            timezone: "UTC",
          },
          {
            _id: owner,
            username: "synthetic-gallery-owner",
            privacy_settings: { media: ["dojo"], metric: ["dojo"] },
          },
        ]);
        await backend.db.collection("dojos").insertOne({
          _id: dojo,
          chief_id: viewer,
          name: "Synthetic gallery",
        });
        await backend.db.collection("dojo_members").insertMany([
          { user_id: viewer, dojo_id: dojo, role: "chief" },
          { user_id: owner, dojo_id: dojo, role: "member" },
        ]);
        const stamp = new Date(Date.now() - 60000);
        const rows = Array.from({ length: photoCount * 2 }, (_, index) => ({
          _id: new backend.ObjectId(),
          user_id: owner,
          type: index % 2 ? "metric" : "media",
          status: "complete",
          created_at: stamp,
          completed_at: stamp,
          data:
            index % 2
              ? { measurements: [] }
              : {
                  files: [
                    {
                      _id: String(new backend.ObjectId()),
                      type: "image/jpeg",
                      name: "synthetic.jpg",
                    },
                  ],
                },
        }));
        await backend.db.collection("activities").insertMany(rows);
        const human = backend
          .require("jsonwebtoken")
          .sign(
            { user_id: String(viewer), username: "synthetic-gallery-viewer" },
            process.env.JWT_SECRET,
          );
        const issued = await fetch(
          backend.origin + "/api/coach/external-agent/credentials",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${human}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              name: "Synthetic gallery pairing",
              rest_user_access: true,
            }),
          },
        );
        assert.equal(issued.status, 201);
        const { token } = (await issued.json()) as any;
        const store = new Store(home);
        await store.init();
        await store.save({
          ...store.publicConfig(),
          origin: backend.origin,
          token,
        });
        studio = await admin(store, 0);
        const headers = { Authorization: `Bearer ${store.secrets.admin}` };
        assert.equal(
          (await fetch(studio.origin + "/api/dashboard/gallery")).status,
          401,
        );
        const collected: string[] = [],
          cursors = new Set<string>();
        let cursor: string | undefined;
        for (let index = 0; index < 5; index++) {
          const response = await fetch(
            studio.origin +
              "/api/dashboard/gallery" +
              (cursor ? "?" + new URLSearchParams({ cursor }) : ""),
            { headers },
          );
          assert.equal(response.status, 200);
          const page = (await response.json()) as any;
          assert.ok(Array.isArray(page.activities));
          assert.ok(
            page.activities.every(
              (row: any) =>
                row.type === "media" && row.user_id === String(owner),
            ),
          );
          collected.push(...page.activities.map((row: any) => String(row._id)));
          if (!page.hasMore) {
            assert.equal(
              page.activities.length,
              photoCount === 80 ? 0 : 5,
              "exact-full pages require final empty probe",
            );
            break;
          }
          assert.equal(typeof page.nextCursor, "string");
          assert.ok(page.nextCursor.length && !cursors.has(page.nextCursor));
          assert.ok(
            page.nextCursor.length <= 512,
            "valid backend cursor fits native REST query-value bound",
          );
          if (!cursor) {
            const native = await restRequest(
              backend.origin,
              token,
              {
                method: "GET",
                path: `/api/friends/feed/dojo?type=media&limit=20&pagination=cursor&cursor=${encodeURIComponent(page.nextCursor)}`,
              },
              new AbortController().signal,
              [],
            );
            assert.ok(
              "content" in native,
              "native REST transport accepts actual filtered backend cursor",
            );
            const nativePage = JSON.parse((native as any).content[0].text);
            assert.equal(
              nativePage.activities.length,
              Math.min(40, photoCount - 40),
            );
            assert.ok(
              nativePage.activities.every((row: any) => row.type === "media"),
            );
          }
          cursors.add(page.nextCursor);
          cursor = page.nextCursor;
        }
        assert.deepEqual(
          [...new Set(collected)].sort(),
          rows
            .filter((row) => row.type === "media")
            .map((row) => String(row._id))
            .sort(),
        );
        assert.equal(collected.length, photoCount);
        const feeds = calls.filter((path) =>
          path.startsWith("/api/friends/feed/dojo?"),
        );
        assert.ok(feeds.length >= 2);
        assert.ok(
          feeds.every(
            (path) =>
              new URL(path, backend.origin).searchParams.get("type") ===
              "media",
          ),
        );
        assert.equal(
          calls.filter((path) => path.startsWith("/api/media/")).length,
          0,
        );
        await studio.close();
        studio = undefined;
      }
    } finally {
      await studio?.close();
      await backend.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
