import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { complete } from "../src/runtime/piAdapter.js";
import { Worker } from "../src/worker/runner.js";
import { InvocationCapability } from "../src/capability/invocation.js";
import { answer, toolCall } from "./helpers/continuity.js";
import { taskFixture } from "./task-fixtures.js";

// Standalone typed day_closure: the actual Worker task -> InvocationCapability
// -> loopback REST (canonical backend response shapes) -> real Pi adapter ->
// provider envelope. Only the model is scripted; it proves what the provider
// was given before its first turn, not live model compliance.

const REQUESTER = "2".repeat(24);
const PRINCIPAL = "c".repeat(24);
const DOJO = "d".repeat(24);
const AS_OF = "2026-10-07T21:30:00.000Z";
const DAY = "2026-10-07";
const id = (n: number) => "a".repeat(22) + String(n).padStart(2, "0");
const REST = "katafit_rest_request";
const TOKEN = "synthetic-worker-credential";

const closeout = {
  activity_feedback: { reaction: "check", reply_worthwhile: true },
  general_advice:
    "Every scheduled meal is complete as of the snapshot. Keep tomorrow simple.",
  day_closeout_meal_assessment:
    "Saved foods were read for the completed meals; unavailable reads are stated as unavailable.",
};

/** Mirrors backend dayObservations() for a negotiated lease. */
function dayEvidence(activities: any[]) {
  const meals = activities.filter((a) => a.type === "meal");
  return {
    timezone: "UTC",
    observations: [
      {
        label: "Day closeout snapshot",
        text: JSON.stringify({
          local_day: DAY,
          timezone: "UTC",
          as_of: AS_OF,
          all_meals_complete: true,
          all_activities_complete: true,
          scheduled_meal_count: meals.length,
          completed_meal_count: meals.length,
          scheduled_activity_count: activities.length,
          completed_activity_count: activities.length,
          remaining_activity_count: 0,
          included_activity_count: activities.length,
          omitted_activity_count: 0,
          activities_partial: false,
        }),
      },
      {
        label: "Day activities (part 1 of 1)",
        text: JSON.stringify(activities),
      },
      {
        label: "Result limitations",
        text: "This is the single written closeout for the whole local day, as of the snapshot time. Seed evidence lists only authorized activity IDs and typed summaries; missing summary detail is not proof of missing saved foods.",
      },
    ],
    conversation: [],
  };
}
const seedMeal = (n: number) => ({
  activity_id: id(n),
  type: "meal",
  name: `Synthetic meal ${n}`,
  status: "complete",
  completed_at: "2026-10-07T12:00:00.000Z",
  due_at: null,
  summary: { meal: true },
});
const seedWorkout = {
  activity_id: "b".repeat(24),
  type: "workout",
  name: "Synthetic workout",
  status: "complete",
  completed_at: "2026-10-07T09:00:00.000Z",
  due_at: null,
  summary: { exercises: [] },
};
const bowl = {
  food_id: "f".repeat(24),
  instance_id: "e".repeat(24),
  name: "Synthetic bowl",
  quantity: 1,
  unit: "serving",
};
const summary = { calories: 600, protein: 40, carbs: 60, fat: 20, water_ml: 0 };
const memberTargets = {
  calories: 2400,
  protein: 160,
  carbs: 260,
  fat: 70,
  water_ml: 3000,
};
const principalTargets = { calories: 5000, protein: 300 };
/** Flat GET /api/activities/:activity_id (owner-only) response. */
const selfDetail = (n: number, foods: any[], extra: any = {}) => ({
  _id: id(n),
  user_id: REQUESTER,
  type: "meal",
  name: `Synthetic meal ${n}`,
  status: "complete",
  created_at: "2026-10-07T11:55:00.000Z",
  completed_at: "2026-10-07T12:00:00.000Z",
  data: { foods },
  nutrition_summary: summary,
  nutrition_targets: memberTargets,
  social: { kudos_count: 0, comment_count: 0, has_kudos: false },
  ...extra,
});
/** Nested GET /api/friends/activity/:activityId response. */
const peerDetail = (n: number, owner = REQUESTER, extra: any = {}) => ({
  activity: {
    _id: id(n),
    user_id: owner,
    type: "meal",
    name: `Synthetic meal ${n}`,
    status: "complete",
    created_at: "2026-10-07T11:55:00.000Z",
    completed_at: "2026-10-07T12:00:00.000Z",
    data: { foods: [bowl] },
    nutrition_summary: summary,
    social: { kudos_count: 0, comment_count: 0, has_kudos: false },
    ...extra,
  },
  owner: { _id: owner, display_name: "Synthetic member" },
});
const feedRow = (n: number, owner: string, day: string, targets: any) => ({
  _id: id(n),
  user_id: owner,
  type: "meal",
  status: "complete",
  created_at: `${day}T11:55:00.000Z`,
  nutrition_summary: summary,
  dojo_nutrition: {
    day_key: day,
    is_current_day: false,
    coverage: "partial",
    targets,
  },
});

const toolText = (m: any) =>
  typeof m.content === "string"
    ? m.content
    : (m.content ?? []).map((p: any) => p.text ?? "").join("");
type Policy = (body: any, toolResults: string[]) => string;
async function scriptedProvider(policy: Policy) {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    bodies.push(body);
    res.setHeader("Content-Type", "text/event-stream");
    try {
      res.end(
        policy(
          body,
          body.messages.filter((m: any) => m.role === "tool").map(toolText),
        ),
      );
    } catch (error) {
      res.end(answer(`policy failure: ${(error as Error).message}`));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    bodies,
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
/** The serialized task envelope the provider actually received. */
function envelope(body: any) {
  const user = body.messages.find(
    (m: any) => m.role === "user" && toolText(m).includes("generation_task"),
  );
  assert.ok(user, "provider received the task envelope");
  return JSON.parse(toolText(user));
}
const byId = (evidence: any) =>
  Object.fromEntries(
    (evidence?.meals ?? []).map((m: any) => [m.activity_id, m]),
  );

async function run(
  fixtureOptions: any,
  enqueue: { kind: string; patch?: any },
  policy: Policy,
) {
  // All HTTP fixture allocation happens inside the finally-guarded scope.
  let f: Awaited<ReturnType<typeof taskFixture>> | undefined;
  let p: Awaited<ReturnType<typeof scriptedProvider>> | undefined;
  let w: Worker | undefined;
  const readsAtFirstTurn: string[] = [];
  try {
    f = await taskFixture(fixtureOptions);
    const fixture = f;
    p = await scriptedProvider((body, results) => {
      if (p!.bodies.length === 1)
        readsAtFirstTurn.push(
          ...fixture.restCalls.map((c: any) => `${c.method} ${c.path}`),
        );
      return policy(body, results);
    });
    const provider = p;
    w = new Worker({
      origin: f.origin,
      token: TOKEN,
      system: "Synthetic Coach persona",
      complete: (context, signal, system, tools) =>
        complete(
          {
            baseUrl: provider.baseUrl,
            model: "synthetic-model",
            apiKey: "synthetic-provider-credential",
            secrets: [TOKEN],
          },
          system,
          context,
          signal,
          tools,
        ),
    });
    f.enqueue(enqueue.kind, enqueue.patch);
    const error = await w.pollOnce().then(
      () => undefined,
      (e: Error) => e,
    );
    return {
      error,
      state: w.state,
      bodies: provider.bodies,
      saved: [...f.saved],
      reads: f.restCalls.map((c: any) => `${c.method} ${c.path}`),
      readsAtFirstTurn,
      authorizations: f.restCalls.map((c: any) => c.authorization),
    };
  } finally {
    await w?.stop();
    await p?.close();
    await f?.close();
  }
}

test("personal day closeout hydrates canonical self meal detail before the model, distinguishing empty foods from an unavailable read", async () => {
  const activities = [seedMeal(1), seedMeal(2), seedMeal(3), seedWorkout];
  const r = await run(
    {
      negotiate: true,
      evidence: dayEvidence(activities),
      rest: async (c: any) => {
        if (c.path === `/api/activities/${id(1)}`)
          return { status: 200, body: selfDetail(1, [bowl]) };
        if (c.path === `/api/activities/${id(2)}`)
          return {
            status: 200,
            body: selfDetail(2, [], {
              nutrition_summary: {
                calories: 0,
                protein: 0,
                carbs: 0,
                fat: 0,
                water_ml: 0,
              },
            }),
          };
        if (c.path === `/api/activities/${id(3)}`)
          return { status: 500, body: { error: "Synthetic outage" } };
        if (c.path === "/api/user/targets")
          return { status: 200, body: principalTargets };
      },
    },
    { kind: "day_closure" },
    (body, results) => {
      // A later model read of an acquired path reuses the acquired result.
      if (results.length === 0)
        return toolCall(
          REST,
          { method: "GET", path: `/api/activities/${id(1)}` },
          "reread",
        );
      assert.match(results[0], /Synthetic bowl/);
      return answer(JSON.stringify(closeout));
    },
  );
  assert.equal(r.error, undefined, String(r.error));
  assert.equal(r.state, "task-result-stored");
  assert.deepEqual(r.saved[0].result, closeout);
  // Deterministic bounded acquisition happened before the first model turn.
  assert.deepEqual(r.readsAtFirstTurn, [
    `GET /api/activities/${id(1)}`,
    `GET /api/activities/${id(2)}`,
    `GET /api/activities/${id(3)}`,
  ]);
  // The model's re-read was served from the acquisition, not refetched; no
  // principal-account targets or workout reads.
  assert.deepEqual(r.reads, r.readsAtFirstTurn);
  assert.ok(r.authorizations.every((a) => a === `Bearer ${TOKEN}`));

  const first = envelope(r.bodies[0]);
  assert.deepEqual(Object.keys(first), [
    "generation_task",
    "evidence",
    "acquired_meal_evidence",
  ]);
  assert.deepEqual(first.evidence, dayEvidence(activities));
  const acquired = first.acquired_meal_evidence;
  assert.equal(acquired.subject, "self");
  assert.equal(acquired.seed_as_of, AS_OF);
  assert.ok(Date.parse(acquired.acquired_at) > Date.parse(AS_OF));
  assert.match(acquired.provenance, /current|after/i);
  const meals = byId(acquired);
  assert.deepEqual(Object.keys(meals), [id(1), id(2), id(3)]);
  assert.equal(meals[id(1)].read, "ok");
  assert.deepEqual(meals[id(1)].foods, [
    { name: "Synthetic bowl", quantity: 1, unit: "serving" },
  ]);
  assert.equal(meals[id(1)].foods_empty, false);
  assert.deepEqual(meals[id(1)].nutrition_summary, summary);
  assert.deepEqual(meals[id(1)].targets, {
    read: "ok",
    source: "own_activity_detail",
    values: memberTargets,
  });
  // Successful read with no saved foods.
  assert.equal(meals[id(2)].read, "ok");
  assert.deepEqual(meals[id(2)].foods, []);
  assert.equal(meals[id(2)].foods_empty, true);
  // Unavailable read: no foods, totals or targets are implied.
  assert.equal(meals[id(3)].read, "unavailable");
  assert.equal(meals[id(3)].status_code, 500);
  assert.ok(!("foods" in meals[id(3)]));
  assert.ok(!("nutrition_summary" in meals[id(3)]));
  // No inferred day totals.
  assert.doesNotMatch(JSON.stringify(acquired), /total|1200/i);
  assert.doesNotMatch(JSON.stringify(r.bodies[0]), /5000/);
});

test("Dojo requester day closeout reads nested peer detail and exact owner/meal/day feed targets, never principal targets", async () => {
  const activities = [seedMeal(1), seedMeal(2), seedMeal(4), seedMeal(5)];
  const r = await run(
    {
      negotiate: true,
      evidence: dayEvidence(activities),
      rest: async (c: any) => {
        if (c.path === `/api/friends/activity/${id(1)}`)
          return { status: 200, body: peerDetail(1) };
        if (c.path === `/api/friends/activity/${id(2)}`)
          return { status: 403, body: { error: "Forbidden" } };
        // A credential-principal row for the same ID must not be attributed.
        if (c.path === `/api/friends/activity/${id(4)}`)
          return { status: 200, body: peerDetail(4, PRINCIPAL) };
        if (c.path === `/api/friends/activity/${id(5)}`)
          return {
            status: 200,
            body: peerDetail(5, REQUESTER, {
              nutrition_summary_unavailable: true,
              nutrition_summary: {
                calories: 0,
                protein: 0,
                carbs: 0,
                fat: 0,
                water_ml: 0,
              },
            }),
          };
        if (c.path === "/api/friends/feed/dojo?type=meal&limit=20")
          return {
            status: 200,
            body: {
              users: [],
              inDojo: true,
              activities: [
                feedRow(1, PRINCIPAL, DAY, principalTargets),
                feedRow(1, REQUESTER, DAY, memberTargets),
                feedRow(5, REQUESTER, "2026-10-06", memberTargets),
              ],
            },
          };
        if (c.path === "/api/user/targets")
          return { status: 200, body: principalTargets };
        if (c.path.startsWith("/api/activities/"))
          return { status: 404, body: { error: "Activity not found." } };
      },
    },
    { kind: "day_closure", patch: { owner_type: "dojo", owner_id: DOJO } },
    () => answer(JSON.stringify(closeout)),
  );
  assert.equal(r.error, undefined, String(r.error));
  assert.equal(r.state, "task-result-stored");
  assert.deepEqual(r.readsAtFirstTurn, [
    `GET /api/friends/activity/${id(1)}`,
    `GET /api/friends/activity/${id(2)}`,
    `GET /api/friends/activity/${id(4)}`,
    `GET /api/friends/activity/${id(5)}`,
    "GET /api/friends/feed/dojo?type=meal&limit=20",
  ]);
  assert.deepEqual(r.reads, r.readsAtFirstTurn);

  const acquired = envelope(r.bodies[0]).acquired_meal_evidence;
  assert.equal(acquired.subject, "dojo_requester");
  const meals = byId(acquired);
  assert.equal(meals[id(1)].read, "ok");
  assert.deepEqual(meals[id(1)].foods, [
    { name: "Synthetic bowl", quantity: 1, unit: "serving" },
  ]);
  assert.deepEqual(meals[id(1)].nutrition_summary, summary);
  assert.deepEqual(meals[id(1)].targets, {
    read: "ok",
    source: "dojo_feed",
    coverage: "partial",
    day_key: DAY,
    values: memberTargets,
  });
  assert.equal(meals[id(2)].read, "denied");
  assert.equal(meals[id(2)].status_code, 403);
  assert.ok(!("foods" in meals[id(2)]));
  // Subject is checked against the requester, not the credential principal.
  assert.equal(meals[id(4)].read, "subject_mismatch");
  assert.ok(!("foods" in meals[id(4)]));
  // Backend-flagged unavailable totals are not zero intake; a row for a
  // different day never supplies this snapshot day's targets.
  assert.equal(meals[id(5)].read, "ok");
  assert.equal(meals[id(5)].nutrition_summary, null);
  assert.equal(meals[id(5)].nutrition_summary_status, "unavailable");
  assert.deepEqual(meals[id(5)].targets, {
    read: "day_mismatch",
    source: "dojo_feed",
  });
  assert.doesNotMatch(JSON.stringify(acquired), /5000|"protein":300/);
});

test("bounded acquisition marks meals beyond the read budget as unattempted", async () => {
  const activities = Array.from({ length: 10 }, (_, i) => seedMeal(i + 1));
  const r = await run(
    {
      negotiate: true,
      evidence: dayEvidence(activities),
      rest: async (c: any) => {
        const m = /^\/api\/activities\/(a{22}(\d\d))$/.exec(c.path);
        if (m) return { status: 200, body: selfDetail(Number(m[2]), [bowl]) };
      },
    },
    { kind: "day_closure" },
    () => answer(JSON.stringify(closeout)),
  );
  assert.equal(r.state, "task-result-stored");
  assert.equal(r.readsAtFirstTurn.length, 8);
  const meals = byId(envelope(r.bodies[0]).acquired_meal_evidence);
  assert.deepEqual(
    Object.values(meals).map((m: any) => m.read),
    [...Array(8).fill("ok"), "unattempted", "unattempted"],
  );
  assert.equal(meals[id(9)].reason, "read_budget");
});

for (const control of ["rest_opt_out", "legacy", "activity_reaction"] as const)
  test(`no meal acquisition control: ${control}`, async () => {
    const kind = control === "activity_reaction" ? control : "day_closure";
    const evidence = dayEvidence([seedMeal(1)]);
    const r = await run(
      {
        negotiate: control !== "legacy",
        ...(control === "rest_opt_out" ? { restAccess: false } : {}),
        evidence,
        rest: async () => ({ status: 200, body: selfDetail(1, [bowl]) }),
      },
      { kind },
      () =>
        answer(
          JSON.stringify(
            kind === "day_closure"
              ? closeout
              : {
                  activity_feedback: {
                    reaction: "check",
                    reply_worthwhile: false,
                  },
                  general_advice: "",
                },
          ),
        ),
    );
    assert.equal(r.state, "task-result-stored");
    assert.deepEqual(r.reads, []);
    const first = envelope(r.bodies[0]);
    assert.deepEqual(Object.keys(first), ["generation_task", "evidence"]);
    assert.deepEqual(first.evidence, evidence);
  });

// Review fixes (B1, S1, S2).

const empty = {
  calories: 0,
  protein: 0,
  carbs: 0,
  fat: 0,
  water_ml: 0,
};
test("empty, array or non-numeric nutrition summaries and targets are unavailable, never ok", async () => {
  const malformed: [any, any][] = [
    [{}, {}],
    [[], []],
    [
      { calories: "600", protein: null },
      { calories: "2400", protein: null },
    ],
  ];
  const r = await run(
    {
      negotiate: true,
      evidence: dayEvidence([1, 2, 3, 4].map(seedMeal)),
      rest: async (c: any) => {
        const n = Number(/a{22}(\d\d)$/.exec(c.path)?.[1]);
        if (n >= 1 && n <= 3) {
          const [nutrition_summary, nutrition_targets] = malformed[n - 1];
          return {
            status: 200,
            body: selfDetail(n, [bowl], {
              nutrition_summary,
              nutrition_targets,
            }),
          };
        }
        // Partial numeric values remain an ok read of what was returned.
        if (n === 4)
          return {
            status: 200,
            body: selfDetail(4, [bowl], {
              nutrition_summary: { calories: 600 },
              nutrition_targets: { protein: 160 },
            }),
          };
      },
    },
    { kind: "day_closure" },
    () => answer(JSON.stringify(closeout)),
  );
  assert.equal(r.state, "task-result-stored");
  const meals = byId(envelope(r.bodies[0]).acquired_meal_evidence);
  for (const n of [1, 2, 3]) {
    assert.equal(meals[id(n)].read, "ok", `meal ${n} detail was read`);
    assert.equal(meals[id(n)].nutrition_summary, null, `meal ${n} summary`);
    assert.equal(meals[id(n)].nutrition_summary_status, "unavailable");
    assert.deepEqual(meals[id(n)].targets, {
      read: "unavailable",
      source: "own_activity_detail",
    });
  }
  assert.deepEqual(meals[id(4)].nutrition_summary, { calories: 600 });
  assert.equal(meals[id(4)].nutrition_summary_status, "ok");
  assert.deepEqual(meals[id(4)].targets, {
    read: "ok",
    source: "own_activity_detail",
    values: { protein: 160 },
  });
});

test("Dojo feed targets without numeric values and an array peer summary are unavailable, never ok", async () => {
  const r = await run(
    {
      negotiate: true,
      evidence: dayEvidence([seedMeal(1)]),
      rest: async (c: any) => {
        if (c.path === `/api/friends/activity/${id(1)}`)
          return {
            status: 200,
            body: peerDetail(1, REQUESTER, { nutrition_summary: [] }),
          };
        // Backend enrichment yields {} when a lookup has none of its keys.
        if (c.path === "/api/friends/feed/dojo?type=meal&limit=20")
          return {
            status: 200,
            body: { activities: [feedRow(1, REQUESTER, DAY, {})] },
          };
      },
    },
    { kind: "day_closure", patch: { owner_type: "dojo", owner_id: DOJO } },
    () => answer(JSON.stringify(closeout)),
  );
  assert.equal(r.state, "task-result-stored");
  const meal = byId(envelope(r.bodies[0]).acquired_meal_evidence)[id(1)];
  assert.equal(meal.read, "ok");
  assert.equal(meal.nutrition_summary, null);
  assert.equal(meal.nutrition_summary_status, "unavailable");
  assert.deepEqual(meal.targets, {
    read: "unavailable",
    source: "dojo_feed",
    coverage: "partial",
    day_key: DAY,
  });
});

test("host acquire honors the tool's secret-endpoint and host-only integration guards with zero network dispatch", async () => {
  let server: ReturnType<typeof createServer> | undefined;
  const dispatched: string[] = [];
  try {
    server = createServer((req, res) => {
      dispatched.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ secret: "never" }));
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const capability = new InvocationCapability({
      plane: "task",
      origin: `http://127.0.0.1:${(server.address() as any).port}`,
      token: TOKEN,
      secrets: [],
      vision: false,
      current: () => true,
      actions: [],
    });
    for (const path of [
      "/api/coach/rest-credentials",
      "/api/coach/rest-credentials/abc",
      "/api/mcp/tokens",
      "/api/auth/session",
      "/api/login",
      "/api/coach/integrations",
      "/api/coach/integrations/abc/secrets",
    ]) {
      const result = await capability.acquire(path);
      assert.equal(result.ok, false, path);
      assert.match(
        (result as any).error,
        /^(SECRET_ENDPOINT_DENIED|HOST_ONLY_ROUTE)$/,
        path,
      );
    }
    assert.deepEqual(dispatched, []);
    // An ordinary documented read still dispatches exactly once.
    assert.equal(
      (await capability.acquire(`/api/activities/${id(1)}`)).ok,
      true,
    );
    assert.deepEqual(dispatched, [`GET /api/activities/${id(1)}`]);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((r) => server!.close(() => r()));
    }
  }
});

test("maximal multibyte food input is bounded to 32768 serialized UTF-8 bytes with explicit truncation, preserving every meal status and target", async () => {
  // Each name splits a surrogate pair at the backend-independent 120-unit
  // clip and mixes JSON-escaped control/quote characters with 4-byte emoji.
  const heavy = (n: number) =>
    Array.from({ length: 60 }, (_, i) => ({
      ...bowl,
      instance_id: String(i).padStart(24, "e"),
      name: `\u0007"${n}` + "🍙".repeat(100),
      unit: '"\u0001'.repeat(20) + "🍙".repeat(10),
    }));
  const activities = Array.from({ length: 10 }, (_, i) => seedMeal(i + 1));
  const r = await run(
    {
      negotiate: true,
      evidence: dayEvidence(activities),
      rest: async (c: any) => {
        const n = Number(/a{22}(\d\d)$/.exec(c.path)?.[1]);
        if (n === 3)
          return { status: 500, body: { error: "Synthetic outage" } };
        if (n) return { status: 200, body: selfDetail(n, heavy(n)) };
      },
    },
    { kind: "day_closure" },
    () => answer(JSON.stringify(closeout)),
  );
  assert.equal(r.state, "task-result-stored");
  const acquired = envelope(r.bodies[0]).acquired_meal_evidence;
  assert.ok(
    Buffer.byteLength(JSON.stringify(acquired), "utf8") <= 32768,
    `acquired evidence is ${Buffer.byteLength(JSON.stringify(acquired))} bytes`,
  );
  assert.equal(acquired.bounded.byte_limit, 32768);
  assert.ok(acquired.bounded.foods_omitted > 0);
  const meals = byId(acquired);
  assert.deepEqual(
    Object.values(meals).map((m: any) => m.read),
    [
      "ok",
      "ok",
      "unavailable",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "unattempted",
      "unattempted",
    ],
  );
  let omitted = 0;
  for (const m of Object.values(meals) as any[]) {
    if (m.read !== "ok") continue;
    assert.deepEqual(m.targets, {
      read: "ok",
      source: "own_activity_detail",
      values: memberTargets,
    });
    assert.deepEqual(m.nutrition_summary, summary);
    // Trimming never turns saved foods into an apparent empty meal.
    assert.equal(m.foods_empty, false);
    assert.equal(m.foods_truncated, true);
    assert.equal(m.foods_count, 60);
    assert.ok(m.foods.length < 60);
    omitted += 60 - m.foods.length;
    for (const f of m.foods) {
      assert.ok(f.name.isWellFormed(), "no split surrogate in a food name");
      assert.ok(f.unit.isWellFormed(), "no split surrogate in a food unit");
    }
  }
  assert.equal(acquired.bounded.foods_omitted, omitted);
  assert.equal(meals[id(3)].status_code, 500);
  assert.equal(meals[id(9)].reason, "read_budget");
});

test("a maximal seed stays within 32768 bytes by counting, not listing, trailing unread meals", async () => {
  // As many seeded meals as the 65536-byte seed admits, split like the
  // backend into 4000-char parts; read meals carry worst-case escaped names.
  const hex = (n: number) => n.toString(16).padStart(24, "0");
  const seeded = Array.from({ length: 300 }, (_, i) => ({
    ...seedMeal(1),
    activity_id: hex(i + 1),
    name: `M${i + 1}`,
  }));
  const evidence = dayEvidence([]);
  const parts: any[][] = [[]];
  for (const entry of seeded) {
    if (JSON.stringify([...parts.at(-1)!, entry]).length > 3900) parts.push([]);
    parts.at(-1)!.push(entry);
  }
  evidence.observations = [
    evidence.observations[0],
    ...parts.map((part, i) => ({
      label: `Day activities (part ${i + 1} of ${parts.length})`,
      text: JSON.stringify(part),
    })),
    evidence.observations.at(-1)!,
  ];
  assert.ok(Buffer.byteLength(JSON.stringify(evidence)) <= 65536);
  const r = await run(
    {
      negotiate: true,
      evidence,
      rest: async (c: any) => {
        const m = /^\/api\/activities\/([a-f0-9]{24})$/.exec(c.path);
        if (m)
          return {
            status: 200,
            body: {
              ...selfDetail(1, [bowl]),
              _id: m[1],
              name: "\u0007".repeat(200),
              status: "\u0007".repeat(60),
            },
          };
      },
    },
    { kind: "day_closure" },
    () => answer(JSON.stringify(closeout)),
  );
  assert.equal(r.state, "task-result-stored");
  assert.equal(r.readsAtFirstTurn.length, 8);
  const acquired = envelope(r.bodies[0]).acquired_meal_evidence;
  assert.ok(
    Buffer.byteLength(JSON.stringify(acquired), "utf8") <= 32768,
    `acquired evidence is ${Buffer.byteLength(JSON.stringify(acquired))} bytes`,
  );
  // Every read meal keeps its status and targets; dropped entries are only
  // unread meals, counted explicitly (their IDs remain in the seed).
  const listed = acquired.meals;
  assert.deepEqual(
    listed.slice(0, 8).map((m: any) => [m.activity_id, m.read, m.targets.read]),
    seeded.slice(0, 8).map((s) => [s.activity_id, "ok", "ok"]),
  );
  assert.ok(listed.slice(8).every((m: any) => m.read === "unattempted"));
  assert.ok(acquired.bounded.unattempted_meals_omitted > 0);
  assert.equal(
    listed.length + acquired.bounded.unattempted_meals_omitted,
    seeded.length,
  );
});
