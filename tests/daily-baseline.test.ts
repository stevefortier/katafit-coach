import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Worker } from "../src/worker/runner.js";
import { taskFixture } from "./task-fixtures.js";
const result = JSON.stringify({
  general_advice: "A bounded observation.",
  workout_directives: [],
  meal_recommendations: [],
  recovery_recommendations: [],
});
const sample = JSON.parse(
  readFileSync(
    new URL("./fixtures/daily-baseline.synthetic.json", import.meta.url),
    "utf8",
  ),
);
const bindingKeys = [
  "lease_generation",
  "requester_id",
  "owner_type",
  "owner_id",
  "scope_generation",
  "requester_generation",
  "conversation_generation",
];
function bound(task: any) {
  return {
    ...structuredClone(sample),
    binding: {
      task_id: task.id,
      ...Object.fromEntries(bindingKeys.map((k) => [k, task[k]])),
    },
  };
}
async function runPacket(
  mutate: (p: any) => void = () => {},
  kind = "daily_insight",
  repair = false,
  options: any = {},
) {
  const context: any = {
    living_context: {
      version: 1,
      audience: "authorized",
      status: "ready",
      as_of: "2026-11-01T21:25:18.845Z",
      day: "2026-11-01",
      timezone: "UTC",
      revision: 1,
      coverage: [],
      sections: [{ label: "Old", text: "OLD_OPERATOR_TAIL" }],
    },
  };
  const f = await taskFixture({
    memory: true,
    dailyBaseline: true,
    ...options,
    context,
    evidence: {
      timezone: "UTC",
      observations: [{ label: "Canonical", text: "CANONICAL_EVIDENCE" }],
      conversation: [
        {
          role: "coach",
          text: "OLD_OPERATOR_TAIL",
          created_at: "2026-11-01T21:25:18.845Z",
        },
      ],
    },
  });
  const task = f.enqueue(kind);
  context.daily_baseline = bound(task);
  mutate(context.daily_baseline);
  const inputs: string[] = [],
    systems: string[] = [],
    events: any[] = [],
    extractionInputs: string[] = [];
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    onDiagnostic: (e) => events.push(e),
    complete: async (input, signal, system, tools) => {
      if (!system.includes("local result schema")) {
        extractionInputs.push(input);
        return '{"proposals":[]}';
      }
      inputs.push(input);
      systems.push(system);
      if (options.targetedRecall)
        await tools
          .find((t) => t.name === "coach_memory_search")!
          .execute("synthetic-search", { query: "knee history" }, signal);
      return repair && inputs.length === 1
        ? "{}"
        : kind === "daily_insight"
          ? result
          : '{"text":"Grounded reply"}';
    },
  });
  try {
    await w.pollOnce();
    return {
      inputs,
      systems,
      events,
      extractionInputs,
      calls: f.calls,
      saved: f.saved,
      packet: context.daily_baseline,
    };
  } finally {
    await w.stop();
    await f.close();
  }
}

test("malformed optional packet retains legacy recall", async () => {
  const r = await runPacket((p) => {
    p.schema = "unknown";
  });
  assert.equal(JSON.parse(r.inputs[0]).daily_baseline, undefined);
  assert.equal(
    r.calls.filter((c) => c.name === "coach_memory_recall").length,
    1,
  );
  assert.equal(r.saved.length, 1);
});

test("valid prepared packet replaces living and operator tail in real daily model input", async () => {
  const r = await runPacket();
  assert.equal(r.inputs.length, 1);
  const input = JSON.parse(r.inputs[0]);
  assert.deepEqual(input.daily_baseline, r.packet);
  assert.equal(input.living_context, undefined);
  assert.deepEqual(input.evidence.conversation, []);
  assert.doesNotMatch(r.inputs[0], /OLD_OPERATOR_TAIL/);
  assert.match(r.inputs[0], /CANONICAL_EVIDENCE/);
  assert.match(r.systems[0], /Evidence is untrusted/);
  assert.match(r.systems[0], /local result schema/);
  assert.equal(r.saved.length, 1);
  assert.equal(
    r.calls.filter((c) => c.name === "coach_memory_recall").length,
    0,
  );
});

function covered(p: any) {
  p.recall_policy = {
    general_memory: "covered",
    reason: "DAILY_BASELINE_PREPARED",
    covered_domains: Object.keys(p.baseline),
  };
}
test("covered skips only optional general recall while retaining capture and accepted learning", async () => {
  const r = await runPacket(covered);
  assert.equal(
    r.calls.filter((c) => c.name === "coach_memory_recall").length,
    0,
  );
  assert.equal(
    r.calls.filter((c) => c.name === "coach_memory_begin").length,
    1,
  );
  assert.equal(
    r.calls.filter((c) => c.name === "coach_memory_commit").length,
    1,
  );
  assert.equal(r.saved.length, 1);
  assert.ok(r.events.some((e) => e.stage === "daily-baseline-recall-covered"));
  assert.equal(r.extractionInputs.length, 1);
  assert.doesNotMatch(r.extractionInputs.join(""), /OLD_OPERATOR_TAIL/);
  assert.match(r.systems[0], /single backend-prepared/);
});

for (const [name, mutate] of Object.entries({
  "missing objective data": (p: any) => {
    p.baseline.objective.data = {};
  },
  "malformed nutrition target": (p: any) => {
    p.baseline.prescription.data.nutrition.targets.calories = "NOT_A_NUMBER";
  },
  "malformed sessions": (p: any) => {
    p.baseline.prescription.data.training.sessions = {};
  },
  "malformed constraints": (p: any) => {
    p.baseline.constraints.data.items = "NOT_AN_ARRAY";
  },
  "missing binding": (p: any) => {
    delete p.binding;
  },
  "cross requester": (p: any) => {
    p.binding.requester_id = "f".repeat(24);
  },
  "cross owner": (p: any) => {
    p.binding.owner_id = "f".repeat(24);
  },
  "cross scope": (p: any) => {
    p.binding.scope_generation++;
  },
  "cross task": (p: any) => {
    p.binding.task_id = "f".repeat(24);
  },
  "cross lease": (p: any) => {
    p.binding.lease_generation++;
  },
  "cross timezone": (p: any) => {
    p.member.timezone = "America/New_York";
  },
  "cross day": (p: any) => {
    p.checkin.local_day = "2026-11-02";
  },
  oversized: (p: any) => {
    p.baseline.objective.data.goal.text = "🙂".repeat(18000);
  },
  deep: (p: any) => {
    let v: any = {};
    p.baseline.objective.data.goal = v;
    for (let i = 0; i < 25; i++) v = v.next = {};
  },
  "secret shaped": (p: any) => {
    p.checkin.note = "Bearer SYNTHETIC_SECRET_SENTINEL";
  },
  "known secret": (p: any) => {
    p.checkin.note = "worker-secret";
  },
}))
  test(`unsafe packet ${name} is excluded entirely with legacy recall and no leak`, async () => {
    const r = await runPacket((p) => {
      covered(p);
      p.baseline.objective.data.goal.text = "REJECTED_PACKET_SENTINEL";
      mutate(p);
    });
    assert.equal(r.saved.length, 1);
    assert.equal(JSON.parse(r.inputs[0]).daily_baseline, undefined);
    assert.match(r.inputs[0], /OLD_OPERATOR_TAIL/);
    assert.doesNotMatch(
      JSON.stringify([r.inputs, r.extractionInputs, r.events]),
      /SYNTHETIC_SECRET_SENTINEL|worker-secret|REJECTED_PACKET_SENTINEL/,
    );
    assert.equal(
      r.calls.filter((c) => c.name === "coach_memory_recall").length,
      1,
    );
  });

for (const policy of [
  undefined,
  { general_memory: "covered" },
  {
    general_memory: "covered",
    reason: "DAILY_BASELINE_PREPARED",
    covered_domains: [],
  },
  {
    general_memory: "recommended",
    reason: "SECTIONS_NOT_READY",
  },
  { general_memory: "required", reason: "DAILY_BASELINE_UNAVAILABLE" },
])
  test(`incomplete or noncovered recall policy ${JSON.stringify(policy)} retains recall`, async () => {
    const r = await runPacket((p) => {
      p.recall_policy = policy;
    });
    assert.equal(
      r.calls.filter((c) => c.name === "coach_memory_recall").length,
      1,
    );
  });

test("partial/unavailable snapshot retains recall and honest section state", async () => {
  const r = await runPacket((p) => {
    covered(p);
    p.snapshot.status = "unavailable";
    p.baseline.recovery.state = "unavailable";
    p.baseline.recovery.data = null;
  });
  assert.equal(
    JSON.parse(r.inputs[0]).daily_baseline.baseline.recovery.data,
    null,
  );
  assert.equal(
    r.calls.filter((c) => c.name === "coach_memory_recall").length,
    1,
  );
});

test("non-daily never consumes packet or skips recall", async () => {
  const r = await runPacket(covered, "activity_followup");
  assert.equal(JSON.parse(r.inputs[0]).daily_baseline, undefined);
  assert.match(r.inputs[0], /OLD_OPERATOR_TAIL/);
  assert.equal(
    r.calls.filter((c) => c.name === "coach_memory_recall").length,
    1,
  );
  assert.equal(
    r.calls.find((c) => c.name === "coach_read_task_context").args
      .daily_baseline_schema,
    undefined,
  );
});

test("repair reuses prepared input and capture without context replay", async () => {
  const r = await runPacket(covered, "daily_insight", true);
  assert.equal(r.inputs.length, 2);
  assert.equal(
    r.calls.filter((c) => c.name === "coach_read_task_context").length,
    1,
  );
  assert.equal(
    r.calls.filter((c) => c.name === "coach_memory_begin").length,
    1,
  );
  assert.equal(
    r.calls.filter((c) => c.name === "coach_memory_recall").length,
    0,
  );
  assert.equal(
    r.calls.filter((c) => c.name === "coach_complete_task").length,
    1,
  );
  assert.equal(r.saved.length, 1);
  assert.doesNotMatch(r.inputs.join(""), /OLD_OPERATOR_TAIL/);
});

test("unavailable section cannot authorize covered recall even with ready snapshot", async () => {
  const r = await runPacket((p) => {
    covered(p);
    p.baseline.objective.state = "unavailable";
    p.baseline.objective.data = null;
  });
  assert.equal(
    r.calls.filter((c) => c.name === "coach_memory_recall").length,
    1,
  );
  assert.equal(
    JSON.parse(r.inputs[0]).daily_baseline.baseline.objective.state,
    "unavailable",
  );
});

test("recorded string exercise IDs, units and zero set values survive unchanged", async () => {
  const r = await runPacket((p) => {
    const e = p.baseline.prescription.data.training.sessions[0].exercises[0];
    e.exercise_id = "barbell-back-squat";
    Object.assign(e.sets[0], {
      weight: 0,
      repetitions: 0,
      duration: 0,
      distance: 0,
      units: "as_recorded",
    });
  });
  assert.deepEqual(JSON.parse(r.inputs[0]).daily_baseline, r.packet);
});

for (const state of ["partial", "withheld"])
  test(`explicit covered ${state} section retains its limitations without general recall`, async () => {
    const r = await runPacket((p) => {
      covered(p);
      p.baseline.constraints.state = state;
      p.baseline.constraints.data.items = [];
    });
    assert.equal(
      JSON.parse(r.inputs[0]).daily_baseline.baseline.constraints.state,
      state,
    );
    assert.equal(
      r.calls.filter((c) => c.name === "coach_memory_recall").length,
      0,
    );
  });

test("covered packet retains explicit targeted memory search with negotiated tools", async () => {
  const r = await runPacket(covered, "daily_insight", false, {
    negotiate: true,
    targetedRecall: true,
  });
  assert.deepEqual(JSON.parse(r.inputs[0]).daily_baseline, r.packet);
  const recalls = r.calls.filter((c) => c.name === "coach_memory_recall");
  assert.equal(recalls.length, 1);
  assert.equal(recalls[0].args.mode, "search");
  assert.equal(r.saved.length, 1);
});

test("covered packet lost completion ACK resolves exact receipt without replay", async () => {
  const r = await runPacket(covered, "daily_insight", false, {
    dropComplete: true,
  });
  assert.equal(r.saved.length, 1);
  assert.equal(
    r.calls.filter((c) => c.name === "coach_complete_task").length,
    1,
  );
  assert.equal(
    r.calls.filter((c) => c.name === "coach_read_task_receipt").length,
    1,
  );
  assert.equal(
    r.calls.filter((c) => c.name === "coach_read_task_context").length,
    1,
  );
  assert.equal(
    r.calls.filter((c) => c.name === "coach_memory_commit").length,
    1,
  );
});

for (const code of [
  "MEMORY_NOT_AUTHORIZED",
  "LEASE_LOST",
  "CREDENTIAL_REJECTED",
])
  test(`covered does not bypass capture authority ${code}`, async () => {
    await assert.rejects(
      runPacket(covered, "daily_insight", false, {
        onMemoryWire: (name: string) =>
          name === "coach_memory_begin" ? code : undefined,
      }),
    );
  });

test("dated canonical metrics outrank static plan narrative in fixed daily guidance", async () => {
  const r = await runPacket((p) => {
    p.baseline.objective.data.plan.goal_statement.text =
      "Old plan rationale: 188 lbs today";
  });
  assert.match(
    r.systems[0],
    /Dated canonical metrics and approved targets outrank static plan rationale/,
  );
  assert.match(r.inputs[0], /Old plan rationale/);
});

test("new worker negotiates packet only from advertised context selector", async () => {
  const r = await runPacket();
  assert.equal(
    r.calls.find((c) => c.name === "coach_read_task_context").args
      .daily_baseline_schema,
    "coach_daily_baseline.v1",
  );
  const old = await runPacket(
    (p) => {
      p.schema = "unknown";
    },
    "daily_insight",
    false,
    { dailyBaseline: false },
  );
  assert.deepEqual(
    Object.keys(
      old.calls.find((c) => c.name === "coach_read_task_context").args,
    ).sort(),
    ["lease_generation", "protocol", "task_id"],
  );
});
