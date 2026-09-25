import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { complete } from "../src/runtime/piAdapter.js";
import { Client } from "../src/katafit/client.js";
import { openOperatorTools } from "../src/katafit/operatorTools.js";
import { operatorBackend } from "./operator-tools.test.js";

async function provider(args: unknown) {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    bodies.push(JSON.parse(raw));
    const delta =
      bodies.length === 1
        ? {
            tool_calls: [
              {
                index: 0,
                id: "call-one",
                type: "function",
                function: {
                  name: "studio_operator_send_message",
                  arguments: JSON.stringify(args),
                },
              },
            ],
          }
        : { content: "Synthetic final" };
    res.setHeader("content-type", "text/event-stream");
    res.end(
      "data: " +
        JSON.stringify({
          id: "synthetic",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", ...delta },
              finish_reason: null,
            },
          ],
        }) +
        "\n\ndata: " +
        JSON.stringify({
          id: "synthetic",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: bodies.length === 1 ? "tool_calls" : "stop",
            },
          ],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    bodies,
    config: {
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      model: "operator-synthetic",
      apiKey: "synthetic-provider-key",
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
for (const args of [
  { text: 123 },
  { text: "Hello canonical" },
  { text: "synthetic-token" },
  { text: "Hello", member_ref: "forged" },
])
  test(
    "actual Pi HTTP strictly validates operator send " + JSON.stringify(args),
    async () => {
      const f = await operatorBackend();
      const p = await provider(args);
      const actions: any[] = [];
      const signal = AbortSignal.timeout(5000);
      const session = await openOperatorTools(
        new Client(f.origin, "synthetic-token", signal),
        "member-fixture",
        {
          secrets: ["synthetic-token", p.config.apiKey],
          onAction: (a) => actions.push(a),
        },
      );
      try {
        if (args.text === "synthetic-token") {
          await assert.rejects(
            complete(
              { ...p.config, secrets: ["synthetic-token"] },
              "Manager context",
              "Explicit send",
              signal,
              session.tools,
            ),
          );
        } else
          assert.equal(
            await complete(
              { ...p.config, secrets: ["synthetic-token"] },
              "Manager context",
              "Explicit send",
              signal,
              session.tools,
            ),
            "Synthetic final",
          );
        const sends = f.calls.filter(
          (c) => c.params?.name === "studio_operator_send_message",
        );
        const valid = args.text === "Hello canonical";
        assert.equal(sends.length, valid ? 1 : 0);
        assert.equal(
          actions.filter((a) => a.status === "delivered").length,
          valid ? 1 : 0,
        );
        assert.deepEqual(
          p.bodies[0].tools.map((t: any) => t.function.name),
          [
            "studio_operator_read_member_coach_feed",
            "studio_operator_send_message",
          ],
        );
        assert.doesNotMatch(
          JSON.stringify(p.bodies),
          /synthetic-token|session-fixture/,
        );
        if (args.text === 123)
          assert.match(JSON.stringify(p.bodies[1]), /no confirmed receipt/);
      } finally {
        await session.dispose();
        await p.close();
        await f.close();
      }
    },
  );

test("actual Pi reauthorizes before each HTTP dispatch and stops after authority changes", async () => {
  const f = await operatorBackend();
  const p = await provider({ text: "Hello canonical" });
  const actions: any[] = [];
  const signal = AbortSignal.timeout(5000);
  const session = await openOperatorTools(
    new Client(f.origin, "synthetic-token", signal),
    "member-fixture",
    { secrets: ["synthetic-token"], onAction: (a) => actions.push(a) },
  );
  let checks = 0;
  try {
    await assert.rejects(
      complete(
        {
          ...p.config,
          authorize: async () => {
            if (++checks > 1) throw new Error("CREDENTIAL_REJECTED");
            await session.authorize();
          },
        },
        "Manager",
        "Send explicit hello",
        signal,
        session.tools,
      ),
    );
    assert.equal(p.bodies.length, 1);
    assert.equal(checks, 2);
    assert.equal(actions.at(-1).status, "delivered");
  } finally {
    await session.dispose();
    await p.close();
    await f.close();
  }
});
