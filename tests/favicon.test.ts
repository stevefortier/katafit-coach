import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

test("Studio serves its red Kata.fit favicon before unlock without exposing APIs", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-favicon-");
  const store = new Store(dir);
  await store.init();
  const app = await admin(store, 0);
  try {
    const html = await (await fetch(app.origin)).text();
    assert.match(
      html,
      /<link rel="icon" type="image\/svg\+xml" href="\/favicon.svg"\s*\/>/,
    );
    const icon = await fetch(app.origin + "/favicon.svg");
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get("content-type") ?? "", /^image\/svg\+xml/);
    const svg = await icon.text();
    // Canonical main-app micro K geometry and background, with only its fill changed.
    assert.match(svg, /viewBox="0 0 180 180"/);
    assert.match(
      svg,
      /<rect width="180" height="180" rx="34" fill="#0a0c0d"\s*\/>/,
    );
    assert.match(
      svg,
      /d="M34 12h32v62l57-62h40L85 88l82 82h-42l-59-64v64H34z" fill="#ef4444"/,
    );
    assert.ok(!svg.includes("#e8e4db"));
    assert.equal((await fetch(app.origin + "/api/config")).status, 401);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
