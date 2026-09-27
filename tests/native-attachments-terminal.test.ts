import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { NativeTerminal } from "../src/server/terminal.js";
import { answer } from "./helpers/continuity.js";
import { attachmentHarness } from "./helpers/attachments.js";

test("attachments are private, exact-session scoped, safely typed, snapshotted once on reconnect and erased on Stop", async () => {
  const h = await attachmentHarness();
  try {
    const png = await sharp({
      create: { width: 5, height: 4, channels: 3, background: "#3366aa" },
    })
      .png()
      .toBuffer();
    h.files.set("chart.png", png);
    h.files.set("page.html", Buffer.from("<script>alert(1)</script>"));
    const first = await h.connect();
    const snapshot = first.frames.find((m) => m.type === "attachments");
    assert.match(snapshot.session, /^[a-f0-9]{32}$/);
    assert.deepEqual(snapshot.items, []);
    const ordering = first.frames.map((m) => m.type);
    assert.ok(ordering.indexOf("ready") < ordering.indexOf("attachments"));
    const accepted = JSON.parse(
      (
        await h.send({
          workspace_path: "chart.png",
          caption: "Synthetic chart",
        })
      ).content[0].text,
    );
    assert.equal(accepted.panel_connected, true);
    const page = JSON.parse(
      (await h.send({ workspace_path: "page.html" })).content[0].text,
    );
    await first.until(
      () => first.frames.filter((m) => m.type === "attachment").length === 2,
      "attachment frames",
    );
    const [image, html] = first.frames
      .filter((m) => m.type === "attachment")
      .map((m) => {
        assert.equal(m.session, snapshot.session);
        return m.item;
      });
    assert.equal(image.id, accepted.attachment_id);
    assert.equal(html.id, page.attachment_id);
    const url = (session: string, id: string) =>
      `/api/terminal/attachments/${session}/${id}`;
    assert.equal(
      (await h.get(url(snapshot.session, image.id), false)).status,
      401,
    );
    const served = await h.get(url(snapshot.session, image.id));
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.equal(served.headers.get("x-content-type-options"), "nosniff");
    assert.equal(served.headers.get("cache-control"), "no-store");
    assert.equal(
      served.headers.get("cross-origin-resource-policy"),
      "same-origin",
    );
    assert.match(
      served.headers.get("content-security-policy")!,
      /^sandbox; default-src 'none'/,
    );
    assert.match(
      served.headers.get("content-disposition")!,
      /^attachment; filename="chart.png"/,
    );
    const bytes = Buffer.from(await served.arrayBuffer());
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      image.sha256,
    );
    const htmlServed = await h.get(url(snapshot.session, html.id));
    assert.equal(
      htmlServed.headers.get("content-type"),
      "application/octet-stream",
    );
    assert.match(htmlServed.headers.get("content-disposition")!, /page\.html/);
    for (const path of [
      url("0".repeat(32), image.id),
      url(snapshot.session, "at_" + "0".repeat(32)),
      url(snapshot.session, image.id) + "/x",
      `/api/terminal/attachments/${snapshot.session}/../${image.id}`,
      `/api/terminal/attachments/${snapshot.session.toUpperCase()}/${image.id}`,
    ])
      assert.equal((await h.get(path)).status, 404, path);
    // Reconnect: one snapshot with identical ids; the old socket is replaced.
    const second = await h.connect();
    await first.until(() => first.closed() !== undefined, "old socket closed");
    const again = second.frames.filter((m) => m.type === "attachments");
    assert.equal(again.length, 1);
    assert.equal(again[0].session, snapshot.session);
    assert.deepEqual(
      again[0].items.map((i: any) => i.id),
      [image.id, html.id],
    );
    assert.equal(
      second.frames.filter((m) => m.type === "attachment").length,
      0,
    );
    assert.equal(h.runtimes.length, 1, "reconnect reuses the runtime");
    // Stop erases: cleared frame first, then 1008, then 404 for old URLs.
    assert.equal(
      (
        await fetch(h.app.origin + "/api/terminal/stop", {
          method: "POST",
          headers: h.headers,
          body: "{}",
        })
      ).status,
      200,
    );
    await second.until(() => second.closed() === 1008, "stopped socket");
    assert.ok(second.frames.some((m) => m.type === "attachments-cleared"));
    assert.equal((await h.get(url(snapshot.session, image.id))).status, 404);
    // A new runtime has a new session and nothing from the old one.
    const third = await h.connect();
    const fresh = third.frames.find((m) => m.type === "attachments");
    assert.notEqual(fresh.session, snapshot.session);
    assert.deepEqual(fresh.items, []);
    assert.equal((await h.get(url(fresh.session, image.id))).status, 404);
    assert.equal((await h.get(url(snapshot.session, image.id))).status, 404);
  } finally {
    await h.close();
  }
});

test("configuration authority change and backend revocation stop serving and destroy the runtime", async () => {
  const h = await attachmentHarness();
  try {
    h.files.set("a.txt", Buffer.from("synthetic"));
    const c = await h.connect();
    const session = c.frames.find((m) => m.type === "attachments").session;
    const id = JSON.parse(
      (await h.send({ workspace_path: "a.txt" })).content[0].text,
    ).attachment_id;
    const url = `/api/terminal/attachments/${session}/${id}`;
    assert.equal((await h.get(url)).status, 200);
    await h.f.store.save({
      ...h.f.store.publicConfig(),
      persona: { ...h.f.store.publicConfig().persona, name: "Changed" },
    });
    assert.equal((await h.get(url)).status, 410);
    await c.until(() => c.closed() === 1008, "torn down after config change");
    assert.ok(h.runtimes[0].stopped > 0);
    assert.equal((await h.get(url)).status, 404);
  } finally {
    await h.close();
  }
  const r = await attachmentHarness();
  try {
    (NativeTerminal as any).attachmentFreshnessMs = 0;
    r.files.set("a.txt", Buffer.from("synthetic"));
    const c = await r.connect();
    const session = c.frames.find((m) => m.type === "attachments").session;
    const id = JSON.parse(
      (await r.send({ workspace_path: "a.txt" })).content[0].text,
    ).attachment_id;
    const url = `/api/terminal/attachments/${session}/${id}`;
    assert.equal((await r.get(url)).status, 200, "fresh backend authorization");
    r.f.state.revoked = true;
    assert.equal((await r.get(url)).status, 410);
    await c.until(() => c.closed() === 1008, "revocation teardown");
    assert.ok(c.frames.some((m) => m.type === "attachments-cleared"));
    assert.ok(r.runtimes[0].stopped > 0);
    assert.equal((await r.get(url)).status, 404);
  } finally {
    await r.close();
  }
});

test("serving is a retryable 503 while Pi has a request in flight and the fence is stale", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = await attachmentHarness({
    provider: async () => {
      await gate;
      return answer("done");
    },
  });
  try {
    (NativeTerminal as any).attachmentFreshnessMs = 0;
    h.files.set("a.txt", Buffer.from("synthetic"));
    const c = await h.connect();
    const session = c.frames.find((m) => m.type === "attachments").session;
    const id = JSON.parse(
      (await h.send({ workspace_path: "a.txt" })).content[0].text,
    ).attachment_id;
    const pending = h.runtimes[0].gateway.handle({
      kind: "provider",
      body: { model: "approved-custom-model", messages: [] },
    });
    await new Promise((r) => setTimeout(r, 100));
    const busy = await h.get(`/api/terminal/attachments/${session}/${id}`);
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get("retry-after"), "2");
    assert.deepEqual(await busy.json(), {
      error: "ATTACHMENT_AUTHORIZATION_BUSY",
    });
    release();
    await pending;
    assert.equal(
      (await h.get(`/api/terminal/attachments/${session}/${id}`)).status,
      200,
    );
  } finally {
    release();
    await h.close();
  }
});
