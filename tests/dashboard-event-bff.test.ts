import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

const eventId = "0123456789abcdef01234567";
const day =
  "date=2026-09-28&start=2026-09-28T04%3A00%3A00.000Z&end=2026-09-29T04%3A00%3A00.000Z";

test("exact event BFF reauthorizes one ledger event through the day-events reader only", async () => {
  const home = await mkdtemp(tmpdir() + "/dashboard-event-");
  const calls: string[] = [];
  let status = 200;
  const backend = createServer((req, res) => {
    calls.push(req.url!);
    assert.equal(req.headers.authorization, "Bearer synthetic-rest-token");
    res.setHeader("content-type", "application/json");
    if (status !== 200) {
      res.writeHead(status);
      res.end('{"secret":"upstream-private","code":"EVENT_AUTHORITY_CHANGED"}');
      return;
    }
    res.end(
      JSON.stringify({
        users: [{ _id: "aaaaaaaaaaaaaaaaaaaaaaaa", display_name: "Ada" }],
        events: [
          {
            id: eventId,
            user_id: "aaaaaaaaaaaaaaaaaaaaaaaa",
            occurred_at: "2026-09-28T12:00:00.000Z",
            event_type: "meal.food_added",
            position: {
              availability: "available",
              latitude: 1,
              longitude: 2,
              accuracy: 5,
              captured_at: "2026-09-28T12:00:00.000Z",
              source: "gps",
            },
          },
        ],
        hasMore: false,
        nextCursor: null,
      }),
    );
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(backend.address() as any).port}`,
    token: "synthetic-rest-token",
  });
  const server = await admin(store, 0);
  const base = server.origin;
  const headers = { Authorization: `Bearer ${store.secrets.admin}` };
  const exact = `/api/dashboard/event?event_id=${eventId}&${day}`;
  try {
    assert.equal((await fetch(base + exact)).status, 401);
    assert.equal(
      (await fetch(base + exact, { headers: { Authorization: "Bearer x" } }))
        .status,
      401,
    );
    assert.deepEqual(calls, [], "unauthenticated reads never reach upstream");
    const response = await fetch(base + exact, { headers });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].position.latitude, 1);
    assert.deepEqual(calls, [
      `/api/friends/dojo/day-events?event_id=${eventId}&limit=1&start=2026-09-28T04%3A00%3A00.000Z&end=2026-09-29T04%3A00%3A00.000Z`,
    ]);
    calls.length = 0;
    for (const path of [
      `/api/dashboard/event?${day}`,
      `/api/dashboard/event?event_id=${eventId}`,
      `/api/dashboard/event?event_id=${eventId}&${day}&cursor=abc`,
      `/api/dashboard/event?event_id=${eventId}&${day}&limit=2`,
      `/api/dashboard/event?event_id=${eventId}&event_id=${eventId}&${day}`,
      `/api/dashboard/event?event_id=${eventId.toUpperCase()}&${day}`,
      `/api/dashboard/event?event_id=${eventId.slice(1)}&${day}`,
      `/api/dashboard/event?event_id=${eventId}0&${day}`,
      `/api/dashboard/event?event_id=..%2F${eventId.slice(3)}&${day}`,
      `/api/dashboard/event?event_id=${eventId}&date=2026-02-30&start=2026-09-28T04%3A00%3A00.000Z&end=2026-09-29T04%3A00%3A00.000Z`,
      `/api/dashboard/event?event_id=${eventId}&date=2026-09-28&start=2026-09-25T04%3A00%3A00.000Z&end=2026-09-26T04%3A00%3A00.000Z`,
      `/api/dashboard/event?event_id=${eventId}&date=2026-09-28&start=2026-09-28T04%3A00%3A00.000Z&end=2026-09-30T04%3A00%3A00.000Z`,
    ])
      assert.equal(
        (await fetch(base + path, { headers })).status,
        400,
        `rejects ${path}`,
      );
    assert.deepEqual(calls, [], "rejected queries never reach upstream");
    for (const code of [409, 403, 401, 429]) {
      status = code;
      const failed = await fetch(base + exact, { headers });
      assert.equal(failed.status, code, `propagates ${code}`);
      const text = await failed.text();
      assert.ok(!text.includes("upstream-private"), text);
    }
  } finally {
    await server.close();
    await new Promise<void>((r) => backend.close(() => r()));
    await rm(home, { recursive: true, force: true });
  }
});
