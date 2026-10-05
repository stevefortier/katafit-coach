import test from "node:test";
import assert from "node:assert/strict";
import { AutonomyBackend, AutonomyFailure } from "../src/autonomy/backend.js";
import {
  TOKEN,
  autonomyStub,
  capabilities,
  defaultMandate,
  error,
  MANDATE,
  MEMBER,
  WORK,
  CHIEF,
  FOLLOW_UP,
  followUp,
  outcome,
  receipt,
  sha256,
  workItem,
} from "./helpers/autonomy-stub.js";

const REPORT = "64b7f0c2a1b2c3d4e5f60706";

const open = (origin: string, secrets: string[] = []) =>
  new AutonomyBackend(origin, TOKEN, new AbortController().signal, secrets);
const code =
  (expected: string, extra?: (e: AutonomyFailure) => boolean) => (e: unknown) =>
    e instanceof AutonomyFailure &&
    e.code === expected &&
    e.message === expected &&
    (!extra || extra(e));

test("mandate() reads the default-off DTO with the host bearer and validates it", async () => {
  const stub = await autonomyStub(() => ({
    body: { ...defaultMandate(), capabilities },
  }));
  try {
    const mandate = await open(stub.origin).mandate();
    assert.equal(mandate.mode, "off");
    assert.equal(mandate.revision, 0);
    assert.deepEqual(mandate.capabilities, capabilities);
    assert.deepEqual(
      stub.calls.map((c) => [c.method, c.path, c.auth]),
      [["GET", "/api/coach/autonomy/mandate", `Bearer ${TOKEN}`]],
    );
  } finally {
    await stub.close();
  }
});

test("mandate() rejects unexpected fields, wrong protocol and secret echoes", async () => {
  for (const body of [
    { ...defaultMandate(), capabilities, extra: true },
    { ...defaultMandate({ protocol: "coach.autonomy.v0" }), capabilities },
    { ...defaultMandate({ mode: "unbounded" }), capabilities },
    { ...defaultMandate({ instructions: `leak ${TOKEN}` }), capabilities },
    {
      ...defaultMandate({ instructions: "leak provider-secret" }),
      capabilities,
    },
    defaultMandate(),
  ]) {
    const stub = await autonomyStub(() => ({ body }));
    try {
      await assert.rejects(
        () => open(stub.origin, ["provider-secret"]).mandate(),
        code("AUTONOMY_RESULT_REJECTED"),
      );
    } finally {
      await stub.close();
    }
  }
});

test("backend codes map to fixed failures; framework statuses are classified without backend prose", async () => {
  const cases: [any, string][] = [
    [error(403, "AUTONOMY_NOT_AUTHORIZED"), "AUTONOMY_NOT_AUTHORIZED"],
    [error(409, "AUTONOMY_SCOPE_UNSUPPORTED"), "AUTONOMY_SCOPE_UNSUPPORTED"],
    [error(503, "AUTONOMY_UNAVAILABLE"), "AUTONOMY_UNAVAILABLE"],
    [{ status: 401, body: { error: "expired" } }, "AUTONOMY_AUTH_EXPIRED"],
    [{ status: 404, body: "Cannot GET" }, "AUTONOMY_UNSUPPORTED"],
    [{ status: 403, body: "<html>denied</html>" }, "AUTONOMY_NOT_AUTHORIZED"],
    [{ status: 500, body: { code: "SOMETHING_ELSE" } }, "AUTONOMY_UNAVAILABLE"],
    [{ status: 302, location: "/elsewhere" }, "AUTONOMY_RESULT_REJECTED"],
    [
      { status: 200, body: "<html>not json</html>" },
      "AUTONOMY_RESULT_REJECTED",
    ],
    [{ drop: true }, "AUTONOMY_UNAVAILABLE"],
  ];
  for (const [reply, expected] of cases) {
    const stub = await autonomyStub(() => reply);
    try {
      await assert.rejects(
        () => open(stub.origin).mandate(),
        code(expected, (e) => !/synthetic|denied|expired/.test(e.message)),
        expected,
      );
    } finally {
      await stub.close();
    }
  }
});

test("unsafe origins and credentials never reach the network", async () => {
  for (const origin of [
    "http://example.com",
    "https://user:pw@example.com",
    "https://example.com/base",
    "notaurl",
  ])
    await assert.rejects(
      () => open(origin).mandate(),
      code("AUTONOMY_UNAVAILABLE"),
    );
  const stub = await autonomyStub();
  try {
    await assert.rejects(
      () =>
        new AutonomyBackend(
          stub.origin,
          "bad\ntoken",
          new AbortController().signal,
          [],
        ).mandate(),
      code("AUTONOMY_UNAVAILABLE"),
    );
    assert.equal(stub.calls.length, 0);
  } finally {
    await stub.close();
  }
});

const fields = (overrides: Record<string, unknown> = {}) => {
  const {
    protocol,
    mandate_id,
    dojo_id,
    chief_id,
    revision,
    status,
    suspended_reason,
    updated_at,
    updated_by,
    ...rest
  } = defaultMandate();
  return { ...rest, ...overrides };
};
const saved = (overrides: Record<string, unknown> = {}) =>
  defaultMandate({
    mandate_id: MANDATE,
    revision: 1,
    updated_at: "2026-10-03T07:00:00.000Z",
    updated_by: "external_coach",
    ...overrides,
  });

test("putMandate() sends exactly one CAS body and returns the saved mandate", async () => {
  const stub = await autonomyStub(() => ({
    body: {
      mandate: saved({ mode: "observe", timezone: "Europe/Paris" }),
      idempotent: false,
    },
  }));
  try {
    const input = {
      idempotency_key: "mandate-key-0001",
      expected_revision: 0,
      mandate: fields({ mode: "observe", timezone: "Europe/Paris" }),
    };
    const result = await open(stub.origin).putMandate(input);
    assert.equal(result.idempotent, false);
    assert.equal(result.mandate.mode, "observe");
    assert.equal(result.mandate.revision, 1);
    assert.deepEqual(
      stub.calls.map((c) => [c.method, c.path, c.body]),
      [["PUT", "/api/coach/autonomy/mandate", input]],
    );
  } finally {
    await stub.close();
  }
});

test("putMandate() rejects invalid input locally without any request", async () => {
  const stub = await autonomyStub();
  try {
    for (const input of [
      { idempotency_key: "short", expected_revision: 0, mandate: fields() },
      {
        idempotency_key: "mandate-key-0001",
        expected_revision: -1,
        mandate: fields(),
      },
      {
        idempotency_key: "mandate-key-0001",
        expected_revision: 0,
        mandate: fields({ extra: 1 }),
      },
      {
        idempotency_key: "mandate-key-0001",
        expected_revision: 0,
        mandate: fields({ mode: "observe" }),
      },
      {
        idempotency_key: "mandate-key-0001",
        expected_revision: 0,
        mandate: fields({
          mode: "message",
          timezone: "Europe/Paris",
          quiet_hours: null,
        }),
      },
      {
        idempotency_key: "mandate-key-0001",
        expected_revision: 0,
        mandate: fields({ instructions: "x".repeat(4001) }),
      },
      {
        idempotency_key: "mandate-key-0001",
        expected_revision: 0,
        mandate: fields({ instructions: TOKEN }),
      },
      {
        idempotency_key: "mandate-key-0001",
        expected_revision: 0,
        mandate: fields(),
        extra: true,
      },
    ])
      await assert.rejects(
        () => open(stub.origin).putMandate(input as any),
        code("AUTONOMY_INVALID"),
      );
    assert.equal(stub.calls.length, 0);
  } finally {
    await stub.close();
  }
});

test("putMandate() maps CAS and key conflicts; uncertain outcomes are unknown and never retried", async () => {
  const input = {
    idempotency_key: "mandate-key-0001",
    expected_revision: 0,
    mandate: fields(),
  };
  for (const [reply, expected] of [
    [error(409, "AUTONOMY_CONFLICT"), "AUTONOMY_CONFLICT"],
    [
      error(409, "AUTONOMY_IDEMPOTENCY_CONFLICT"),
      "AUTONOMY_IDEMPOTENCY_CONFLICT",
    ],
    [error(400, "AUTONOMY_INVALID"), "AUTONOMY_INVALID"],
    [{ drop: true }, "AUTONOMY_OUTCOME_UNKNOWN"],
    [error(503, "AUTONOMY_UNAVAILABLE"), "AUTONOMY_OUTCOME_UNKNOWN"],
    [
      { status: 200, body: { mandate: { mode: "off" }, idempotent: false } },
      "AUTONOMY_OUTCOME_UNKNOWN",
    ],
    [{ status: 200, body: "<html>ok</html>" }, "AUTONOMY_OUTCOME_UNKNOWN"],
  ] as [any, string][]) {
    const stub = await autonomyStub(() => reply);
    try {
      await assert.rejects(
        () => open(stub.origin).putMandate(input),
        code(expected),
        expected,
      );
      assert.equal(stub.calls.length, 1, `${expected}: exactly one request`);
    } finally {
      await stub.close();
    }
  }
});

test("claim/start/checkpoint/complete send exact lease-fenced bodies and validate the returned work", async () => {
  const stub = await autonomyStub((call) => {
    if (call.path === "/api/coach/autonomy/work/claim")
      return { body: { work: workItem() } };
    if (call.path.endsWith("/start"))
      return { body: { work: workItem({ status: "running" }) } };
    if (call.path.endsWith("/checkpoint"))
      return {
        body: { work: workItem({ status: "running", checkpoint: "step-2" }) },
      };
    if (call.path.endsWith("/complete"))
      return {
        body: {
          work: workItem({ status: "completed", lease_expires_at: null }),
          report_id: REPORT,
        },
      };
  });
  try {
    const backend = open(stub.origin);
    const claimed = await backend.claim({
      lease_seconds: 120,
      kinds: ["event"],
    });
    assert.equal(claimed?.id, WORK);
    const started = await backend.start(WORK, 1);
    assert.equal(started.status, "running");
    const saved = await backend.checkpoint(WORK, {
      lease_generation: 1,
      checkpoint: "step-2",
      lease_seconds: 120,
    });
    assert.equal(saved.checkpoint, "step-2");
    const done = await backend.complete(WORK, {
      lease_generation: 1,
      mandate_revision: 1,
      outcome: outcome(),
    } as any);
    assert.equal(done.report_id, REPORT);
    assert.deepEqual(
      stub.calls.map((c) => [c.method, c.path, c.body]),
      [
        [
          "POST",
          "/api/coach/autonomy/work/claim",
          { lease_seconds: 120, kinds: ["event"] },
        ],
        [
          "POST",
          `/api/coach/autonomy/work/${WORK}/start`,
          { lease_generation: 1 },
        ],
        [
          "POST",
          `/api/coach/autonomy/work/${WORK}/checkpoint`,
          { lease_generation: 1, checkpoint: "step-2", lease_seconds: 120 },
        ],
        [
          "POST",
          `/api/coach/autonomy/work/${WORK}/complete`,
          { lease_generation: 1, mandate_revision: 1, outcome: outcome() },
        ],
      ],
    );
  } finally {
    await stub.close();
  }
});

test("an empty claim is null; listWork pages with bounded query parameters", async () => {
  const stub = await autonomyStub((call) =>
    call.method === "POST"
      ? { body: { work: null } }
      : {
          body: {
            items: [workItem({ status: "queued", lease_expires_at: null })],
            next_cursor: "opaque-cursor",
            has_more: true,
          },
        },
  );
  try {
    const backend = open(stub.origin);
    assert.equal(await backend.claim({}), null);
    const page = await backend.listWork({
      status: "due",
      limit: 10,
      cursor: "a b/c",
    });
    assert.equal(page.items.length, 1);
    assert.equal(page.next_cursor, "opaque-cursor");
    assert.equal(
      stub.calls[1].path,
      "/api/coach/autonomy/work?status=due&limit=10&cursor=a+b%2Fc",
    );
  } finally {
    await stub.close();
  }
});

test("work results that do not match the fenced request are not trusted", async () => {
  for (const [reply, call, expected] of [
    [
      { work: workItem({ id: MEMBER }) },
      (b: AutonomyBackend) => b.start(WORK, 1),
      "AUTONOMY_OUTCOME_UNKNOWN",
    ],
    [
      { work: workItem({ lease_generation: 2 }) },
      (b: AutonomyBackend) => b.start(WORK, 1),
      "AUTONOMY_OUTCOME_UNKNOWN",
    ],
    [
      { work: workItem({ extra: 1 }) },
      (b: AutonomyBackend) => b.claim({}),
      "AUTONOMY_OUTCOME_UNKNOWN",
    ],
    [
      { work: workItem({ status: "exploded" }) },
      (b: AutonomyBackend) => b.claim({}),
      "AUTONOMY_OUTCOME_UNKNOWN",
    ],
    [
      {
        items: [workItem({ subject_ids: ["nope"] })],
        next_cursor: null,
        has_more: false,
      },
      (b: AutonomyBackend) => b.listWork({}),
      "AUTONOMY_RESULT_REJECTED",
    ],
    [
      { items: [], next_cursor: null, has_more: true },
      (b: AutonomyBackend) => b.listWork({}),
      "AUTONOMY_RESULT_REJECTED",
    ],
  ] as [any, (b: AutonomyBackend) => Promise<unknown>, string][]) {
    const stub = await autonomyStub(() => ({ body: reply }));
    try {
      await assert.rejects(() => call(open(stub.origin)), code(expected));
    } finally {
      await stub.close();
    }
  }
});

test("lease and mandate fences map to fixed codes", async () => {
  for (const name of [
    "LEASE_LOST",
    "AUTONOMY_MANDATE_CHANGED",
    "AUTONOMY_DISABLED",
    "AUTONOMY_SCOPE_CHANGED",
  ]) {
    const stub = await autonomyStub(() => error(409, name));
    try {
      await assert.rejects(() => open(stub.origin).start(WORK, 1), code(name));
      await assert.rejects(
        () =>
          open(stub.origin).complete(WORK, {
            lease_generation: 1,
            mandate_revision: 1,
            outcome: outcome(),
          } as any),
        code(name),
      );
    } finally {
      await stub.close();
    }
  }
});

test("invalid work identifiers, leases and outcomes are rejected before any request", async () => {
  const stub = await autonomyStub();
  try {
    const backend = open(stub.origin);
    const bad: (() => Promise<unknown>)[] = [
      () => backend.start("../mandate", 1),
      () => backend.start(WORK.toUpperCase(), 1),
      () => backend.start(WORK, -1),
      () => backend.claim({ lease_seconds: 301 }),
      () => backend.claim({ kinds: ["anything"] } as any),
      () =>
        backend.checkpoint(WORK, {
          lease_generation: 1,
          checkpoint: "x".repeat(4097),
        }),
      () => backend.listWork({ limit: 51 }),
      () => backend.listWork({ status: "all" } as any),
      ...[
        outcome({ result: "deferred" }),
        outcome({ result: "blocked", blocked_reason: "because" }),
        outcome({ uncertainty: ["x".repeat(201)] }),
        outcome({ uncertainty: Array(11).fill("u") }),
        outcome({ decisions: Array(51).fill(outcome().decisions[0]) }),
        outcome({
          coverage: { ...outcome().coverage, unobserved: ["everything"] },
        }),
        outcome({ narrative: "I sent a message" }),
      ].map(
        (o) => () =>
          backend.complete(WORK, {
            lease_generation: 1,
            mandate_revision: 1,
            outcome: o,
          } as any),
      ),
    ];
    for (const call of bad)
      await assert.rejects(call, code("AUTONOMY_INVALID"));
    assert.equal(stub.calls.length, 0);
  } finally {
    await stub.close();
  }
});

const TEXT = "Great squat session today.";
const act = (overrides: Record<string, unknown> = {}) => ({
  lease_generation: 1,
  mandate_revision: 1,
  type: "member_message" as const,
  recipient_id: MEMBER,
  text: TEXT,
  ...overrides,
});

test("act() PUTs one atomic intent per slot and verifies the receipt against it", async () => {
  let status = 201;
  const stub = await autonomyStub(() => ({
    status,
    body: { receipt: receipt(), idempotent: status === 200 },
  }));
  try {
    const backend = open(stub.origin);
    const first = await backend.act(WORK, "praise-1", act());
    assert.equal(first.idempotent, false);
    assert.equal(first.receipt.message_id, receipt().message_id);
    status = 200;
    const replay = await backend.act(WORK, "praise-1", act());
    assert.equal(replay.idempotent, true);
    assert.equal(replay.receipt.message_id, first.receipt.message_id);
    assert.deepEqual(
      stub.calls.map((c) => [c.method, c.path, c.body]),
      Array(2).fill([
        "PUT",
        `/api/coach/autonomy/work/${WORK}/actions/praise-1`,
        act(),
      ]),
    );
  } finally {
    await stub.close();
  }
});

test("a receipt for another slot, type, recipient or payload is never accepted as this send", async () => {
  for (const [body, input] of [
    [receipt({ slot: "praise-2" }), act()],
    [receipt({ type: "manager_report" }), act()],
    [receipt({ recipient_id: CHIEF }), act()],
    [receipt({ text_sha256: sha256("Different text") }), act()],
    [receipt({ idempotency_key: "random-host-key" }), act()],
    [
      receipt({ type: "member_message", recipient_id: CHIEF }),
      act({ type: "manager_report", recipient_id: undefined }),
    ],
  ] as [any, any][]) {
    const stub = await autonomyStub(() => ({
      status: 201,
      body: { receipt: body, idempotent: false },
    }));
    try {
      await assert.rejects(
        () =>
          open(stub.origin).act(
            WORK,
            "praise-1",
            JSON.parse(JSON.stringify(input)),
          ),
        code("AUTONOMY_OUTCOME_UNKNOWN"),
      );
      assert.equal(stub.calls.length, 1);
    } finally {
      await stub.close();
    }
  }
});

test("manager reports carry no recipient; the backend's chief receipt is accepted", async () => {
  const stub = await autonomyStub(() => ({
    status: 201,
    body: {
      receipt: receipt({
        slot: "digest",
        type: "manager_report",
        recipient_id: CHIEF,
        text_sha256: sha256("Digest"),
      }),
      idempotent: false,
    },
  }));
  try {
    const input = {
      lease_generation: 1,
      mandate_revision: 1,
      type: "manager_report" as const,
      text: "Digest",
    };
    const result = await open(stub.origin).act(WORK, "digest", input);
    assert.equal(result.receipt.recipient_id, CHIEF);
    assert.deepEqual(stub.calls[0].body, input);
  } finally {
    await stub.close();
  }
});

test("act() validates locally before any request", async () => {
  const stub = await autonomyStub();
  try {
    const backend = open(stub.origin);
    for (const [slot, input] of [
      ["Praise", act()],
      ["-x", act()],
      ["x".repeat(65), act()],
      ["../mandate", act()],
      ["ok", act({ type: "follow_up" })],
      ["ok", act({ type: "public_praise" })],
      ["ok", act({ recipient_id: undefined })],
      ["ok", act({ recipient_id: "not-an-id" })],
      ["ok", act({ type: "manager_report" })],
      ["ok", act({ text: "" })],
      ["ok", act({ text: "   " })],
      ["ok", act({ text: "x".repeat(8001) })],
      ["ok", act({ text: `token ${TOKEN}` })],
      ["ok", act({ idempotency_key: "host-chosen" })],
    ] as [string, any][])
      await assert.rejects(
        () => backend.act(WORK, slot, JSON.parse(JSON.stringify(input))),
        code("AUTONOMY_INVALID"),
        slot,
      );
    assert.equal(stub.calls.length, 0);
  } finally {
    await stub.close();
  }
});

test("action denials map to fixed codes; limits keep their reason; lost replies are unknown", async () => {
  for (const [reply, expected, limit] of [
    [
      error(409, "ACTION_LIMITED", { limit: "quiet_hours" }),
      "ACTION_LIMITED",
      "quiet_hours",
    ],
    [
      error(409, "ACTION_LIMITED", { limit: "invented" }),
      "ACTION_LIMITED",
      undefined,
    ],
    [error(409, "ACTION_CONFLICT"), "ACTION_CONFLICT", undefined],
    [error(403, "RECIPIENT_NOT_MEMBER"), "RECIPIENT_NOT_MEMBER", undefined],
    [error(400, "ACTION_UNSUPPORTED"), "ACTION_UNSUPPORTED", undefined],
    [error(409, "LEASE_LOST"), "LEASE_LOST", undefined],
    [{ drop: true }, "AUTONOMY_OUTCOME_UNKNOWN", undefined],
    [
      { status: 502, body: "bad gateway" },
      "AUTONOMY_OUTCOME_UNKNOWN",
      undefined,
    ],
  ] as [any, string, string | undefined][]) {
    const stub = await autonomyStub(() => reply);
    try {
      await assert.rejects(
        () => open(stub.origin).act(WORK, "praise-1", act()),
        code(expected, (e) => e.limit === limit),
        expected,
      );
      assert.equal(stub.calls.length, 1);
    } finally {
      await stub.close();
    }
  }
});

test("actionReceipt() reads the exact committed slot; absence is a distinct fixed code", async () => {
  let reply: any = { body: { receipt: receipt() } };
  const stub = await autonomyStub(() => reply);
  try {
    const backend = open(stub.origin);
    assert.equal(
      (await backend.actionReceipt(WORK, "praise-1")).message_id,
      receipt().message_id,
    );
    assert.deepEqual(
      stub.calls.map((c) => [c.method, c.path]),
      [["GET", `/api/coach/autonomy/work/${WORK}/actions/praise-1`]],
    );
    reply = error(404, "ACTION_NOT_FOUND");
    await assert.rejects(
      () => backend.actionReceipt(WORK, "praise-1"),
      code("ACTION_NOT_FOUND"),
    );
    reply = { status: 404, body: "Cannot GET" };
    await assert.rejects(
      () => backend.actionReceipt(WORK, "praise-1"),
      code("AUTONOMY_UNSUPPORTED"),
    );
    reply = { body: { receipt: receipt({ slot: "other" }) } };
    await assert.rejects(
      () => backend.actionReceipt(WORK, "praise-1"),
      code("AUTONOMY_RESULT_REJECTED"),
    );
    reply = { body: { receipt: receipt({ text: TEXT }) } };
    await assert.rejects(
      () => backend.actionReceipt(WORK, "praise-1"),
      code("AUTONOMY_RESULT_REJECTED"),
    );
  } finally {
    await stub.close();
  }
});

test("every accepted response envelope must carry the coach.autonomy.v1 protocol", async () => {
  for (const [body, call, expected] of [
    [
      { work: null },
      (b: AutonomyBackend) => b.claim({}),
      "AUTONOMY_OUTCOME_UNKNOWN",
    ],
    [
      { work: workItem() },
      (b: AutonomyBackend) => b.start(WORK, 1),
      "AUTONOMY_OUTCOME_UNKNOWN",
    ],
    [
      { receipt: receipt(), idempotent: false },
      (b: AutonomyBackend) => b.act(WORK, "praise-1", act()),
      "AUTONOMY_OUTCOME_UNKNOWN",
    ],
    [
      { receipt: receipt() },
      (b: AutonomyBackend) => b.actionReceipt(WORK, "praise-1"),
      "AUTONOMY_RESULT_REJECTED",
    ],
    [
      { items: [], next_cursor: null, has_more: false },
      (b: AutonomyBackend) => b.listWork({}),
      "AUTONOMY_RESULT_REJECTED",
    ],
    [
      {
        protocol: "coach.autonomy.v2",
        items: [],
        next_cursor: null,
        has_more: false,
      },
      (b: AutonomyBackend) => b.listWork({}),
      "AUTONOMY_RESULT_REJECTED",
    ],
  ] as [any, (b: AutonomyBackend) => Promise<unknown>, string][]) {
    const stub = await autonomyStub(() => ({ raw: true, body }));
    try {
      await assert.rejects(() => call(open(stub.origin)), code(expected));
    } finally {
      await stub.close();
    }
  }
});

const followUpInput = (overrides: Record<string, unknown> = {}) => ({
  lease_generation: 1,
  mandate_revision: 1,
  subject_id: MEMBER,
  basis: "member_commitment" as const,
  summary: "Committed to a Thursday mobility session.",
  due_at: "2026-10-09T18:00:00.000Z",
  next_condition: "Mobility activity logged by Thursday evening.",
  evidence: {
    message_ref: "sealed.ref-1",
    quote: "I will do mobility on Thursday",
  },
  ...overrides,
});

test("followUp() creates one follow-up per work slot and verifies its source", async () => {
  let status = 201;
  const stub = await autonomyStub(() => ({
    status,
    body: { follow_up: followUp(), idempotent: status === 200 },
  }));
  try {
    const backend = open(stub.origin);
    const created = await backend.followUp(
      WORK,
      "commitment-1",
      followUpInput(),
    );
    assert.equal(created.idempotent, false);
    assert.equal(created.follow_up.id, FOLLOW_UP);
    status = 200;
    assert.equal(
      (await backend.followUp(WORK, "commitment-1", followUpInput()))
        .idempotent,
      true,
    );
    assert.deepEqual(
      stub.calls.map((c) => [c.method, c.path, c.body]),
      Array(2).fill([
        "PUT",
        `/api/coach/autonomy/work/${WORK}/follow-ups/commitment-1`,
        followUpInput(),
      ]),
    );
  } finally {
    await stub.close();
  }
});

test("a follow-up from another work, slot or subject is not accepted as this one", async () => {
  for (const body of [
    followUp({ source: { work_id: FOLLOW_UP, slot: "commitment-1" } }),
    followUp({ source: { work_id: WORK, slot: "commitment-2" } }),
    followUp({ subject_id: CHIEF }),
    followUp({ basis: "coach_request" }),
    followUp({ status: "pending" }),
    followUp({ summary: "x".repeat(501) }),
  ]) {
    const stub = await autonomyStub(() => ({
      status: 201,
      body: { follow_up: body, idempotent: false },
    }));
    try {
      await assert.rejects(
        () => open(stub.origin).followUp(WORK, "commitment-1", followUpInput()),
        code("AUTONOMY_OUTCOME_UNKNOWN"),
      );
    } finally {
      await stub.close();
    }
  }
});

test("follow-up inputs are bounded locally", async () => {
  const stub = await autonomyStub();
  try {
    const backend = open(stub.origin);
    for (const [slot, input] of [
      ["Bad", followUpInput()],
      ["ok", followUpInput({ basis: "inferred_expectation" })],
      ["ok", followUpInput({ summary: "x".repeat(501) })],
      ["ok", followUpInput({ next_condition: "x".repeat(301) })],
      ["ok", followUpInput({ due_at: "next thursday" })],
      ["ok", followUpInput({ subject_id: "nope" })],
      ["ok", followUpInput({ timezone: "UTC" })],
    ] as [string, any][])
      await assert.rejects(
        () => backend.followUp(WORK, slot, input),
        code("AUTONOMY_INVALID"),
        slot,
      );
    for (const input of [
      { expected_revision: 1, status: "open", closure_reason: "evidence_met" },
      { expected_revision: 1, status: "closed", closure_reason: "because" },
      { expected_revision: 1, status: "closed", closure_reason: null },
      {
        expected_revision: 1,
        status: "closed",
        closure_reason: "evidence_met",
        lease: { work_id: "x", lease_generation: 1 },
      },
    ])
      await assert.rejects(
        () => backend.patchFollowUp(FOLLOW_UP, input as any),
        code("AUTONOMY_INVALID"),
      );
    await assert.rejects(
      () => backend.listFollowUps({ status: "any" } as any),
      code("AUTONOMY_INVALID"),
    );
    assert.equal(stub.calls.length, 0);
  } finally {
    await stub.close();
  }
});

test("patchFollowUp() CAS-closes an exact follow-up; listFollowUps() pages by subject", async () => {
  const stub = await autonomyStub((call) =>
    call.method === "PATCH"
      ? {
          body: {
            follow_up: followUp({
              status: "closed",
              closure_reason: "evidence_met",
              revision: 2,
            }),
          },
        }
      : { body: { items: [followUp()], next_cursor: null, has_more: false } },
  );
  try {
    const backend = open(stub.origin);
    const input = {
      expected_revision: 1,
      status: "closed" as const,
      closure_reason: "evidence_met" as const,
      lease: { work_id: WORK, lease_generation: 1 },
    };
    const closed = await backend.patchFollowUp(FOLLOW_UP, input);
    assert.equal(closed.status, "closed");
    const page = await backend.listFollowUps({
      status: "open",
      subject_id: MEMBER,
      limit: 5,
    });
    assert.equal(page.items[0].id, FOLLOW_UP);
    assert.deepEqual(
      stub.calls.map((c) => [c.method, c.path, c.body]),
      [
        ["PATCH", `/api/coach/autonomy/follow-ups/${FOLLOW_UP}`, input],
        [
          "GET",
          `/api/coach/autonomy/follow-ups?status=open&subject_id=${MEMBER}&limit=5`,
          undefined,
        ],
      ],
    );
  } finally {
    await stub.close();
  }
  for (const [reply, expected] of [
    [error(409, "AUTONOMY_CONFLICT"), "AUTONOMY_CONFLICT"],
    [
      {
        body: {
          follow_up: followUp({
            id: WORK,
            status: "closed",
            closure_reason: "evidence_met",
          }),
        },
      },
      "AUTONOMY_OUTCOME_UNKNOWN",
    ],
    [{ body: { follow_up: followUp() } }, "AUTONOMY_OUTCOME_UNKNOWN"],
  ] as [any, string][]) {
    const stub = await autonomyStub(() => reply);
    try {
      await assert.rejects(
        () =>
          open(stub.origin).patchFollowUp(FOLLOW_UP, {
            expected_revision: 1,
            status: "closed",
            closure_reason: "evidence_met",
          }),
        code(expected),
      );
    } finally {
      await stub.close();
    }
  }
});

const statusBody = (overrides: Record<string, unknown> = {}) => ({
  mandate: { mode: "observe", paused: false, status: "active", revision: 3 },
  queue: { queued: 2, running: 1, blocked: 1 },
  last_completed_at: "2026-10-03T06:55:00.000Z",
  next_due_at: "2026-10-03T07:05:00.000Z",
  blocked: [{ work_id: WORK, reason: "uncertain_write" }],
  ingest: {
    roster_pass_completed_at: "2026-10-03T06:00:00.000Z",
    members_pending_in_pass: 0,
    members_total: 12,
    lagging_members: 0,
  },
  ...overrides,
});
const reportItem = (overrides: Record<string, unknown> = {}) => ({
  id: REPORT,
  work_id: WORK,
  kind: "event",
  result: "completed",
  coverage: outcome().coverage,
  counts: { acted: 1, no_action: 0, deferred: 0, escalated: 0 },
  action_slots: ["praise-1"],
  created_at: "2026-10-03T07:02:00.000Z",
  ...overrides,
});

test("status() and reports() read bounded, content-free operational state", async () => {
  const stub = await autonomyStub((call) =>
    call.path.startsWith("/api/coach/autonomy/status")
      ? { body: statusBody() }
      : {
          body: { items: [reportItem()], next_cursor: "next", has_more: true },
        },
  );
  try {
    const backend = open(stub.origin);
    const status = await backend.status();
    assert.equal(status.queue.blocked, 1);
    assert.equal(status.blocked[0].reason, "uncertain_write");
    const reports = await backend.reports({ limit: 20, cursor: "c1" });
    assert.equal(reports.items[0].counts.acted, 1);
    assert.deepEqual(
      stub.calls.map((c) => [c.method, c.path]),
      [
        ["GET", "/api/coach/autonomy/status"],
        ["GET", "/api/coach/autonomy/reports?limit=20&cursor=c1"],
      ],
    );
  } finally {
    await stub.close();
  }
});

test("a report or status carrying message content or unbounded lists is rejected", async () => {
  for (const [body, call] of [
    [
      statusBody({ blocked: Array(11).fill({ work_id: WORK, reason: "x" }) }),
      (b: AutonomyBackend) => b.status(),
    ],
    [
      statusBody({
        mandate: {
          mode: "message",
          paused: false,
          status: "active",
          revision: 3,
          instructions: "private",
        },
      }),
      (b: AutonomyBackend) => b.status(),
    ],
    [
      statusBody({ queue: { queued: -1, running: 0, blocked: 0 } }),
      (b: AutonomyBackend) => b.status(),
    ],
    [
      {
        items: [reportItem({ text: "Great squat session today." })],
        next_cursor: null,
        has_more: false,
      },
      (b: AutonomyBackend) => b.reports(),
    ],
    [
      {
        items: [reportItem({ result: "certified" })],
        next_cursor: null,
        has_more: false,
      },
      (b: AutonomyBackend) => b.reports(),
    ],
  ] as [any, (b: AutonomyBackend) => Promise<unknown>][]) {
    const stub = await autonomyStub(() => ({ body }));
    try {
      await assert.rejects(
        () => call(open(stub.origin)),
        code("AUTONOMY_RESULT_REJECTED"),
      );
    } finally {
      await stub.close();
    }
  }
});
