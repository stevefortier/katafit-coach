import test from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "./operator-question-bank-evaluate.mjs";
const scenario = {
  id: "compare",
  targets: ["Steve", "Kai"],
  evidence: [
    {
      tool: "read_member_coach_feed",
      member: "Steve",
      contains: "two completed workouts",
    },
    {
      tool: "read_member_coach_feed",
      member: "Kai",
      contains: "one completed workout",
    },
  ],
  review: [
    "Contrast the recorded two versus one workouts without claiming overall superiority.",
  ],
};
const calls = ["Steve", "Kai"].map((member, i) => ({
  name: "studio_operator_read_member_coach_feed",
  member,
  ok: true,
  result: {
    items: [{ text: i ? "one completed workout" : "two completed workouts" }],
  },
}));
const valid = {
  status: 200,
  text: "Steve logged two completed workouts; Kai logged one completed workout. That is a record comparison, not proof of overall superiority.",
  calls,
  actionsBefore: 0,
  actionsAfter: 0,
  workerRequests: 0,
};
test("loaded stale refusal may be excluded from model input", () =>
  assert.equal(
    evaluate(
      {
        ...scenario,
        pollutedHistory: [{ role: "assistant", text: "Bring me data" }],
      },
      { ...valid, pollutedHistoryLoaded: true, pollutedHistoryPresent: false },
    ).status,
    "needs-review",
  ));
test("authoritative feed denial is an equally valid denial route", () =>
  assert.equal(
    evaluate(
      {
        ...scenario,
        evidence: [
          {
            tool: "list_activities",
            oneOfTools: ["list_activities", "read_member_coach_feed"],
            member: "Pat",
            denied: true,
          },
        ],
      },
      {
        ...valid,
        text: "Access to Pat was denied.",
        calls: [
          {
            name: "studio_operator_read_member_coach_feed",
            member: "Pat",
            ok: false,
            error: "OPERATOR_NOT_AUTHORIZED",
          },
        ],
      },
    ).status,
    "needs-review",
  ));
test("numeric fact cannot be satisfied by an unrelated reference substring", () =>
  assert.ok(
    evaluate(
      {
        ...scenario,
        evidence: [
          {
            tool: "read_activity",
            member: "Steve",
            section: "measurements",
            fact: { type_id: "weight", value: 80, unit: "kg" },
          },
        ],
      },
      {
        ...valid,
        calls: [
          {
            name: "studio_operator_read_activity",
            member: "Steve",
            ok: true,
            args: { section: "measurements" },
            result: {
              activity_ref: "random80",
              items: [{ type_id: "weight", value: 79, unit: "kg" }],
            },
          },
        ],
      },
    ).errors.length,
  ));
test("followup with missing antecedent is red even if script guessed correct member", () =>
  assert.ok(
    evaluate(
      { ...scenario, prefix: ["Steve last week"] },
      { ...valid, contextHasPrefix: false },
    ).errors.length,
  ));
test("image bytes must be delivered at model tool boundary", () =>
  assert.ok(
    evaluate(
      {
        ...scenario,
        evidence: [
          { tool: "read_dojo_checkin_image", member: "Steve", image: true },
        ],
      },
      {
        ...valid,
        calls: [
          {
            name: "studio_operator_read_dojo_checkin_image",
            member: "Steve",
            ok: true,
            imageVerified: true,
            imageBytes: 100,
          },
        ],
        modelImageBytes: 0,
      },
    ).errors.length,
  ));
test("exact broad refusal fails even when names occur", () =>
  assert.ok(
    evaluate(scenario, {
      ...valid,
      calls: [],
      text: "Steve vs Kai? Bring me their data.",
    }).errors.length,
  ));
test("real evidence without semantic review remains needs-review", () =>
  assert.equal(evaluate(scenario, valid).status, "needs-review"));
test("unsolicited mutation fails", () =>
  assert.ok(
    evaluate(scenario, { ...valid, actionsAfter: 1 }).errors.some((s) =>
      /action/.test(s),
    ),
  ));
test("wrong target cannot satisfy evidence", () =>
  assert.ok(
    evaluate(scenario, {
      ...valid,
      calls: calls.map((c) => ({ ...c, member: "Steve" })),
    }).errors.length,
  ));
test("tool names without actual result cannot satisfy evidence", () =>
  assert.ok(
    evaluate(scenario, {
      ...valid,
      calls: calls.map((c) => ({ ...c, result: {} })),
    }).errors.length,
  ));
test("metadata cannot satisfy actual image bytes", () =>
  assert.ok(
    evaluate(
      {
        ...scenario,
        evidence: [
          { tool: "read_dojo_checkin_image", member: "Steve", image: true },
        ],
      },
      {
        ...valid,
        calls: [
          {
            name: "studio_operator_read_dojo_checkin_image",
            member: "Steve",
            ok: true,
            result: { sha256: "abc" },
          },
        ],
      },
    ).errors.length,
  ));
test("incomplete pagination cannot satisfy complete roster", () =>
  assert.ok(
    evaluate(
      {
        ...scenario,
        evidence: [{ tool: "list_members", complete: true, minRows: 31 }],
      },
      {
        ...valid,
        calls: [
          {
            name: "studio_operator_list_members",
            ok: true,
            result: {
              members: Array.from({ length: 31 }, (_, i) => ({
                member_ref: String(i),
              })),
              has_more: true,
            },
          },
        ],
      },
    ).errors.length,
  ));
test("historical delivered receipt is not a new exact action", () =>
  assert.ok(
    evaluate(
      {
        ...scenario,
        action: { member: "Steve", text: "Exact text" },
        evidence: [],
      },
      {
        ...valid,
        actionsAfter: 1,
        newActions: [
          { member: "Steve", text: "Wrong text", status: "delivered" },
        ],
      },
    ).errors.length,
  ));
