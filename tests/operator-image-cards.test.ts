import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { fixture } from "./operator-checkins.test.js";
import { OperatorChat } from "../src/chat/operator.js";

const LIST = "studio_operator_list_dojo_checkins";
const IMAGE = "studio_operator_read_dojo_checkin_image";
test("only executed, backend-validated tool images become ephemeral cards and authenticated bytes", async () => {
  const options = { two: true, revoke: false, hasMore: true };
  const f = await fixture(options);
  const dir = await mkdtemp(tmpdir() + "/operator-cards-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
    apiKey: "synth...ey",
    provider: { ...store.publicConfig().provider, vision: false },
  });
  const app = await admin(
    store,
    0,
    async (_provider, _prompt, input, _signal, tools = []) => {
      assert.deepEqual(
        tools.map((t) => t.name),
        [
          "studio_operator_list_members",
          "studio_operator_read_member_coach_feed",
          "studio_operator_send_message",
          LIST,
          IMAGE,
        ],
      );
      assert.match(JSON.parse(input).authority, /model chooses member_ref/);
      const list = await tools
        .find((t) => t.name === LIST)!
        .execute("list", { limit: 10 });
      assert.match((list.content[0] as any).text, /not_shared/);
      for (const [member_ref, media_ref] of [
        ["member-photo", "media-photo"],
        ["member-two", "media-two"],
      ]) {
        const result = await tools
          .find((t) => t.name === IMAGE)!
          .execute("photo", { member_ref, media_ref });
        assert.deepEqual(
          result.content.map((part) => part.type),
          ["text"],
        );
        assert.match((result.content[0] as any).text, /not visually assessed/);
      }
      return "Two read; roster has more pages, coverage incomplete.";
    },
  );
  const request = (path: string, body?: object, auth = true) =>
    fetch(app.origin + path, {
      method: body ? "POST" : "GET",
      headers: {
        ...(auth ? { Authorization: "Bearer " + store.secrets.admin } : {}),
        ...(body
          ? { Origin: app.origin, "Content-Type": "application/json" }
          : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    const response = await request("/api/operator/chat", {
      text: "Show dojo photo",
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.images.length, 2);
    assert.deepEqual(
      data.images.map((x: any) => x.display_name),
      ["Alex", "Morgan"],
    );
    assert.match(data.text, /coverage incomplete/);
    assert.match(data.coverage_notice, /Partial photo coverage/);
    assert.equal(data.ephemeral, true);
    assert.equal(f.calls.includes("studio_operator_send_message"), false);
    assert.deepEqual(
      f.openings.map((opening: any) => Object.keys(opening).sort()),
      [["idempotency_key", "mode"]],
    );
    assert.equal(f.openings[0].mode, "dojo_operator");
    assert.equal(
      JSON.stringify(data).includes(f.bytes.toString("base64")),
      false,
    );
    assert.equal(JSON.stringify(data).includes("media-photo"), false);
    const id = data.images[0].id;
    assert.match(id, /^[0-9a-f-]{36}$/);
    const url = "/api/operator/image?id=" + id;
    assert.equal((await request(url, undefined, false)).status, 401);
    const media = await request(url);
    assert.equal(media.status, 200);
    assert.equal(media.headers.get("content-type"), "image/png");
    assert.equal(media.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await media.arrayBuffer()), f.bytes);
    assert.deepEqual(
      f.openings.map((opening: any) => opening.mode),
      ["dojo_operator", "dojo_operator"],
    );
    options.revoke = true;
    assert.notEqual((await request(url)).status, 200);
    options.revoke = false;
    await store.save({
      ...store.publicConfig(),
      token: "rotated-synthetic-token",
    });
    assert.notEqual((await request(url)).status, 200);
    assert.deepEqual(
      (await (await request("/api/operator/chat")).json()).images,
      undefined,
    );
    await request("/api/operator/clear", {});
    assert.notEqual((await request(url)).status, 200);
  } finally {
    await app.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("two fetched cards from three authorized refs report incomplete coverage without model admission", async () => {
  const f = await fixture({ two: true, three: true });
  const dir = await mkdtemp(tmpdir() + "/operator-coverage-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
    apiKey: "synthetic-key",
    provider: { ...store.publicConfig().provider, vision: false },
  });
  const chat = new OperatorChat(
    store,
    async (_p, _prompt, _input, _signal, tools = []) => {
      await tools.find((t) => t.name === LIST)!.execute("list", { limit: 10 });
      for (const [member_ref, media_ref] of [
        ["member-photo", "media-photo"],
        ["member-two", "media-two"],
      ])
        await tools
          .find((t) => t.name === IMAGE)!
          .execute("read", { member_ref, media_ref });
      return "I reviewed everyone's photos.";
    },
  );
  try {
    const result = await chat.turn("Show everyone's photos");
    assert.equal(result.images.length, 2);
    assert.match(result.coverage_notice ?? "", /Partial photo coverage/);
  } finally {
    await chat.cancel();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("card expiry uses unreferenced timers, zeroes bytes, and close cancels timers", async () => {
  const f = await fixture();
  const dir = await mkdtemp(tmpdir() + "/operator-expiry-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
    apiKey: "synthetic-key",
  });
  const chat = new OperatorChat(
    store,
    async (_p, _prompt, _input, _signal, tools = []) => {
      await tools.find((t) => t.name === LIST)!.execute("list", { limit: 10 });
      await tools
        .find((t) => t.name === IMAGE)!
        .execute("read", {
          member_ref: "member-photo",
          media_ref: "media-photo",
        });
      return "Done.";
    },
  );
  try {
    const result = await chat.turn("Show photo");
    const internal = chat as any;
    const card = internal.cards.get(result.images[0].id);
    const timer = internal.cardTimers.get(card.id);
    assert.equal(timer.hasRef(), false);
    assert.equal(internal.cardTimers.size, 1);
    // Invoke the scheduled expiry handler; the handle is unref'd and cannot hold the CLI open.
    timer._onTimeout();
    clearTimeout(timer);
    assert.equal(internal.cardTimers.size, 0);
    assert.equal(internal.cards.size, 0);
    assert.ok(card.bytes.every((byte: number) => byte === 0));
    const again = await chat.turn("Show photo again");
    const next = internal.cards.get(again.images[0].id);
    const nextTimer = internal.cardTimers.get(next.id);
    assert.equal(internal.cardTimers.size, 1);
    await chat.cancel();
    assert.equal(internal.cardTimers.size, 0);
    assert.equal(internal.cards.size, 0);
    assert.ok(next.bytes.every((byte: number) => byte === 0));
    assert.equal(nextTimer._destroyed, true);
  } finally {
    await chat.cancel();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("model-authored image claims never create cards", async () => {
  const f = await fixture();
  const dir = await mkdtemp(tmpdir() + "/operator-no-cards-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
    apiKey: "synth...ey",
  });
  const app = await admin(
    store,
    0,
    async () => "![photo](data:image/png;base64,AAAA) media-photo",
  );
  try {
    const response = await fetch(app.origin + "/api/operator/chat", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + store.secrets.admin,
        Origin: app.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "Show" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).images, []);
  } finally {
    await app.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("completed roster pagination does not falsely warn about partial coverage", async () => {
  const f = await fixture({ two: true, twoPages: true });
  const dir = await mkdtemp(tmpdir() + "/operator-pages-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
    apiKey: "synthetic-key",
    provider: { ...store.publicConfig().provider, vision: false },
  });
  const app = await admin(
    store,
    0,
    async (_provider, _prompt, _input, _signal, tools = []) => {
      const list = tools.find((tool) => tool.name === LIST)!;
      const image = tools.find((tool) => tool.name === IMAGE)!;
      const first = JSON.parse(
        (await list.execute("first", { limit: 10 })).content[0].text,
      );
      assert.equal(first.has_more, true);
      const second = JSON.parse(
        (await list.execute("next", { limit: 10, cursor: first.next_cursor }))
          .content[0].text,
      );
      assert.equal(second.has_more, false);
      for (const row of [...first.items, ...second.items]) {
        if (row.access !== "shared") continue;
        for (const item of row.images)
          await image.execute("photo", {
            member_ref: row.member_ref,
            media_ref: item.media_ref,
          });
      }
      return "Two authorized photos delivered.";
    },
  );
  try {
    const response = await fetch(app.origin + "/api/operator/chat", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + store.secrets.admin,
        Origin: app.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "Show the shared photos" }),
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.images.length, 2);
    assert.equal(data.coverage_notice, undefined);
  } finally {
    await app.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
