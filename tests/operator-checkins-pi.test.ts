import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "../src/katafit/client.js";
import { openOperatorTools } from "../src/katafit/operatorTools.js";
import { complete } from "../src/runtime/piAdapter.js";
import { fixture } from "./operator-checkins.test.js";

test("real Pi tool selections deliver verified photo as image content in provider request", async () => {
  const f = await fixture();
  const bodies: any[] = [];
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    bodies.push(body);
    const index = bodies.length;
    const delta =
      index < 3
        ? {
            tool_calls: [
              {
                index: 0,
                id: `photo-call-${index}`,
                type: "function",
                function: {
                  name:
                    index === 1
                      ? "studio_operator_list_dojo_checkins"
                      : "studio_operator_read_dojo_checkin_image",
                  arguments: JSON.stringify(
                    index === 1
                      ? { limit: 10 }
                      : {
                          member_ref: "member-photo",
                          media_ref: "media-photo",
                        },
                  ),
                },
              },
            ],
          }
        : {
            content:
              "I verified Alex's check-in photo; Pat has not shared a photo.",
          };
    const event = (value: any) =>
      `data: ${JSON.stringify({ id: "synthetic", choices: [{ index: 0, delta: value.delta, finish_reason: value.reason }] })}\n\n`;
    res.setHeader("content-type", "text/event-stream");
    res.end(
      event({ delta: { role: "assistant", ...delta }, reason: null }) +
        event({ delta: {}, reason: index < 3 ? "tool_calls" : "stop" }) +
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
        vision: true,
        secrets: ["synthetic-token"],
        authorize: s.authorize,
      },
      "Manager",
      "Show check-ins",
      signal,
      s.tools,
    );
    assert.match(reply, /Alex/);
    assert.equal(
      f.calls.filter((n) => n === "studio_operator_list_dojo_checkins")
        .length >= 1,
      true,
    );
    assert.equal(
      f.calls.filter((n) => n === "studio_operator_read_dojo_checkin_image")
        .length,
      1,
    );
    const wire = JSON.stringify(bodies[2]);
    assert.match(wire, /image_url/);
    assert.match(wire, new RegExp(f.bytes.toString("base64")));
    assert.doesNotMatch(JSON.stringify(bodies.slice(0, 2)), /image_url/);
  } finally {
    await s.dispose();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await f.close();
  }
});
