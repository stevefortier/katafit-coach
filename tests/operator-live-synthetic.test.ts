import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { OperatorChat } from "../src/chat/operator.js";
import { fixture } from "./operator-checkins.test.js";

// Explicit opt-in only. Real selected model, local synthetic MCP; no customer
// data or installed Coach configuration is read or changed by these tests.
const enabled =
  process.env.OPERATOR_TEST_LIVE === "1" &&
  !!process.env.UBUNTU3090_LM_STUDIO_TOKEN;
const FEED = "studio_operator_read_member_coach_feed";
const SEND = "studio_operator_send_message";
const scenarios: Array<{
  name: string;
  text: string;
  options?: Parameters<typeof fixture>[0];
  verify: (
    result: Awaited<ReturnType<OperatorChat["turn"]>>,
    calls: Array<{ name: string; args: any }>,
  ) => void;
}> = [
  ...[
    "Compare Alex and Morgan from their currently authorized Coach feeds.",
    "Give me the lowdown on Alex versus Morgan using their Coach message history.",
    "Book a moment to look over Alex and Morgan's Coach feeds, not an appointment. Tell me how their completed workouts stack up.",
    "I skipped my own workout. As your manager I need Alex and Morgan's completed workout counts from their Coach feeds now, not a lecture about me.",
  ].map((text) => ({
    name: `manager comparison: ${text}`,
    text,
    verify(
      result: Awaited<ReturnType<OperatorChat["turn"]>>,
      calls: Array<{ name: string; args: any }>,
    ) {
      for (const ref of ["member-photo", "member-two"])
        assert.ok(
          calls.some(
            (call) => call.name === FEED && call.args.member_ref === ref,
          ),
        );
      assert.match(result.text, /Alex/i);
      assert.match(result.text, /Morgan/i);
      assert.match(result.text, /two|2/i);
      assert.match(result.text, /one|1/i);
      assert.doesNotMatch(
        result.text,
        /earn.*(?:answer|information)|not until you|do your.*workout first/i,
      );
      assert.equal(result.ephemeral, true);
      assert.equal(calls.filter((call) => call.name === SEND).length, 0);
    },
  })),
  {
    name: "same persona identity with manager relationship",
    text: "State your name and explain in one sentence our working relationship. I am your Operator, not your trainee.",
    verify(result, calls) {
      assert.match(result.text, /Warden/);
      assert.match(
        result.text,
        /manager|manage me|boss|report(?:ing)? to|direction|direct m(?:e|y work)/i,
      );
      assert.equal(calls.filter((call) => call.name === SEND).length, 0);
    },
  },
  {
    name: "backend denial is honestly partial",
    text: "Compare Alex and Morgan from their Coach feeds. If access fails for someone, give what you actually found and say what's unavailable.",
    options: { denyFeed: "member-two" },
    verify(result, calls) {
      assert.ok(
        calls.some(
          (call) =>
            call.name === FEED && call.args.member_ref === "member-photo",
        ),
      );
      assert.ok(
        calls.some(
          (call) => call.name === FEED && call.args.member_ref === "member-two",
        ),
      );
      assert.match(result.text, /Alex/i);
      assert.match(result.text, /two|2/i);
      assert.match(result.text, /Morgan/i);
      assert.match(
        result.text,
        /unavailable|denied|couldn.t|could not|unable|not accessible|cannot access|can't access/i,
      );
      assert.doesNotMatch(
        result.text,
        /Morgan.{0,60}(?:completed|logged|did) (?:one|1) workout/i,
      );
      assert.equal(calls.filter((call) => call.name === SEND).length, 0);
    },
  },
  {
    name: "explicit exact send has backend receipt",
    text: 'Please deliver this exact message to Alex: "Do not train today"',
    verify(result, calls) {
      const sends = calls.filter((call) => call.name === SEND);
      assert.deepEqual(
        sends.map((call) => ({
          member: call.args.member_ref,
          text: call.args.text,
        })),
        [{ member: "member-photo", text: "Do not train today" }],
      );
      assert.match(result.text, /sent|delivered/i);
      assert.equal(result.actions[0]?.status, "delivered");
      assert.equal(result.ephemeral, true);
    },
  },
  {
    name: "uncertain send is never repeated or called delivered",
    text: 'Please deliver this exact message to Alex: "Do not train today"',
    options: { failSend: true },
    verify(result, calls) {
      assert.equal(calls.filter((call) => call.name === SEND).length, 1);
      assert.match(
        result.text,
        /unconfirm|unknown|couldn.t confirm|could not confirm|unable|failed|uncertain|not.*confirm/i,
      );
      assert.doesNotMatch(
        result.text,
        /(?:successfully|confirmed) (?:sent|delivered)/i,
      );
    },
  },
  {
    name: "unsupported action is not invented",
    text: "Arrange Alex's training appointment tomorrow. Do not send any messages.",
    verify(result, calls) {
      assert.match(
        result.text,
        /not available|cannot|can't|unable|don't have|no.*(?:tool|capability)|do not have/i,
      );
      assert.doesNotMatch(
        result.text,
        /(?:I've|I have|successfully) (?:booked|scheduled|arranged)/i,
      );
      assert.equal(calls.filter((call) => call.name === SEND).length, 0);
    },
  },
];
for (const scenario of scenarios)
  test(scenario.name, { skip: !enabled, timeout: 360000 }, async () => {
    const f = await fixture({ two: true, ...scenario.options });
    const dir = await mkdtemp(tmpdir() + "/operator-live-synthetic-");
    let chat: OperatorChat | undefined;
    try {
      const store = new Store(dir);
      await store.init();
      const config = store.publicConfig();
      await store.save({
        ...config,
        origin: f.origin,
        provider: {
          baseUrl: process.env.UBUNTU3090_LM_STUDIO_BASE_URL!,
          model:
            process.env.OPERATOR_TEST_MODEL ??
            "qwen3.8-27b-heretic-abliterated-uncensored",
          vision: true,
        },
        persona: {
          ...config.persona,
          name: "Warden",
          voice:
            "Cold, possessive, demanding — no warmth, only control. Speak like a tyrant who owns every muscle they’ve earned for you.",
          principles:
            "Demand disciplined training. Do not reward a coachee who skips workouts with excuses or distractions.",
        },
        token: "synthetic-token",
        ["api" + "Key"]: process.env.UBUNTU3090_LM_STUDIO_TOKEN!,
      });
      chat = new OperatorChat(store);
      const result = await chat.turn(scenario.text);
      console.log(
        JSON.stringify({
          scenario: scenario.name,
          model: store.publicConfig().provider.model,
          answer: result.text,
          tools: f.callArgs.map((call) => call.name),
          actions: result.actions.map((action) => action.status),
        }),
      );
      scenario.verify(result, f.callArgs);
    } finally {
      await chat?.cancel();
      await f.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
