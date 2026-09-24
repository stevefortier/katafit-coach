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

test("real text-only Pi selects authorized image delivery but never sends pixels to provider", async () => {
  const f = await fixture();
  const bodies: any[] = [];
  const names: string[] = [];
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
                id: `call-${index}`,
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
        : { content: "Card delivered; I did not visually assess the photo." };
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
    {
      secrets: ["synthetic-token"],
      onAction: () => {},
      onImage: (image) => names.push(image.display_name),
    },
  );
  try {
    const reply = await complete(
      {
        baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
        model: "operator-synthetic",
        apiKey: "synthetic-provider-key",
        vision: false,
        secrets: ["synthetic-token"],
        authorize: s.authorize,
      },
      "Manager",
      "Show check-ins",
      signal,
      modelOperatorTools(s.tools, false),
    );
    assert.match(reply, /did not visually assess/);
    assert.deepEqual(names, ["Alex"]);
    assert.equal(bodies.length >= 3, true);
    assert.match(JSON.stringify(bodies[2]), /not visually assessed/);
    assert.doesNotMatch(
      JSON.stringify(bodies),
      /image_url|data:image\/|base64/,
    );
    assert.doesNotMatch(
      JSON.stringify(bodies),
      new RegExp(f.bytes.toString("base64")),
    );
  } finally {
    await s.dispose();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await f.close();
  }
});
