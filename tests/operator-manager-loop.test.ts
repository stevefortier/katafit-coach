import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store, compileOperator } from "../src/config/store.js";
import { Client } from "../src/katafit/client.js";
import { openOperatorTools } from "../src/katafit/operatorTools.js";
import { OperatorChat } from "../src/chat/operator.js";
import { fixture } from "./operator-checkins.test.js";

async function run(
  text: string,
  infer: ConstructorParameters<typeof OperatorChat>[1],
  options: Parameters<typeof fixture>[0] = {},
) {
  const backend = await fixture({ two: true, ...options });
  const dir = await mkdtemp(tmpdir() + "/operator-manager-");
  let chat: OperatorChat | undefined;
  try {
    const store = new Store(dir);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin: backend.origin,
      token: "synthetic-token",
      ["api" + "Key"]: "synthetic-key",
    });
    chat = new OperatorChat(store, infer);
    const result = await chat.turn(text);
    return { result, calls: backend.callArgs, history: chat.snapshot() };
  } finally {
    await chat?.cancel();
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  }
}

for (const request of [
  "Bring me up to speed on Alex and Morgan.",
  "Give me the lowdown on those two, Alex and Morgan.",
  "Book a moment to review Alex and Morgan's Coach feeds, not an appointment.",
])
  test(`manager native loop, not intent gates: ${request}`, async () => {
    const { result, calls } = await run(
      request,
      async (_provider, prompt, context, _signal, tools = []) => {
        assert.match(prompt, /manager/);
        assert.match(prompt, /persona/i);
        assert.match(prompt, /coachee behavior/i);
        assert.match(context, /studio_operator_send_message/);
        const roster = tools.find(
          (t) => t.name === "studio_operator_list_members",
        )!;
        const output = await roster.execute("roster", {});
        const part = output.content.find((p) => p.type === "text")!;
        assert.equal(part.type, "text");
        const members = JSON.parse(part.text).members;
        const feed = tools.find(
          (t) => t.name === "studio_operator_read_member_coach_feed",
        )!;
        for (const name of ["Alex", "Morgan"])
          await feed.execute(name, {
            member_ref: members.find((m: any) => m.display_name === name)
              .member_ref,
          });
        return "Alex completed two workouts; Morgan completed one.";
      },
    );
    assert.match(result.text, /two workouts/);
    assert.ok(
      calls.some(
        (c) =>
          c.name === "studio_operator_read_member_coach_feed" &&
          c.args.member_ref === "member-two",
      ),
    );
    assert.equal(result.ephemeral, true);
  });

test("backend-denied read can produce an honest partial answer, not discard successful work", async () => {
  const { result, history } = await run(
    "Summarize Alex and Morgan",
    async (_p, _s, _c, _signal, tools = []) => {
      const feed = tools.find(
        (t) => t.name === "studio_operator_read_member_coach_feed",
      )!;
      await feed.execute("alex", { member_ref: "member-photo" });
      await assert.rejects(
        feed.execute("morgan", { member_ref: "member-two" }),
      );
      return "Alex completed two workouts. Morgan's feed was unavailable; I cannot compare them.";
    },
    { denyFeed: "member-two" },
  );
  assert.match(result.text, /unavailable/);
  assert.equal(result.ephemeral, true);
  assert.deepEqual(history.messages, []);
});

test("manager persona retains identity and delegates capability permissions to backend", () => {
  const store = new Store("/unused");
  const config = store.publicConfig();
  config.persona.name = "Coach Granite";
  config.persona.principles =
    "Demand disciplined training; refuse excuses from trainees.";
  const prompt = compileOperator(config);
  assert.match(prompt, /Coach Granite/);
  assert.match(prompt, /same.*identity/i);
  assert.match(prompt, /backend.*capabilit/i);
  assert.doesNotMatch(prompt, /do not otherwise mutate records/);
});

test("image reauthorization asks backend again rather than inferring sharing from roster equality", async () => {
  const f = await fixture();
  try {
    const session = await openOperatorTools(
      new Client(f.origin, "synthetic-token", AbortSignal.timeout(5000)),
      undefined,
      { secrets: ["synthetic-token"], onAction: () => {} },
    );
    try {
      await session.tools
        .find((t) => t.name === "studio_operator_list_dojo_checkins")!
        .execute("list", {});
      await session.tools
        .find((t) => t.name === "studio_operator_read_dojo_checkin_image")!
        .execute("image", {
          member_ref: "member-photo",
          media_ref: "media-photo",
        });
      f.revokeSharing();
      await assert.rejects(session.authorize(), /MCP_TOOL_FAILED/);
      assert.equal(
        f.calls.filter(
          (name) => name === "studio_operator_read_dojo_checkin_image",
        ).length,
        2,
      );
    } finally {
      await session.dispose();
    }
  } finally {
    await f.close();
  }
});
