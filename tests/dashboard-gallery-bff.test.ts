import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

test("gallery independently proxies media-only stable cursor reads", async () => {
  const home = await mkdtemp(tmpdir() + "/gallery-");
  const calls: string[] = [];
  const backend = createServer((req, res) => {
    calls.push(req.url!);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        users: [],
        activities: [],
        hasMore: true,
        nextCursor: "opaque_cursor",
      }),
    );
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(backend.address() as any).port}`,
    token: "synthetic",
  });
  const server = await admin(store, 0);
  const headers = { Authorization: `Bearer ${store.secrets.admin}` };
  try {
    assert.equal(
      (await fetch(server.origin + "/api/dashboard/gallery")).status,
      401,
    );
    const response = await fetch(
      server.origin + "/api/dashboard/gallery?cursor=opaque_cursor",
      { headers },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).nextCursor, "opaque_cursor");
    assert.deepEqual(calls, [
      "/api/friends/feed/dojo?limit=20&type=media&pagination=cursor&cursor=opaque_cursor",
    ]);
    for (const query of [
      "type=metric",
      "cursor=a&cursor=b",
      "cursor=",
      "cursor=" + "x".repeat(1025),
    ])
      assert.equal(
        (
          await fetch(server.origin + "/api/dashboard/gallery?" + query, {
            headers,
          })
        ).status,
        400,
      );
  } finally {
    await server.close();
    await new Promise<void>((r) => backend.close(() => r()));
    await rm(home, { recursive: true, force: true });
  }
});
