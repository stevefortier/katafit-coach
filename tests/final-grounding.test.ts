import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { complete } from "../src/runtime/piAdapter.js";

async function fixture(
  run: (url: string, requests: any[]) => Promise<void>,
  respond?: (request: any, turn: number) => any | Promise<any>,
) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const delta = respond
      ? await respond(requests.at(-1), requests.length)
      : {
          role: "assistant",
          content: requests.length === 1 ? "DRAFT_PRIVATE" : "REVIEWED_FINAL",
        };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ id: "synthetic", choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(
      `http://127.0.0.1:${(server.address() as any).port}/v1`,
      requests,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("opt-in reviews a private draft in the same context with no tool declarations", async () => {
  await fixture(async (baseUrl, requests) => {
    const events: any[] = [];
    const result = await complete(
      {
        baseUrl,
        model: "synthetic",
        apiKey: "fixture-key",
        onDiagnostic: (event) => events.push(event),
      },
      "Saved stern voice",
      "Original manager request",
      AbortSignal.timeout(5000),
      [],
      { finalGroundingReview: true },
    );
    assert.equal(result, "REVIEWED_FINAL");
    assert.equal(requests.length, 2);
    assert.equal(requests[1].tool_choice, "none");
    assert.equal(requests[1].tools, undefined);
    assert.match(JSON.stringify(requests[1].messages), /DRAFT_PRIVATE/);
    assert.match(
      JSON.stringify(requests[1].messages),
      /Original manager request/,
    );
    assert.match(JSON.stringify(requests[1].messages), /Saved stern voice/);
    assert.match(
      JSON.stringify(requests[1].messages),
      /Preserve genuinely supported same-window comparisons/,
    );
    assert.match(
      JSON.stringify(requests[1].messages),
      /unequal inventory coverage alone/,
    );
    assert.match(JSON.stringify(requests[1].messages), /concise direct answer/);
    assert.match(
      JSON.stringify(requests[1].messages),
      /created_at with completed_at/,
    );
    assert.match(JSON.stringify(requests[1].messages), /different months/);
    assert.doesNotMatch(JSON.stringify(events), /DRAFT_PRIVATE|REVIEWED_FINAL/);
    for (const event of events) {
      assert.equal(event.preview, undefined);
      assert.equal(event.texts?.length ?? 0, 0);
      assert.equal(event.calls?.length ?? 0, 0);
    }
  });
});

test("read-free callback avoids review", async () => {
  await fixture(async (baseUrl, requests) => {
    assert.equal(
      await complete(
        { baseUrl, model: "synthetic", apiKey: "fixture-key" },
        "Coach",
        "Request",
        AbortSignal.timeout(5000),
        [],
        { finalGroundingReview: () => false },
      ),
      "DRAFT_PRIVATE",
    );
    assert.equal(requests.length, 1);
  });
});

const native = (name: string) => ({
  role: "assistant",
  tool_calls: [
    {
      index: 0,
      id: "call_synthetic",
      type: "function",
      function: { name, arguments: "{}" },
    },
  ],
});
const prose = (content: string) => ({ role: "assistant", content });
for (const outcome of ["completed", "unknown"]) {
  test(`review cannot replay a ${outcome} write, even when provider ignores tools disabled`, async () => {
    let writes = 0;
    await fixture(
      async (baseUrl, requests) => {
        await assert.rejects(
          complete(
            { baseUrl, model: "synthetic", apiKey: "fixture-key" },
            "Coach",
            "Send once",
            AbortSignal.timeout(5000),
            [
              {
                name: "studio_operator_send_message",
                label: "Send",
                description: "Synthetic send",
                parameters: { type: "object", properties: {} } as any,
                execute: async () => {
                  writes++;
                  return {
                    content: [
                      {
                        type: "text" as const,
                        text:
                          outcome === "completed"
                            ? "CANONICAL_COMPLETED"
                            : "DELIVERY_UNVERIFIED",
                      },
                    ],
                    details: {},
                  };
                },
              },
            ],
            { finalGroundingReview: true },
          ),
          /MODEL_FAILED/,
        );
        assert.equal(writes, 1);
        assert.equal(requests.length, 3);
        assert.equal(requests[2].tool_choice, "none");
        assert.equal(requests[2].tools, undefined);
        assert.match(
          JSON.stringify(requests[2].messages),
          outcome === "completed"
            ? /CANONICAL_COMPLETED/
            : /DELIVERY_UNVERIFIED/,
        );
      },
      (_request, turn) =>
        turn === 2
          ? prose("DRAFT_PRIVATE")
          : native("studio_operator_send_message"),
    );
  });
}

for (const badTurn of [1, 2]) {
  test(`pseudo-tool text on turn ${badTurn} stays closed, not repaired`, async () => {
    await fixture(
      async (baseUrl, requests) => {
        await assert.rejects(
          complete(
            { baseUrl, model: "synthetic", apiKey: "fixture-key" },
            "Coach",
            "Request",
            AbortSignal.timeout(5000),
            [],
            { finalGroundingReview: true },
          ),
          /MODEL_TOOL_FORMAT_UNSUPPORTED/,
        );
        assert.equal(requests.length, badTurn);
      },
      (_request, turn) =>
        prose(
          turn === badTurn
            ? "<tool_call><function=studio_operator_send_message>"
            : "DRAFT_PRIVATE",
        ),
    );
  });
}

for (const failure of ["empty", "cancel", "deadline", "revoked"]) {
  test(`mandatory review ${failure} never returns the draft`, async () => {
    const controller = new AbortController();
    let revoked = false;
    await fixture(
      async (baseUrl, requests) => {
        await assert.rejects(
          complete(
            {
              baseUrl,
              model: "synthetic",
              apiKey: "fixture-key",
              authorize: async () => {
                if (revoked) throw new Error("READ_NOT_AUTHORIZED");
              },
            },
            "Coach",
            "Request",
            controller.signal,
            [],
            { finalGroundingReview: true },
          ),
          failure === "empty"
            ? /MODEL_EMPTY_RESPONSE/
            : failure === "revoked"
              ? /READ_NOT_AUTHORIZED/
              : failure === "deadline"
                ? /PROVIDER_TIMEOUT/
                : /CANCELLED/,
        );
        assert.equal(requests.length, 2);
      },
      (_request, turn) => {
        if (turn === 2) {
          if (failure === "cancel") controller.abort();
          if (failure === "deadline")
            controller.abort(new DOMException("deadline", "TimeoutError"));
          if (failure === "revoked") revoked = true;
          return prose(failure === "empty" ? "" : "REVIEWED_FINAL");
        }
        return prose("DRAFT_PRIVATE");
      },
    );
  });
}

test("reserves draft and review within the existing forty-turn ceiling", async () => {
  let reads = 0;
  await fixture(
    async (baseUrl, requests) => {
      const result = await complete(
        { baseUrl, model: "synthetic", apiKey: "fixture-key" },
        "Coach",
        "Request",
        AbortSignal.timeout(5000),
        [
          {
            name: "studio_operator_read_member_coach_feed",
            label: "Read",
            description: "Read",
            parameters: { type: "object", properties: {} } as any,
            execute: async () => {
              reads++;
              return {
                content: [
                  { type: "text" as const, text: "SYNTHETIC_OBSERVATION" },
                ],
                details: {},
              };
            },
          },
        ],
        { finalGroundingReview: () => reads > 0 },
      );
      assert.equal(result, "REVIEWED_FINAL");
      assert.equal(reads, 38);
      assert.equal(requests.length, 40);
      assert.equal(requests[38].tool_choice, "none");
      assert.equal(requests[39].tool_choice, "none");
    },
    (request, turn) =>
      request.tool_choice === "none"
        ? prose(turn === 39 ? "DRAFT_PRIVATE" : "REVIEWED_FINAL")
        : native("studio_operator_read_member_coach_feed"),
  );
});

test("a provider refusing synthesis cannot spend the reserved review turn and leak a draft", async () => {
  await fixture(
    async (baseUrl, requests) => {
      await assert.rejects(
        complete(
          { baseUrl, model: "synthetic", apiKey: "fixture-key" },
          "Coach",
          "Request",
          AbortSignal.timeout(5000),
          [],
          { finalGroundingReview: true },
        ),
        /MODEL_BUDGET_EXHAUSTED/,
      );
      assert.equal(requests.length, 40);
    },
    () => native("studio_operator_send_message"),
  );
});

test("deadline exhaustion after the draft prevents review and publication", async () => {
  const budget = {
    finalGroundingReview: true,
    deadlineAt: Date.now() + 300000,
  };
  await fixture(
    async (baseUrl, requests) => {
      await assert.rejects(
        complete(
          { baseUrl, model: "synthetic", apiKey: "fixture-key" },
          "Coach",
          "Request",
          AbortSignal.timeout(5000),
          [],
          budget,
        ),
        /PROVIDER_TIMEOUT/,
      );
      assert.equal(requests.length, 1);
    },
    () => {
      budget.deadlineAt = Date.now() - 1;
      return prose("DRAFT_PRIVATE");
    },
  );
});

for (const imageParts of [0, 1]) {
  test(`review carries ${imageParts} successful native image parts, not historical photo prose`, async () => {
    await fixture(
      async (baseUrl, requests) => {
        const result = await complete(
          { baseUrl, model: "synthetic", apiKey: "fixture-key", vision: true },
          "Coach",
          "Compare",
          AbortSignal.timeout(5000),
          [
            {
              name: "studio_operator_read_member_coach_feed",
              label: "Read",
              description: "Read",
              parameters: { type: "object", properties: {} } as any,
              execute: async () => ({
                content: [
                  {
                    type: "text" as const,
                    text: "Historical assistant report: I viewed the photo.",
                  },
                  ...(imageParts
                    ? [
                        {
                          type: "image" as const,
                          mimeType: "image/png",
                          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
                        },
                      ]
                    : []),
                ],
                details: {},
              }),
            },
          ],
          { finalGroundingReview: true },
        );
        assert.equal(result, "REVIEWED_FINAL");
        assert.match(
          JSON.stringify(requests[2].messages),
          new RegExp(
            `Successful native image parts returned this turn: ${imageParts}`,
          ),
        );
      },
      (_request, turn) =>
        turn === 1
          ? native("studio_operator_read_member_coach_feed")
          : prose(turn === 2 ? "DRAFT_PRIVATE" : "REVIEWED_FINAL"),
    );
  });
}

test("default runtime returns the first final without review", async () => {
  await fixture(async (baseUrl, requests) => {
    assert.equal(
      await complete(
        { baseUrl, model: "synthetic", apiKey: "fixture-key" },
        "Coach",
        "Request",
        AbortSignal.timeout(5000),
      ),
      "DRAFT_PRIVATE",
    );
    assert.equal(requests.length, 1);
  });
});
