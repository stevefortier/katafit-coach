import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "../src/katafit/client.js";
import {
  openOperatorTools,
  modelOperatorTools,
} from "../src/katafit/operatorTools.js";
import { complete } from "../src/runtime/piAdapter.js";
import { fixture } from "./operator-checkins.test.js";

test("real Pi selects roster then both authorized member feeds for a comparison", async () => {
  const f = await fixture({ two: true });
  const bodies: any[] = [];
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    bodies.push(body);
    const index = bodies.length;
    const calls = [
      ["studio_operator_list_members", {}],
      [
        "studio_operator_read_member_coach_feed",
        { member_ref: "member-photo" },
      ],
      ["studio_operator_read_member_coach_feed", { member_ref: "member-two" }],
    ] as const;
    const delta =
      index <= calls.length
        ? {
            tool_calls: [
              {
                index: 0,
                id: `comparison-${index}`,
                type: "function",
                function: {
                  name: calls[index - 1][0],
                  arguments: JSON.stringify(calls[index - 1][1]),
                },
              },
            ],
          }
        : {
            content:
              "Both feeds were read, but activities were unavailable; no volume or compliance claim is justified.",
          };
    const event = (value: any) =>
      `data: ${JSON.stringify({ id: "synthetic", choices: [{ index: 0, delta: value.delta, finish_reason: value.reason }] })}\n\n`;
    res.setHeader("content-type", "text/event-stream");
    res.end(
      event({ delta: { role: "assistant", ...delta }, reason: null }) +
        event({
          delta: {},
          reason: index <= calls.length ? "tool_calls" : "stop",
        }) +
        "data: [DONE]\n\n",
    );
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const signal = AbortSignal.timeout(10000);
  const s = await openOperatorTools(
    new Client(f.origin, "synthetic-token", signal),
    undefined,
    { secrets: ["synthetic-token"], onAction: () => {} },
  );
  try {
    const reply = await complete(
      {
        baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
        model: "operator-synthetic",
        apiKey: "synthetic-key",
        vision: false,
        secrets: ["synthetic-token"],
        authorize: s.authorize,
      },
      "Manager: compare only retrieved evidence",
      "Compare Alex and Morgan",
      signal,
      modelOperatorTools(s.tools, false),
    );
    assert.match(reply, /Both feeds were read/);
    assert.equal(
      f.calls.filter(
        (name) => name === "studio_operator_read_member_coach_feed",
      ).length >= 2,
      true,
    );
    assert.match(JSON.stringify(bodies[3]), /Authorized member feed/);
    assert.equal(f.calls.includes("studio_operator_send_message"), false);
  } finally {
    await s.dispose();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await f.close();
  }
});
