import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Worker } from "../src/worker/runner.js";
import { taskCatalog } from "../src/katafit/taskCatalog.js";
import { stockSkills } from "../src/config/skills.js";
import {
  CAPABILITY_PROTOCOL,
  PRINCIPAL_REST_NOTE,
  classifySecretRequest,
} from "../src/capability/invocation.js";
import { taskFixture } from "./task-fixtures.js";

/**
 * Full-capability addendum (Steve): every typed task and chat request runs with
 * the shared, isolated invocation capability (API discovery, ordinary REST
 * reads, dynamic memory, enabled skills, supported actions), keeps structured
 * output, and never replays an uncertain action.
 */
const TOKEN = "synthetic-worker-credential-0123456789";
const docs = {
  paths: {
    "/api/user/targets": "GET current nutrition targets",
    "/api/meals": "GET meals for a date",
  },
};
const skills = () => ({
  revision: 1,
  skills: stockSkills.map((skill) => structuredClone(skill)),
});
async function call(tools: any[], name: string, args: any, id = "call-1") {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} offered`);
  const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
  return tool.execute(id, prepared, new AbortController().signal);
}
async function attempt(tools: any[], name: string, args: any) {
  try {
    const result = await call(tools, name, args);
    return { ok: true, text: result.content?.[0]?.text ?? "" };
  } catch (error) {
    return { ok: false, text: (error as Error).message };
  }
}
const sha = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function worker(f: any, complete: any, extra: any = {}) {
  return new Worker({
    origin: f.origin,
    token: TOKEN,
    system: "Saved Coach persona",
    skills: skills(),
    complete,
    ...extra,
  });
}

test("capability protocol and secret-producing endpoint classifier", () => {
  assert.equal(CAPABILITY_PROTOCOL, "coach.capability.v1");
  for (const [method, path] of [
    ["GET", "/api/coach/rest-credentials"],
    ["DELETE", "/api/coach/rest-credentials/abc"],
    ["GET", "/api/COACH/%72est-credentials"],
    ["POST", "/api/mcp/servers/device"],
    ["POST", "/api/mcp/servers/device/rotate"],
    ["GET", "/api/mcp/servers"],
    ["POST", "/api/login"],
    ["POST", "/api/register"],
    ["POST", "/api/auth/mobile-ticket"],
    ["POST", "/api/auth/clerk/sync"],
    ["GET", "/api/invite/abc"],
    ["POST", "/api/email-verification/verify-code"],
    ["GET", "/api/%ZZ"],
  ])
    assert.equal(
      classifySecretRequest(method, path),
      true,
      `${method} ${path}`,
    );
  for (const [method, path] of [
    ["GET", "/api/docs/coach"],
    ["GET", "/api/user/targets"],
    ["POST", "/api/meals"],
    ["GET", "/api/coach/memory?query=protein"],
  ])
    assert.equal(
      classifySecretRequest(method, path),
      false,
      `${method} ${path}`,
    );
});

for (const negotiate of [true, false])
  test(`every advertised task kind gets the shared capability, and correction keeps it (${negotiate ? "negotiated" : "legacy"} DTO)`, async () => {
    const kinds = taskCatalog.contracts.map((c) => c.kind);
    assert.equal(kinds.length, 9);
    for (const kind of kinds) {
      const f = await taskFixture({
        negotiate,
        memory: true,
        rest: async (c: any) =>
          c.path === "/api/docs/coach"
            ? { status: 200, body: docs }
            : undefined,
      });
      const seen: any[] = [];
      const w = worker(
        f,
        async (
          _ctx: string,
          _s: any,
          system: string,
          tools: any[],
          _ref: string,
          budget: any,
        ) => {
          const names = tools.map((t) => t.name).sort();
          const discovery = await call(tools, "katafit_rest_request", {
            method: "GET",
            path: "/api/docs/coach",
          });
          seen.push({ names, system, budget, discovery });
          return "not json";
        },
      );
      try {
        f.enqueue(kind);
        await assert.rejects(w.pollOnce());
        const claim = f.calls.find((c) => c.name === "coach_claim_task");
        assert.deepEqual(
          claim.args.capability_protocols,
          negotiate ? [CAPABILITY_PROTOCOL] : undefined,
          kind,
        );
        assert.equal(seen.length, 2, `${kind}: correction attempt ran`);
        for (const [i, s] of seen.entries()) {
          assert.ok(s.names.includes("katafit_rest_request"), `${kind}#${i}`);
          assert.ok(s.names.includes("coach_memory_search"), `${kind}#${i}`);
          assert.match(s.system, /GET \/api\/docs\/coach/, kind);
          assert.match(s.system, /Use the Kata\.fit API/, `${kind} skill`);
          assert.doesNotMatch(s.system, /no prose, tools/i, kind);
          assert.ok(
            Number.isFinite(s.budget?.deadlineAt),
            `${kind}: bounded deadline`,
          );
          assert.match(s.discovery.content[0].text, /api\/user\/targets/);
        }
        assert.ok(seen[1].budget.deadlineAt <= seen[0].budget.deadlineAt);
        assert.equal(
          f.restCalls.filter((c: any) => c.path === "/api/docs/coach").length,
          2,
        );
        assert.ok(
          f.restCalls.every((c: any) => c.authorization === `Bearer ${TOKEN}`),
        );
        assert.ok(
          f.calls.some((c) => c.name === "coach_memory_begin"),
          `${kind}: dynamic memory`,
        );
        assert.deepEqual(
          f.calls
            .filter((c) => c.name === "coach_fail_task")
            .map((c) => c.args.code),
          ["TASK_INVALID_OUTPUT"],
        );
      } finally {
        await w.stop();
        await f.close();
      }
    }
  });

const targets = { calories: 2350, protein_g: 160 };
const meals = { meals: [{ name: "Lunch", calories: 1900, protein_g: 120 }] };
for (const control of ["fetched", "denied", "missing", "timeout"] as const)
  test(
    `nutrition regression: daily insight without seed targets acquires them (${control})`,
    { timeout: 30000 },
    async () => {
      const f = await taskFixture({
        negotiate: true,
        memory: true,
        evidence: {
          timezone: "UTC",
          observations: [
            { label: "Meals", text: "Synthetic: three meals logged today." },
          ],
          conversation: [],
        },
        rest: async (c: any) => {
          if (c.path === "/api/docs/coach") return { status: 200, body: docs };
          if (c.path === "/api/user/targets")
            return control === "fetched"
              ? { status: 200, body: targets }
              : control === "denied"
                ? { status: 403, body: { error: "Forbidden" } }
                : control === "missing"
                  ? { status: 404, body: { error: "No targets" } }
                  : "hang";
          if (c.path.startsWith("/api/meals"))
            return { status: 200, body: meals };
        },
      });
      const observed: string[] = [];
      let system = "";
      const w = worker(
        f,
        async (ctx: string, _s: any, sys: string, tools: any[]) => {
          if (sys.startsWith("You maintain the long-term memory"))
            return JSON.stringify({ proposals: [] });
          system = sys;
          assert.doesNotMatch(ctx, /2350/, "seed evidence lacks targets");
          for (const path of [
            "/api/docs/coach",
            "/api/user/targets",
            "/api/meals?date=2026-10-03",
          ]) {
            const r = await attempt(tools, "katafit_rest_request", {
              method: "GET",
              path,
            });
            assert.equal(
              r.ok,
              true,
              `${path} is a visible result, not a crash`,
            );
            observed.push(r.text);
          }
          const t = observed[1];
          const advice =
            control === "fetched"
              ? `You logged 1900 kcal of your ${JSON.parse(t).calories} kcal target and 120 g of ${JSON.parse(t).protein_g} g protein.`
              : "You logged 1900 kcal and 120 g protein; your nutrition targets were unavailable, so I cannot judge target adequacy.";
          return JSON.stringify({
            general_advice: advice,
            meal_recommendations: [],
            recovery_recommendations: [],
            workout_directives: [],
          });
        },
      );
      try {
        f.enqueue("daily_insight");
        await w.pollOnce();
        assert.deepEqual(
          f.restCalls.map((c: any) => `${c.method} ${c.path}`),
          [
            "GET /api/docs/coach",
            "GET /api/user/targets",
            "GET /api/meals?date=2026-10-03",
          ],
        );
        assert.match(system, /partial/i);
        assert.match(system, /never invent|do not invent/i);
        assert.equal(f.saved.length, 1, "published once");
        assert.equal(w.state, "task-result-stored", "read back canonical");
        const advice = f.saved[0].result.general_advice;
        if (control === "fetched") {
          assert.match(advice, /2350 kcal target/);
          assert.match(advice, /160 g protein/);
        } else {
          assert.doesNotMatch(advice, /2350/);
          assert.match(
            observed[1],
            {
              denied: /REST_READ_DENIED.*403|403.*REST_READ_DENIED/,
              missing: /REST_READ_MISSING.*404|404.*REST_READ_MISSING/,
              timeout: /BACKEND_TIMEOUT/,
            }[control],
          );
          assert.match(observed[1], /do not invent/i);
        }
      } finally {
        await w.stop();
        await f.close();
      }
    },
  );

const valid = {
  activity_feedback: { reaction: "flex", reply_worthwhile: true },
  general_advice: "Synthetic individual activity note.",
};
const bad = { ...valid, day_closeout_meal_assessment: "Synthetic day." };

test("negotiated personal task mutation is journaled, executed once, settled, and never replayed by correction", async () => {
  const f = await taskFixture({
    negotiate: true,
    rest: async (c: any) =>
      c.method === "POST" && c.path === "/api/user/goals"
        ? { status: 201, body: { id: "g1" } }
        : undefined,
  });
  const results: any[] = [];
  let attempts = 0;
  const w = worker(
    f,
    async (_c: string, _s: any, _sys: string, tools: any[]) => {
      attempts++;
      results.push(
        await attempt(tools, "katafit_rest_request", {
          method: "POST",
          path: "/api/user/goals",
          body: { goal: "Synthetic goal" },
        }),
      );
      return JSON.stringify(attempts === 1 ? bad : valid);
    },
  );
  try {
    f.enqueue("activity_reaction");
    await w.pollOnce();
    assert.equal(attempts, 2);
    assert.equal(
      f.restCalls.filter((c: any) => c.method === "POST").length,
      1,
      "correction never replays the action",
    );
    assert.equal(results[0].ok, true);
    assert.match(results[0].text, /"id":"g1"/);
    assert.equal(results[1].ok, true);
    assert.match(results[1].text, /ALREADY_PERFORMED/);
    const opens = f.calls.filter((c) => c.name === "coach_open_task_action");
    assert.equal(opens.length, 1);
    assert.deepEqual(
      { ...opens[0].args, request_sha256: undefined },
      {
        protocol: "coach.tasks.v1",
        task_id: f.saved[0].task_id,
        lease_generation: 1,
        slot: "r1",
        action: "rest_mutation",
        method: "POST",
        path: "/api/user/goals",
        request_sha256: undefined,
      },
    );
    assert.equal(
      opens[0].args.request_sha256,
      sha({
        method: "POST",
        path: "/api/user/goals",
        body: { goal: "Synthetic goal" },
      }),
    );
    assert.deepEqual(
      f.calls
        .filter((c) => c.name === "coach_settle_task_action")
        .map((c) => [c.args.slot, c.args.status]),
      [["r1", "succeeded"]],
    );
    // One canonical task publication, separate from the extra action.
    assert.equal(f.saved.length, 1);
  } finally {
    await w.stop();
    await f.close();
  }
});

test("uncertain task mutation settles unknown, fences new writes, and a restart never replays it", async () => {
  let drop = true;
  const f = await taskFixture({
    negotiate: true,
    rest: async (c: any) =>
      c.method === "POST"
        ? drop
          ? "drop"
          : { status: 201, body: { ok: true } }
        : undefined,
  });
  const body = { goal: "Synthetic goal" };
  const seen: any[] = [];
  const complete = async (_c: string, _s: any, _sys: string, tools: any[]) => {
    seen.push(
      await attempt(tools, "katafit_rest_request", {
        method: "POST",
        path: "/api/user/goals",
        body,
      }),
      await attempt(tools, "katafit_rest_request", {
        method: "PUT",
        path: "/api/user/settings",
        body: { units: "metric" },
      }),
    );
    return JSON.stringify(valid);
  };
  const w = worker(f, complete);
  const first = f.enqueue("activity_reaction");
  try {
    await w.pollOnce();
  } finally {
    await w.stop();
  }
  assert.equal(seen[0].ok, false);
  assert.match(seen[0].text, /DELIVERY_UNVERIFIED/);
  assert.equal(seen[1].ok, false, "an unresolved write fences new writes");
  assert.match(seen[1].text, /DELIVERY_UNVERIFIED/);
  assert.equal(f.restCalls.length, 1, "no request reached the network after");
  assert.deepEqual(
    f.calls
      .filter((c) => c.name === "coach_settle_task_action")
      .map((c) => [c.args.slot, c.args.status]),
    [["r1", "unknown"]],
  );
  // Restart: a new worker process receives the same task at a new lease.
  drop = false;
  f.enqueue("activity_reaction", { id: first.id, lease_generation: 2 });
  const again = worker(f, complete);
  try {
    await again.pollOnce();
  } finally {
    await again.stop();
    await f.close();
  }
  assert.equal(f.restCalls.length, 1, "restart never replays or writes anew");
  assert.match(seen[2].text, /DELIVERY_UNVERIFIED/);
  assert.match(seen[3].text, /DELIVERY_UNVERIFIED/);
});

test("stale lease, legacy DTO and unavailable REST block mutations before any network", async () => {
  for (const scenario of ["lease-lost", "legacy", "no-rest"] as const) {
    const f = await taskFixture({
      negotiate: scenario !== "legacy",
      restAccess: scenario !== "no-rest",
      rest: async () => ({ status: 201, body: {} }),
    });
    let outcome: any;
    const w = worker(
      f,
      async (_c: string, _s: any, _sys: string, tools: any[]) => {
        if (scenario === "lease-lost") f.state.leaseLost = true;
        outcome = await attempt(tools, "katafit_rest_request", {
          method: "POST",
          path: "/api/user/goals",
          body: { goal: "x" },
        });
        return JSON.stringify(valid);
      },
    );
    try {
      f.enqueue("activity_reaction");
      await w.pollOnce().catch(() => {});
      assert.equal(
        f.restCalls.filter((c: any) => c.method !== "GET").length,
        0,
        scenario,
      );
      assert.match(
        outcome.text,
        scenario === "lease-lost" ? /LEASE_LOST/ : /ACTION_UNSUPPORTED/,
        scenario,
      );
    } finally {
      await w.stop();
      await f.close();
    }
  }
});

test("secret-producing, host-only control-plane and memory-write routes are blocked before network", async () => {
  const f = await taskFixture({
    negotiate: true,
    rest: async () => ({ status: 200, body: { leaked: TOKEN } }),
  });
  const outcomes: any[] = [];
  let system = "";
  const w = worker(
    f,
    async (_c: string, _s: any, sys: string, tools: any[]) => {
      system = sys;
      for (const [method, path, body] of [
        ["GET", "/api/coach/rest-credentials"],
        ["POST", "/api/mcp/servers/device"],
        ["POST", "/api/auth/mobile-ticket"],
        ["POST", "/api/coach/autonomy/claims", { x: 1 }],
        ["PATCH", "/api/coach/memory/abc", { pinned: true }],
      ] as const)
        outcomes.push(
          await attempt(tools, "katafit_rest_request", {
            method,
            path,
            ...(body ? { body } : {}),
          }),
        );
      // An ordinary read whose response would disclose a host secret.
      outcomes.push(
        await attempt(tools, "katafit_rest_request", {
          method: "GET",
          path: "/api/user/profile",
        }),
      );
      return JSON.stringify(valid);
    },
  );
  try {
    f.enqueue("activity_reaction");
    await w.pollOnce();
    assert.deepEqual(
      f.restCalls.map((c: any) => c.path),
      ["/api/user/profile"],
    );
    for (const o of outcomes.slice(0, 3))
      assert.match(o.text, /SECRET_ENDPOINT_DENIED/);
    assert.match(outcomes[3].text, /HOST_ONLY_ROUTE/);
    assert.match(outcomes[4].text, /HOST_ONLY_ROUTE/);
    for (const o of outcomes) assert.ok(!o.text.includes(TOKEN));
    assert.ok(!system.includes(TOKEN));
  } finally {
    await w.stop();
    await f.close();
  }
});

test("dojo task member message reaches only its requester once under the journal key; repair and restart reconcile by receipt", async () => {
  let dropSend = false;
  const f = await taskFixture({
    negotiate: true,
    // A dropped send commits server-side first: only the response is lost.
    rest: async (c: any, { memberReceipts }: any) => {
      if (!dropSend || c.method !== "POST") return undefined;
      memberReceipts.set(c.body.idempotency_key, {
        status: "delivered",
        recipient_id: c.path.split("/").at(-1),
        idempotency_key: c.body.idempotency_key,
        message_id: "d".repeat(24),
      });
      return "drop";
    },
  });
  const requester = "2".repeat(24);
  const seen: any[] = [];
  let attempts = 0;
  const complete = async (_c: string, _s: any, _sys: string, tools: any[]) => {
    attempts++;
    seen.push(
      await attempt(tools, "katafit_rest_request", {
        method: "POST",
        path: `/api/coach/member-messages/${"9".repeat(24)}`,
        body: { text: "Synthetic note for someone else" },
      }),
      await attempt(tools, "katafit_rest_request", {
        method: "POST",
        path: `/api/coach/member-messages/${requester}`,
        body: { text: "Synthetic extra note" },
      }),
    );
    return JSON.stringify(attempts === 1 ? bad : valid);
  };
  const w = worker(f, complete);
  try {
    const task = f.enqueue("activity_reaction", {
      owner_type: "dojo",
      owner_id: "3".repeat(24),
    });
    await w.pollOnce();
    const posts = () => f.restCalls.filter((c: any) => c.method === "POST");
    assert.equal(posts().length, 1, "one visible message across correction");
    assert.equal(posts()[0].path, `/api/coach/member-messages/${requester}`);
    assert.deepEqual(posts()[0].body, {
      text: "Synthetic extra note",
      idempotency_key: `tsk_${task.id}_m1`,
    });
    assert.match(seen[0].text, /ACTION_UNSUPPORTED/, "other recipients denied");
    assert.equal(seen[1].ok, true);
    assert.match(seen[1].text, /delivered/);
    assert.match(seen[3].text, /ALREADY_PERFORMED/);
    assert.deepEqual(
      f.calls
        .filter((c) => c.name === "coach_settle_task_action")
        .map((c) => [c.args.slot, c.args.status]),
      [["m1", "succeeded"]],
    );
    assert.equal(f.saved.length, 1);
  } finally {
    await w.stop();
  }
  // A lost send response on another task: settle unknown; restart reconciles
  // by the backend receipt and never re-POSTs.
  dropSend = true;
  attempts = 1;
  seen.length = 0;
  const lost = f.enqueue("activity_reaction", {
    owner_type: "dojo",
    owner_id: "3".repeat(24),
  });
  const w2 = worker(f, complete);
  try {
    await w2.pollOnce();
  } finally {
    await w2.stop();
  }
  assert.match(seen[1].text, /DELIVERY_UNVERIFIED/);
  const postsBefore = f.restCalls.filter(
    (c: any) => c.method === "POST",
  ).length;
  dropSend = false;
  seen.length = 0;
  attempts = 0;
  f.enqueue("activity_reaction", {
    id: lost.id,
    owner_type: "dojo",
    owner_id: "3".repeat(24),
    lease_generation: 2,
  });
  const w3 = worker(f, async (c: string, s: any, sys: string, tools: any[]) => {
    const occ = [...f.journal.values()].find(
      (r: any) => r.idempotency_key === `tsk_${lost.id}_m1`,
    );
    assert.ok(occ, "journal retained the occurrence");
    return complete(c, s, sys, tools);
  });
  try {
    await w3.pollOnce();
  } finally {
    await w3.stop();
    await f.close();
  }
  assert.equal(
    f.restCalls.filter((c: any) => c.method === "POST").length,
    postsBefore,
    "restart never re-POSTs an uncertain message",
  );
  assert.ok(
    f.restCalls.some(
      (c: any) =>
        c.method === "GET" &&
        c.path ===
          `/api/coach/member-messages/${requester}/receipts/tsk_${lost.id}_m1`,
    ),
    "reconciled by receipt",
  );
  assert.match(seen[1].text, /ALREADY_PERFORMED/);
  assert.match(seen[1].text, /delivered/);
  assert.deepEqual(
    f.calls
      .filter(
        (c) =>
          c.name === "coach_settle_task_action" && c.args.task_id === lost.id,
      )
      .map((c) => [c.args.lease_generation, c.args.status]),
    [
      [1, "unknown"],
      [2, "succeeded"],
    ],
  );
});

test("worker chat requests receive the same REST capability with durable local write fences", async () => {
  const ledger: any[] = [];
  const f = await taskFixture({
    main: true,
    negotiate: true,
    rest: async (c: any) =>
      c.path === "/api/docs/coach"
        ? { status: 200, body: docs }
        : c.method === "POST"
          ? "drop"
          : undefined,
  });
  const seen: any[] = [];
  const w = worker(
    f,
    async (_c: string, _s: any, sys: string, tools: any[]) => {
      seen.push(
        sys,
        await attempt(tools, "katafit_rest_request", {
          method: "GET",
          path: "/api/docs/coach",
        }),
        await attempt(tools, "katafit_rest_request", {
          method: "POST",
          path: "/api/user/goals",
          body: { goal: "x" },
        }),
        await attempt(tools, "katafit_rest_request", {
          method: "POST",
          path: "/api/user/goals",
          body: { goal: "y" },
        }),
      );
      return "Synthetic reply.";
    },
    {
      actionLedger: {
        unresolved: () =>
          ledger.some((a) => ["pending", "unknown"].includes(a.status)),
        save: (a: any) => {
          const i = ledger.findIndex(
            (x) => x.idempotency_key === a.idempotency_key,
          );
          if (i >= 0) ledger[i] = a;
          else ledger.push(a);
        },
      },
    },
  );
  try {
    await w.pollOnce();
    assert.match(seen[0], /GET \/api\/docs\/coach/);
    assert.match(seen[1].text, /api\/user\/targets/);
    assert.match(seen[2].text, /DELIVERY_UNVERIFIED/);
    assert.match(seen[3].text, /DELIVERY_UNVERIFIED/);
    assert.equal(f.restCalls.filter((c: any) => c.method === "POST").length, 1);
    assert.deepEqual(
      ledger.map((a) => [a.tool_name, a.status]),
      [["katafit_rest_request", "unknown"]],
    );
    assert.match(ledger[0].session_id, /^worker-request:main:/);
    assert.deepEqual(
      f.calls.find((c) => c.name === "coach_claim_request")?.args
        .capability_protocols,
      ["coach.capability.v1"],
      "the request lease opts into coach.capability.v1",
    );
  } finally {
    await w.stop();
    await f.close();
  }
});

const memoryLedger = (ledger: any[]) => ({
  unresolved: () =>
    ledger.some((a) => ["pending", "unknown"].includes(a.status)),
  save: (a: any) => ledger.push(a),
});
const requestRun = async (options: any, ledger: any[] = []) => {
  const f = await taskFixture({
    main: true,
    rest: async (c: any) =>
      c.path === "/api/docs/coach" ? { status: 200, body: docs } : undefined,
    ...options,
  });
  const seen: any = { inferences: 0 };
  const w = worker(
    f,
    async (_c: string, _s: any, sys: string, tools: any[]) => {
      seen.inferences++;
      seen.system = sys;
      seen.read = await attempt(tools, "katafit_rest_request", {
        method: "GET",
        path: "/api/docs/coach",
      });
      seen.write = await attempt(tools, "katafit_rest_request", {
        method: "POST",
        path: "/api/user/goals",
        body: { goal: "x" },
      });
      return "Synthetic reply.";
    },
    { actionLedger: memoryLedger(ledger) },
  );
  try {
    await w.pollOnce().catch((e: Error) => (seen.error = e.message));
  } finally {
    await w.stop();
    await f.close();
  }
  return { f, seen, ledger };
};

test("legacy chat request context keeps the backend write prohibition: reads only", async () => {
  const { f, seen, ledger } = await requestRun({});
  assert.equal(seen.read.ok, true);
  assert.match(seen.read.text, /api\/user\/targets/);
  assert.match(seen.write.text, /ACTION_UNSUPPORTED/);
  assert.equal(f.restCalls.filter((c: any) => c.method !== "GET").length, 0);
  assert.deepEqual(ledger, []);
  assert.equal(
    f.calls.find((c) => c.name === "coach_claim_request")?.args
      .capability_protocols,
    undefined,
    "no opt-in without the advertised protocol",
  );
});

test("negotiated Dojo chat request reads as the chief principal and never writes", async () => {
  const { f, seen, ledger } = await requestRun({
    negotiate: true,
    requestScope: "dojo",
  });
  assert.equal(seen.inferences, 1);
  assert.equal(seen.read.ok, true);
  assert.match(seen.write.text, /ACTION_UNSUPPORTED/);
  assert.equal(f.restCalls.filter((c: any) => c.method !== "GET").length, 0);
  assert.deepEqual(ledger, []);
  assert.ok(seen.system.includes(PRINCIPAL_REST_NOTE));
});

test("negotiated chat request without REST access offers no writes", async () => {
  const { f, seen, ledger } = await requestRun({
    negotiate: true,
    restAccess: false,
  });
  assert.equal(seen.inferences, 1);
  assert.match(seen.write.text, /ACTION_UNSUPPORTED/);
  assert.equal(f.restCalls.filter((c: any) => c.method !== "GET").length, 0);
  assert.deepEqual(ledger, []);
});

for (const [label, patch] of [
  ["wrong plane", (c: any) => ({ ...c, plane: "task" })],
  [
    "foreign subject",
    (c: any) => ({
      ...c,
      rest: { ...c.rest, subject_user_id: "someone-else" },
    }),
  ],
  [
    "replaying correction",
    (c: any) => ({
      ...c,
      structured_result_correction: {
        tools_retained: true,
        replay_actions: true,
      },
    }),
  ],
  [
    "Dojo write-admitting",
    (c: any) => ({
      ...c,
      actions: { ...c.actions, supported: ["rest_mutation"] },
    }),
  ],
] as const)
  test(`negotiated chat request with a ${label} descriptor is rejected before inference`, async () => {
    const { f, seen } = await requestRun({
      negotiate: true,
      capabilityPatch: patch,
      ...(label === "Dojo write-admitting" ? { requestScope: "dojo" } : {}),
    });
    assert.equal(seen.inferences, 0);
    assert.equal(seen.error, "CONTEXT_REJECTED");
    assert.ok(!f.calls.some((c) => c.name === "coach_respond"));
    assert.equal(f.restCalls.length, 0);
  });
