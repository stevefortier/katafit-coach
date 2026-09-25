import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { fixture } from "./operator-checkins.test.js";

const FEED = "studio_operator_read_member_coach_feed";
const SEND = "studio_operator_send_message";
test("one Operator turn chooses a member through advertised session tools, never a host recipient", async () => {
  const f = await fixture();
  const dir = await mkdtemp(tmpdir() + "/operator-unified-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: f.origin,
    token: "synthetic-token",
    apiKey: "synthetic-key",
  });
  const app = await admin(
    store,
    0,
    async (_p, _s, context, _signal, tools = []) => {
      assert.match(JSON.parse(context).authority, /authorized.*turn tools/i);
      assert.deepEqual(
        tools.map((t) => t.name),
        [
          "studio_operator_list_members",
          FEED,
          SEND,
          "studio_operator_list_dojo_checkins",
          "studio_operator_read_dojo_checkin_image",
        ],
      );
      await tools[0].execute("roster", {});
      await assert.rejects(
        tools[2].execute("invalid", { text: "Hi" }),
        /READ_UNAVAILABLE|ARGUMENTS_REJECTED/,
      );
      await tools[1].execute("read", { member_ref: "member-photo" });
      await tools[2].execute("send", {
        member_ref: "member-photo",
        text: "Hi Alex",
      });
      await assert.rejects(
        tools[2].execute("second", {
          member_ref: "member-denied",
          text: "Hi Pat",
        }),
        /READ_UNAVAILABLE|ARGUMENTS_REJECTED/,
      );
      return "Sent to Alex.";
    },
    undefined,
    undefined,
    undefined,
    async () => ({
      kind: "action",
      targets: ["Alex"],
      domains: [],
      action: "send",
    }),
  );
  try {
    const headers = {
      Authorization: "Bearer " + store.secrets.admin,
      Origin: app.origin,
      "Content-Type": "application/json",
    };
    const forged = await fetch(app.origin + "/api/operator/chat", {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "Hi", member_ref: "member-photo" }),
    });
    assert.equal(forged.status, 400);
    const result = await fetch(app.origin + "/api/operator/chat", {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "Send Alex Hi Alex" }),
    });
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal((await result.json()).ephemeral, true);
    assert.deepEqual(
      f.openings.map((opening: any) => opening.mode),
      ["dojo_operator"],
    );
    assert.deepEqual(
      (
        await (
          await fetch(app.origin + "/api/operator/chat", { headers })
        ).json()
      ).messages,
      [],
    );
  } finally {
    await app.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
