import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  validateRequestClaim,
  modelRequestPlanner,
  claimsAgree,
  reconcileReadClaims,
} from "../src/chat/operatorPlan.js";

const tools = [
  "studio_operator_read_member_coach_feed",
  "studio_operator_list_dojo_checkins",
  "studio_operator_read_dojo_checkin_image",
  "studio_operator_send_message",
].map((name) => ({ name, description: name })) as any;
const empty = {
  scope: "none",
  scopeQuote: "",
  targets: [],
  evidence: [],
  actionQuote: "",
  payloadQuote: "",
};

test("independent claims must agree on scope, target, evidence, and action", () => {
  const named = {
    ...empty,
    kind: "read" as const,
    scope: "named" as const,
    scopeQuote: "Alex",
    targets: [{ name: "Alex", quote: "Alex" }],
    evidence: [
      {
        level: "metadata" as const,
        domains: ["feed" as const],
        quote: "progress",
      },
    ],
  };
  assert.equal(claimsAgree(named, { ...named, scopeQuote: "Alex's" }), true);
  assert.equal(claimsAgree(named, { ...named, scope: "dojo" }), false);
  assert.equal(
    claimsAgree(named, { ...named, targets: [{ name: "Kai", quote: "Kai" }] }),
    false,
  );
  assert.equal(
    claimsAgree(named, {
      ...named,
      evidence: [
        { level: "image", domains: ["image"], quote: "photos" },
      ] as any,
    }),
    false,
  );
  assert.equal(claimsAgree(named, { ...named, kind: "conversation" }), false);
});

test("two agreeing read subjects may conservatively union metadata domains, not visual scope", () => {
  const base = {
    ...empty,
    kind: "read" as const,
    scope: "named" as const,
    scopeQuote: "Alex vs Morgan",
    targets: [
      { name: "Alex", quote: "Alex" },
      { name: "Morgan", quote: "Morgan" },
    ],
    evidence: [
      {
        level: "metadata" as const,
        domains: ["checkins" as const],
        quote: "feeds",
      },
    ],
  };
  const audited = {
    ...base,
    evidence: [
      {
        level: "metadata" as const,
        domains: ["feed" as const],
        quote: "feeds",
      },
    ],
  };
  const merged = reconcileReadClaims(base, audited);
  assert.deepEqual(merged?.evidence.flatMap((e) => e.domains).sort(), [
    "checkins",
    "feed",
  ]);
  assert.equal(
    reconcileReadClaims(base, { ...audited, scope: "dojo" }),
    undefined,
  );
  assert.equal(
    reconcileReadClaims(base, {
      ...audited,
      targets: [{ name: "Alex", quote: "Alex" }],
    }),
    undefined,
  );
  assert.equal(
    reconcileReadClaims(base, {
      ...audited,
      evidence: [
        {
          level: "image" as const,
          domains: ["image" as const],
          quote: "photos",
        },
      ],
    }),
    undefined,
  );
});

test("generic discussion and progress paraphrase remain distinct advice", () => {
  const conversation = validateRequestClaim(
    "Let's discuss our coaching approach",
    { ...empty, kind: "conversation" },
    tools,
  );
  assert.equal(conversation.status, "advisory");
  const read = validateRequestClaim(
    "Summarize Alex’s progress now",
    {
      ...empty,
      kind: "read",
      scope: "named",
      scopeQuote: "Alex",
      targets: [{ name: "Alex", quote: "Alex" }],
      evidence: [{ level: "metadata", domains: ["feed"], quote: "progress" }],
    },
    tools,
  );
  assert.equal(read.status, "advisory");
  assert.equal(read.claim.kind, "read");
  assert.equal(read.claim.scope, "named");
  // A shape validator cannot refute a semantically false conversation claim without host policy.
  assert.equal(
    validateRequestClaim(
      "Summarize Alex’s progress now",
      { ...empty, kind: "conversation" },
      tools,
    ).status,
    "advisory",
  );
});

test("group plus named retains dojo-wide scope without mistaking Alex for coverage", () => {
  const claim = validateRequestClaim(
    "How are all dojo members, including Alex, doing in the feed?",
    {
      ...empty,
      kind: "read",
      scope: "dojo",
      scopeQuote: "all dojo members",
      targets: [{ name: "Alex", quote: "Alex" }],
      evidence: [{ level: "metadata", domains: ["feed"], quote: "feed" }],
    },
    tools,
  );
  assert.equal(claim.status, "advisory");
  assert.equal(claim.claim.scope, "dojo");
  assert.equal(
    validateRequestClaim(
      "How are all dojo members, including Alex, doing in the feed?",
      { ...claim.claim, scopeQuote: "missing" },
      tools,
    ).status,
    "uncertain",
  );
});

test("photo interpretation requires image evidence distinct from check-in metadata", () => {
  const text = "How do Alex's progress photos look?";
  const base = {
    ...empty,
    kind: "read",
    scope: "named",
    scopeQuote: "Alex",
    targets: [{ name: "Alex", quote: "Alex" }],
  };
  const image = validateRequestClaim(
    text,
    {
      ...base,
      evidence: [
        { level: "image", domains: ["checkins", "image"], quote: "photos" },
      ],
    },
    tools,
  );
  assert.equal(image.status, "advisory");
  assert.equal(image.claim.evidence[0].level, "image");
  assert.equal(
    validateRequestClaim(
      text,
      {
        ...base,
        evidence: [{ level: "image", domains: ["checkins"], quote: "photos" }],
      },
      tools,
    ).status,
    "uncertain",
  );
});

test("unsupported mutation cannot be converted to send or completed action", () => {
  const text = "Arrange Alex’s session tomorrow";
  const unsupported = validateRequestClaim(
    text,
    {
      ...empty,
      kind: "unsupported",
      actionQuote: "Arrange",
      scope: "named",
      scopeQuote: "Alex",
      targets: [{ name: "Alex", quote: "Alex" }],
    },
    tools,
  );
  assert.equal(unsupported.status, "advisory");
  assert.equal(unsupported.claim.kind, "unsupported");
  assert.equal(
    validateRequestClaim(
      text,
      { ...unsupported.claim, kind: "send", payloadQuote: "session tomorrow" },
      tools,
    ).status,
    "uncertain",
  );
});

test("explicit quoted send requires anchored recipient, action, and complete quoted payload", () => {
  const text = 'Send Alex exactly: "Do not train today"';
  const send = {
    ...empty,
    kind: "send",
    scope: "named",
    scopeQuote: "Alex",
    targets: [{ name: "Alex", quote: "Alex" }],
    actionQuote: "Send",
    payloadQuote: '"Do not train today"',
  };
  assert.equal(validateRequestClaim(text, send, tools).status, "advisory");
  assert.equal(
    validateRequestClaim(text, { ...send, payloadQuote: "train" }, tools)
      .status,
    "uncertain",
  );
  assert.equal(
    validateRequestClaim(
      text,
      { ...send, targets: [{ name: "Bob", quote: "Alex" }] },
      tools,
    ).status,
    "uncertain",
  );
});

test("unquoted saying tail accepts only the complete source payload", () => {
  const text = "Send Alex a note saying do not train today";
  const send = {
    ...empty,
    kind: "send",
    scope: "named",
    scopeQuote: "Alex",
    targets: [{ name: "Alex", quote: "Alex" }],
    actionQuote: "Send",
    payloadQuote: "do not train today",
  };
  assert.equal(validateRequestClaim(text, send, tools).status, "advisory");
  assert.equal(
    validateRequestClaim(text, { ...send, payloadQuote: "train today" }, tools)
      .status,
    "uncertain",
  );
});

test("structured request planner sends a strict schema and treats malformed provider claims as uncertainty", async () => {
  let request: any;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    request = JSON.parse(raw);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                ...empty,
                kind: "read",
                scope: "named",
                scopeQuote: "fabricated",
                targets: [{ name: "Alex", quote: "fabricated" }],
                evidence: [
                  { level: "metadata", domains: ["feed"], quote: "progress" },
                ],
              }),
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("address");
    const plan = await modelRequestPlanner(
      "Summarize Alex’s progress now",
      tools,
      AbortSignal.timeout(5000),
      {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "synthetic",
        apiKey: "synthetic-key",
      },
      Date.now() + 5000,
    );
    assert.equal(plan.status, "uncertain");
    assert.equal(request.response_format.type, "json_schema");
    assert.equal(request.response_format.json_schema.strict, true);
    assert.equal(request.tools, undefined);
    assert.equal(request.stream, false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(resolve));
  }
});

test("structured planner makes one bounded schema-repair attempt without executing tools", async () => {
  let calls = 0;
  const prompts: string[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    prompts.push(body.messages[0].content);
    calls++;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                ...empty,
                kind: "read",
                scope: "named",
                scopeQuote: "Alex",
                targets: [{ name: "Alex", quote: "Alex" }],
                evidence: [
                  { level: "metadata", domains: ["feed"], quote: "progress" },
                ],
                actionQuote: calls === 1 ? "Summarize" : "",
              }),
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("address");
    const result = await modelRequestPlanner(
      "Summarize Alex’s progress now",
      tools,
      AbortSignal.timeout(5000),
      {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "synthetic",
        apiKey: "synthetic-key",
      },
      Date.now() + 5000,
    );
    assert.equal(result.status, "advisory");
    assert.equal(calls, 2);
    assert.match(prompts[1], /read-conflict|actionQuote/i);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(resolve));
  }
});
