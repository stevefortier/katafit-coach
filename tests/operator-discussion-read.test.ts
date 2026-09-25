import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { fixture } from "./operator-checkins.test.js";

test("member-derived operator context is not reused after sharing changes", async () => {
  const f = await fixture();
  const dir = await mkdtemp(tmpdir() + "/operator-read-followup-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
    apiKey: "synth...ey",
  });
  const seen: any[] = [];
  const app = await admin(
    store,
    0,
    async (_provider, _prompt, input, _signal, tools = []) => {
      const context = JSON.parse(input);
      seen.push(context.messages);
      assert.deepEqual(
        tools.map((t) => t.name),
        [
          "studio_operator_list_members",
          "studio_operator_read_member_coach_feed",
          "studio_operator_list_dojo_checkins",
          "studio_operator_read_dojo_checkin_image",
        ],
      );
      if (seen.length === 1) {
        await tools[2].execute("roster", { limit: 10 });
        return "Authorized Alex shared; Pat not shared.";
      }
      const roster = await tools[2].execute("roster", { limit: 10 });
      assert.match(roster.content[0].text, /not_shared/);
      return "Current access does not establish Alex's photos.";
    },
    undefined,
    undefined,
    undefined,
    async (text) =>
      text === "A new topic"
        ? { kind: "discussion", targets: [], domains: [], action: "none" }
        : {
            kind: "read",
            targets: text.includes("Alex") ? ["Alex"] : [],
            domains: ["checkins"],
            action: "none",
          },
  );
  const post = (text: string) =>
    fetch(app.origin + "/api/operator/chat", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + store.secrets.admin,
        Origin: app.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
  try {
    const first = await post("How are my trainees doing?");
    assert.equal(first.status, 200);
    assert.equal((await first.json()).ephemeral, true);
    f.revokeSharing();
    const second = await post("And what about Alex now?");
    assert.equal(second.status, 200);
    assert.equal((await second.json()).ephemeral, true);
    assert.doesNotMatch(JSON.stringify(seen[1]), /Authorized Alex shared/);
    assert.deepEqual(
      (
        await (
          await fetch(app.origin + "/api/operator/chat", {
            headers: { Authorization: "Bearer " + store.secrets.admin },
          })
        ).json()
      ).messages,
      [],
    );
    assert.deepEqual(
      f.openings.map((opening: any) => opening.mode),
      ["dojo_operator", "dojo_operator"],
    );
    await fetch(app.origin + "/api/operator/clear", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + store.secrets.admin,
        Origin: app.origin,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    await post("A new topic");
    assert.equal(seen[2].length, 1);
  } finally {
    await app.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
