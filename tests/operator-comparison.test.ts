import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { fixture } from "./operator-checkins.test.js";

test("Operator compares two roster identities from permitted evidence without retaining cross-turn member context", async () => {
  const f = await fixture({ two: true });
  const dir = await mkdtemp(tmpdir() + "/operator-comparison-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
    apiKey: "synthetic-key",
  });
  let turns = 0;
  const app = await admin(
    store,
    0,
    async (_p, system, context, _signal, tools = []) => {
      turns++;
      assert.match(system, /retrieve both members.*permitted feeds/i);
      assert.match(system, /display names can collide.*clarif/i);
      if (turns === 2) {
        assert.doesNotMatch(context, /Authorized member feed/);
        return "Current access has not been rechecked in this turn.";
      }
      const roster = await tools
        .find((t) => t.name === "studio_operator_list_members")!
        .execute("roster", {});
      assert.match(JSON.stringify(roster), /member-photo/);
      assert.match(JSON.stringify(roster), /member-two/);
      const feed = tools.find(
        (t) => t.name === "studio_operator_read_member_coach_feed",
      )!;
      for (const member_ref of ["member-photo", "member-two"])
        assert.match(
          JSON.stringify(await feed.execute("feed", { member_ref })),
          /Authorized member feed/,
        );
      return "Both authorized feeds have synthetic evidence. Activity data was not retrieved, so volume and compliance cannot be compared.";
    },
  );
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  try {
    for (const text of ["Compare Alex and Morgan", "Follow up"]) {
      const response = await fetch(app.origin + "/api/operator/chat", {
        method: "POST",
        headers,
        body: JSON.stringify({ text }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(
        (await response.json()).ephemeral,
        text === "Compare Alex and Morgan",
      );
    }
    assert.equal(turns, 2);
  } finally {
    await app.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Operator retries a no-read comparison refusal against authorized evidence", async () => {
  const f = await fixture({ two: true });
  const dir = await mkdtemp(tmpdir() + "/operator-no-read-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
    ["api" + "Key"]: ["synthetic", "key"].join("-"),
  });
  let attempts = 0;
  const app = await admin(
    store,
    0,
    async (_p, system, _context, _signal, tools = []) => {
      attempts++;
      if (attempts === 1)
        return "I do not have Steve or Kai's files open. Supply evidence before I compare them.";
      assert.match(system, /read tools/i);
      const roster = await tools
        .find((t) => t.name === "studio_operator_list_members")!
        .execute("roster", {});
      assert.match(JSON.stringify(roster), /member-photo/);
      const feed = tools.find(
        (t) => t.name === "studio_operator_read_member_coach_feed",
      )!;
      for (const member_ref of ["member-photo", "member-two"])
        await feed.execute("feed", { member_ref });
      return "Authorized evidence for both members was retrieved. Other domains were not checked.";
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
      body: JSON.stringify({
        text: "Tell me what you think about Alex vs Morgan",
      }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const answer = await response.json();
    assert.equal(attempts, 2);
    assert.equal(answer.ephemeral, true);
    assert.match(answer.text, /evidence for both members was retrieved/);
    assert.doesNotMatch(JSON.stringify(answer.messages), /Supply evidence/);
  } finally {
    await app.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("duplicate roster display names cannot yield an arbitrary named-member verdict", async () => {
  const f = await fixture({ two: true, duplicateMorgan: true });
  const dir = await mkdtemp(tmpdir() + "/operator-duplicate-name-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
    ["api" + "Key"]: ["synthetic", "key"].join("-"),
  });
  let attempts = 0;
  const app = await admin(
    store,
    0,
    async (_p, _system, context, _signal, tools = []) => {
      attempts++;
      assert.match(context, /member-photo/); // roster fetched before inference
      assert.equal(
        tools.some((t) => t.name === "studio_operator_send_message"),
        false,
      );
      const feed = tools.find(
        (t) => t.name === "studio_operator_read_member_coach_feed",
      )!;
      await feed.execute("alex", { member_ref: "member-photo" });
      await feed.execute("pat", { member_ref: "member-denied" });
      return "Alex completed two workouts; Morgan completed none.";
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
      body: JSON.stringify({
        text: "Compare Alex vs Morgan and summarize their message activity",
      }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "READ_UNAVAILABLE");
    assert.equal(attempts, 0); // Ambiguity rejected before asking a model to guess.
    assert.equal(f.calls.includes("studio_operator_send_message"), false);
  } finally {
    await app.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("one member's feed cannot support a two-member comparison", async () => {
  const f = await fixture({ two: true });
  const dir = await mkdtemp(tmpdir() + "/operator-one-member-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
    ["api" + "Key"]: ["synthetic", "key"].join("-"),
  });
  let attempts = 0;
  const app = await admin(
    store,
    0,
    async (_p, _system, _context, _signal, tools = []) => {
      attempts++;
      assert.equal(
        tools.some((t) => t.name === "studio_operator_send_message"),
        false,
      );
      await tools
        .find((t) => t.name === "studio_operator_list_members")!
        .execute("roster", {});
      await tools
        .find((t) => t.name === "studio_operator_read_member_coach_feed")!
        .execute("feed", { member_ref: "member-photo" });
      return "Alex completed two workouts while Morgan completed none.";
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
      body: JSON.stringify({
        text: "Compare Alex vs Morgan and summarize their message activity",
      }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "READ_UNAVAILABLE");
    assert.equal(attempts, 2);
    const history = await fetch(app.origin + "/api/operator/chat", {
      headers: { Authorization: "Bearer " + store.secrets.admin },
    });
    assert.deepEqual((await history.json()).messages, []);
  } finally {
    await app.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a roster-only comparison cannot be presented as an evidence-grounded verdict", async () => {
  const f = await fixture({ two: true });
  const dir = await mkdtemp(tmpdir() + "/operator-roster-only-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
    ["api" + "Key"]: ["synthetic", "key"].join("-"),
  });
  let attempts = 0;
  const app = await admin(
    store,
    0,
    async (_p, _system, _context, _signal, tools = []) => {
      attempts++;
      if (attempts === 2)
        await tools
          .find((t) => t.name === "studio_operator_list_members")!
          .execute("roster", {});
      return "I have no files open, so you must provide their data.";
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
      body: JSON.stringify({
        text: "Compare Alex vs Morgan and summarize their message activity",
      }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "READ_UNAVAILABLE");
    assert.equal(attempts, 2);
    assert.deepEqual(
      (
        await fetch(app.origin + "/api/operator/chat", {
          headers: { Authorization: "Bearer " + store.secrets.admin },
        }).then((r) => r.json())
      ).messages,
      [],
    );
  } finally {
    await app.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
