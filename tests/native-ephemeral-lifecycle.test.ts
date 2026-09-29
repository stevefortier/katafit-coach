import test from "node:test";
import assert from "node:assert/strict";
import { attachmentHarness } from "./helpers/attachments.js";
import { restSession } from "../src/katafit/restSession.js";
import { readdir } from "node:fs/promises";

test("native Coach keeps one in-memory Pi after browser detach and never persists a conversation", async () => {
  const h = await attachmentHarness();
  try {
    const first = await h.connect();
    const session = first.frames.find((m) => m.type === "attachments").session;
    first.ws.close();
    await first.until(() => first.closed() !== undefined, "detached");
    assert.equal(h.runtimes[0].stopped, 0);
    // Old navigation used to schedule an unconditional stop after 30 seconds.
    await new Promise((resolve) => setTimeout(resolve, 31000));
    assert.equal(h.runtimes[0].stopped, 0);
    const second = await h.connect();
    assert.equal(h.runtimes.length, 1);
    assert.equal(
      second.frames.find((m) => m.type === "attachments").session,
      session,
    );
    assert.deepEqual(
      await readdir(h.f.store.dir + "/operator-sessions").catch(() => []),
      [],
    );
  } finally {
    await h.close();
  }
});

test("ordinary REST session does not advertise archive sealing", async () => {
  let legacyOpens = 0;
  const session = restSession(
    () => true,
    async () => {
      legacyOpens++;
      throw new Error("old context must not be opened");
    },
  );
  try {
    assert.equal(session.archive, false);
    assert.equal(session.seal, undefined);
    assert.equal(
      session.continuity(),
      null,
      "a live Pi has no synthetic hourly expiry",
    );
    assert.equal(
      session.tools.some((tool) => tool.name === "coach_memory_search"),
      false,
    );
    await assert.rejects(session.recallMemories("old conversation"));
    assert.equal(legacyOpens, 0);
  } finally {
    await session.dispose();
  }
});

test("history API is absent", async () => {
  const h = await attachmentHarness();
  try {
    for (const [method, path] of [
      ["GET", "/api/terminal/history"],
      ["GET", "/api/terminal/history/" + "a".repeat(64)],
      ["POST", "/api/terminal/history/delete"],
    ]) {
      const response = await fetch(h.app.origin + path, {
        method,
        headers: {
          ...h.headers,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      assert.equal(response.status, 404, `${method} ${path}`);
    }
  } finally {
    await h.close();
  }
});
