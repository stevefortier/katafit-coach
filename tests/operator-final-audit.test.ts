import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  validateFinalAudit,
  modelFinalAudit,
  type FinalAuditInput,
} from "../src/chat/operatorFinalAudit.js";

const input: FinalAuditInput = {
  request: "Compare Alice and Bob's feeds",
  response: "Alice logged twice; Bob logged once.",
  catalog: [
    "studio_operator_list_members",
    "studio_operator_read_member_coach_feed",
  ],
  receipts: [
    {
      domain: "roster",
      cursor: null,
      status: "success",
      has_more: false,
      tool: "studio_operator_list_members",
    },
    ...["a", "b"].map((member_ref) => ({
      domain: "feed" as const,
      member_ref,
      cursor: null,
      status: "success" as const,
      has_more: false,
      tool: "studio_operator_read_member_coach_feed",
    })),
  ],
  targets: [
    { name: "Alice", member_ref: "a" },
    { name: "Bob", member_ref: "b" },
  ],
  sourceExcerpts: [
    { domain: "feed", member_ref: "a", text: "Alice logged two sessions." },
    { domain: "feed", member_ref: "b", text: "Bob logged one session." },
  ],
  actions: [],
};
const claims = [
  {
    quote: "Alice logged twice",
    domain: "feed",
    member_ref: "a",
    level: "metadata",
  },
  {
    quote: "Bob logged once",
    domain: "feed",
    member_ref: "b",
    level: "metadata",
  },
];
const candidate = {
  verdict: "supported",
  requested_scope: "named",
  requested_coverage: "sample",
  requested_visual: false,
  claims_visual: false,
  claims_completed_action: false,
  entailed: true,
  claims,
  action_claims: [],
};

test("complete targeted receipts support bounded response claims", () => {
  assert.deepEqual(validateFinalAudit(input, candidate), {
    status: "supported",
  });
});

test("group request cannot shrink to a named example even when that example has a receipt", () => {
  const group: FinalAuditInput = {
    ...input,
    request: "How did all dojo members including Alice do?",
    requestedCoverage: "complete",
    response: "Alice did well.",
    roster: [
      { name: "Alice", member_ref: "a" },
      { name: "Bob", member_ref: "b" },
    ],
    realizedSubjects: ["a"],
    receipts: input.receipts.slice(0, 2),
  };
  assert.equal(
    validateFinalAudit(group, {
      ...candidate,
      requested_scope: "dojo",
      requested_coverage: "complete",
      claims: [
        {
          quote: "Alice did well",
          domain: "feed",
          member_ref: "a",
          level: "metadata",
        },
      ],
    }).status,
    "uncertain",
  );
});

test("partial dojo sample with explicit coverage notice is not a full-roster audit", () => {
  const sample: FinalAuditInput = {
    ...input,
    request: "Show some dojo members",
    requestedScope: "dojo",
    requestedCoverage: "sample",
    response: "Alice logged twice; partial coverage.",
    receipts: [
      { ...input.receipts[0], has_more: true, next_cursor: "next" },
      input.receipts[1],
    ],
    realizedSubjects: ["a"],
  };
  const audit = {
    ...candidate,
    requested_scope: "dojo",
    claims: [
      {
        quote: "Alice logged twice",
        domain: "feed",
        member_ref: "a",
        level: "metadata",
      },
      {
        quote: "partial coverage",
        domain: "feed",
        member_ref: "a",
        level: "metadata",
      },
    ],
  };
  assert.deepEqual(validateFinalAudit(sample, audit), { status: "supported" });
  assert.equal(
    validateFinalAudit({ ...sample, requestedCoverage: "complete" }, audit)
      .status,
    "uncertain",
  );
});

test("visual prose cannot use metadata even if the model relabels it", () => {
  const photo: FinalAuditInput = {
    ...input,
    request: "How do Alice's photos look?",
    response: "Alice's photos look stronger.",
    receipts: [
      {
        tool: "studio_operator_list_dojo_checkins",
        domain: "checkins",
        cursor: null,
        status: "success",
        has_more: false,
      },
    ],
    catalog: ["studio_operator_list_dojo_checkins"],
  };
  assert.equal(
    validateFinalAudit(photo, {
      ...candidate,
      claims: [
        {
          quote: "Alice's photos look stronger",
          domain: "checkins",
          level: "metadata",
        },
      ],
    }).status,
    "uncertain",
  );
});

test("semantic uncertainty fails closed despite complete receipts", () => {
  assert.equal(
    validateFinalAudit(input, { ...candidate, entailed: false }).status,
    "uncertain",
  );
});

test("receipt alone cannot support a factual claim without source excerpts", () => {
  assert.equal(
    validateFinalAudit({ ...input, sourceExcerpts: [] }, candidate).status,
    "uncertain",
  );
});

test("structured nullable reference fields are accepted only when they match receipts", () => {
  const nullable = {
    ...candidate,
    claims: claims.map((claim) => ({
      ...claim,
      activity_ref: null,
      media_ref: null,
    })),
  };
  assert.deepEqual(validateFinalAudit(input, nullable), {
    status: "supported",
  });
  assert.equal(
    validateFinalAudit(input, {
      ...nullable,
      claims: [
        { ...nullable.claims[0], media_ref: "wrong" },
        nullable.claims[1],
      ],
    }).status,
    "uncertain",
  );
});

test("a model cannot waive its own missing target, omitted claim, or invented domain", () => {
  assert.equal(
    validateFinalAudit(input, { ...candidate, claims: claims.slice(0, 1) })
      .status,
    "uncertain",
  );
  assert.equal(
    validateFinalAudit(input, {
      ...candidate,
      claims: [{ ...claims[0], member_ref: "other" }, claims[1]],
    }).status,
    "uncertain",
  );
  assert.equal(
    validateFinalAudit(input, {
      ...candidate,
      claims: [{ ...claims[0], domain: "checkins" }, claims[1]],
    }).status,
    "uncertain",
  );
  assert.equal(
    validateFinalAudit(input, { ...candidate, surprise: true }).status,
    "uncertain",
  );
});

test("partial, denied, mismatched, and unavailable reads cannot support claims", () => {
  for (const change of [
    { ...input.receipts[2], has_more: true, next_cursor: "next" },
    { ...input.receipts[2], status: "failure" as const },
    { ...input.receipts[2], tool: "studio_operator_list_members" },
  ]) {
    const receipts = [...input.receipts.slice(0, 2), change];
    assert.equal(
      validateFinalAudit({ ...input, receipts }, candidate).status,
      "uncertain",
    );
  }
  assert.equal(
    validateFinalAudit({ ...input, catalog: [] }, candidate).status,
    "uncertain",
  );
});

test("visual claims require model-visible image receipt for the exact media", () => {
  const photo: FinalAuditInput = {
    ...input,
    response: "Alice's photo shows a change.",
    receipts: [
      {
        tool: "studio_operator_read_dojo_checkin_image",
        domain: "image",
        member_ref: "a",
        media_ref: "p",
        cursor: null,
        status: "success",
        image_to_model: false,
      },
    ],
    catalog: ["studio_operator_read_dojo_checkin_image"],
    sourceExcerpts: [
      {
        domain: "image",
        member_ref: "a",
        media_ref: "p",
        mime: "image/png",
        image_base64: "AQID",
      },
    ],
  };
  const visual = {
    verdict: "supported",
    requested_scope: "named",
    requested_coverage: "sample",
    requested_visual: false,
    claims_visual: true,
    claims_completed_action: false,
    entailed: true,
    claims: [
      {
        quote: "Alice's photo shows a change",
        domain: "image",
        member_ref: "a",
        media_ref: "p",
        level: "visual",
      },
    ],
    action_claims: [],
  };
  assert.equal(validateFinalAudit(photo, visual).status, "uncertain");
  assert.deepEqual(
    validateFinalAudit(
      { ...photo, receipts: [{ ...photo.receipts[0], image_to_model: true }] },
      visual,
    ),
    { status: "supported" },
  );
});

test("a send claim needs exact recipient, payload, and confirmed action receipt", () => {
  const send: FinalAuditInput = {
    ...input,
    request: 'Send Alice "Hello"',
    response: "I sent Alice: Hello",
    catalog: ["studio_operator_send_message"],
    receipts: [],
    actions: [
      { kind: "send", member_ref: "a", text: "Hello", status: "confirmed" },
    ],
  };
  const audit = {
    verdict: "supported",
    requested_scope: "named",
    requested_coverage: "sample",
    requested_visual: false,
    claims_visual: false,
    claims_completed_action: true,
    entailed: true,
    claims: [],
    action_claims: [
      {
        quote: "I sent Alice: Hello",
        kind: "send",
        member_ref: "a",
        text: "Hello",
      },
    ],
  };
  assert.deepEqual(validateFinalAudit(send, audit), { status: "supported" });
  assert.equal(
    validateFinalAudit(
      { ...send, actions: [{ ...send.actions[0], status: "uncertain" }] },
      audit,
    ).status,
    "uncertain",
  );
  assert.equal(
    validateFinalAudit(send, {
      ...audit,
      action_claims: [{ ...audit.action_claims[0], text: "Hell" }],
    }).status,
    "uncertain",
  );
});

test("transport sends bounded structured audit without exposing tools or performing actions", async () => {
  let captured: any;
  const server = createServer(async (req, res) => {
    captured = JSON.parse(
      await new Promise<string>((resolve) => {
        let body = "";
        req.on("data", (s) => (body += s));
        req.on("end", () => resolve(body));
      }),
    );
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(candidate) } }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("address");
    assert.deepEqual(
      await modelFinalAudit(
        input,
        {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          model: "synthetic",
          apiKey: "secret",
        },
        AbortSignal.timeout(5000),
        Date.now() + 5000,
      ),
      { status: "supported" },
    );
    assert.equal(captured.response_format.type, "json_schema");
    assert.equal(captured.tools, undefined);
    assert.equal(captured.tool_choice, "none");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
