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
